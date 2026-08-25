/**
 * Animation library.
 *
 * Every animation is a pure function of (ctx) -> [r, g, b] in 0..1, and declares
 * the parameters it exposes. The UI builds its controls from those declarations,
 * so adding a knob is a one-line change here and needs no UI work at all.
 *
 * That declaration format is deliberately the shape the node graph will compile
 * to: a node with typed inputs and one colour output. These are the reference
 * implementations the compiler gets tested against.
 *
 * Coordinates, and why there are two flavours:
 *
 *   u   i / (N-1)     0..1 inclusive. Endpoint-exact, NOT seamless.
 *   uw  i / N         0..1 exclusive. Wraps.
 *   e   (i % 11) / 11 position along one edge, wrapping.
 *
 * The strip is a CLOSED LOOP whose ends meet at the corner the cube stands on,
 * and its per-edge runs meet at every other corner. Using the inclusive form for
 * a hue ramp puts a visible colour break at those joins - which is exactly the
 * bug that was reported at the mounting corner.
 */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const fract = (x) => x - Math.floor(x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** '#rrggbb' -> [r, g, b] in 0..1. */
export function hexRGB(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

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

/** Inigo Quilez cosine palette. Inherently cyclic, so it never seams. */
export function iq(t, a, b, c, d) {
  return [0, 1, 2].map((k) => clamp01(a[k] + b[k] * Math.cos(6.28318 * (c[k] * t + d[k]))));
}

/** Named cosine-palette presets. Four vec3s cover an enormous range. */
export const PALETTES = {
  spectrum: [[.5, .5, .5], [.5, .5, .5], [1, 1, 1], [0, .33, .67]],
  sunset:   [[.5, .5, .5], [.5, .5, .5], [1, 1, 1], [0, .1, .2]],
  ocean:    [[.2, .4, .5], [.3, .4, .5], [1, 1, .8], [0, .25, .25]],
  ember:    [[.5, .3, .2], [.5, .3, .2], [1, 1, .8], [0, .1, .2]],
  neon:     [[.5, .5, .5], [.5, .5, .5], [2, 1, 0], [.5, .2, .25]],
  ultra:    [[.6, .4, .6], [.4, .3, .4], [1, 1, 1], [0, .1, .5]],
  mono:     [[.5, .5, .5], [.5, .5, .5], [1, 1, 1], [0, 0, 0]],
};
export const PALETTE_NAMES = Object.keys(PALETTES);

export function palette(name, t) {
  const p = PALETTES[name] ?? PALETTES.spectrum;
  return iq(t, ...p);
}

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

/** Shortest cyclic distance on a 0..1 ring. */
export function ringDist(a, b) {
  const d = Math.abs(a - b);
  return d > 0.5 ? 1 - d : d;
}

/** Parameter shorthands, so declarations stay readable. */
const num = (label, def, min, max, step = 0.01, hint) =>
  ({ type: 'number', label, default: def, min, max, step, hint });
const col = (label, def, hint) => ({ type: 'color', label, default: def, hint });
const pal = (label, def = 'spectrum') =>
  ({ type: 'select', label, default: def, options: PALETTE_NAMES });
const bool = (label, def = false, hint) => ({ type: 'boolean', label, default: def, hint });
const pick = (label, def, options, hint) => ({ type: 'select', label, default: def, options, hint });

export const ANIMATIONS = {
  rainbow: {
    label: 'Rainbow',
    desc: 'a hue cycle travelling around the loop',
    params: {
      cycles: num('Cycles', 1, 1, 4, 1, 'whole turns of hue around the strip — fractions would seam'),
      saturation: num('Saturation', 0.95, 0, 1),
      drift: num('Drift', 0.15, -1, 1, 0.01, 'how fast the whole pattern rotates'),
    },
    fn: ({ uw, t, speed, p }) => hsv(uw * p.cycles + t * p.drift * speed, p.saturation, 1),
  },

  edgebow: {
    label: 'Edge Bow',
    desc: 'a hue cycle along every edge at once, synchronised',
    params: {
      cycles: num('Cycles per edge', 1, 1, 3, 1),
      saturation: num('Saturation', 0.95, 0, 1),
      drift: num('Drift', 0.2, -1, 1),
    },
    fn: ({ e, t, speed, p }) => hsv(e * p.cycles + t * p.drift * speed, p.saturation, 1),
  },

  comet: {
    label: 'Comet',
    desc: 'a bright head with an exponential tail, orbiting the cube',
    params: {
      tail: num('Tail length', 22, 4, 60, 1, 'lower is longer'),
      glow: num('Glow', 0.6, 0, 1, 0.01, 'soft halo around the head'),
      hue: num('Hue', 0.55, 0, 1),
      hueShift: num('Hue shift', 0.4, 0, 1, 0.01, 'colour change as it orbits'),
      count: num('Comets', 1, 1, 4, 1),
    },
    fn: ({ uw, t, speed, p }) => {
      let out = [0, 0, 0];
      for (let k = 0; k < p.count; k++) {
        const head = fract(t * 0.25 * speed + k / p.count);
        const d = ringDist(uw, head);
        const v = Math.exp(-d * p.tail) + p.glow * Math.exp(-d * p.tail * 0.27);
        const c = hsv(p.hue + head * p.hueShift, 0.7, 1);
        out = out.map((x, j) => Math.max(x, c[j] * clamp01(v)));
      }
      return out;
    },
  },

  breathe: {
    label: 'Breathe',
    desc: 'the whole cube swelling and fading',
    params: {
      colorA: col('Colour', '#7C5CFC'),
      colorB: col('Fade toward', '#FF2D55'),
      floor: num('Dimmest', 0.18, 0, 1),
      shape: num('Sharpness', 2.2, 1, 6, 0.1),
      blend: num('Colour blend', 0.5, 0, 1, 0.01, 'how far it drifts toward the second colour'),
    },
    fn: ({ t, speed, p }) => {
      const v = p.floor + (1 - p.floor) * Math.pow(0.5 + 0.5 * Math.sin(t * 0.7 * speed), p.shape);
      const a = hexRGB(p.colorA), b = hexRGB(p.colorB);
      const mix = p.blend * (0.5 + 0.5 * Math.sin(t * 0.21 * speed));
      return a.map((x, k) => (x + (b[k] - x) * mix) * v);
    },
  },

  pulse: {
    label: 'Pulse',
    desc: 'rings running outward along every edge together',
    params: {
      paletteName: pal('Palette'),
      width: num('Falloff', 3, 1, 8, 0.1),
      rate: num('Rate', 0.4, -2, 2),
      spread: num('Colour spread', 0.3, 0, 2),
    },
    fn: ({ e, uw, t, speed, p }) => {
      const phase = fract(e - t * p.rate * speed);
      const v = Math.pow(1 - phase, p.width);
      return palette(p.paletteName, uw * p.spread + t * 0.05).map((x) => x * v);
    },
  },

  fire: {
    label: 'Fire',
    desc: 'warm turbulent flicker',
    // Deliberately linear noise rather than sampled around a ring: turbulence
    // hides the loop seam completely, and a circular sample would impose a
    // symmetry that changes the character to fix something invisible.
    params: {
      scale: num('Scale', 4, 1, 12, 0.1, 'higher is more detail'),
      rate: num('Flicker rate', 1.6, 0.1, 5),
      heat: num('Heat', 1.6, 0.5, 3),
      cool: num('Blue tip', 6, 2, 12, 0.1, 'higher is less blue at the peaks'),
    },
    fn: ({ u, t, speed, p }) => {
      const n = fbm(u * p.scale + t * p.rate * speed, 3);
      const heat = clamp01(Math.pow(n, 1.5) * p.heat);
      return [
        clamp01(heat * 1.6),
        clamp01(Math.pow(heat, 2.2) * 1.1),
        clamp01(Math.pow(heat, p.cool) * 0.7),
      ];
    },
  },

  plasma: {
    label: 'Plasma',
    desc: 'layered sines — suits a mirrored object',
    params: {
      paletteName: pal('Palette'),
      scaleA: num('Strip waves', 1, 1, 6, 1),
      scaleB: num('Edge waves', 1.5, 0.5, 6, 0.5),
      contrast: num('Contrast', 0.16, 0.02, 0.5),
    },
    fn: ({ uw, e, t, speed, p }) => {
      const a = uw * 6.28318;
      const v =
        Math.sin(a * p.scaleA + t * 1.1 * speed) +
        Math.sin(e * 6.28318 * p.scaleB - t * 0.8 * speed) +
        Math.sin(a * 2 + e * 3 + t * 0.5 * speed);
      return palette(p.paletteName, v * p.contrast + t * 0.03);
    },
  },

  sparkle: {
    label: 'Sparkle',
    desc: 'twinkles over a deep base — quiet, good left running',
    params: {
      base: col('Base', '#0a1030'),
      spark: col('Spark', '#ffffff'),
      density: num('Density', 24, 4, 60, 1, 'higher is rarer'),
      rate: num('Rate', 0.9, 0.1, 4),
    },
    fn: ({ i, t, speed, p }) => {
      const base = hexRGB(p.base), spark = hexRGB(p.spark);
      const ph = hash(i * 7.3);
      const s = Math.pow(clamp01(Math.sin((t * p.rate * speed + ph * 10) % 6.283)), p.density);
      return base.map((x, k) => clamp01(x + s * spark[k]));
    },
  },

  scan: {
    label: 'Scan',
    desc: 'a hard bar sweeping the strip — shows the wiring order',
    params: {
      color: col('Colour', '#ff5900'),
      width: num('Width', 0.06, 0.01, 0.4),
      rate: num('Rate', 0.18, -1, 1),
      bounce: bool('Ping-pong', false, 'sweep back and forth instead of looping'),
    },
    fn: ({ uw, t, speed, p }) => {
      let pos = fract(t * p.rate * speed);
      if (p.bounce) pos = Math.abs(pos * 2 - 1);
      const v = 1 - smoothstep(0, p.width, ringDist(uw, pos));
      return hexRGB(p.color).map((x) => x * v);
    },
  },

  aurora: {
    label: 'Aurora',
    desc: 'slow drifting curtains',
    params: {
      colorA: col('Curtain', '#33ff88'),
      colorB: col('Veil', '#8844ff'),
      scale: num('Scale', 2.2, 0.5, 6, 0.1),
      rate: num('Drift', 0.25, 0.01, 1.5),
      contrast: num('Contrast', 2, 1, 5, 0.1),
    },
    fn: ({ u, t, speed, p }) => {
      const a = fbm(u * p.scale + t * p.rate * speed, 3);
      const b = fbm(u * (p.scale * 0.64) - t * (p.rate * 0.68) * speed + 31.7, 3);
      const ga = Math.pow(clamp01(a * 1.5), p.contrast);
      const gb = Math.pow(clamp01(b * 1.4), p.contrast + 1);
      const A = hexRGB(p.colorA), B = hexRGB(p.colorB);
      return [0, 1, 2].map((k) => clamp01(A[k] * ga + B[k] * gb));
    },
  },

  custom: {
    label: 'Custom',
    desc: 'build your own — pick a wave, a space and colours',
    // The closest thing to the node editor that fits in one screen: a small
    // signal chain (space -> wave -> colour) with every stage exposed. Most
    // looks people want are reachable from here, and a saved preset is a
    // complete description of one.
    params: {
      space: pick('Space', 'strip', ['strip', 'edge', 'index'],
        'strip = around the whole loop · edge = repeats on every edge · index = per LED'),
      wave: pick('Wave', 'sine', ['sine', 'saw', 'triangle', 'square', 'noise', 'flat']),
      cycles: num('Cycles', 1, 1, 8, 1),
      rate: num('Rate', 0.3, -2, 2),
      colorMode: pick('Colour', 'palette', ['palette', 'two-tone', 'hue']),
      paletteName: pal('Palette'),
      colorA: col('Colour A', '#00c2ff'),
      colorB: col('Colour B', '#ff2d55'),
      hue: num('Hue', 0.6, 0, 1),
      contrast: num('Contrast', 1, 0.2, 4, 0.05),
      floor: num('Floor', 0, 0, 1, 0.01, 'lifts the dark end so nothing goes fully black'),
      audioBand: pick('Audio drives', 'none', ['none', 'level', 'bass', 'mid', 'treble']),
      audioAmount: num('Audio depth', 0.7, 0, 1, 0.01, 'how much the sound moves it'),
    },
    fn: ({ uw, e, i, n, t, speed, p, audio }) => {
      const x = p.space === 'edge' ? e : p.space === 'index' ? hash(i * 3.7) : uw;
      const phase = fract(x * p.cycles + t * p.rate * speed);

      let w;
      switch (p.wave) {
        case 'saw': w = phase; break;
        case 'triangle': w = 1 - Math.abs(phase * 2 - 1); break;
        case 'square': w = phase < 0.5 ? 1 : 0; break;
        case 'noise': w = fbm(x * p.cycles * 3 + t * p.rate * speed, 3); break;
        case 'flat': w = 1; break;
        default: w = 0.5 + 0.5 * Math.sin(phase * 6.28318);
      }
      w = clamp01(Math.pow(clamp01(w), p.contrast));
      if (p.audioBand !== 'none') {
        const a = clamp01(audio[p.audioBand] ?? 0);
        w *= 1 - p.audioAmount + p.audioAmount * a;
      }
      w = p.floor + (1 - p.floor) * w;

      if (p.colorMode === 'two-tone') {
        const A = hexRGB(p.colorA), B = hexRGB(p.colorB);
        return A.map((c, k) => clamp01(c + (B[k] - c) * w));
      }
      if (p.colorMode === 'hue') {
        return hsv(p.hue + t * 0.05 * speed, 0.95, w);
      }
      return palette(p.paletteName, w + t * 0.05 * speed).map((c) => c * (p.floor + (1 - p.floor) * w));
    },
  },
};

/** Default values for one animation's parameters. */
export function defaultParams(name) {
  const schema = ANIMATIONS[name]?.params ?? {};
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.default]));
}

/**
 * Index-space symmetry.
 *
 * The firmware has its own symmetry modes, but they operate on its effect
 * renderer and do not visibly reach streamed pixels. These are ours, applied to
 * the sampling index before the animation is evaluated.
 *
 * Every mode is expressible without knowing where any LED physically sits,
 * which matters because that mapping resisted measurement. They work in strip
 * space and edge space, which is all we reliably know.
 */
export const SYMMETRIES = {
  none: (i) => i,
  reverse: (i, n) => n - 1 - i,
  // Fold the loop in half: the second half mirrors the first.
  mirror: (i, n) => (i < n / 2 ? i : n - 1 - i),
  // Repeat the first half / quarter around the loop.
  cyclic2: (i, n) => i % Math.max(1, Math.round(n / 2)),
  cyclic4: (i, n) => i % Math.max(1, Math.round(n / 4)),
  // Mirror within every edge run, so all edges read symmetrically.
  edgeMirror: (i, n, perEdge) => {
    const base = i - (i % perEdge);
    const pos = i % perEdge;
    const half = Math.floor(perEdge / 2);
    return base + (pos <= half ? pos : perEdge - 1 - pos);
  },
};
export const SYMMETRY_NAMES = Object.keys(SYMMETRIES);

/** Per-address context. `perEdge` makes `e` wrap at every corner. */
export function makeContext(i, n, perEdge, t, speed, p, audio) {
  return {
    i, n, t, speed, p,
    u: n > 1 ? i / (n - 1) : 0,
    uw: i / n,
    e: (i % perEdge) / perEdge,
    // Zeroed when no audio is arriving, so animations can read it freely.
    audio: audio ?? { level: 0, bass: 0, mid: 0, treble: 0 },
  };
}
