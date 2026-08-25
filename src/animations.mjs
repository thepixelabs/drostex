/**
 * Animation library.
 *
 * Every animation is a pure function of (ctx) -> [r, g, b] in 0..1. That is
 * deliberately the same shape the node graph will compile to, so these are the
 * reference implementations the compiler gets tested against.
 *
 * Coordinates, and why there are two flavours of each:
 *
 *   u   i / (N-1)     0..1 inclusive. Endpoint-exact, but NOT seamless: the
 *                     first and last address get different values.
 *   uw  i / N         0..1 exclusive. Wraps cleanly.
 *   e   (i % 11) / 11 position along one edge, wrapping.
 *
 * The wrapping variants matter because the strip is a CLOSED LOOP - its start
 * and end meet at the corner the cube stands on, and the per-edge runs meet at
 * every other corner. Using the inclusive form for a hue ramp puts a visible
 * colour discontinuity at those joins. Anything cyclic should use uw / e.
 */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const fract = (x) => x - Math.floor(x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** HSV, all components 0..1, hue wraps. */
export function hsv(h, s, v) {
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

/** Inigo Quilez cosine palette: a + b*cos(2pi*(c*t + d)). Inherently cyclic. */
export function iq(t, a, b, c, d) {
  return [0, 1, 2].map((k) => clamp01(a[k] + b[k] * Math.cos(6.28318 * (c[k] * t + d[k]))));
}

/** Deterministic hash -> 0..1. Stable per index so LEDs keep their identity. */
export const hash = (x) => fract(Math.sin(x * 127.1) * 43758.5453);

export function noise(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
}

export function fbm(x, octaves = 3) {
  let v = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < octaves; o++) {
    v += amp * noise(x * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return v;
}

/** Shortest cyclic distance between two points on a 0..1 ring. */
export function ringDist(a, b) {
  let d = Math.abs(a - b);
  return d > 0.5 ? 1 - d : d;
}

export const ANIMATIONS = {
  rainbow: {
    label: 'Rainbow',
    desc: 'a full hue cycle travelling around the loop',
    // uw, and a whole cycle: address 0 and address N-1 are neighbours at the
    // corner the cube stands on, so anything short of a full turn shows a seam.
    fn: ({ uw, t, speed }) => hsv(uw + t * 0.15 * speed, 0.95, 1),
  },

  edgebow: {
    label: 'Edge Bow',
    desc: 'a hue cycle along every edge at once, synchronised',
    fn: ({ e, t, speed }) => hsv(e + t * 0.2 * speed, 0.95, 1),
  },

  comet: {
    label: 'Comet',
    desc: 'a bright head with an exponential tail, orbiting the cube',
    fn: ({ uw, t, speed }) => {
      const head = fract(t * 0.25 * speed);
      const d = ringDist(uw, head);
      const v = Math.exp(-d * 22) + 0.6 * Math.exp(-d * 6);
      return hsv(0.55 + head * 0.4, 0.7, 1).map((x) => x * clamp01(v));
    },
  },

  breathe: {
    label: 'Breathe',
    desc: 'the whole cube swelling and fading, hue drifting slowly',
    fn: ({ t, speed }) => {
      const v = 0.18 + 0.82 * Math.pow(0.5 + 0.5 * Math.sin(t * 0.7 * speed), 2.2);
      return hsv(t * 0.035, 0.85, v);
    },
  },

  pulse: {
    label: 'Pulse',
    desc: 'rings running outward along every edge together',
    fn: ({ e, uw, t, speed }) => {
      const phase = fract(e - t * 0.4 * speed);
      const v = Math.pow(1 - phase, 3);
      return iq(uw * 0.3 + t * 0.05,
        [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0.0, 0.33, 0.67],
      ).map((x) => x * v);
    },
  },

  fire: {
    label: 'Fire',
    desc: 'warm turbulent flicker',
    // Deliberately sampled linearly, not around a ring. There is technically a
    // seam where the strip closes, but turbulent noise hides it completely and
    // the linear walk reads better than the symmetry a circular sample imposes.
    fn: ({ u, t, speed }) => {
      const n = fbm(u * 4 + t * 1.6 * speed, 3);
      const heat = clamp01(Math.pow(n, 1.5) * 1.6);
      return [
        clamp01(heat * 1.6),
        clamp01(Math.pow(heat, 2.2) * 1.1),
        clamp01(Math.pow(heat, 6) * 0.7),
      ];
    },
  },

  plasma: {
    label: 'Plasma',
    desc: 'layered sines - suits a mirrored object',
    fn: ({ uw, e, t, speed }) => {
      const a = uw * 6.28318;
      const v =
        Math.sin(a + t * 1.1 * speed) +
        Math.sin(e * 6.28318 * 1.5 - t * 0.8 * speed) +
        Math.sin(a * 2 + e * 3 + t * 0.5 * speed);
      return iq(v * 0.16 + t * 0.03,
        [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0.0, 0.1, 0.2],
      );
    },
  },

  sparkle: {
    label: 'Sparkle',
    desc: 'twinkles over a deep base - quiet, good left running',
    fn: ({ i, t, speed }) => {
      const base = hsv(0.62 + 0.05 * Math.sin(t * 0.2), 0.9, 0.1);
      const ph = hash(i * 7.3);
      const s = Math.pow(clamp01(Math.sin((t * 0.9 * speed + ph * 10) % 6.283)), 24);
      return base.map((x, k) => clamp01(x + s * [1, 0.95, 0.8][k]));
    },
  },

  scan: {
    label: 'Scan',
    desc: 'a hard bar sweeping the strip - shows the wiring order',
    fn: ({ uw, t, speed }) => {
      const p = fract(t * 0.18 * speed);
      const v = 1 - smoothstep(0, 0.06, ringDist(uw, p));
      return [v, v * 0.35, 0];
    },
  },

  aurora: {
    label: 'Aurora',
    desc: 'slow drifting curtains of green and violet',
    // Same reasoning as fire: linear noise, seam hidden by the texture.
    fn: ({ u, t, speed }) => {
      const a = fbm(u * 2.2 + t * 0.25 * speed, 3);
      const b = fbm(u * 1.4 - t * 0.17 * speed + 31.7, 3);
      const g = Math.pow(clamp01(a * 1.5), 2);
      const v = Math.pow(clamp01(b * 1.4), 3);
      return [clamp01(v * 0.55), clamp01(g * 0.95), clamp01(g * 0.35 + v * 0.8)];
    },
  },
};

/** Builds the per-address context. `perEdge` makes `e` wrap at every corner. */
export function makeContext(i, n, perEdge, t, speed) {
  return {
    i, n, t, speed,
    u: n > 1 ? i / (n - 1) : 0,
    uw: i / n,
    e: (i % perEdge) / perEdge,
  };
}
