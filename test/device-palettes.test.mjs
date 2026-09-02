import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_PALETTES, paletteStops } from '../src/device-palettes.mjs';

describe('paletteStops', () => {
  it('returns null for the two deliberately-null entries', () => {
    assert.equal(paletteStops('Default'), null);
    assert.equal(paletteStops('Custom'), null);
  });

  it('returns null for a label the device might report that we do not know', () => {
    assert.equal(paletteStops('Some Future Palette'), null);
    assert.equal(paletteStops(''), null);
    assert.equal(paletteStops(undefined), null);
  });

  it('every non-null entry is a non-empty list of valid #rrggbb strings', () => {
    for (const [label, stops] of Object.entries(DEVICE_PALETTES)) {
      if (stops === null) continue;
      const result = paletteStops(label);
      assert.ok(Array.isArray(result), `${label}: expected an array of stops`);
      assert.ok(result.length > 0, `${label}: expected at least one stop`);
      for (const stop of result) {
        assert.match(stop, /^#[0-9a-f]{6}$/i, `${label}: "${stop}" is not a valid #rrggbb string`);
      }
    }
  });

  it('round-trips exactly the array stored in DEVICE_PALETTES, not a copy with different values', () => {
    assert.deepEqual(paletteStops('Lava'), DEVICE_PALETTES.Lava);
    assert.deepEqual(paletteStops('Ocean'), DEVICE_PALETTES.Ocean);
  });
});
