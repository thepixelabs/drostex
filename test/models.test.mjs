import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_KEYS, resolveModel, applyModel } from '../src/models.mjs';

describe('MODELS', () => {
  it('lists every model with the vendor figures and an internally consistent LED count', () => {
    for (const key of MODEL_KEYS) {
      const m = MODELS[key];
      assert.equal(m.key, key);
      assert.equal(m.edges * m.perEdge, m.leds, `${key}: edges × perEdge must equal leds`);
      assert.match(m.spec, /^https:\/\/hyperspacelight\.com\//);
      assert.ok(['measured', 'spec-sheet'].includes(m.status));
    }
  });

  it('only a measured model carries addressing facts, and they add up', () => {
    for (const m of Object.values(MODELS)) {
      if (m.status === 'measured') {
        assert.ok(m.reported > 0 && m.working > 0 && Array.isArray(m.blocks));
        assert.equal(m.blocks.reduce((a, b) => a + b, 0), m.edges);
        assert.equal(m.blocks.length * m.perEdge, m.working);
      } else {
        assert.equal(m.reported, null);
        assert.equal(m.working, null);
        assert.equal(m.blocks, null);
      }
    }
  });

  it('the Nano is the measured one: 44 of 88 addresses, blocks of 1, 2, 4 and 5 edges', () => {
    assert.deepEqual(
      [MODELS.nano.reported, MODELS.nano.working, MODELS.nano.perEdge, [...MODELS.nano.blocks]],
      [88, 44, 11, [1, 2, 4, 5]],
    );
  });
});

describe('resolveModel', () => {
  it('an explicit key wins, case-insensitively, and "auto" defers to the device', () => {
    assert.equal(resolveModel({ key: 'hc15-se' }), MODELS['hc15-se']);
    assert.equal(resolveModel({ key: 'HC10-SE' }), MODELS['hc10-se']);
    assert.equal(resolveModel({ key: 'auto', info: { leds: { count: 88 } } }), MODELS.nano);
  });

  it('an unknown key resolves to nothing rather than to a guess', () => {
    assert.equal(resolveModel({ key: 'hypercube-9000' }), null);
    assert.equal(resolveModel({ key: 'hypercube-9000', info: { leds: { count: 88 } } }), null);
  });

  it('matches the Nano by the address count its controller reports', () => {
    assert.equal(resolveModel({ info: { leds: { count: 88 } } }), MODELS.nano);
  });

  it('matches a spec-sheet model by its LED count as an unverified hypothesis', () => {
    assert.equal(resolveModel({ info: { leds: { count: 216 } } }), MODELS['hc10-se']);
    assert.equal(resolveModel({ info: { leds: { count: 336 } } }), MODELS['hc15-se']);
  });

  it('falls back to the product or device name', () => {
    assert.equal(resolveModel({ info: { product: 'HyperCube Nano', leds: { count: 7 } } }), MODELS.nano);
    assert.equal(resolveModel({ info: { name: 'HyperCube15-SE' } }), MODELS['hc15-se']);
    assert.equal(resolveModel({ info: { product: 'hypercube 10' } }), MODELS['hc10-se']);
  });

  it('returns null for a device it cannot name', () => {
    assert.equal(resolveModel({ info: { product: 'WLED', leds: { count: 300 } } }), null);
    assert.equal(resolveModel({}), null);
    assert.equal(resolveModel({ info: null }), null);
  });
});

describe('applyModel', () => {
  const base = { host: '10.0.0.2', ledsOverride: {} };

  it('a measured model supplies every number', () => {
    const c = applyModel(base, { model: MODELS.nano });
    assert.equal(c.model, 'nano');
    assert.deepEqual([c.ledCount, c.working, c.perEdge, c.blocks], [88, 44, 11, MODELS.nano.blocks]);
    assert.deepEqual(c.notes, []);
  });

  it('explicit leds.* overrides beat the model table', () => {
    const c = applyModel({ ...base, ledsOverride: { count: 90, working: 40, perEdge: 10 } }, { model: MODELS.nano });
    assert.deepEqual([c.ledCount, c.working, c.perEdge], [90, 40, 10]);
  });

  it('a spec-sheet model takes the address count from the device and assumes every address is real', () => {
    const c = applyModel(base, { model: MODELS['hc10-se'], info: { leds: { count: 216 } } });
    assert.deepEqual([c.ledCount, c.working, c.perEdge, c.blocks], [216, 216, 18, null]);
    assert.equal(c.modelStatus, 'spec-sheet');
    assert.equal(c.notes.length, 1);
    assert.match(c.notes[0], /spec sheet/);
    assert.match(c.notes[0], /diagnose/);
  });

  it('a spec-sheet model with no device answer falls back to the vendor LED count', () => {
    const c = applyModel(base, { model: MODELS['hc15-se'] });
    assert.deepEqual([c.ledCount, c.working, c.perEdge], [336, 336, 28]);
  });

  it('a measured working count silences the spec-sheet warning', () => {
    const c = applyModel({ ...base, ledsOverride: { working: 100 } }, { model: MODELS['hc10-se'], info: { leds: { count: 216 } } });
    assert.equal(c.working, 100);
    assert.deepEqual(c.notes, []);
  });

  it('an unknown device gets the controller count, an assumed perEdge, and says so', () => {
    const c = applyModel(base, { info: { leds: { count: 300 } } });
    assert.deepEqual([c.model, c.ledCount, c.working, c.perEdge], [null, 300, 300, 11]);
    assert.ok(c.notes.some((n) => /perEdge/.test(n)));
    assert.ok(c.notes.some((n) => /device\.model/.test(n)));
  });

  it('with nothing known at all, the numbers are still numbers', () => {
    const c = applyModel(base, {});
    assert.ok(c.ledCount > 0 && c.working > 0 && c.perEdge > 0);
  });
});
