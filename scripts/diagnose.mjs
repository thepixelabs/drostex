#!/usr/bin/env node
/**
 * Drostex — geometry diagnostic.
 *
 * The first mapping attempt assumed 11 LEDs per run, taken from the vendor's
 * spec sheet. The observations did not support it: runs lit 1, 1, 2 and "more"
 * lines respectively, and addresses 44..87 did nothing at all.
 *
 * So this stops assuming any grouping and measures the two facts everything
 * else depends on:
 *
 *   1. How many physical LEDs does ONE address drive?
 *      (132 physical / 44 working addresses = 3, which is exactly how WS2811
 *      ICs behave — each drives 3 LEDs as a single pixel. Worth confirming
 *      rather than inferring from arithmetic.)
 *
 *   2. Where exactly does the strip stop responding?
 *      Found by binary search rather than by asking about 88 addresses.
 *
 * Every question is yes/no or a small count of ADJACENT dots, so reflections
 * in the mirrors cannot corrupt the answer.
 *
 *     node scripts/diagnose.mjs
 */

import dgram from 'node:dgram';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeFileSync } from 'node:fs';
import { loadConfig } from './lib/config.mjs';

const CONFIG = loadConfig();
const HOST = CONFIG.host;
const PORT = CONFIG.port;

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

function openSocket() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', reject);
    sock.connect(PORT, HOST, () => resolve(sock));
  });
}

const drgb = (rgb) => {
  const b = Buffer.allocUnsafe(2 + rgb.length);
  b[0] = 2;
  b[1] = 2;
  rgb.copy(b, 2);
  return b;
};

/** Keeps a static frame alive; the firmware reverts ~2.5s after the last packet. */
function hold(sock, rgb) {
  let live = true;
  (async () => {
    while (live) {
      try {
        sock.send(drgb(rgb));
      } catch {}
      await sleep(400);
    }
  })();
  return () => { live = false; };
}

async function main() {
  const info = await getInfo();
  const n = info.leds.count;

  console.log(`\n  ${info.brand} ${info.product} — controller reports ${n} addresses\n`);
  console.log('  Every question below is yes/no or a small count.');
  console.log('  Count only ADJACENT dots on the same edge — ignore anything');
  console.log('  that looks like a reflection deeper inside the cube.\n');

  await prepare();
  const sock = await openSocket();
  const rl = readline.createInterface({ input, output });
  const rgb = Buffer.alloc(n * 3);

  const show = (fn) => {
    rgb.fill(0);
    fn(rgb);
    return hold(sock, rgb);
  };

  const yesno = async (q) => {
    for (;;) {
      const a = (await rl.question(q)).trim().toLowerCase();
      if (['y', 'yes'].includes(a)) return true;
      if (['n', 'no'].includes(a)) return false;
      console.log('    (please answer y or n)');
    }
  };

  const setPixel = (buf, i, [r, g, b]) => {
    if (i * 3 + 2 < buf.length) {
      buf[i * 3] = r;
      buf[i * 3 + 1] = g;
      buf[i * 3 + 2] = b;
    }
  };

  const out = { host: HOST, mac: info.mac, reportedCount: n };

  // ---- Test 1: how many LEDs does a single address drive? -------------------
  console.log('  ── Test 1 ── lighting ONE address (index 0), bright white.\n');
  let stop = show((b) => setPixel(b, 0, [255, 255, 255]));
  const grouped = await rl.question(
    '    How many LEDs light up, side by side?  [1 / 2 / 3 / more] > ',
  );
  stop();
  out.ledsPerAddress = grouped.trim();
  console.log(`     recorded: ${out.ledsPerAddress}\n`);

  // ---- Test 2: binary search for the last responsive address ----------------
  console.log('  ── Test 2 ── finding where the strip stops responding.');
  console.log('     Each step lights a SINGLE address. Just say whether anything lit.\n');

  const lit = async (i) => {
    const s = show((b) => setPixel(b, i, [255, 255, 255]));
    const answer = await yesno(`    address ${String(i).padStart(3)} — anything lit?  [y/n] > `);
    s();
    return answer;
  };

  // Confirm the low end works at all before searching.
  if (!(await lit(0))) {
    console.log('\n  ⚠️  address 0 does not light. Something more basic is wrong.\n');
  }

  let lo = 0; // known good
  let hi = n; // known bad (exclusive)
  if (await lit(n - 1)) {
    lo = n - 1;
    hi = n;
  } else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await lit(mid)) lo = mid;
      else hi = mid;
    }
  }
  out.lastWorkingAddress = lo;
  out.workingCount = lo + 1;
  console.log(`\n     last responsive address: ${lo}  →  ${lo + 1} working addresses\n`);

  // ---- Test 3: how many lines do the working addresses cover? ---------------
  console.log('  ── Test 3 ── lighting every working address, dim white.\n');
  stop = show((b) => {
    for (let i = 0; i <= lo; i++) setPixel(b, i, [70, 70, 70]);
  });
  const lines = await rl.question('    How many separate LINES are lit?  [count] > ');
  stop();
  out.linesFromWorkingRange = lines.trim();

  // ---- Test 4: is the whole cube covered, or only part of it? ---------------
  const full = await yesno('    Is EVERY edge of the cube lit right now?  [y/n] > ');
  out.coversWholeCube = full;

  // ---- done -----------------------------------------------------------------
  rgb.fill(0);
  for (let i = 0; i < 8; i++) {
    sock.send(drgb(rgb));
    await sleep(50);
  }
  sock.close();
  rl.close();

  const path = 'profiles/nano-diagnostic.json';
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');

  const w = out.workingCount;
  console.log('\n  ' + '─'.repeat(56));
  console.log(`  Controller claims      : ${n} addresses`);
  console.log(`  Actually responsive    : ${w}`);
  console.log(`  LEDs per address       : ${out.ledsPerAddress}`);
  console.log(`  Lines lit              : ${out.linesFromWorkingRange}`);
  console.log(`  Whole cube covered     : ${out.coversWholeCube ? 'yes' : 'no'}`);

  const per = Number(out.ledsPerAddress);
  if (Number.isFinite(per) && per > 0) {
    console.log(`  Implied physical LEDs  : ${w} x ${per} = ${w * per}`);
  }
  const nLines = Number(out.linesFromWorkingRange);
  if (Number.isFinite(nLines) && nLines > 0) {
    console.log(`  Addresses per line     : ${(w / nLines).toFixed(2)}`);
  }
  console.log(`\n  Saved to ${path}\n`);
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
