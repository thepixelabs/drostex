#!/usr/bin/env node
/**
 * Drostex — Phase 0 spike.
 *
 * Goal: light exactly one LED on the physical cube, and learn which realtime
 * transport the firmware actually accepts. Nothing else gets built until this
 * passes.
 *
 * The cube runs a rebranded WLED fork, so /json/info reports `live`, `lm`
 * (protocol name) and `lip` (source IP of whoever is streaming). That gives us
 * a closed loop: we can verify a transport worked without asking a human
 * whether something lit up.
 *
 * Usage:
 *   node scripts/blink.mjs [host]
 *   node scripts/blink.mjs 192.168.0.108 --chase
 */

import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';

const HOST = process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? '192.168.0.108';
const CHASE = process.argv.includes('--chase');
const RUNS = process.argv.includes('--runs');

const PORTS = { ddp: 4048, wled: 21324, sacn: 5568, artnet: 6454 };

// ---------------------------------------------------------------- http helpers

async function getInfo() {
  const r = await fetch(`http://${HOST}/json/info`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`GET /json/info -> HTTP ${r.status}`);
  return r.json();
}

async function setState(body) {
  const r = await fetch(`http://${HOST}/json/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text.slice(0, 200) };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------- udp helper

/**
 * Opens a connected UDP socket and reports the OS-chosen source IP.
 *
 * connect() gives us two things: the real source address (which we compare
 * against the cube's `lip`), and ICMP delivery — a closed port on the device
 * comes back as ECONNREFUSED instead of silently vanishing. That is genuinely
 * useful signal, so we record it rather than letting it throw.
 */
function openSocket(port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const state = { refused: false, lastError: null };
    sock.on('error', (e) => {
      state.lastError = e;
      if (e.code === 'ECONNREFUSED') state.refused = true;
    });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 3000);
    sock.connect(port, HOST, () => {
      clearTimeout(timer);
      resolve({ sock, srcIp: sock.address().address, state });
    });
  });
}

const send = (sock, buf) =>
  new Promise((res, rej) => sock.send(buf, (err) => (err ? rej(err) : res())));

// ---------------------------------------------------------------- packet builders

/** DDP — 10-byte header + RGB payload. The primary candidate. */
function buildDDP(rgb, seq) {
  const buf = Buffer.allocUnsafe(10 + rgb.length);
  buf[0] = 0x40 | 0x01; // VER1 | PUSH
  buf[1] = seq & 0x0f; // 1..15, 0 means "unused"
  buf[2] = 0x0b; // RGB24: 8 bits/channel, 3 channels
  buf[3] = 1; // DDP_ID_DISPLAY
  buf.writeUInt32BE(0, 4); // offset, in BYTES
  buf.writeUInt16BE(rgb.length, 8); // length, in BYTES
  rgb.copy(buf, 10);
  return buf;
}

/** WLED native realtime UDP, DRGB mode. */
function buildWLED(rgb) {
  const buf = Buffer.allocUnsafe(2 + rgb.length);
  buf[0] = 2; // DRGB
  buf[1] = 2; // seconds before the cube reverts to its own effects
  rgb.copy(buf, 2);
  return buf;
}

const CID = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');

/** E1.31 / sACN — a full 638-byte universe packet. */
function buildSACN(rgb, seq, universe) {
  const buf = Buffer.alloc(638);
  // --- root layer
  buf.writeUInt16BE(0x0010, 0); // preamble size
  buf.writeUInt16BE(0x0000, 2); // postamble size
  buf.write('ASC-E1.17\0\0\0', 4, 'latin1'); // ACN packet identifier
  buf.writeUInt16BE(0x726e, 16); // flags + length
  buf.writeUInt32BE(0x00000004, 18); // vector: E1.31 data
  CID.copy(buf, 22);
  // --- framing layer
  buf.writeUInt16BE(0x7258, 38);
  buf.writeUInt32BE(0x00000002, 40); // vector: DMP
  buf.write('Drostex Phase 0', 44, 'latin1'); // 64-byte source name
  buf[108] = 100; // priority
  buf.writeUInt16BE(0, 109); // sync universe
  buf[111] = seq & 0xff; // sequence — per universe
  buf[112] = 0; // options. bit7 = preview: MUST stay 0 or WLED drops it
  buf.writeUInt16BE(universe, 113);
  // --- DMP layer
  buf.writeUInt16BE(0x720b, 115);
  buf[117] = 0x02; // vector: set property
  buf[118] = 0xa1; // address type & data type
  buf.writeUInt16BE(0x0000, 119); // first property address
  buf.writeUInt16BE(0x0001, 121); // address increment
  buf.writeUInt16BE(0x0201, 123); // property value count = 513
  buf[125] = 0x00; // DMX start code
  rgb.copy(buf, 126, 0, Math.min(rgb.length, 512));
  return buf;
}

/** Art-Net ArtDmx. Header is 18 bytes; the DMX length must be even. */
function buildArtNet(rgb, seq, universe) {
  const len = rgb.length + (rgb.length % 2);
  const buf = Buffer.alloc(18 + len);
  buf.write('Art-Net\0', 0, 'latin1'); // 0..7
  buf.writeUInt16LE(0x5000, 8); // 8..9   OpDmx
  buf[10] = 0; // protocol version hi
  buf[11] = 14; // protocol version lo
  buf[12] = (seq & 0xff) || 1; // sequence, 0 disables ordering
  buf[13] = 0; // physical
  buf[14] = universe & 0xff; // SubUni
  buf[15] = (universe >> 8) & 0x7f; // Net
  buf.writeUInt16BE(len, 16); // length, big-endian
  rgb.copy(buf, 18);
  return buf;
}

// ---------------------------------------------------------------- the probe

/**
 * Streams a frame repeatedly for ~500ms, then asks the cube whether it noticed.
 * Returns { ok, lm, lip } — `ok` requires that the cube is live AND that the
 * stream it is listening to is *ours* (otherwise another sender on the LAN,
 * like the vendor app, produces a false positive).
 */
/**
 * Waits for the cube to stop considering itself "live". WLED reverts ~2.5s
 * after the last realtime packet. Without this, a probe that runs straight
 * after a successful one inherits its `live:true` and reports a false positive.
 */
async function waitForIdle(timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await getInfo();
    if (!info.live) return true;
    await sleep(400);
  }
  return false;
}

async function probe(name, port, build, rgb) {
  process.stdout.write(`  ${name.padEnd(12)} `);

  if (!(await waitForIdle())) {
    console.log('skipped — device still live from a previous stream');
    return { ok: false };
  }

  let sock, srcIp, state;
  try {
    ({ sock, srcIp, state } = await openSocket(port));
  } catch (e) {
    console.log(`socket error: ${e.message}`);
    return { ok: false };
  }

  try {
    for (let i = 0; i < 16; i++) {
      if (state.refused) break; // port is closed; no point continuing
      try {
        await send(sock, build(rgb, (i % 15) + 1));
      } catch (e) {
        state.lastError = e;
        break;
      }
      await sleep(30);
    }
    await sleep(150);

    if (state.refused) {
      console.log('port closed (ICMP unreachable) — not listening');
      return { ok: false, closed: true };
    }

    const info = await getInfo();
    // This firmware fork does not report `lip`, so we cannot attribute the
    // stream by source IP. The live=false -> live=true transition we just
    // forced, plus `lm`, is the strongest signal available here.
    const ok = Boolean(info.live);
    const via = info.lm ? ` lm="${info.lm}"` : ' (no lm field)';
    console.log(ok ? `ACCEPTED${via}` : `open, but ignored (live=${info.live})`);
    return { ok, lm: info.lm, srcIp, port };
  } catch (e) {
    console.log(`error: ${e.message}`);
    return { ok: false };
  } finally {
    sock.close();
  }
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`\nDrostex Phase 0 — probing ${HOST}\n`);

  // 1. Identify the device.
  const info = await getInfo();
  const n = info.leds.count;
  console.log(`Device : ${info.brand} ${info.product}  (${info.ver}, ${info.arch})`);
  console.log(`LEDs   : ${n}  →  ${n * 3} channels`);
  console.log(`MAC    : ${info.mac}`);
  console.log(`Live   : ${info.live}\n`);

  // 2. Prepare the cube. Realtime pixels are scaled by global brightness, and
  //    a non-zero `lor` makes packets arrive while nothing lights up.
  console.log('Preparing device: on=true, bri=255, lor=0 …');
  const res = await setState({ on: true, bri: 255, lor: 0, live: false });
  console.log(`  POST /json/state -> HTTP ${res.status} ${res.body}`);
  if (!res.ok) {
    console.log('  ⚠️  state POST failed — see risk #2 in the plan.');
  }
  await sleep(300);

  // 3. One LED red, everything else off. If a whole edge lights up instead of a
  //    single LED, that is the parallel-wiring hypothesis showing itself.
  const rgb = Buffer.alloc(n * 3);
  rgb[0] = 255;

  console.log('\nProbing transports (LED 0 red, all others off):');
  const results = {
    ddp: await probe('DDP', PORTS.ddp, buildDDP, rgb),
    wled: await probe('WLED-UDP', PORTS.wled, buildWLED, rgb),
    sacnU1: await probe('sACN u1', PORTS.sacn, (d, s) => buildSACN(d, s, 1), rgb),
    sacnU0: await probe('sACN u0', PORTS.sacn, (d, s) => buildSACN(d, s, 0), rgb),
    artnet: await probe('Art-Net u0', PORTS.artnet, (d, s) => buildArtNet(d, s, 0), rgb),
  };

  const winner = Object.entries(results).find(([, r]) => r.ok);

  console.log('\n' + '─'.repeat(60));
  if (!winner) {
    console.log('❌ No transport accepted. Phase 0 FAILED — stop and reassess.');
    process.exitCode = 1;
    return;
  }

  const accepted = Object.entries(results).filter(([, r]) => r.ok).map(([k]) => k);
  const [key] = winner;
  console.log(`Phase 0 PASSED — working transports: ${accepted.join(', ')}`);
  console.log(`Using: ${key}`);
  console.log('─'.repeat(60));

  if (RUNS) {
    await walkRuns(key, n);
    return;
  }

  if (CHASE) {
    console.log('\nRunning a chase so you can watch the mapping. Ctrl-C to stop.');
    await chase(key, n);
  } else {
    console.log('\nLook at the cube: is exactly ONE LED red, or a whole edge?');
    console.log('Re-run with --chase to walk the strip and see the wiring order.\n');
  }
}

/** Walks one LED at a time down the strip, so the wiring order is visible. */
async function chase(key, n) {
  const port = key.startsWith('sacn') ? PORTS.sacn : key === 'wled' ? PORTS.wled : key === 'artnet' ? PORTS.artnet : PORTS.ddp;
  const build =
    key === 'ddp' ? buildDDP
    : key === 'wled' ? buildWLED
    : key === 'artnet' ? ((d, s) => buildArtNet(d, s, 0))
    : ((d, s) => buildSACN(d, s, key === 'sacnU0' ? 0 : 1));

  const { sock } = await openSocket(port);
  const rgb = Buffer.alloc(n * 3);
  let seq = 1;
  for (let i = 0; ; i = (i + 1) % n) {
    rgb.fill(0);
    rgb[i * 3] = 255;
    rgb[i * 3 + 1] = 40;
    process.stdout.write(`\r  LED ${String(i).padStart(3)} / ${n}   `);
    await send(sock, build(rgb, (seq++ % 15) + 1));
    await sleep(120);
  }
}

/** Resolves the packet builder + port for a probe key. */
function senderFor(key) {
  if (key === 'wled') return { port: PORTS.wled, build: buildWLED };
  if (key === 'artnet') return { port: PORTS.artnet, build: (d, s) => buildArtNet(d, s, 0) };
  if (key === 'sacnU0') return { port: PORTS.sacn, build: (d, s) => buildSACN(d, s, 0) };
  if (key === 'sacnU1') return { port: PORTS.sacn, build: (d, s) => buildSACN(d, s, 1) };
  return { port: PORTS.ddp, build: buildDDP };
}

/**
 * Lights one 11-LED run at a time, holding each for a few seconds.
 *
 * This is the CLI ancestor of the mapping wizard. 88 logical pixels / 11 per
 * edge = 8 runs. If the cube has 12 glowing edges but only 8 runs, then some
 * runs must drive two edges at once — watching this walk is what tells us
 * which pairs are ganged.
 */
async function walkRuns(key, n, perEdge = 11, holdMs = 5000) {
  const { port, build } = senderFor(key);
  const { sock } = await openSocket(port);
  const runs = Math.ceil(n / perEdge);
  const rgb = Buffer.alloc(n * 3);
  let seq = 1;

  console.log(`\nWalking ${runs} runs of ${perEdge} LEDs, ${holdMs / 1000}s each.`);
  console.log('For each one, note how many EDGES light up (1 or 2).\n');

  for (let r = 0; r < runs; r++) {
    const start = r * perEdge;
    const end = Math.min(start + perEdge, n);
    console.log(`  Run ${r}  →  LEDs ${start}..${end - 1}   (red at ${start}, blue at ${end - 1})`);
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      rgb.fill(0);
      // Gradient encodes direction for free: red end is the low index.
      for (let i = start; i < end; i++) {
        const t = (i - start) / Math.max(1, end - start - 1);
        rgb[i * 3] = Math.round(255 * (1 - t));
        rgb[i * 3 + 2] = Math.round(255 * t);
      }
      await send(sock, build(rgb, (seq++ % 15) + 1));
      await sleep(60);
    }
  }

  rgb.fill(0);
  for (let i = 0; i < 8; i++) await send(sock, build(rgb, (seq++ % 15) + 1));
  sock.close();
  console.log('\nDone. Which runs lit two edges instead of one?\n');
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
});
