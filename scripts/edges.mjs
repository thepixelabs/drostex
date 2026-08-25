#!/usr/bin/env node
/**
 * Drostex — edge identification, for a cube standing on a corner.
 *
 * The cube sits on its stand balanced on a vertex, not flat on a face. That
 * changes the natural description completely: there is no top face or bottom
 * face, and no "vertical" edges. Standing on a point, the 12 edges fall into
 * three groups:
 *
 *              o  top point
 *             /|\
 *            / | \
 *           o  |  o        TOP    - 3 edges meeting at the top point
 *           |\ | /|
 *           | \|/ |        MIDDLE - 6 edges zigzagging around the middle
 *           |  o  |
 *           | /|\ |
 *           o  |  o        BOTTOM - 3 edges meeting at the bottom point
 *            \ | /
 *             \|/
 *              o  bottom point, on the stand
 *
 * Counting within a group is far more reliable than naming an individual edge,
 * so that is all this asks for. It also happens to be the information the
 * geometry model actually needs: with the cube on a corner, the useful axis is
 * the corner-to-corner diagonal, and which group an edge belongs to is what
 * places it along that axis.
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

// Measured previously; the expected totals double as a sanity check.
const BLOCKS = [
  { id: 0, start: 0, end: 10, expect: 1 },
  { id: 1, start: 11, end: 21, expect: 2 },
  { id: 2, start: 22, end: 32, expect: 4 },
  { id: 3, start: 33, end: 43, expect: 5 },
];

const GROUPS = [
  { key: 'bottom', max: 3, label: 'BOTTOM — meeting at the point on the stand' },
  { key: 'middle', max: 6, label: 'MIDDLE — the zigzag ring around the widest part' },
  { key: 'top', max: 3, label: 'TOP    — meeting at the point facing up' },
];

const DIAGRAM = `
              o   top point
             /|\\
            / | \\
           o  |  o     TOP    (3 edges)
           |\\ | /|
           | \\|/ |     MIDDLE (6 edges)
           |  o  |
           | /|\\ |
           o  |  o     BOTTOM (3 edges)
            \\ | /
             \\|/
              o   on the stand
`;

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

async function main() {
  const info = await getInfo();
  const n = info.leds.count;

  console.log(`\n  ${info.brand} ${info.product} — edge identification`);
  console.log(DIAGRAM);
  console.log('  Leave the cube on its stand. Every question is a COUNT within');
  console.log('  one of those three groups — you never have to name an edge.');
  console.log('  Press Enter to accept 0. Type "r" to re-show the pattern.\n');

  await prepare();
  const sock = await openSocket();
  const rl = readline.createInterface({ input, output });
  const rgb = Buffer.alloc(n * 3);

  await rl.question('  Press Enter to begin. > ');

  const paint = (from, to) => {
    rgb.fill(0);
    for (let i = from; i <= to; i++) {
      rgb[i * 3] = 255; rgb[i * 3 + 1] = 160; rgb[i * 3 + 2] = 40;
    }
    return hold(sock, rgb);
  };

  const askCount = async (label, max) => {
    for (;;) {
      const a = (await rl.question(`      ${label}  [0-${max}] > `)).trim().toLowerCase();
      if (a === 'r') return 'r';
      if (a === '') return 0;
      const v = Number(a);
      if (Number.isInteger(v) && v >= 0 && v <= max) return v;
      console.log(`      (needs a number 0-${max})`);
    }
  };

  const result = { product: info.product, orientation: 'corner-standing', blocks: [] };

  for (const blk of BLOCKS) {
    console.log(`\n  ═══ Block ${blk.id} — addresses ${blk.start}-${blk.end} ═══`);

    // --- how many edges in each group? --------------------------------------
    let counts;
    for (;;) {
      const stop = paint(blk.start, blk.end);
      console.log(`\n    The whole block is lit. How many lit edges in each group?`);
      console.log(`    (earlier measurement suggests ${blk.expect} in total)\n`);
      counts = {};
      let redo = false;
      for (const g of GROUPS) {
        const v = await askCount(g.label, g.max);
        if (v === 'r') { redo = true; break; }
        counts[g.key] = v;
      }
      stop();
      if (redo) continue;

      const total = counts.bottom + counts.middle + counts.top;
      if (total === 0) { console.log('    (nothing counted — try again)'); continue; }
      if (total !== blk.expect) {
        console.log(`    ⚠️  that is ${total} edges; the earlier measurement said ${blk.expect}.`);
        const ok = await rl.question('    trust what you can see? [y/n] > ');
        if (!ok.trim().toLowerCase().startsWith('y')) continue;
      }
      break;
    }
    const total = counts.bottom + counts.middle + counts.top;
    console.log(`    ✓ ${total} edges — bottom ${counts.bottom}, middle ${counts.middle}, top ${counts.top}`);

    // --- which end does the block start from? -------------------------------
    let origin;
    for (;;) {
      const stop = paint(blk.start, blk.start); // one dot per edge
      console.log('\n    Now only position 0 is lit — one dot on each of those edges.');
      const a = (await rl.question(
        '      Are those dots nearer the BOTTOM point, the TOP point, or the MIDDLE?\n' +
        '      [bottom / top / middle / mixed] > ',
      )).trim().toLowerCase();
      stop();
      if (a === 'r') continue;
      if (['bottom', 'top', 'middle', 'mixed'].includes(a)) { origin = a; break; }
      console.log('      (bottom, top, middle or mixed)');
    }
    console.log(`    ✓ position 0 sits toward the ${origin}`);

    result.blocks.push({
      block: blk.id,
      addresses: [blk.start, blk.end],
      edges: counts,
      edgeTotal: total,
      startsToward: origin,
    });
  }

  rgb.fill(0);
  for (let i = 0; i < 8; i++) { sock.send(drgb(rgb)); await sleep(50); }
  sock.close();
  rl.close();

  const path = 'profiles/nano-edges.json';
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');

  const sum = (k) => result.blocks.reduce((a, b) => a + b.edges[k], 0);
  const totals = { bottom: sum('bottom'), middle: sum('middle'), top: sum('top') };
  const grand = totals.bottom + totals.middle + totals.top;

  console.log('\n  ' + '─'.repeat(58));
  for (const b of result.blocks) {
    console.log(
      `  block ${b.block}  ${String(b.addresses[0]).padStart(2)}-${String(b.addresses[1]).padStart(2)}  ` +
      `${b.edgeTotal} edges  (b${b.edges.bottom} m${b.edges.middle} t${b.edges.top})  from ${b.startsToward}`,
    );
  }
  console.log(`\n  totals: bottom ${totals.bottom}/3, middle ${totals.middle}/6, top ${totals.top}/3  =  ${grand}/12`);
  if (totals.bottom === 3 && totals.middle === 6 && totals.top === 3) {
    console.log('  ✅ all 12 edges accounted for, and the groups balance.');
  } else {
    console.log('  ⚠️  groups do not balance — some edges counted twice or missed.');
  }
  console.log(`\n  Saved to ${path}\n`);
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
