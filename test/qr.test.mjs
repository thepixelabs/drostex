import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode, toSVG, MAX_VERSION } from '../web/qr.mjs';

const at = (qr, x, y) => qr.modules[y * qr.size + x];

/**
 * A real reader, when one is installed. OpenCV ships a QR decoder, and the
 * machine this was written on has it; on one that does not, the round-trip
 * tests are skipped rather than failed, and the structural tests still run.
 */
const READER = spawnSync('python3', ['-c', 'import cv2, sys; sys.stdout.write(cv2.__version__)'], { encoding: 'utf8' });
const hasReader = READER.status === 0 && /^\d/.test(READER.stdout);

/** Renders to a PGM (no image library needed) and asks OpenCV what it says. */
function decodeWithReader(qr) {
  const scale = 8, margin = 4;
  const n = (qr.size + margin * 2) * scale;
  const px = Buffer.alloc(n * n, 255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!at(qr, x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = (y + margin) * scale + dy;
        px.fill(0, row * n + (x + margin) * scale, row * n + (x + margin + 1) * scale);
      }
    }
  }
  const file = join(mkdtempSync(join(tmpdir(), 'drostex-qr-')), 'qr.pgm');
  writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${n} ${n}\n255\n`), px]));
  const r = spawnSync('python3', ['-c', [
    'import cv2, sys',
    `img = cv2.imread(${JSON.stringify(file)}, cv2.IMREAD_GRAYSCALE)`,
    'text, pts, _ = cv2.QRCodeDetector().detectAndDecode(img)',
    'sys.stdout.write(text)',
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe('encode: structure', () => {
  const url = 'http://192.168.1.50:7847';
  const qr = encode(url);

  it('picks the smallest version that fits, and sizes the symbol from it', () => {
    assert.equal(qr.version, 2);                 // 26 bytes: version 1 holds 14, version 2 holds 26
    assert.equal(qr.size, 25);
    assert.equal(qr.modules.length, 25 * 25);
    assert.equal(encode('a').version, 1);
    assert.equal(encode('x'.repeat(42)).version, 3);
    assert.equal(encode('x'.repeat(43)).version, 4);
  });

  it('refuses text past version 10 rather than emitting something unreadable', () => {
    assert.equal(encode('x'.repeat(213)).version, MAX_VERSION);
    assert.throws(() => encode('x'.repeat(214)), RangeError);
  });

  it('draws the three finder patterns with light separators', () => {
    const finder = (cx, cy) => {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          assert.equal(at(qr, cx + dx, cy + dy), d === 2 ? 0 : 1, `finder at ${cx},${cy} offset ${dx},${dy}`);
        }
      }
    };
    finder(3, 3);
    finder(qr.size - 4, 3);
    finder(3, qr.size - 4);
    assert.equal(at(qr, 7, 7), 0);               // separator corner
    assert.equal(at(qr, 8, qr.size - 8), 1);     // the always-dark module
  });

  it('draws alternating timing patterns between the finders', () => {
    for (let i = 8; i < qr.size - 8; i++) {
      assert.equal(at(qr, i, 6), i % 2 === 0 ? 1 : 0, `row timing at ${i}`);
      assert.equal(at(qr, 6, i), i % 2 === 0 ? 1 : 0, `column timing at ${i}`);
    }
  });

  it('writes format information that decodes back to level M and the chosen mask', () => {
    // Read the first copy of the 15 bits back off the matrix and undo the BCH mask.
    const bits = [];
    for (let i = 0; i <= 5; i++) bits[i] = at(qr, 8, i);
    bits[6] = at(qr, 8, 7); bits[7] = at(qr, 8, 8); bits[8] = at(qr, 7, 8);
    for (let i = 9; i < 15; i++) bits[i] = at(qr, 14 - i, 8);
    let value = 0;
    bits.forEach((b, i) => { value |= b << i; });
    value ^= 0x5412;
    const data = value >>> 10;
    assert.equal(data >>> 3, 0, 'EC level bits for M are 00');
    assert.equal(data & 7, qr.mask);
    // The BCH remainder must check out.
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(value & 0x3ff, rem);
  });

  it('is deterministic, and honours an explicit mask', () => {
    assert.deepEqual(encode(url).modules, qr.modules);
    for (let m = 0; m < 8; m++) assert.equal(encode(url, { mask: m }).mask, m);
    assert.ok(qr.mask >= 0 && qr.mask <= 7);
  });
});

describe('toSVG', () => {
  it('draws one rect per dark module inside a quiet zone, in viewBox units', () => {
    const qr = encode('hi');
    const svg = toSVG(qr, { margin: 4 });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
    const dark = qr.modules.reduce((a, b) => a + b, 0);
    assert.equal((svg.match(/h1v1h-1z/g) ?? []).length, dark);
    assert.match(svg, /fill="#fff"/);
    assert.match(svg, /crispEdges/);
  });
});

describe('a real reader decodes it', { skip: hasReader ? false : 'python3 with OpenCV not installed' }, () => {
  const cases = [
    ['a LAN URL, version 2', 'http://192.168.1.50:7847'],
    ['a hostname URL with a path, version 4', 'http://my-macbook-pro.local:7847/#looks'],
    ['every mask on the same text', null],
    ['version 7, which carries version information', 'https://drostex.pixelabs.net/?' + 'k=v&'.repeat(28)],
    ['version 10, the largest supported', 'x'.repeat(200) + 'END'],
    ['non-ASCII text, as UTF-8 bytes', 'קובייה ✓ cube'],
  ];
  for (const [label, text] of cases) {
    if (text === null) {
      it(label, () => {
        for (let m = 0; m < 8; m++) {
          const qr = encode('http://10.0.0.7:7847', { mask: m });
          assert.equal(decodeWithReader(qr), 'http://10.0.0.7:7847', `mask ${m}`);
        }
      });
      continue;
    }
    it(label, () => {
      const qr = encode(text);
      assert.equal(decodeWithReader(qr), text);
    });
  }
});
