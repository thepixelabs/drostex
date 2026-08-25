#!/usr/bin/env node
/**
 * Drostex — animation player.
 *
 * Every animation is a pure function (i, t, ctx) -> [r, g, b] in 0..1, where
 * `i` is an address index. That is the same shape the node graph will compile
 * to, so these double as reference material for the compiler's node library.
 *
 * Indexed by ADDRESS, not by 3D position. Mapping addresses to edges proved
 * unreliable to measure on a mirrored cube, and it turns out not to matter:
 * the strip has real structure we can use without knowing where it sits in
 * space. Two coordinates carry most of it:
 *
 *   u = i / (N-1)        position along the whole strip, 0..1
 *   e = (i % 11) / 10    position along ONE edge, 0..1, repeating every edge
 *
 * Anything driven by `e` appears simultaneously on every edge, which on a
 * mirrored cube reads as coherent and deliberate. Anything driven by `u`
 * travels through the object. Most of the good-looking material is a blend.
 *
 *   node scripts/play.mjs --list
 *   node scripts/play.mjs rainbow
 *   node scripts/play.mjs comet --fps=40 --bri=0.7 --speed=1.5
 */

import dgram from 'node:dgram';
import { loadConfig } from './lib/config.mjs';

const CONFIG = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const flag = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : dflt;
};

const FPS = flag('fps', 40); // WLED's own guidance for WiFi is <= 40
const BRI = Math.min(1, Math.max(0, flag('bri', 0.85)));
const SPEED = flag('speed', 1);
const GAMMA = flag('gamma', 2.2);

// ---------------------------------------------------------------- colour utils

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const fract = (x) => x - Math.floor(x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** HSV with h wrapping, all components 0..1. */
function hsv(h, s, v) {
  h = fract(h) * 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/**
 * Inigo Quilez's cosine palette: a + b*cos(2pi*(c*t + d)).
 *
 * Four vec3s cover an enormous range of pleasant gradients, which is why this
 * is one node in the planned library rather than a dozen hand-tuned ramps.
 */
function iq(t, a, b, c, d) {
  return [0, 1, 2].map((k) => clamp01(a[k] + b[k] * Math.cos(6.28318 * (c[k] * t + d[k]))));
}

/** Cheap deterministic hash -> 0..1. Stable per index, so LEDs keep identities. */
const hash = (x) => fract(Math.sin(x * 127.1) * 43758.5453);

/** 1D value noise with smooth interpolation. */
function noise(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
}

/** Fractal noise — a few octaves reads far more organic than one. */
function fbm(x, octaves = 3) {
  let v = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < octaves; o++) {
    v += amp * noise(x * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return v;
}

// ---------------------------------------------------------------- animations

const ANIMATIONS = {
  rainbow: {
    desc: 'hue travelling along the strip',
    fn: (i, t, c) => hsv(c.u * 0.7 + t * 0.15, 0.95, 1),
  },

  edgebow: {
    desc: 'hue running along every edge at once — synchronised, not travelling',
    fn: (i, t, c) => hsv(c.e * 0.5 + t * 0.2, 0.95, 1),
  },

  comet: {
    desc: 'bright head with an exponential tail, looping through the strip',
    fn: (i, t, c) => {
      const head = fract(t * 0.25 * SPEED);
      let d = c.u - head;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      const v = Math.exp(-Math.abs(d) * 22) + 0.6 * Math.exp(-Math.abs(d) * 6);
      const col = hsv(0.55 + head * 0.4, 0.7, 1);
      return col.map((x) => x * clamp01(v));
    },
  },

  breathe: {
    desc: 'whole cube swelling and fading, hue drifting slowly',
    fn: (i, t) => {
      const v = 0.18 + 0.82 * Math.pow(0.5 + 0.5 * Math.sin(t * 0.7 * SPEED), 2.2);
      return hsv(t * 0.035, 0.85, v);
    },
  },

  pulse: {
    desc: 'rings expanding outward along each edge, then again from the start',
    fn: (i, t, c) => {
      const phase = fract(c.e - t * 0.4 * SPEED);
      const v = Math.pow(1 - phase, 3);
      return iq(c.u * 0.3 + t * 0.05,
        [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0.0, 0.33, 0.67],
      ).map((x) => x * v);
    },
  },

  fire: {
    desc: 'warm turbulent flicker',
    fn: (i, t, c) => {
      const n = fbm(c.u * 4 + t * 1.6 * SPEED, 3);
      const heat = clamp01(Math.pow(n, 1.5) * 1.6);
      const r = clamp01(heat * 1.6);
      const g = clamp01(Math.pow(heat, 2.2) * 1.1);
      const b = clamp01(Math.pow(heat, 6) * 0.7);
      return [r, g, b];
    },
  },

  plasma: {
    desc: 'layered sines — the classic, and it suits a mirrored object',
    fn: (i, t, c) => {
      const x = c.u * 6, e = c.e * 3;
      const v =
        Math.sin(x + t * 1.1 * SPEED) +
        Math.sin(e * 1.7 - t * 0.8 * SPEED) +
        Math.sin((x + e) * 0.9 + t * 0.5 * SPEED);
      return iq(v * 0.16 + t * 0.03,
        [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0.0, 0.1, 0.2],
      );
    },
  },

  sparkle: {
    desc: 'twinkles over a deep base — quiet, good for leaving running',
    fn: (i, t, c) => {
      const base = hsv(0.62 + 0.05 * Math.sin(t * 0.2), 0.9, 0.1);
      // Each index gets its own phase offset so they never blink in unison.
      const ph = hash(i * 7.3);
      const s = Math.pow(clamp01(Math.sin((t * 0.9 * SPEED + ph * 10) % 6.283)), 24);
      return base.map((x, k) => clamp01(x + s * [1, 0.95, 0.8][k]));
    },
  },

  scan: {
    desc: 'a hard bar sweeping the strip — the honest way to see the wiring order',
    fn: (i, t, c) => {
      const p = fract(t * 0.18 * SPEED);
      const w = 0.06;
      let d = Math.abs(c.u - p);
      if (d > 0.5) d = 1 - d;
      const v = 1 - smoothstep(0, w, d);
      return [v, v * 0.35, 0];
    },
  },

  aurora: {
    desc: 'slow drifting curtains of green and violet',
    fn: (i, t, c) => {
      const a = fbm(c.u * 2.2 + t * 0.25 * SPEED, 3);
      const b = fbm(c.u * 1.4 - t * 0.17 * SPEED + 31.7, 3);
      const g = Math.pow(clamp01(a * 1.5), 2);
      const v = Math.pow(clamp01(b * 1.4), 3);
      return [clamp01(v * 0.55), clamp01(g * 0.95), clamp01(g * 0.35 + v * 0.8)];
    },
  },
};

// ---------------------------------------------------------------- output

const drgb = (buf) => {
  const b = Buffer.allocUnsafe(2 + buf.length);
  b[0] = 2;
  b[1] = 2; // seconds before the cube reverts to its onboard effects
  buf.copy(b, 2);
  return b;
};

function openSocket() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.connect(CONFIG.port, CONFIG.host, () => resolve(s));
  });
}

async function prepare() {
  await fetch(`http://${CONFIG.host}/json/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // bri must be 255: realtime pixels are scaled by the global brightness, so
    // anything less silently dims every animation. Brightness is applied here
    // instead, where it can be gamma-correct.
    body: JSON.stringify({ on: true, bri: 255, lor: 0 }),
    signal: AbortSignal.timeout(4000),
  });
}

function list() {
  console.log('\n  Animations:\n');
  const w = Math.max(...Object.keys(ANIMATIONS).map((k) => k.length));
  for (const [name, a] of Object.entries(ANIMATIONS)) {
    console.log(`    ${name.padEnd(w)}   ${a.desc}`);
  }
  console.log('\n  node scripts/play.mjs <name> [--fps=40] [--bri=0.85] [--speed=1]\n');
}

async function main() {
  if (process.argv.includes('--list')) return list();

  const name = process.argv.slice(2).find((a) => !a.startsWith('--') && !/^\d/.test(a));
  const anim = ANIMATIONS[name];
  if (!anim) {
    if (name) console.error(`\n  ✗ unknown animation: ${name}`);
    list();
    process.exitCode = name ? 1 : 0;
    return;
  }

  const N = CONFIG.working;
  const PER = CONFIG.perEdge;
  const buf = Buffer.alloc(CONFIG.ledCount * 3); // addresses past `working` stay dark

  await prepare();
  const sock = await openSocket();

  console.log(`\n  ${name} — ${anim.desc}`);
  console.log(`  ${N} addresses @ ${FPS}fps, brightness ${BRI}, speed ${SPEED}`);
  console.log('  Ctrl-C to stop.\n');

  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(0);
    stopping = true;
    buf.fill(0);
    for (let i = 0; i < 8; i++) { sock.send(drgb(buf)); await sleep(40); }
    console.log('\n  Blanked.\n');
    process.exit(0);
  });

  const started = Date.now();
  const interval = 1000 / FPS;
  let next = Date.now();

  for (;;) {
    const t = (Date.now() - started) / 1000;
    for (let i = 0; i < N; i++) {
      const ctx = { u: N > 1 ? i / (N - 1) : 0, e: (i % PER) / (PER - 1), i, n: N };
      const rgb = anim.fn(i, t, ctx);
      for (let k = 0; k < 3; k++) {
        // Gamma last, after brightness, so dimming stays perceptually smooth.
        const v = clamp01(rgb[k]) * BRI;
        buf[i * 3 + k] = Math.round(255 * Math.pow(v, GAMMA));
      }
    }
    sock.send(drgb(buf));

    // Drift-corrected pacing: schedule from a fixed epoch rather than sleeping
    // a fixed amount, so timer jitter does not accumulate.
    next += interval;
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    else next = Date.now();
  }
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
