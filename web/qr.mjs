/**
 * QR code encoder. Byte mode, error correction level M, versions 1 to 10.
 *
 * Exists because the app has zero runtime dependencies and one job that needs
 * a QR code: putting the server's LAN address in front of a phone camera. A
 * URL like http://192.168.1.50:7847 is 26 bytes, which is a version 2 symbol;
 * version 10 holds 213 bytes, far past any hostname anyone will type. Nothing
 * above that is implemented, and asking for it throws rather than silently
 * producing a symbol a phone cannot read.
 *
 * Pure: no DOM, no Node APIs, so it runs in the page and under node --test.
 * `encode` returns the module matrix; `toSVG` draws it. The algorithm follows
 * ISO/IEC 18004 step by step (data codewords, Reed-Solomon blocks,
 * interleave, placement, mask selection by penalty score, format and version
 * information) and is verified in test/qr.test.mjs by decoding the rendered
 * result with a real reader.
 */

/* ---------- constants ---------- */

/** Format-information bits for each error-correction level. */
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Level M block structure, versions 1 to 10.
 * [ec codewords per block, [[block count, data codewords per block], ...]]
 * Shorter blocks are listed first, which is the order the standard interleaves them in.
 */
const BLOCKS_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

export const MAX_VERSION = BLOCKS_M.length - 1;

/* ---------- GF(256) arithmetic for Reed-Solomon ---------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of the given degree, highest power first. */
function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Error-correction codewords for one block of data. */
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/* ---------- data codewords ---------- */

function dataCapacity(version) {
  const [, groups] = BLOCKS_M[version];
  return groups.reduce((sum, [count, len]) => sum + count * len, 0);
}

function pickVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const needed = 4 + countBits + 8 * byteLength;
    if (needed <= dataCapacity(v) * 8) return v;
  }
  throw new RangeError(`text is too long for a QR code up to version ${MAX_VERSION} (${byteLength} bytes)`);
}

class BitBuffer {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { out[i >>> 3] |= b << (7 - (i & 7)); });
    return out;
  }
}

function dataCodewords(bytes, version) {
  const capacity = dataCapacity(version) * 8;
  const bb = new BitBuffer();
  bb.push(0b0100, 4);                              // byte mode
  bb.push(bytes.length, version <= 9 ? 8 : 16);    // character count
  for (const b of bytes) bb.push(b, 8);
  bb.push(0, Math.min(4, capacity - bb.length));   // terminator
  if (bb.length % 8) bb.push(0, 8 - (bb.length % 8));
  for (let pad = 0xec; bb.length < capacity; pad ^= 0xec ^ 0x11) bb.push(pad, 8);
  return bb.toBytes();
}

/** Splits data into blocks, appends EC to each, and interleaves the lot. */
function interleave(data, version) {
  const [ecLen, groups] = BLOCKS_M[version];
  const blocks = [];
  let k = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(data.subarray(k, k + len));
      k += len;
    }
  }
  const ecs = blocks.map((b) => rsRemainder(b, ecLen));
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const e of ecs) out.push(e[i]);
  }
  return Uint8Array.from(out);
}

/* ---------- the matrix ---------- */

/** Centre coordinates of the alignment patterns for a version. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = 17 + 4 * version;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = 17 + 4 * version;
    this.modules = new Uint8Array(this.size * this.size);      // 1 = dark
    this.reserved = new Uint8Array(this.size * this.size);     // function patterns
  }

  get(x, y) { return this.modules[y * this.size + x]; }
  set(x, y, dark) { this.modules[y * this.size + x] = dark ? 1 : 0; }
  reserve(x, y, dark) {
    this.set(x, y, dark);
    this.reserved[y * this.size + x] = 1;
  }
  isReserved(x, y) { return this.reserved[y * this.size + x] === 1; }

  drawFunctionPatterns() {
    const n = this.size;
    // Timing patterns.
    for (let i = 0; i < n; i++) {
      this.reserve(6, i, i % 2 === 0);
      this.reserve(i, 6, i % 2 === 0);
    }
    // Finder patterns with their separators.
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);
    // Alignment patterns, skipping the three that would sit on a finder.
    const pos = alignmentPositions(this.version);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const onFinder = (i === 0 && j === 0)
          || (i === 0 && j === pos.length - 1)
          || (i === pos.length - 1 && j === 0);
        if (!onFinder) this.drawAlignment(pos[i], pos[j]);
      }
    }
    // Format and version areas are reserved now, written after masking.
    this.drawFormat(0);
    this.drawVersion();
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        this.reserve(x, y, d !== 2 && d !== 4);
      }
    }
  }

  drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.reserve(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** Format information: EC level and mask, BCH-protected, in both copies. */
  drawFormat(mask) {
    const data = (ECL_BITS.M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.reserve(8, i, bit(i));
    this.reserve(8, 7, bit(6));
    this.reserve(8, 8, bit(7));
    this.reserve(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.reserve(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.reserve(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.reserve(8, n - 15 + i, bit(i));
    this.reserve(8, n - 8, true);                 // the dark module
  }

  /** Version information, versions 7 and up: two 6×3 blocks, BCH-protected. */
  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    const n = this.size;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3), b = Math.floor(i / 3);
      this.reserve(a, b, dark);
      this.reserve(b, a, dark);
    }
  }

  /** Zigzag placement of the codewords, two columns at a time, right to left. */
  placeData(codewords) {
    const n = this.size;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                  // the timing column is skipped
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.isReserved(x, y) && i < total) {
            this.set(x, y, (codewords[i >>> 3] >>> (7 - (i & 7))) & 1);
            i++;
          }
        }
      }
    }
    // Any remainder bits stay light, which is what the standard specifies.
  }

  applyMask(mask) {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (this.isReserved(x, y)) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (invert) this.modules[y * n + x] ^= 1;
      }
    }
  }

  /** The standard's four penalty rules; lower is easier to scan. */
  penalty() {
    const n = this.size;
    let score = 0;
    // Rule 1: runs of five or more, and rule 3: finder-like runs, along rows and columns.
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < n; a++) {
        let run = 0, prev = -1;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < n; b++) {
          const dark = pass === 0 ? this.get(b, a) : this.get(a, b);
          if (dark === prev) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else {
            history.shift(); history.push(run);
            if (prev === 0 && this.finderLike(history)) score += 40;
            prev = dark;
            run = 1;
          }
        }
        history.shift(); history.push(run);
        if (prev === 0 && this.finderLike(history)) score += 40;
        // A finder-like run that ends at the edge also counts.
        history.shift(); history.push(0);
        if (prev === 1 && this.finderLike(history)) score += 40;
      }
    }
    // Rule 2: 2×2 blocks of one colour.
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = this.get(x, y);
        if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) score += 3;
      }
    }
    // Rule 4: dark proportion far from a half.
    let dark = 0;
    for (const m of this.modules) dark += m;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return score + k * 10;
  }

  /** 1:1:3:1:1 dark-light ratio with four light modules on either side. */
  finderLike(h) {
    const core = h[2];
    return core > 0
      && h[3] === core && h[4] === core * 3 && h[5] === core && h[6] === core
      && (h[1] >= core * 4 || h[0] >= core * 4);
  }
}

/* ---------- public API ---------- */

/**
 * Encodes `text` (UTF-8) at error correction level M.
 *
 * Returns `{ version, size, mask, modules }` where `modules` is a row-major
 * Uint8Array of size×size, 1 for dark. The mask is chosen by penalty score
 * unless `mask` is given (0 to 7), which the tests use.
 */
export function encode(text, { mask = null } = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  const codewords = interleave(dataCodewords(bytes, version), version);

  const m = new Matrix(version);
  m.drawFunctionPatterns();
  m.placeData(codewords);

  let chosen = mask;
  if (chosen === null) {
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      m.applyMask(i);
      m.drawFormat(i);
      const score = m.penalty();
      if (score < best) { best = score; chosen = i; }
      m.applyMask(i);                              // XOR twice restores the data
    }
  }
  m.applyMask(chosen);
  m.drawFormat(chosen);

  return { version, size: m.size, mask: chosen, modules: m.modules };
}

/**
 * Renders a code as an SVG string: one path, dark modules only, with the
 * quiet zone the standard asks for. Sized in viewBox units so CSS decides
 * how big it appears, and shape-rendering keeps the edges crisp when scaled.
 */
export function toSVG(qr, { margin = 4, dark = '#000', light = '#fff' } = {}) {
  const n = qr.size + margin * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img">`
    + `<rect width="${n}" height="${n}" fill="${light}"/>`
    + `<path d="${d}" fill="${dark}"/></svg>`;
}
