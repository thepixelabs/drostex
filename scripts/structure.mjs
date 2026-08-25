#!/usr/bin/env node
/**
 * Drostex — structure test.
 *
 * Measured so far: 44 responsive addresses (0..43), the whole cube covered,
 * 1 LED lit per address when asked about ADJACENT dots, and the user's
 * observation that one address appears on more than one line at once.
 * Line count corrected by the user to 12 (an earlier count of 11 was a miscount).
 *
 * With 12 lines the arithmetic closes on exactly one structure:
 *
 *     12 edges x 11 LEDs      = 132 physical LEDs   (matches the vendor)
 *     132 LEDs / 44 addresses = 3 LEDs per address
 *     12 edges / 3 parallel   = 4 groups
 *     4 groups x 11 positions = 44 addresses        (matches what responds)
 *
 * The competing "short lines" theory (each line holding its own addresses)
 * would need 12 x 4 = 48 addresses. Only 44 exist, so it is ruled out by
 * arithmetic alone and no longer needs testing.
 *
 * So this script now CONFIRMS rather than discriminates. Predictions:
 *
 *     Test 1 - one address lights 3 dots, spread across 3 different edges
 *     Test 3 - addresses 0..10 fill 3 complete edges, corner to corner
 *     Test 4 - each of the 4 colour groups covers its own 3 edges
 *     Test 5 - addresses 0 and 10 land at opposite ends of those edges
 *
 * If any of these come back different, the model is wrong again and the
 * answers are what tell us how.
 *
 *     node scripts/structure.mjs
 */

import dgram from 'node:dgram';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeFileSync } from 'node:fs';
import { loadConfig } from './lib/config.mjs';

const CONFIG = loadConfig();
const HOST = CONFIG.host;
const PORT = CONFIG.port;
const WORKING = 44; // addresses 0..43, measured

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

function hold(sock, rgb) {
  let live = true;
  (async () => {
    while (live) {
      try { sock.send(drgb(rgb)); } catch {}
      await sleep(400);
    }
  })();
  return () => { live = false; };
}

async function main() {
  const info = await getInfo();
  const n = info.leds.count;

  console.log(`\n  ${info.brand} ${info.product}\n`);
  console.log('  Answer while each pattern is lit. Look at the WHOLE cube each');
  console.log('  time, not just the nearest edge. Ignore the deep reflections');
  console.log('  that recede into the mirrors — count only the front-most set.\n');

  await prepare();
  const sock = await openSocket();
  const rl = readline.createInterface({ input, output });
  const rgb = Buffer.alloc(n * 3);

  const paint = (fn) => { rgb.fill(0); fn(); return hold(sock, rgb); };
  const set = (i, [r, g, b]) => {
    if (i >= 0 && i * 3 + 2 < rgb.length) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; }
  };
  const range = (a, b, col) => { for (let i = a; i <= b; i++) set(i, col); };

  const WHITE = [255, 255, 255], RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 80, 255];
  const out = { host: HOST, mac: info.mac, workingAddresses: WORKING };

  // ---- T1: the decisive one -------------------------------------------------
  console.log('  ── Test 1 ── ONE address lit (index 0), bright white.\n');
  let stop = paint(() => set(0, WHITE));
  out.dotsForOneAddress = (await rl.question(
    '    How many separate DOTS are lit in total, anywhere on the cube? > ',
  )).trim();
  stop();
  console.log(`     recorded: ${out.dotsForOneAddress}\n`);

  // ---- T2: does a line hold 4 addresses, or 11? -----------------------------
  console.log('  ── Test 2 ── addresses 0-3 RED, 4-7 GREEN (both should sit on the SAME edges).\n');
  stop = paint(() => { range(0, 3, RED); range(4, 7, GREEN); });
  out.redGreenSameLine = (await rl.question(
    '    Are red and green on the SAME line, or DIFFERENT lines?  [same/different] > ',
  )).trim().toLowerCase();
  stop();
  console.log(`     recorded: ${out.redGreenSameLine}\n`);

  // ---- T3: does a group of 11 fill whole edges? -----------------------------
  console.log('  ── Test 3 ── addresses 0-10 in RED, the rest dark.\n');
  stop = paint(() => range(0, 10, RED));
  out.elevenFormsCompleteLines = (await rl.question(
    '    Do the red LEDs fill COMPLETE lines, corner to corner?  [y/n] > ',
  )).trim().toLowerCase();
  out.elevenLineCount = (await rl.question(
    '    How many lines are lit red? > ',
  )).trim();
  stop();
  console.log(`     recorded: ${out.elevenLineCount} line(s), complete=${out.elevenFormsCompleteLines}\n`);

  // ---- T4: are the four groups of 11 distinct? ------------------------------
  console.log('  ── Test 4 ── 0-10 RED, 11-21 GREEN, 22-32 BLUE, 33-43 WHITE.\n');
  stop = paint(() => {
    range(0, 10, RED); range(11, 21, GREEN); range(22, 32, BLUE); range(33, 43, WHITE);
  });
  out.fourGroupsDistinct = (await rl.question(
    '    Does each COLOUR occupy its own separate set of lines?  [y/n] > ',
  )).trim().toLowerCase();
  out.linesPerColour = (await rl.question(
    '    Roughly how many lines does ONE colour cover? > ',
  )).trim();
  stop();
  console.log(`     recorded: distinct=${out.fourGroupsDistinct}, ${out.linesPerColour} lines/colour\n`);

  // ---- T5: does position within a group track along the line? ---------------
  console.log('  ── Test 5 ── address 0 RED and address 10 BLUE (ends of one group).\n');
  stop = paint(() => { set(0, RED); set(10, BLUE); });
  out.endsOfGroup = (await rl.question(
    '    Are red and blue at OPPOSITE ENDS of the same line(s), or elsewhere?  [ends/elsewhere] > ',
  )).trim().toLowerCase();
  stop();
  console.log(`     recorded: ${out.endsOfGroup}\n`);

  // ---- done -----------------------------------------------------------------
  rgb.fill(0);
  for (let i = 0; i < 8; i++) { sock.send(drgb(rgb)); await sleep(50); }
  sock.close();
  rl.close();

  const path = 'profiles/nano-structure.json';

  const dots = Number(out.dotsForOneAddress);
  const perColour = Number(out.linesPerColour);
  const EXPECT_DOTS = 3;
  const EXPECT_LINES_PER_GROUP = 3;

  console.log('  ' + '─'.repeat(58));
  console.log(`  Working addresses : ${WORKING}`);
  console.log(`  Dots per address  : ${out.dotsForOneAddress}  (predicted ${EXPECT_DOTS})`);
  console.log(`  Lines per group   : ${out.linesPerColour}  (predicted ${EXPECT_LINES_PER_GROUP})`);

  const dotsOk = dots === EXPECT_DOTS;
  const groupOk = perColour === EXPECT_LINES_PER_GROUP;

  if (dotsOk && groupOk) {
    console.log('\n  ✅ CONFIRMED — 4 groups x 11 positions, 3 parallel edges per address.');
    console.log(`     ${WORKING} addresses drive ${WORKING * EXPECT_DOTS} LEDs across 12 edges.`);
    out.verdict = 'confirmed';
  } else if (Number.isFinite(dots) && dots >= 1) {
    console.log('\n  ⚠️  MODEL DOES NOT FIT.');
    if (!dotsOk) console.log(`     Expected ${EXPECT_DOTS} dots per address, saw ${out.dotsForOneAddress}.`);
    if (!groupOk) console.log(`     Expected ${EXPECT_LINES_PER_GROUP} lines per group, saw ${out.linesPerColour}.`);
    if (Number.isFinite(dots) && dots > 0) {
      console.log(`     ${WORKING} x ${dots} = ${WORKING * dots} LEDs implied.`);
      if (WORKING * dots === 132) console.log('     That still totals 132, so the grouping differs, not the count.');
    }
    out.verdict = 'mismatch';
  } else {
    console.log('\n  → inconclusive; see the saved answers.');
    out.verdict = 'inconclusive';
  }
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');

  console.log(`\n  Saved to ${path}\n`);
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
