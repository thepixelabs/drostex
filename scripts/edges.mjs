#!/usr/bin/env node
/**
 * Drostex — edge identification.
 *
 * We know the cube has 4 address blocks driving 1, 2, 4 and 5 edges. This pins
 * down WHICH edges, and which way round each one runs, producing the geometry
 * profile the 3D preview and the node graph need.
 *
 * Two questions per block:
 *   1. Light the whole block  -> which of the 12 edges are lit?
 *   2. Light only position 0  -> which corner is each dot nearest?
 *
 * Question 2 is what establishes direction. Address k of a block maps to
 * position k along every edge that block drives, so knowing where position 0
 * sits tells us which end each edge starts from.
 *
 *     node scripts/edges.mjs
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

// Measured in the previous session; the expected counts double as a sanity check.
const BLOCKS = [
  { id: 0, start: 0, end: 10, expect: 1 },
  { id: 1, start: 11, end: 21, expect: 2 },
  { id: 2, start: 22, end: 32, expect: 4 },
  { id: 3, start: 33, end: 43, expect: 5 },
];

const EDGES = [
  'T-front', 'T-right', 'T-back', 'T-left',
  'B-front', 'B-right', 'B-back', 'B-left',
  'V-front-left', 'V-front-right', 'V-back-right', 'V-back-left',
];

const CORNERS = [
  'T-front-left', 'T-front-right', 'T-back-right', 'T-back-left',
  'B-front-left', 'B-front-right', 'B-back-right', 'B-back-left',
];

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
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.connect(PORT, HOST, () => resolve(s));
  });
}

const drgb = (rgb) => {
  const b = Buffer.allocUnsafe(2 + rgb.length);
  b[0] = 2; b[1] = 2;
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

function menu(items) {
  const lines = [];
  for (let i = 0; i < items.length; i += 2) {
    const a = `${String(i + 1).padStart(2)}. ${items[i].padEnd(15)}`;
    const b = items[i + 1] ? `${String(i + 2).padStart(2)}. ${items[i + 1]}` : '';
    lines.push(`      ${a}${b}`);
  }
  return lines.join('\n');
}

/** Parses "1,3, 7" into names, ignoring anything out of range. */
function parsePicks(answer, items) {
  return [...new Set(
    answer.split(/[,\s]+/).map((x) => Number(x.trim()))
      .filter((x) => Number.isInteger(x) && x >= 1 && x <= items.length),
  )].map((x) => items[x - 1]);
}

async function main() {
  const info = await getInfo();
  const n = info.leds.count;

  console.log(`\n  ${info.brand} ${info.product} — edge identification\n`);
  console.log('  ── Orientation ──────────────────────────────────────────');
  console.log('  Stand the cube normally and put the CABLE / control box at');
  console.log('  the BACK. The face nearest you is FRONT. Keep it in that');
  console.log('  position for the whole session — every answer depends on it.\n');

  await prepare();
  const sock = await openSocket();
  const rl = readline.createInterface({ input, output });
  const rgb = Buffer.alloc(n * 3);

  await rl.question('  Press Enter when the cube is positioned. > ');

  const paint = (from, to) => {
    rgb.fill(0);
    for (let i = from; i <= to; i++) {
      rgb[i * 3] = 255; rgb[i * 3 + 1] = 160; rgb[i * 3 + 2] = 40;
    }
    return hold(sock, rgb);
  };

  const result = { product: info.product, blocks: [] };

  for (const blk of BLOCKS) {
    console.log(`\n  ═══ Block ${blk.id} — addresses ${blk.start}-${blk.end} ═══`);

    // --- which edges? -------------------------------------------------------
    let edges;
    for (;;) {
      const stop = paint(blk.start, blk.end);
      console.log('\n    The whole block is lit. Which edges?\n');
      console.log(menu(EDGES));
      const a = await rl.question(`\n    numbers, comma-separated  (expect ~${blk.expect}) > `);
      stop();
      if (a.trim().toLowerCase() === 'r') continue;
      edges = parsePicks(a, EDGES);
      if (edges.length === 0) { console.log('    (nothing recognised — try again)'); continue; }
      if (edges.length !== blk.expect) {
        console.log(`    ⚠️  you picked ${edges.length}, earlier measurement said ${blk.expect}.`);
        const ok = await rl.question('    keep your answer anyway? [y/n] > ');
        if (!ok.trim().toLowerCase().startsWith('y')) continue;
      }
      break;
    }
    console.log(`    ✓ ${edges.join(', ')}`);

    // --- which end is position 0? -------------------------------------------
    let corners;
    for (;;) {
      const stop = paint(blk.start, blk.start); // a single dot on each edge
      console.log('\n    Now only position 0 is lit — one dot per edge.');
      console.log('    Which corner is each dot nearest?\n');
      console.log(menu(CORNERS));
      const a = await rl.question(`\n    numbers, comma-separated  (expect ~${edges.length}) > `);
      stop();
      if (a.trim().toLowerCase() === 'r') continue;
      corners = parsePicks(a, CORNERS);
      if (corners.length === 0) { console.log('    (nothing recognised — try again)'); continue; }
      break;
    }
    console.log(`    ✓ starts at ${corners.join(', ')}`);

    result.blocks.push({
      block: blk.id,
      addresses: [blk.start, blk.end],
      edges,
      startCorners: corners,
    });
  }

  rgb.fill(0);
  for (let i = 0; i < 8; i++) { sock.send(drgb(rgb)); await sleep(50); }
  sock.close();
  rl.close();

  const path = 'profiles/nano-edges.json';
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');

  const all = result.blocks.flatMap((b) => b.edges);
  const dupes = all.filter((e, i) => all.indexOf(e) !== i);
  const missing = EDGES.filter((e) => !all.includes(e));

  console.log('\n  ' + '─'.repeat(58));
  for (const b of result.blocks) {
    console.log(`  block ${b.block}  ${String(b.addresses[0]).padStart(2)}-${String(b.addresses[1]).padStart(2)}  ${b.edges.join(', ')}`);
  }
  console.log(`\n  edges covered : ${all.length} of 12`);
  if (dupes.length) console.log(`  ⚠️  claimed twice : ${[...new Set(dupes)].join(', ')}`);
  if (missing.length) console.log(`  ⚠️  never lit     : ${missing.join(', ')}`);
  if (!dupes.length && !missing.length) console.log('  ✅ all 12 edges accounted for exactly once.');
  console.log(`\n  Saved to ${path}\n`);
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
