import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01, fract, lerp, smoothstep, hexRGB, hsv, iq,
  ANIMATIONS, defaultParams, SYMMETRIES, SYMMETRY_NAMES, makeContext, resolveSchema,
} from '../src/animations.mjs';

// Real cube geometry (see scripts/lib/config.mjs defaults), used throughout so
// the sweeps below exercise the shape the animations actually run against.
const N = 44;
const PER_EDGE = 11;

describe('clamp01', () => {
  it('passes values already inside 0..1 through unchanged', () => {
    assert.equal(clamp01(0), 0);
    assert.equal(clamp01(1), 1);
    assert.equal(clamp01(0.5), 0.5);
  });

  it('clamps below 0 and above 1', () => {
    assert.equal(clamp01(-3), 0);
    assert.equal(clamp01(3), 1);
  });
});

describe('fract', () => {
  it('returns the fractional part of a positive number', () => {
    assert.equal(fract(1.75), 0.75);
    assert.equal(fract(3), 0);
  });

  it('wraps negative numbers up into 0..1, matching GLSL fract', () => {
    assert.equal(fract(-0.25), 0.75);
    assert.equal(fract(-3), 0);
  });
});

describe('lerp', () => {
  it('interpolates between a and b at t', () => {
    assert.equal(lerp(0, 10, 0.5), 5);
    assert.equal(lerp(2, 4, 0), 2);
    assert.equal(lerp(2, 4, 1), 4);
  });

  it('extrapolates outside 0..1 rather than clamping', () => {
    assert.equal(lerp(0, 10, 1.5), 15);
    assert.equal(lerp(0, 10, -0.5), -5);
  });
});

describe('smoothstep', () => {
  it('clamps below e0 to 0 and above e1 to 1', () => {
    assert.equal(smoothstep(0, 1, -1), 0);
    assert.equal(smoothstep(0, 1, 2), 1);
  });

  it('is exactly 0 and 1 at the edges and 0.5 at the midpoint', () => {
    assert.equal(smoothstep(0, 1, 0), 0);
    assert.equal(smoothstep(0, 1, 1), 1);
    assert.equal(smoothstep(0, 1, 0.5), 0.5);
  });
});

describe('hexRGB', () => {
  it('parses a 6-digit hex colour to 0..1 RGB', () => {
    assert.deepEqual(hexRGB('#ff0000'), [1, 0, 0]);
    assert.deepEqual(hexRGB('#00ff00'), [0, 1, 0]);
    assert.deepEqual(hexRGB('#0000ff'), [0, 0, 1]);
  });

  it('expands a 3-digit hex colour', () => {
    assert.deepEqual(hexRGB('#f00'), [1, 0, 0]);
    assert.deepEqual(hexRGB('#0f0'), [0, 1, 0]);
    assert.deepEqual(hexRGB('#00f'), [0, 0, 1]);
  });

  it('does not require the leading #', () => {
    assert.deepEqual(hexRGB('ff0000'), [1, 0, 0]);
  });

  it('falls back to white for unparsable input', () => {
    assert.deepEqual(hexRGB('#zzzzzz'), [1, 1, 1]);
    assert.deepEqual(hexRGB('#zzz'), [1, 1, 1]);
    assert.deepEqual(hexRGB('nonsense'), [1, 1, 1]);
    assert.deepEqual(hexRGB(''), [1, 1, 1]);
  });
});

describe('hsv', () => {
  it('rounds the six 60-degree sectors at full saturation and value', () => {
    assert.deepEqual(hsv(0 / 6, 1, 1), [1, 0, 0]); // red
    assert.deepEqual(hsv(1 / 6, 1, 1), [1, 1, 0]); // yellow
    assert.deepEqual(hsv(2 / 6, 1, 1), [0, 1, 0]); // green
    assert.deepEqual(hsv(3 / 6, 1, 1), [0, 1, 1]); // cyan
    assert.deepEqual(hsv(4 / 6, 1, 1), [0, 0, 1]); // blue
    assert.deepEqual(hsv(5 / 6, 1, 1), [1, 0, 1]); // magenta
  });

  it('wraps hue at 1 back to the same colour as 0', () => {
    assert.deepEqual(hsv(1, 1, 1), hsv(0, 1, 1));
  });

  it('wraps negative hue into range via fract', () => {
    assert.deepEqual(hsv(-1 / 6, 1, 1), hsv(5 / 6, 1, 1));
  });

  it('produces grey, independent of hue, at zero saturation', () => {
    assert.deepEqual(hsv(0.37, 0, 0.6), [0.6, 0.6, 0.6]);
    assert.deepEqual(hsv(0.9, 0, 0.6), [0.6, 0.6, 0.6]);
  });
});

describe('iq (cosine palette)', () => {
  it('matches a hand-computed cosine at known phase points', () => {
    const mono = [[.5, .5, .5], [.5, .5, .5], [1, 1, 1], [0, 0, 0]];
    const white = iq(0, ...mono);
    for (const c of white) assert.ok(Math.abs(c - 1) < 1e-9);

    const black = iq(0.5, ...mono);
    for (const c of black) assert.ok(Math.abs(c) < 1e-9);
  });

  it('clamps each channel to 0..1 even when a+b would overshoot', () => {
    const overshoot = iq(0, [1, 1, 1], [1, 1, 1], [0, 0, 0], [0, 0, 0]);
    assert.deepEqual(overshoot, [1, 1, 1]);
  });
});

describe('ANIMATIONS registry contract', () => {
  // A sweep of indices (including the wrap boundary and every edge-boundary
  // crossing) and times (zero, sub-frame, mid-range, and "the process has
  // been running a while") that every animation must survive.
  const indices = [0, 1, 2, 5, 10, 11, 21, 22, 32, 33, 42, 43];
  const times = [0, 0.001, 0.25, 1, 2.5, 10, 37.91, 123.456, 9999.5];

  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    it(`${name}: fn(ctx) returns 3 finite numbers in 0..1 across a sweep of indices and times`, () => {
      const p = defaultParams(name);
      for (const t of times) {
        for (const i of indices) {
          const ctx = makeContext(i, N, PER_EDGE, t, 1, p);
          const out = anim.fn(ctx);
          assert.equal(out.length, 3, `${name} at i=${i}, t=${t}: expected [r,g,b], got length ${out.length}`);
          out.forEach((v, k) => {
            assert.equal(typeof v, 'number', `${name} channel ${k} at i=${i}, t=${t} is not a number (${v})`);
            assert.ok(Number.isFinite(v), `${name} channel ${k} at i=${i}, t=${t} is not finite (${v})`);
            assert.ok(v >= 0 && v <= 1, `${name} channel ${k} at i=${i}, t=${t} out of 0..1: ${v}`);
          });
        }
      }
    });
  }
});

describe('ANIMATIONS param schemas', () => {
  const VALID_TYPES = ['number', 'boolean', 'select', 'color'];

  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    it(`${name}: every declared param is well-formed`, () => {
      // A max of 'working' is resolved against the cube; check the resolved shape.
      for (const [key, def] of Object.entries(resolveSchema(anim.params, { working: N }))) {
        assert.ok(VALID_TYPES.includes(def.type), `${name}.${key} has an unrecognised type: ${def.type}`);

        if (def.type === 'number') {
          assert.equal(typeof def.min, 'number', `${name}.${key} missing numeric min`);
          assert.equal(typeof def.max, 'number', `${name}.${key} missing numeric max`);
          assert.ok(def.min < def.max, `${name}.${key} min (${def.min}) is not less than max (${def.max})`);
          assert.ok(
            def.default >= def.min && def.default <= def.max,
            `${name}.${key} default (${def.default}) is outside [${def.min}, ${def.max}]`,
          );
        } else if (def.type === 'select') {
          assert.ok(Array.isArray(def.options) && def.options.length > 0, `${name}.${key} has no options`);
          assert.ok(
            def.options.includes(def.default),
            `${name}.${key} default (${def.default}) is not among its own options [${def.options}]`,
          );
        } else if (def.type === 'boolean') {
          assert.equal(typeof def.default, 'boolean', `${name}.${key} boolean default is not a boolean`);
        } else if (def.type === 'color') {
          assert.match(
            def.default, /^#[0-9a-fA-F]{6}$/,
            `${name}.${key} colour default (${def.default}) is not a valid #rrggbb string`,
          );
        }
      }
    });

    it(`${name}: defaultParams() returns exactly the declared keys, all in range`, () => {
      const schema = resolveSchema(anim.params, { working: N });
      const d = defaultParams(name);

      assert.deepEqual(Object.keys(d).sort(), Object.keys(schema).sort());

      for (const [key, def] of Object.entries(schema)) {
        if (def.type === 'number') {
          assert.ok(d[key] >= def.min && d[key] <= def.max, `${name}.${key} default value out of range`);
        } else if (def.type === 'select') {
          assert.ok(def.options.includes(d[key]), `${name}.${key} default value not in its options`);
        } else if (def.type === 'boolean') {
          assert.equal(typeof d[key], 'boolean');
        }
      }
    });
  }

  it('defaultParams() of an unknown animation returns an empty object rather than throwing', () => {
    assert.deepEqual(defaultParams('not-a-real-animation'), {});
  });
});

describe('SYMMETRIES', () => {
  it('SYMMETRY_NAMES matches the registry keys', () => {
    assert.deepEqual(SYMMETRY_NAMES, Object.keys(SYMMETRIES));
  });

  it('none is the identity for every index', () => {
    for (let i = 0; i < N; i++) assert.equal(SYMMETRIES.none(i, N, PER_EDGE), i);
  });

  for (const [name, fold] of Object.entries(SYMMETRIES)) {
    it(`${name}: maps every index in [0, ${N}) back into [0, ${N})`, () => {
      for (let i = 0; i < N; i++) {
        const j = fold(i, N, PER_EDGE);
        assert.ok(Number.isInteger(j), `${name}(${i}) produced a non-integer index: ${j}`);
        assert.ok(j >= 0 && j < N, `${name}(${i}) = ${j} is outside [0, ${N})`);
      }
    });
  }
});

describe('seam invariant: the strip is a closed loop', () => {
  // These animations' colour is driven by the WRAPPING coordinate `uw` (i/N)
  // in a way that is architecturally periodic across the join:
  //   - rainbow: hue is `uw * cycles`, and `cycles` is schema-constrained to a
  //     whole number ("fractions would seam" per its own hint), so hsv's
  //     internal fract() sees an exact-integer wrap.
  //   - comet: position is compared with `ringDist`, which is periodic by
  //     construction (shortest distance on a 0..1 ring).
  //   - plasma: the strip-wide term is `sin(uw*2*PI*scaleA + ...)`, and
  //     scaleA is schema-constrained to whole numbers, so sin() also sees an
  //     exact-integer-multiple-of-2*PI wrap.
  //   - snake (default path: 'loop'): position is `fract(head - uw)`.
  //   - custom (default space: 'strip'): position is `uw`, cycles is a whole
  //     number for the same reason as rainbow.
  //
  // Deliberately excluded:
  //   - fire, aurora: sample the INCLUSIVE `u` (i/(N-1)), not `uw`. fire says
  //     so explicitly and leans on turbulence to hide the resulting seam;
  //     aurora has no such disclaimer (see the test-report bug note).
  //   - scan: an intentionally hard, non-wrapping bar.
  //   - edgebow, sparkle, breathe: driven by `e`, `i`, or nothing at all, not
  //     by a strip-wide wrapping coordinate.
  //   - pulse, and plasma's own edge term: driven primarily by the per-edge
  //     coordinate `e`; their residual `uw` use is not cycle-quantised so
  //     they do not claim to close the strip-wide loop.
  const SEAMLESS = ['rainbow', 'comet', 'plasma', 'snake', 'custom'];
  const times = [0, 0.37, 1.9, 12.345, 88.1];

  for (const name of SEAMLESS) {
    it(`${name}: colour is continuous where the strip's two ends meet (uw treated as periodic)`, () => {
      const anim = ANIMATIONS[name];
      const p = defaultParams(name);

      for (const t of times) {
        // ctx0 is the real first sample: uw = 0/N = 0. ctxWrap is the context
        // one address PAST the last would carry if the strip had one more
        // LED before closing the loop back onto address 0: uw = N/N = 1, and
        // every other field is identical, since N is an exact multiple of
        // PER_EDGE so `e` wraps back to 0 at the very same point. Comparing
        // the two isolates exactly the question the header raises: does this
        // animation treat `uw` as periodic with period 1, so index N-1 and
        // index 0 read as neighbours instead of a visible break?
        const ctx0 = makeContext(0, N, PER_EDGE, t, 1, p);
        const ctxWrap = { ...ctx0, uw: 1 };
        const c0 = anim.fn(ctx0);
        const cWrap = anim.fn(ctxWrap);

        for (let k = 0; k < 3; k++) {
          assert.ok(
            Math.abs(c0[k] - cWrap[k]) < 1e-4,
            `${name} channel ${k} breaks across the seam at t=${t}: uw=0 -> ${c0[k]}, uw=1 -> ${cWrap[k]}`,
          );
        }
      }
    });
  }
});

describe('resolveSchema', () => {
  const schema = {
    tail: { type: 'number', label: 'Tail', default: 12, min: 1, max: 'working', step: 1 },
    hue: { type: 'number', label: 'Hue', default: 0.5, min: 0, max: 1, step: 0.01 },
  };

  it("replaces a max of 'working' with the cube's address count and leaves the rest alone", () => {
    const r = resolveSchema(schema, { working: 216 });
    assert.equal(r.tail.max, 216);
    assert.equal(r.tail.default, 12);
    assert.deepEqual(r.hue, schema.hue);
  });

  it('pulls the default down on a cube smaller than it', () => {
    const r = resolveSchema(schema, { working: 8 });
    assert.equal(r.tail.max, 8);
    assert.equal(r.tail.default, 8);
  });

  it('never produces a max below min, and tolerates an empty schema', () => {
    assert.equal(resolveSchema(schema, { working: 0 }).tail.max, 1);
    assert.deepEqual(resolveSchema(undefined, { working: 44 }), {});
  });

  it("comet's tail is the parameter that needs it", () => {
    assert.equal(ANIMATIONS.comet.params.tail.max, 'working');
    assert.equal(resolveSchema(ANIMATIONS.comet.params, { working: 44 }).tail.max, 44);
  });
});
