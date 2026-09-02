import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/renderer.mjs';
import { ANIMATIONS, defaultParams } from '../src/animations.mjs';

// A plain config object — the same shape scripts/lib/config.mjs produces —
// with an example, non-personal LAN address per the test ground rules.
// Nothing in this file calls connect()/play()/prepareDevice()/restoreDevice(),
// so this host is never actually dialled.
function makeConfig(overrides = {}) {
  return {
    host: '192.168.1.50',
    port: 21324,
    ledCount: 88,
    working: 44,
    perEdge: 11,
    ...overrides,
  };
}

describe('Renderer construction', () => {
  it('seeds animParams for every registered animation from its own defaults', () => {
    const r = new Renderer(makeConfig());
    assert.deepEqual(Object.keys(r.animParams).sort(), Object.keys(ANIMATIONS).sort());
    for (const name of Object.keys(ANIMATIONS)) {
      assert.deepEqual(r.animParams[name], defaultParams(name));
    }
  });

  it('starts with no saved brightness and an untouched slider', () => {
    const r = new Renderer(makeConfig());
    assert.equal(r.savedBrightness, null);
    assert.equal(r.brightnessTouched, false);
    assert.equal(r.running, false);
    assert.equal(r.animation, null);
  });
});

describe('Renderer#setAnimParams', () => {
  it('clamps numeric values to the schema min/max', () => {
    const r = new Renderer(makeConfig());
    r.setAnimParams('rainbow', { cycles: 100 }); // schema max is 4
    assert.equal(r.animParams.rainbow.cycles, 4);
    r.setAnimParams('rainbow', { cycles: -100 }); // schema min is 1
    assert.equal(r.animParams.rainbow.cycles, 1);
  });

  it('coerces boolean params', () => {
    const r = new Renderer(makeConfig());
    r.setAnimParams('scan', { bounce: 1 });
    assert.equal(r.animParams.scan.bounce, true);
    r.setAnimParams('scan', { bounce: 0 });
    assert.equal(r.animParams.scan.bounce, false);
  });

  it('rejects a select value that is not in the declared options', () => {
    const r = new Renderer(makeConfig());
    const before = r.animParams.snake.path;
    r.setAnimParams('snake', { path: 'diagonal' }); // only 'loop' | 'edge' are valid
    assert.equal(r.animParams.snake.path, before);
  });

  it('accepts a valid select value', () => {
    const r = new Renderer(makeConfig());
    r.setAnimParams('snake', { path: 'edge' });
    assert.equal(r.animParams.snake.path, 'edge');
  });

  it('silently ignores keys the schema does not declare', () => {
    const r = new Renderer(makeConfig());
    const before = { ...r.animParams.rainbow };
    r.setAnimParams('rainbow', { notARealParam: 42 });
    assert.deepEqual(r.animParams.rainbow, before);
    assert.equal('notARealParam' in r.animParams.rainbow, false);
  });

  it('throws on an unknown animation name', () => {
    const r = new Renderer(makeConfig());
    assert.throws(() => r.setAnimParams('not-a-real-animation', {}), /unknown animation/);
  });

  it('keeps each animation\'s parameter values independent', () => {
    const r = new Renderer(makeConfig());
    r.setAnimParams('rainbow', { cycles: 3 });
    assert.equal(r.animParams.rainbow.cycles, 3);
    assert.equal(r.animParams.edgebow.cycles, defaultParams('edgebow').cycles);
  });

  it('returns the updated parameter object', () => {
    const r = new Renderer(makeConfig());
    const out = r.setAnimParams('rainbow', { cycles: 2 });
    assert.equal(out, r.animParams.rainbow);
    assert.equal(out.cycles, 2);
  });
});

describe('Renderer#resetAnimParams', () => {
  it('restores an animation\'s declared defaults after it was edited', () => {
    const r = new Renderer(makeConfig());
    r.setAnimParams('rainbow', { cycles: 4, saturation: 0.1 });
    r.resetAnimParams('rainbow');
    assert.deepEqual(r.animParams.rainbow, defaultParams('rainbow'));
  });
});

describe('Renderer#setParams', () => {
  it('clamps brightness to 0..1', () => {
    const r = new Renderer(makeConfig());
    r.setParams({ brightness: 5 });
    assert.equal(r.params.brightness, 1);
    r.setParams({ brightness: -5 });
    assert.equal(r.params.brightness, 0);
  });

  it('clamps fps to 1..60', () => {
    const r = new Renderer(makeConfig());
    r.setParams({ fps: 1000 });
    assert.equal(r.params.fps, 60);
    r.setParams({ fps: 0 });
    assert.equal(r.params.fps, 1);
  });

  it('ignores non-finite values, leaving the previous setting in place', () => {
    const r = new Renderer(makeConfig());
    r.setParams({ brightness: 0.4 });
    r.setParams({ brightness: NaN });
    assert.equal(r.params.brightness, 0.4);
    r.setParams({ fps: Infinity });
    assert.equal(r.params.fps, 40); // constructor default, untouched
  });

  it('accepts only a known symmetry name', () => {
    const r = new Renderer(makeConfig());
    r.setParams({ symmetry: 'mirror' });
    assert.equal(r.params.symmetry, 'mirror');
    r.setParams({ symmetry: 'not-a-real-symmetry' });
    assert.equal(r.params.symmetry, 'mirror'); // unchanged
  });

  it('clamps sparkle to 0..1', () => {
    const r = new Renderer(makeConfig());
    r.setParams({ sparkle: 5 });
    assert.equal(r.params.sparkle, 1);
    r.setParams({ sparkle: -5 });
    assert.equal(r.params.sparkle, 0);
  });

  it('sets brightnessTouched only when brightness is explicitly given', () => {
    const r = new Renderer(makeConfig());
    assert.equal(r.brightnessTouched, false);
    r.setParams({ speed: 2 });
    assert.equal(r.brightnessTouched, false);
    r.setParams({ brightness: 0.5 });
    assert.equal(r.brightnessTouched, true);
  });
});

describe('Renderer#captureBrightness', () => {
  it('records the first real value it is given', () => {
    const r = new Renderer(makeConfig());
    r.captureBrightness(128);
    assert.equal(r.savedBrightness, 128);
    assert.equal(r.params.brightness, 128 / 255);
  });

  it('refuses a second call once a value is already held', () => {
    const r = new Renderer(makeConfig());
    r.captureBrightness(128);
    r.captureBrightness(200);
    assert.equal(r.savedBrightness, 128);
    assert.equal(r.params.brightness, 128 / 255);
  });

  it('ignores non-number input', () => {
    const r = new Renderer(makeConfig());
    r.captureBrightness('200');
    assert.equal(r.savedBrightness, null);
    r.captureBrightness(undefined);
    assert.equal(r.savedBrightness, null);
    r.captureBrightness(null);
    assert.equal(r.savedBrightness, null);
    r.captureBrightness({ bri: 200 });
    assert.equal(r.savedBrightness, null);
  });

  it('refuses 255 outright, so a mid-stream kill cannot latch full brightness', () => {
    const r = new Renderer(makeConfig());
    r.captureBrightness(255);
    assert.equal(r.savedBrightness, null);
    assert.equal(r.params.brightness, 0.85); // constructor default, untouched

    const r2 = new Renderer(makeConfig());
    r2.captureBrightness(300); // also >= 255
    assert.equal(r2.savedBrightness, null);
  });

  it('still records a real value once 255 has already been refused', () => {
    const r = new Renderer(makeConfig());
    r.captureBrightness(255);
    r.captureBrightness(90);
    assert.equal(r.savedBrightness, 90);
  });

  it('does not overwrite a brightness the user already touched explicitly', () => {
    const r = new Renderer(makeConfig());
    r.setParams({ brightness: 1 }); // the user's genuine, explicit wish
    r.captureBrightness(50); // e.g. the device's own reading on startup
    assert.equal(r.savedBrightness, 50); // still recorded, for restoreDevice() later
    assert.equal(r.params.brightness, 1); // but the live slider is left alone
  });
});

describe('Renderer#pixels', () => {
  it('returns config.working RGB triplets read from the frame buffer', () => {
    const r = new Renderer(makeConfig({ working: 4, ledCount: 8 }));
    r.buf.fill(0);
    r.buf[0] = 10; r.buf[1] = 20; r.buf[2] = 30;
    r.buf[3] = 40; r.buf[4] = 50; r.buf[5] = 60;
    const px = r.pixels();
    assert.equal(px.length, 4);
    assert.deepEqual(px[0], [10, 20, 30]);
    assert.deepEqual(px[1], [40, 50, 60]);
    assert.deepEqual(px[2], [0, 0, 0]);
    assert.deepEqual(px[3], [0, 0, 0]);
  });
});

describe('Renderer#status', () => {
  it('reports the documented shape for a fresh, idle renderer', () => {
    const r = new Renderer(makeConfig());
    const s = r.status();
    assert.equal(s.running, false);
    assert.equal(s.animation, null);
    assert.equal(s.params, r.params);
    assert.equal(s.deviceBrightness, null);
    assert.equal(s.animParams, null); // no animation selected yet
    assert.equal(s.brightnessTouched, false);
    assert.equal(s.frames, 0);
    assert.equal(s.uptime, 0);
  });

  it('reports the running animation\'s own parameter values, without touching the network', () => {
    const r = new Renderer(makeConfig());
    // Simulate what play() would have set, without calling play() itself.
    r.running = true;
    r.animation = 'rainbow';
    r.startedAt = Date.now() - 1000;
    r.frames = 42;

    const s = r.status();
    assert.equal(s.running, true);
    assert.equal(s.animation, 'rainbow');
    assert.equal(s.animParams, r.animParams.rainbow);
    assert.equal(s.frames, 42);
    assert.ok(s.uptime >= 1, `expected uptime to reflect startedAt, got ${s.uptime}`);
  });
});
