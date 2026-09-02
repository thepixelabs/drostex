/**
 * The HyperCube line, as the vendor publishes it, plus what has been measured.
 *
 * Two kinds of fact live here and they are kept apart on purpose:
 *
 *   - `leds`, `perEdge`, `edges`, `size` come from the vendor's own product
 *     pages (`spec`). They are counts of parts, and on the Nano they held up
 *     against measurement.
 *   - `reported`, `working` and `blocks` describe how the controller actually
 *     addresses those parts. The vendor publishes none of this. It exists
 *     only for the model someone has probed with the scripts in `scripts/`,
 *     and `status` says which that is.
 *
 * A `spec-sheet` model is a real configuration, not a guess: the per-edge
 * count is what makes `e` wrap at every corner and what edge symmetry folds
 * on, and it is the one number the vendor prints. What is missing for those
 * models is whether the controller reports more addresses than drive LEDs,
 * and how the edges gang together. Until someone with that cube runs
 * `scripts/diagnose.mjs`, the safe assumption is that every reported address
 * is real, and the preview falls back to an even split of edges.
 *
 * The older, non-SE HyperCube 10 and 15 are deliberately absent. Their manual
 * describes a different controller (two LED tracks, two sACN universes) and
 * nothing here has been tried against one.
 */

export const MODELS = Object.freeze({
  nano: Object.freeze({
    key: 'nano',
    name: 'HyperCube Nano',
    size: '5.6 in / 142 mm',
    edges: 12,
    perEdge: 11,
    leds: 132,
    spec: 'https://hyperspacelight.com/products/hypercube-nano',
    status: 'measured',
    // Controller reports 88 addresses; only the first 44 drive anything.
    reported: 88,
    working: 44,
    // Edges driven by each address block. Uneven fan-out, sums to 12.
    blocks: Object.freeze([1, 2, 4, 5]),
    profile: 'profiles/nano-topology.json',
  }),
  'hc10-se': Object.freeze({
    key: 'hc10-se',
    name: 'HyperCube10-SE',
    size: '10.15 in / 25.8 cm',
    edges: 12,
    perEdge: 18,
    leds: 216,
    spec: 'https://hyperspacelight.com/products/hypercube10-se',
    status: 'spec-sheet',
    reported: null,
    working: null,
    blocks: null,
    profile: null,
  }),
  'hc15-se': Object.freeze({
    key: 'hc15-se',
    name: 'HyperCube15-SE',
    size: '15.16 in / 38.5 cm',
    edges: 12,
    perEdge: 28,
    leds: 336,
    spec: 'https://hyperspacelight.com/products/hypercube15-se',
    status: 'spec-sheet',
    reported: null,
    working: null,
    blocks: null,
    profile: null,
  }),
});

export const MODEL_KEYS = Object.keys(MODELS);

/**
 * Picks a model from what is known about the device.
 *
 * An explicit key wins outright. Otherwise the controller's own report is
 * consulted: the reported address count, then any product or device name
 * that carries the model in it. Returns null when nothing matches, and the
 * caller decides what a device it cannot name should default to. Guessing
 * here would be worse than admitting it: a wrong `perEdge` puts a colour
 * seam on every corner.
 */
export function resolveModel({ key = null, info = null } = {}) {
  if (key && key !== 'auto') {
    return MODELS[String(key).toLowerCase()] ?? null;
  }
  if (!info) return null;

  const count = Number(info.leds?.count);
  if (Number.isFinite(count)) {
    // Only models that have been probed know what their controller reports.
    const byReported = MODEL_KEYS.map((k) => MODELS[k]).find((m) => m.reported === count);
    if (byReported) return byReported;
    // A spec-sheet model whose controller reports exactly its LED count is
    // the natural hypothesis for an unmeasured cube; still unverified.
    const byLeds = MODEL_KEYS.map((m) => MODELS[m]).find((m) => m.leds === count);
    if (byLeds) return byLeds;
  }

  const label = [info.product, info.brand, info.name].filter(Boolean).join(' ').toLowerCase();
  if (/nano/.test(label)) return MODELS.nano;
  if (/\b(hc|hypercube)\s*-?\s*15\b/.test(label)) return MODELS['hc15-se'];
  if (/\b(hc|hypercube)\s*-?\s*10\b/.test(label)) return MODELS['hc10-se'];
  return null;
}

/**
 * Turns a config plus a model plus whatever the device said into the three
 * numbers the renderer runs on, and says where each one came from.
 *
 * Precedence, per field:
 *   1. an explicit `leds.*` value in config.json - someone measured it
 *   2. the model table
 *   3. the controller's own `/json/info` report (for the address count)
 *   4. a fallback, and a warning that it is one
 *
 * `working` defaults to the address count rather than to anything from the
 * Nano: on an unprobed cube the honest assumption is that every address is
 * real, and `scripts/diagnose.mjs` exists to find out otherwise.
 */
export function applyModel(config, { model = null, info = null } = {}) {
  const overrides = config.ledsOverride ?? {};
  const reported = Number(info?.leds?.count);
  const notes = [];

  const ledCount = overrides.count
    ?? model?.reported
    ?? (Number.isFinite(reported) && reported > 0 ? reported : null)
    ?? model?.leds
    ?? 88;
  const working = overrides.working
    ?? model?.working
    ?? ledCount;
  let perEdge = overrides.perEdge ?? model?.perEdge ?? null;
  if (!perEdge) {
    perEdge = 11;
    notes.push('leds.perEdge is unknown for this device; assuming 11. Set it in config.json.');
  }
  const blocks = overrides.blocks ?? model?.blocks ?? null;

  if (model && model.status !== 'measured' && !overrides.working) {
    notes.push(
      `${model.name} is configured from the vendor's spec sheet and has not been run against a real unit. ` +
      `If fewer than ${working} addresses light up, run scripts/diagnose.mjs and set leds.working.`,
    );
  }
  if (!model && !overrides.perEdge) {
    notes.push('Could not tell which HyperCube this is. Set device.model in config.json (nano, hc10-se, hc15-se).');
  }

  return {
    ...config,
    model: model?.key ?? null,
    modelName: model?.name ?? null,
    modelStatus: model?.status ?? null,
    ledCount,
    working,
    perEdge,
    blocks,
    notes,
  };
}
