#!/usr/bin/env node
/**
 * Drostex — interactive mapping probe.
 *
 * The CLI ancestor of the mapping wizard. Rather than asking you to watch a
 * timed walk and remember what happened, this lights one thing at a time and
 * waits for you to answer before moving on.
 *
 * What we are trying to learn:
 *   1. How many separate glowing lines the cube actually has.
 *   2. Whether each of the 8 addressable runs drives one line or two.
 *   3. Which physical line each run corresponds to, and which way it runs.
 *
 * None of this is documented anywhere, and the vendor's own numbers disagree
 * with the controller's, so it has to be measured.
 *
 * Run it yourself so you can answer as you look:
 *     node scripts/map.mjs
 */

import dgram from 'node:dgram';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeFileSync } from 'node:fs';
import { loadConfig } from './lib/config.mjs';

const CONFIG = loadConfig();
const HOST = CONFIG.host;
const PORT = CONFIG.port; // WLED native realtime UDP — measured working in Phase 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- device i/o

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

function openSocket() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', reject);
    sock.connect(PORT, HOST, () => resolve(sock));
  });
}

/** WLED DRGB: [2, timeout_seconds, R,G,B ...] */
function drgb(rgb) {
  const buf = Buffer.allocUnsafe(2 + rgb.length);
  buf[0] = 2;
  buf[1] = 2;
  rgb.copy(buf, 2);
  return buf;
}

/**
 * Holds a frame on the cube until `stop()` is called.
 *
 * WLED reverts to its onboard effects ~2.5s after the last realtime packet,
 * so a static image still has to be retransmitted while we wait for input.
 */
function hold(sock, rgb) {
  let live = true;
  (async () => {
    while (live) {
      try {
        sock.send(drgb(rgb));
      } catch {
        /* transient send failure; the next tick retries */
      }
      await sleep(500);
    }
  })();
  return () => {
    live = false;
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const info = await getInfo();
  const n = info.leds.count;
  const perRun = 11;
  const runs = Math.ceil(n / perRun);

  console.log(`\n  ${info.brand} ${info.product} — ${n} addressable LEDs\n`);
  console.log('  Answer while each pattern is lit. Press Enter to keep the default.');
  console.log('  Type "r" at any prompt to re-show the current pattern.\n');

  await prepare();
  const sock = await openSocket();
  const rl = readline.createInterface({ input, output });
  const rgb = Buffer.alloc(n * 3);

  const ask = async (q, valid, dflt) => {
    for (;;) {
      const a = (await rl.question(q)).trim().toLowerCase();
      if (a === '') return dflt;
      if (a === 'r') return 'r';
      if (!valid || valid(a)) return a;
      console.log('    (unrecognised — try again)');
    }
  };

  const result = { host: HOST, mac: info.mac, ledCount: n, perRun, runs: [] };

  // --- Step 1: how many lines does this cube actually have? ------------------
  for (;;) {
    rgb.fill(60); // dim white — bright enough to see, dim enough not to dazzle
    const stop = hold(sock, rgb);
    console.log('  ── Step 1 ── every LED is now lit, dim white.');
    const a = await ask(
      '  How many separate glowing LINES do you count?  (ignore reflections) > ',
      (x) => /^\d+$/.test(x) || x === 'r',
      null,
    );
    stop();
    if (a === 'r') continue;
    result.visibleLines = a === null ? null : Number(a);
    break;
  }
  console.log(`     recorded: ${result.visibleLines} lines\n`);

  // --- Step 2: what does each addressable run drive? -------------------------
  console.log('  ── Step 2 ── now one run at a time.\n');

  for (let r = 0; r < runs; r++) {
    const start = r * perRun;
    const end = Math.min(start + perRun, n);

    for (;;) {
      rgb.fill(0);
      for (let i = start; i < end; i++) {
        const t = (i - start) / Math.max(1, end - start - 1);
        rgb[i * 3] = Math.round(255 * (1 - t)); // red at the low-index end
        rgb[i * 3 + 2] = Math.round(255 * t); // blue at the high-index end
      }
      const stop = hold(sock, rgb);

      console.log(`  Run ${r}  (LEDs ${start}..${end - 1})  — red at one end, blue at the other`);
      const count = await ask('    How many LINES lit up?  [1/2/more] > ', (x) =>
        ['1', '2', 'more', 'r'].includes(x),
      );
      if (count === 'r') {
        stop();
        continue;
      }
      const where = await ask(
        '    Where is it?  [top / bottom / vertical / mixed / skip] > ',
        (x) => ['top', 'bottom', 'vertical', 'mixed', 'skip', 'r'].includes(x),
        'skip',
      );
      stop();
      if (where === 'r') continue;

      result.runs.push({ run: r, start, end: end - 1, lines: count, position: where });
      console.log(`    ✓ run ${r}: ${count} line(s), ${where}\n`);
      break;
    }
  }

  // --- blank the cube and hand it back --------------------------------------
  rgb.fill(0);
  for (let i = 0; i < 8; i++) {
    sock.send(drgb(rgb));
    await sleep(50);
  }
  sock.close();
  rl.close();

  const out = 'profiles/nano-observations.json';
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');

  // --- summary ---------------------------------------------------------------
  const doubled = result.runs.filter((x) => x.lines === '2').length;
  console.log('  ' + '─'.repeat(56));
  console.log(`  Visible lines : ${result.visibleLines}`);
  console.log(`  Runs          : ${result.runs.length}`);
  console.log(`  Runs driving 2 lines : ${doubled}`);
  const implied = result.runs.reduce((a, x) => a + (x.lines === '2' ? 2 : 1), 0);
  console.log(`  Implied line count from runs : ${implied}`);
  if (result.visibleLines != null && implied !== result.visibleLines) {
    console.log(`  ⚠️  does not match the ${result.visibleLines} you counted — worth a re-run`);
  }
  console.log(`\n  Saved to ${out}\n`);
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
