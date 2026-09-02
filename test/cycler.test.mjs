import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cycler, POOLS } from '../src/cycler.mjs';

// A small, self-contained animation registry — deliberately not the real
// ANIMATIONS import, so these tests exercise the Cycler's own pool-building
// logic in isolation, the way its "fully injectable" constructor intends.
const FAKE_ANIMATIONS = {
  rainbow: { label: 'Rainbow' },
  comet: { label: 'Comet' },
};

function fakeRenderer() {
  const calls = [];
  return {
    calls,
    setAnimParams(name, values) { calls.push(['setAnimParams', name, values]); },
    setParams(values) { calls.push(['setParams', values]); },
    async play(name) { calls.push(['play', name]); },
    async stop(opts) { calls.push(['stop', opts]); },
  };
}

function fakeDevice() {
  const calls = [];
  const device = async (path, init) => {
    calls.push({ path, init });
    return {};
  };
  device.calls = calls;
  return device;
}

/** Builds a Cycler with sane empty-by-default fakes; pass overrides to fill in. */
function makeCycler(overrides = {}) {
  const renderer = overrides.renderer ?? fakeRenderer();
  const device = overrides.device ?? fakeDevice();
  const listPresets = overrides.listPresets ?? (async () => []);
  const listFavorites = overrides.listFavorites ?? (async () => ({ animation: [], effect: [] }));
  const listEffects = overrides.listEffects ?? (async () => []);
  const animations = overrides.animations ?? FAKE_ANIMATIONS;
  const cycler = new Cycler({ renderer, device, listPresets, listFavorites, listEffects, animations });
  return { cycler, renderer, device };
}

/**
 * Runs fn with Math.random replaced by a deterministic LCG, then restores it.
 * The cycler shuffles with Math.random directly, and the ground rules forbid
 * asserting on luck, so every shuffle test goes through this.
 */
function withSeededRandom(seed, fn) {
  const original = Math.random;
  let state = seed;
  Math.random = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

describe('Cycler#set', () => {
  it('clamps interval to 5..3600', async () => {
    const { cycler } = makeCycler();
    await cycler.set({ interval: 1 });
    assert.equal(cycler.interval, 5);
    await cycler.set({ interval: 999999 });
    assert.equal(cycler.interval, 3600);
  });

  it('rounds a fractional interval within range', async () => {
    const { cycler } = makeCycler();
    await cycler.set({ interval: 10.6 });
    assert.equal(cycler.interval, 11);
  });

  it('rejects an unknown pool, leaving the current one in place', async () => {
    const { cycler } = makeCycler();
    const before = cycler.pool;
    await cycler.set({ pool: 'not-a-real-pool' });
    assert.equal(cycler.pool, before);
  });

  it('accepts every declared pool name', async () => {
    const { cycler } = makeCycler();
    for (const pool of Object.keys(POOLS)) {
      await cycler.set({ pool });
      assert.equal(cycler.pool, pool);
    }
  });

  it('rejects an unknown order value, leaving the current one in place', async () => {
    const { cycler } = makeCycler();
    const before = cycler.order;
    await cycler.set({ order: 'random' });
    assert.equal(cycler.order, before);
  });

  it('accepts sequential and shuffle', async () => {
    const { cycler } = makeCycler();
    await cycler.set({ order: 'sequential' });
    assert.equal(cycler.order, 'sequential');
    await cycler.set({ order: 'shuffle' });
    assert.equal(cycler.order, 'shuffle');
  });

  it('resets the queue when a new pool is set', async () => {
    const { cycler } = makeCycler();
    cycler.queue = [{ kind: 'preset', id: 'p1', label: 'stale' }];
    await cycler.set({ pool: 'looks' });
    assert.deepEqual(cycler.queue, []);
  });

  it('resets the queue when the order is changed', async () => {
    const { cycler } = makeCycler();
    cycler.queue = [{ kind: 'preset', id: 'p1', label: 'stale' }];
    await cycler.set({ order: 'sequential' });
    assert.deepEqual(cycler.queue, []);
  });

  it('leaves interval, pool and order untouched when not given', async () => {
    const { cycler } = makeCycler();
    await cycler.set({ pool: 'looks', interval: 30, order: 'sequential' });
    await cycler.set({});
    assert.equal(cycler.pool, 'looks');
    assert.equal(cycler.interval, 30);
    assert.equal(cycler.order, 'sequential');
  });

  it('returns status()', async () => {
    const { cycler } = makeCycler();
    const out = await cycler.set({ interval: 20 });
    assert.deepEqual(out, cycler.status());
  });
});

describe('Cycler pool membership (via items())', () => {
  const presets = [
    { id: 'p1', name: 'Look One', favorite: false },
    { id: 'p2', name: 'Look Two (starred)', favorite: true },
  ];
  const effects = [
    { id: 10, label: 'Solid', sound: false, mode: false },
    { id: 11, label: 'Sonic Bloom', sound: true, mode: false },
    { id: 12, label: 'Mode: Party', sound: false, mode: true },
  ];

  it('looks: only saved presets', async () => {
    const { cycler } = makeCycler({ listPresets: async () => presets });
    await cycler.set({ pool: 'looks' });
    const items = await cycler.items();
    assert.deepEqual(items, [
      { kind: 'preset', id: 'p1', label: 'Look One' },
      { kind: 'preset', id: 'p2', label: 'Look Two (starred)' },
    ]);
  });

  it('patterns: only animations, one per registry entry', async () => {
    const { cycler } = makeCycler();
    await cycler.set({ pool: 'patterns' });
    const items = await cycler.items();
    assert.deepEqual(items, [
      { kind: 'animation', id: 'rainbow', label: 'Rainbow' },
      { kind: 'animation', id: 'comet', label: 'Comet' },
    ]);
  });

  it('effects: every non-mode effect, sound-reactive or not', async () => {
    const { cycler } = makeCycler({ listEffects: async () => effects });
    await cycler.set({ pool: 'effects' });
    const items = await cycler.items();
    assert.deepEqual(items, [
      { kind: 'effect', id: 10, label: 'Solid' },
      { kind: 'effect', id: 11, label: 'Sonic Bloom' },
    ]);
  });

  it('effects-sound: only sound-reactive, non-mode effects', async () => {
    const { cycler } = makeCycler({ listEffects: async () => effects });
    await cycler.set({ pool: 'effects-sound' });
    const items = await cycler.items();
    assert.deepEqual(items, [{ kind: 'effect', id: 11, label: 'Sonic Bloom' }]);
  });

  it('effects-static: only non-sound-reactive, non-mode effects', async () => {
    const { cycler } = makeCycler({ listEffects: async () => effects });
    await cycler.set({ pool: 'effects-static' });
    const items = await cycler.items();
    assert.deepEqual(items, [{ kind: 'effect', id: 10, label: 'Solid' }]);
  });

  it('all: presets, patterns and every non-mode effect combined', async () => {
    const { cycler } = makeCycler({ listPresets: async () => presets, listEffects: async () => effects });
    await cycler.set({ pool: 'all' });
    const items = await cycler.items();
    assert.deepEqual(items, [
      { kind: 'preset', id: 'p1', label: 'Look One' },
      { kind: 'preset', id: 'p2', label: 'Look Two (starred)' },
      { kind: 'animation', id: 'rainbow', label: 'Rainbow' },
      { kind: 'animation', id: 'comet', label: 'Comet' },
      { kind: 'effect', id: 10, label: 'Solid' },
      { kind: 'effect', id: 11, label: 'Sonic Bloom' },
    ]);
  });

  it('"Mode:" playlists are excluded from effects, effects-sound, effects-static and all', async () => {
    const { cycler } = makeCycler({ listPresets: async () => [], listEffects: async () => effects });
    for (const pool of ['effects', 'effects-sound', 'effects-static', 'all']) {
      await cycler.set({ pool });
      const items = await cycler.items();
      assert.ok(!items.some((i) => i.id === 12), `pool ${pool} leaked the Mode: entry`);
    }
  });

  describe('favorites', () => {
    it('includes starred presets, favourited patterns and favourited effects', async () => {
      const { cycler } = makeCycler({
        listPresets: async () => presets,
        listFavorites: async () => ({ animation: ['comet'], effect: [10] }),
        listEffects: async () => effects,
      });
      await cycler.set({ pool: 'favorites' });
      const items = await cycler.items();
      assert.deepEqual(items, [
        { kind: 'preset', id: 'p2', label: 'Look Two (starred)' },
        { kind: 'animation', id: 'comet', label: 'Comet' },
        { kind: 'effect', id: 10, label: 'Solid' },
      ]);
    });

    it('does not double-count a starred preset', async () => {
      const { cycler } = makeCycler({ listPresets: async () => presets });
      await cycler.set({ pool: 'favorites' });
      const items = await cycler.items();
      const p2Count = items.filter((i) => i.kind === 'preset' && i.id === 'p2').length;
      assert.equal(p2Count, 1);
    });

    it('excludes a favourited "Mode:" effect, same as every other effects pool', async () => {
      const { cycler } = makeCycler({
        listPresets: async () => [],
        listFavorites: async () => ({ animation: [], effect: [12] }),
        listEffects: async () => effects,
      });
      await cycler.set({ pool: 'favorites' });
      const items = await cycler.items();
      assert.deepEqual(items, []);
    });

    it('tolerates a deps object with no listFavorites at all', async () => {
      const renderer = fakeRenderer();
      const device = fakeDevice();
      const cycler = new Cycler({
        renderer, device,
        listPresets: async () => presets,
        listEffects: async () => effects,
        animations: FAKE_ANIMATIONS,
        // listFavorites intentionally omitted
      });
      await cycler.set({ pool: 'favorites' });
      const items = await cycler.items();
      assert.deepEqual(items, [{ kind: 'preset', id: 'p2', label: 'Look Two (starred)' }]);
    });
  });
});

describe('Cycler#advance', () => {
  it('does not throw on an empty pool, and leaves currentLabel null', async () => {
    const { cycler } = makeCycler();
    await cycler.set({ pool: 'looks' }); // no listPresets override -> empty
    await cycler.advance();
    assert.equal(cycler.currentLabel, null);
    // Stays well-behaved on a second call too.
    await cycler.advance();
    assert.equal(cycler.currentLabel, null);
  });

  it('sequential order visits every item once, in list order, before repeating', async () => {
    const presets = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
      { id: 'p3', name: 'Gamma' },
    ];
    const { cycler } = makeCycler({ listPresets: async () => presets });
    await cycler.set({ pool: 'looks', order: 'sequential' });

    const seen = [];
    for (let i = 0; i < 3; i++) {
      await cycler.advance();
      seen.push(cycler.currentLabel);
    }
    assert.deepEqual(seen, ['Alpha', 'Beta', 'Gamma']);

    // Fourth call exhausts the queue and refills, starting the pass over.
    await cycler.advance();
    assert.equal(cycler.currentLabel, 'Alpha');
  });

  it('shuffle order shows every item exactly once across a full pass before any repeat', async () => {
    const presets = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
      { id: 'p3', name: 'Gamma' },
      { id: 'p4', name: 'Delta' },
      { id: 'p5', name: 'Epsilon' },
    ];
    const { cycler } = makeCycler({ listPresets: async () => presets });
    await cycler.set({ pool: 'looks', order: 'shuffle' });

    await withSeededRandom(12345, async () => {
      const seen = [];
      for (let i = 0; i < presets.length; i++) {
        await cycler.advance();
        seen.push(cycler.currentLabel);
      }
      assert.deepEqual(
        new Set(seen),
        new Set(presets.map((p) => p.name)),
        'a full shuffled pass should show every item exactly once',
      );
      assert.equal(seen.length, presets.length);
      assert.equal(new Set(seen).size, presets.length, 'no item repeated within the pass');
    });
  });

  it('refills and reshuffles once a pass is exhausted, still covering every item', async () => {
    const presets = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
      { id: 'p3', name: 'Gamma' },
    ];
    const { cycler } = makeCycler({ listPresets: async () => presets });
    await cycler.set({ pool: 'looks', order: 'shuffle' });

    await withSeededRandom(777, async () => {
      const firstPass = [];
      for (let i = 0; i < 3; i++) { await cycler.advance(); firstPass.push(cycler.currentLabel); }
      const secondPass = [];
      for (let i = 0; i < 3; i++) { await cycler.advance(); secondPass.push(cycler.currentLabel); }

      assert.equal(new Set(firstPass).size, 3);
      assert.equal(new Set(secondPass).size, 3);
    });
  });
});

describe('Cycler#apply', () => {
  it('releases the renderer (blank: false) before selecting a firmware effect', async () => {
    const renderer = fakeRenderer();
    const device = fakeDevice();
    const { cycler } = makeCycler({ renderer, device });

    await cycler.apply({ kind: 'effect', id: 7, label: 'Test FX' });

    assert.deepEqual(renderer.calls, [['stop', { blank: false }]]);
    assert.equal(device.calls.length, 1);
    assert.equal(device.calls[0].path, '/json/state');
    const body = JSON.parse(device.calls[0].init.body);
    assert.deepEqual(body, { seg: [{ fx: 7 }] });
  });

  it('applies a preset\'s animation params and playback speed, then plays it', async () => {
    const preset = {
      id: 'p1', name: 'Look', animation: 'rainbow',
      values: { cycles: 3 }, playback: { speed: 1.5, brightness: 0.9 },
    };
    const renderer = fakeRenderer();
    const { cycler } = makeCycler({ renderer, listPresets: async () => [preset] });

    await cycler.apply({ kind: 'preset', id: 'p1', label: 'Look' });

    assert.deepEqual(renderer.calls[0], ['setAnimParams', 'rainbow', { cycles: 3 }]);
    // Brightness is stripped from playback before it reaches setParams.
    assert.deepEqual(renderer.calls[1], ['setParams', { speed: 1.5 }]);
    assert.deepEqual(renderer.calls[2], ['play', 'rainbow']);
  });

  it('is a silent no-op for a preset id that no longer exists', async () => {
    const renderer = fakeRenderer();
    const { cycler } = makeCycler({ renderer, listPresets: async () => [] });
    await cycler.apply({ kind: 'preset', id: 'ghost', label: 'Gone' });
    assert.deepEqual(renderer.calls, []);
  });

  it('plays an animation item directly by id', async () => {
    const renderer = fakeRenderer();
    const { cycler } = makeCycler({ renderer });
    await cycler.apply({ kind: 'animation', id: 'comet', label: 'Comet' });
    assert.deepEqual(renderer.calls, [['play', 'comet']]);
  });
});
