#!/usr/bin/env node
/**
 * Drostex — colour block map.
 *
 * Splits the addressable range into N blocks, each a distinct hue, and holds
 * the pattern until you stop it. Walk around the cube and read the mapping
 * off it directly, instead of answering questions about counts.
 *
 * Two earlier tests were corrupted by brightness rather than by hue: white at
 * (255,255,255) reflects far harder than blue at (0,80,255), so the white
 * block appeared to cover many more edges than it did. Every colour here is
 * generated at a FIXED total drive level, so no block can out-shout another.
 *
 * What we are trying to settle: 44 addresses respond and the cube has 12 edges
 * of 11 LEDs. If one block of 11 addresses lights 3 edges in the same colour,
 * the cube has 3 parallel LED tracks fed from one data line (3 x 44 = 132).
 * If a block lights 1 edge, only 4 edges are driven.
 *
 *   node scripts/colors.mjs                # 4 blocks across addresses 0-43
 *   node scripts/colors.mjs --blocks=12    # 12 blocks, finer grain
 *   node scripts/colors.mjs --all          # spread across all 88, incl. the dead half
 *   node scripts/colors.mjs --sacn2        # send via sACN as TWO universes
 *
 * Ctrl-C to stop; the cube is blanked on exit.
 */

import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './lib/config.mjs';

const CONFIG = loadConfig();
const HOST = CONFIG.host;
const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};
const ALL = process.argv.includes('--all');
const SACN2 = process.argv.includes('--sacn2');
const BLOCKS = Number(arg('blocks', 4));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getInfo() {
  const r = await fetch(`http://${HOST}/json/info`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`GET /json/info -> HTTP ${r.status}`);
  return r.json();
}

async function prepare() {
  await fetch(`http://${HOST}/json/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: true, bri: 255, lor: 0 }),
    signal: AbortSignal.timeout(4000),
  });
}

/**
 * Hue -> RGB at a fixed total drive budget.
 *
 * Equalising total drive rather than peak channel is what keeps a two-channel
 * colour like yellow from being twice as bright as a single-channel red, which
 * is the artefact that ruined the previous reading.
 */
function hueRGB(h, budget = 300) {
  const s = 1, v = 1;
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = 0, q = 1 - f, t = f;
  const [r, g, b] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ][i];
  const sum = r + g + b || 1;
  const k = budget / sum;
  return [
    Math.min(255, Math.round(r * k)),
    Math.min(255, Math.round(g * k)),
    Math.min(255, Math.round(b * k)),
  ];
}

const NAMES = ['red', 'orange', 'yellow', 'lime', 'green', 'spring', 'cyan', 'azure', 'blue', 'violet', 'magenta', 'pink'];

// ---------------------------------------------------------------- transports

const drgb = (rgb) => {
  const b = Buffer.allocUnsafe(2 + rgb.length);
  b[0] = 2; b[1] = 2;
  rgb.copy(b, 2);
  return b;
};

const CID = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
function sacn(slots, seq, universe) {
  const buf = Buffer.alloc(638);
  buf.writeUInt16BE(0x0010, 0);
  buf.write('ASC-E1.17\0\0\0', 4, 'latin1');
  buf.writeUInt16BE(0x726e, 16);
  buf.writeUInt32BE(0x00000004, 18);
  CID.copy(buf, 22);
  buf.writeUInt16BE(0x7258, 38);
  buf.writeUInt32BE(0x00000002, 40);
  buf.write('Drostex', 44, 'latin1');
  buf[108] = 100;
  buf[111] = seq & 0xff;
  buf[112] = 0;
  buf.writeUInt16BE(universe, 113);
  buf.writeUInt16BE(0x720b, 115);
  buf[117] = 0x02;
  buf[118] = 0xa1;
  buf.writeUInt16BE(0x0001, 121);
  buf.writeUInt16BE(0x0201, 123);
  buf[125] = 0x00;
  slots.copy(buf, 126, 0, Math.min(slots.length, 512));
  return buf;
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => {});
    s.connect(port, HOST, () => resolve(s));
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}

// ---------------------------------------------------------------- main

async function main() {
  const info = await getInfo();
  const n = info.leds.count;
  const last = ALL ? n - 1 : 43; // 43 = last address measured as responsive
  const span = last + 1;
  const size = Math.ceil(span / BLOCKS);

  const rgb = Buffer.alloc(n * 3);
  console.log(`\n  ${info.brand} ${info.product} — ${n} addresses configured\n`);
  console.log(`  ${BLOCKS} blocks across addresses 0..${last} (${size} addresses each)\n`);

  for (let b = 0; b < BLOCKS; b++) {
    const start = b * size;
    const end = Math.min(start + size - 1, last);
    if (start > last) break;
    const col = hueRGB(b / BLOCKS);
    const name = NAMES[Math.round((b / BLOCKS) * 12) % 12];
    console.log(
      `    block ${String(b).padStart(2)}  addresses ${String(start).padStart(2)}-${String(end).padStart(2)}  ` +
      `${name.padEnd(8)} rgb(${col.join(',')})`,
    );
    for (let i = start; i <= end; i++) {
      rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
    }
  }

  await prepare();

  let send;
  if (SACN2) {
    // The manual says pixels are split across two LED tracks on two universes.
    // Track 1 gets addresses 0..43, track 2 gets 44..87, each from channel 1 of
    // its own universe. If the dead upper half is simply listening elsewhere,
    // this is what wakes it up.
    const sock = await openSocket(CONFIG.sacnPort);
    const half = Math.ceil(n / 2);
    let seq = 0;
    console.log(`\n  Sending sACN: universe 1 = addresses 0-${half - 1}, universe 2 = ${half}-${n - 1}\n`);
    send = () => {
      const u1 = rgb.subarray(0, half * 3);
      const u2 = rgb.subarray(half * 3);
      sock.send(sacn(u1, seq, 1));
      sock.send(sacn(u2, seq, 2));
      seq = (seq + 1) & 0xff;
    };
    process.on('exit', () => sock.close());
  } else {
    const sock = await openSocket(CONFIG.port);
    console.log(`\n  Sending WLED DRGB on :${CONFIG.port}\n`);
    send = () => sock.send(drgb(rgb));
    process.on('exit', () => sock.close());
  }

  console.log('  Holding. Walk around the cube and note which edges show which');
  console.log('  colour. Ctrl-C when done.\n');

  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(0);
    stopping = true;
    rgb.fill(0);
    for (let i = 0; i < 8; i++) { send(); await sleep(40); }
    console.log('\n  Blanked.\n');
    process.exit(0);
  });

  for (;;) {
    send();
    await sleep(400);
  }
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
