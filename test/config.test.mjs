import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHardware } from '../scripts/lib/config.mjs';

// A config as loadConfig() hands it over before the cube has been asked:
// no overrides, model left on auto.
const base = () => ({ host: '10.0.0.9', modelKey: 'auto', ledsOverride: {} });

describe('resolveHardware', () => {
  it('recognises the Nano from its report and applies the measured numbers', async () => {
    const c = await resolveHardware(base(), {
      fetchInfo: async () => ({ brand: 'Hyperspace', product: 'HyperCube Nano', leds: { count: 88 } }),
    });
    assert.equal(c.model, 'nano');
    assert.deepEqual([c.ledCount, c.working, c.perEdge], [88, 44, 11]);
    assert.deepEqual(c.notes, []);
  });

  it('recognises a bigger cube by product name, takes its address count from the cube, and says it is untested', async () => {
    const c = await resolveHardware(base(), {
      fetchInfo: async () => ({ brand: 'Hyperspace', product: 'HyperCube10-SE', leds: { count: 216 } }),
    });
    assert.equal(c.model, 'hc10-se');
    assert.equal(c.modelStatus, 'spec-sheet');
    assert.deepEqual([c.ledCount, c.working, c.perEdge, c.blocks], [216, 216, 18, null]);
    assert.ok(c.notes.some((n) => /spec sheet/.test(n)));
  });

  it('an explicit device.model beats whatever the cube says', async () => {
    const c = await resolveHardware({ ...base(), modelKey: 'hc15-se' }, {
      fetchInfo: async () => ({ product: 'HyperCube Nano', leds: { count: 88 } }),
    });
    assert.equal(c.model, 'hc15-se');
    assert.equal(c.perEdge, 28);
    // The address count is still what the cube reported: that is a fact, the model is a choice.
    assert.equal(c.ledCount, 88);
  });

  it('a cube that does not answer leaves the config as the table had it, plus a note', async () => {
    const c = await resolveHardware({ ...base(), modelKey: 'nano' }, {
      fetchInfo: async () => { throw new Error('timeout'); },
    });
    assert.deepEqual([c.model, c.ledCount, c.working, c.perEdge], ['nano', 88, 44, 11]);
    assert.ok(c.notes.some((n) => /did not answer/.test(n)));
  });

  it('measured overrides survive whatever the cube reports', async () => {
    const c = await resolveHardware({ ...base(), ledsOverride: { working: 100, perEdge: 18 } }, {
      fetchInfo: async () => ({ product: 'HyperCube10-SE', leds: { count: 216 } }),
    });
    assert.deepEqual([c.ledCount, c.working, c.perEdge], [216, 100, 18]);
    assert.deepEqual(c.notes, []);
  });
});
