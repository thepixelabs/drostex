/**
 * Drostex UI.
 *
 * Thin by design: the server owns the pixels and the UDP socket, so this page
 * only sends control messages and reflects state back. That is what lets an
 * animation survive closing the tab.
 *
 * Structure follows one distinction the hardware forced on us. There are two
 * PIXEL SOURCES - our streamed animations, or the cube's own firmware effects -
 * and exactly one drives the LEDs at a time. But brightness, sparkle, symmetry
 * and sound-reactive are MODIFIERS that apply to whichever is running. Filing
 * the modifiers inside an "onboard" tab made them look like they only worked
 * there, which was the source of a genuine "why doesn't this apply to my
 * animations?" - so they live in a rail outside the tabs.
 */

import { CubePreview } from './cube.mjs';

const $ = (id) => document.getElementById(id);

const api = async (path, body) => {
  const r = await fetch(`/api/${path}`, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  if (!r.ok) {
    const err = new Error(`${path}: ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
};

const debounce = (fn, ms) => {
  let t = null;
  return (...a) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

let current = null;        // playing animation id
let schemas = {};          // id -> { label, desc, params, values }
let palettes = {};         // name -> [[r,g,b] x7]
let effectsLoaded = false;
let brightnessSynced = false;
let deviceOnline = true;
const PAGE_BUILD = document.querySelector('meta[name="drostex-build"]')?.content ?? '';
$('build').textContent = PAGE_BUILD.startsWith('__') ? 'stale page' : PAGE_BUILD;
// One missed poll is normal for a busy ESP32; only a run of them means trouble.
let offlineStrikes = 0;

/* ── tabs ─────────────────────────────────────────────────── */
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    }
    for (const p of document.querySelectorAll('.panel')) {
      p.classList.toggle('is-active', p.id === `panel-${tab.dataset.tab}`);
    }
    if (tab.dataset.tab === 'onboard' && !effectsLoaded) loadEffects();
  });
}

/* ── helpers ──────────────────────────────────────────────── */
const css = (stops) => `linear-gradient(90deg, ${stops.map((c) => `rgb(${c.join(',')})`).join(',')})`;
const fmt = (v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(2));

/** hsv -> #rrggbb, matching the hsv() the animations themselves colour with. */
function hsvHex(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  const hx = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/**
 * A gradient that hints at what a pattern looks like, from its own defaults.
 *
 * The order below is "most specific evidence first". It used to fall through to
 * a full spectrum for anything without colour parameters, which put an
 * identical rainbow on Fire, Comet and Rainbow alike - three patterns that look
 * nothing like each other. Now the spectrum is only shown by something that
 * genuinely is one.
 */
function swatchFor(spec) {
  const v = spec.values ?? {};
  const p = spec.params ?? {};

  // Only trust paletteName when the pattern is actually in palette mode. Snake
  // carries paletteName AND colorMode:'solid', and the palette used to win.
  const usesPalette = v.colorMode == null || v.colorMode === 'palette';
  if (usesPalette && v.paletteName && palettes[v.paletteName]) return css(palettes[v.paletteName]);

  const cols = Object.entries(p).filter(([, d]) => d.type === 'color').map(([k]) => v[k]);
  if (cols.length >= 2) return `linear-gradient(90deg, ${cols.join(',')})`;
  if (cols.length === 1) return `linear-gradient(90deg, #0A0B0F, ${cols[0]})`;

  // Hue-driven patterns (Comet): sweep exactly the arc they travel, at the same
  // saturation their fn() uses, rather than the whole wheel.
  if (typeof v.hue === 'number') {
    const span = typeof v.hueShift === 'number' ? v.hueShift : 0.15;
    const stops = Array.from({ length: 5 }, (_, i) => hsvHex(v.hue + (span * i) / 4, 0.7, 1));
    return `linear-gradient(90deg, ${stops.join(',')})`;
  }

  if (spec.swatch?.length) return `linear-gradient(90deg, ${spec.swatch.join(',')})`;
  return palettes.spectrum ? css(palettes.spectrum) : 'linear-gradient(90deg,#444,#888)';
}

/* ── stars ────────────────────────────────────────────────────
 *
 * A saved look keeps its star inside presets.json; patterns and firmware
 * effects keep theirs in favorites.json, because those two are fixed catalogues
 * with nowhere of their own to put a flag. The button is identical in all three
 * places - only where the answer is stored differs.
 */
let favorites = { animation: [], effect: [] };

const isFav = (kind, id) => favorites[kind]?.some((x) => x === id) ?? false;

/** Adds a star to a card. `onToggle` owns persistence and re-render. */
function addStar(el, { on, label, onToggle }) {
  const b = document.createElement('button');
  b.className = 'fav';
  b.type = 'button';
  b.textContent = on ? '★' : '☆';
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? `Remove ${label} from favourites` : `Add ${label} to favourites`);
  b.addEventListener('click', async (e) => {
    e.stopPropagation();     // the card underneath would otherwise start playing
    await onToggle();
  });
  el.appendChild(b);
  el.classList.add('has-fav');
  return b;
}

/** Toggles a pattern or effect star, then repaints whichever grid it was in. */
async function toggleFav(kind, id, after) {
  favorites = await api('favorites', { kind, id });
  after();
}

/* The colour scale sits BELOW the name, not above it. Above, it read as a
   decorative rule separating one card from the next; below, it reads as
   belonging to the thing it is named after - which is the whole point of it. */
function card({ cls = '', swatch, name, desc, onClick }) {
  const el = document.createElement('button');
  el.className = `card ${cls}`.trim();
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;
  el.appendChild(n);
  if (desc) {
    const d = document.createElement('span');
    d.className = 'desc';
    d.textContent = desc;
    el.appendChild(d);
  }
  if (swatch) {
    const s = document.createElement('span');
    s.className = 'swatch';
    s.style.setProperty('--sw', swatch);
    el.appendChild(s);
  }
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/* ── patterns ─────────────────────────────────────────────── */
async function loadAnimations() {
  palettes = await api('palettes');
  const list = await api('animations');
  schemas = Object.fromEntries(list.map((a) => [a.id, a]));

  const grid = $('animations');
  const cards = list.filter((a) => a.id !== 'custom')
    // Starred patterns first, creation order preserved within each group.
    .sort((a, b) => isFav('animation', b.id) - isFav('animation', a.id))
    .map((a) => {
      const el = card({ swatch: swatchFor(a), name: a.label, desc: a.desc, onClick: () => play(a.id) });
      el.dataset.id = a.id;
      addStar(el, {
        on: isFav('animation', a.id),
        label: a.label,
        onToggle: () => toggleFav('animation', a.id, () => loadAnimations()),
      });
      return el;
    });

  // `custom` is different in kind - a small signal chain rather than a finished
  // pattern - so it gets a create-affordance instead of blending into the grid.
  const add = card({ cls: 'card-add', name: '+ Build a look', onClick: () => play('custom') });
  add.dataset.id = 'custom';
  grid.replaceChildren(add, ...cards);
}

async function play(name) {
  markActive(name);              // optimistic: the click should feel instant
  buildInspector(name);
  try {
    await api('play', { name });
  } catch {
    markActive(current);         // roll back to whatever is really running
  }
}

function markActive(name) {
  current = name;
  for (const c of document.querySelectorAll('#animations .card')) {
    c.classList.toggle('is-active', c.dataset.id === name);
  }
  const insp = $('inspector');
  if (!name) { insp.hidden = true; return; }
  insp.hidden = false;
  $('inspector-title').textContent = schemas[name]?.label ?? name;
}

/* ── parameter inspector ──────────────────────────────────── */

/* Grouping for the animations with enough parameters to need it. Anything with
   four or fewer is left ungrouped - headers over three controls is chrome for
   its own sake. */
const GROUPS = {
  custom: {
    Shape: ['space', 'wave', 'cycles', 'rate'],
    Colour: ['colorMode', 'paletteName', 'colorA', 'colorB', 'hue'],
    Range: ['contrast', 'floor'],
  },
  snake: {
    Shape: ['path', 'length', 'count'],
    Motion: ['rate', 'tail', 'glow'],
    Colour: ['colorMode', 'color', 'paletteName'],
  },
  aurora: { Colour: ['colorA', 'colorB'], Motion: ['scale', 'rate', 'contrast'] },
  breathe: { Colour: ['colorA', 'colorB', 'blend'], Motion: ['floor', 'shape'] },
  sparkle: { Colour: ['base', 'spark'], Motion: ['density', 'rate'] },
};

let saveStatusTimer = null;
function flagUnsaved(msg) {
  const el = $('save-status');
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function buildInspector(name) {
  const spec = schemas[name];
  const host = $('params');
  if (!spec) { host.replaceChildren(); return; }

  const values = { ...spec.values };
  // Failures here used to be silent: the slider moved, the cube never heard
  // about it, and nothing said so.
  const push = debounce(() => {
    api('anim-params', { name, values })
      .then(() => { spec.values = { ...values }; })
      .catch(() => flagUnsaved('Not applied — connection lost'));
  }, 60);

  const groups = GROUPS[name];
  const order = groups
    ? Object.entries(groups).map(([g, keys]) => [g, keys.filter((k) => spec.params[k])])
    : [[null, Object.keys(spec.params)]];

  const nodes = [];
  for (const [group, keys] of order) {
    if (!keys.length) continue;
    if (group) {
      const h = document.createElement('p');
      h.className = 'param-group';
      h.textContent = group;
      nodes.push(h);
    }
    for (const key of keys) nodes.push(paramControl(key, spec.params[key], values, push));
  }
  host.replaceChildren(...nodes);
}

function paramControl(key, def, values, push) {
  const wrap = document.createElement('div');
  wrap.className = 'param';

  const label = document.createElement('label');
  label.textContent = def.label ?? key;
  label.htmlFor = `p-${key}`;
  const out = document.createElement('output');
  label.appendChild(out);
  wrap.appendChild(label);

  const addHint = () => {
    if (!def.hint) return;
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = def.hint;
    wrap.appendChild(p);
  };

  if (def.type === 'number') {
    const input = document.createElement('input');
    input.type = 'range'; input.id = `p-${key}`;
    input.min = def.min; input.max = def.max; input.step = def.step ?? 0.01;
    input.value = values[key];
    out.textContent = fmt(values[key]);
    input.addEventListener('input', () => {
      values[key] = Number(input.value);
      out.textContent = fmt(values[key]);
      push();
    });
    wrap.appendChild(input);

  } else if (def.type === 'color') {
    const row = document.createElement('div');
    row.className = 'param-color';
    const btn = document.createElement('span');
    btn.className = 'swatch-btn';
    const fill = document.createElement('span');
    fill.className = 'swatch-fill';
    const input = document.createElement('input');
    input.type = 'color'; input.id = `p-${key}`; input.value = values[key];
    const hex = document.createElement('input');
    hex.type = 'text'; hex.className = 'hex'; hex.value = values[key];

    const apply = (v, from) => {
      if (!/^#[0-9a-f]{6}$/i.test(v)) return;
      values[key] = v;
      fill.style.background = v;
      // Glow in the colour itself: on a near-black UI this reads as light.
      btn.style.boxShadow = `0 0 14px ${v}66`;
      if (from !== 'picker') input.value = v;
      if (from !== 'hex') hex.value = v;
      push();
    };
    apply(values[key], null);
    input.addEventListener('input', () => apply(input.value, 'picker'));
    hex.addEventListener('change', () => apply(hex.value.trim(), 'hex'));

    btn.append(fill, input);
    row.append(btn, hex);
    wrap.appendChild(row);

  } else if (def.type === 'boolean') {
    const sw = document.createElement('label');
    sw.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.id = `p-${key}`; input.checked = Boolean(values[key]);
    input.addEventListener('change', () => { values[key] = input.checked; push(); });
    sw.append(input, document.createElement('span'));
    wrap.appendChild(sw);

  } else if (key === 'paletteName') {
    // A palette's whole point is what it looks like; a dropdown of names throws
    // that away.
    const strip = document.createElement('div');
    strip.className = 'palettes';
    strip.replaceChildren(...def.options.map((nm) => {
      const b = document.createElement('button');
      b.className = 'pal-btn';
      b.style.background = palettes[nm] ? css(palettes[nm]) : '#444';
      b.title = nm;
      b.setAttribute('aria-label', nm);
      b.setAttribute('aria-pressed', String(values[key] === nm));
      b.addEventListener('click', () => {
        values[key] = nm;
        for (const s of strip.children) s.setAttribute('aria-pressed', String(s === b));
        push();
      });
      return b;
    }));
    wrap.appendChild(strip);

  } else {
    const input = document.createElement('select');
    input.id = `p-${key}`;
    input.replaceChildren(...def.options.map((o) => {
      const el = document.createElement('option');
      el.value = o; el.textContent = o;
      return el;
    }));
    input.value = values[key];
    input.addEventListener('change', () => { values[key] = input.value; push(); });
    wrap.appendChild(input);
  }

  addHint();
  return wrap;
}

$('reset-params').addEventListener('click', async () => {
  if (!current) return;
  const { values } = await api('anim-params', { name: current, reset: true });
  schemas[current].values = values;
  buildInspector(current);
});

/* Randomise-then-tune is the shortest path from "adjusting something" to
   "making something", and every parameter already declares its own range. */
$('shuffle').addEventListener('click', async () => {
  if (!current) return;
  const spec = schemas[current];
  const values = {};
  for (const [k, d] of Object.entries(spec.params)) {
    if (d.type === 'number') {
      const raw = d.min + Math.random() * (d.max - d.min);
      values[k] = d.step >= 1 ? Math.round(raw) : Number(raw.toFixed(3));
    } else if (d.type === 'boolean') {
      values[k] = Math.random() < 0.5;
    } else if (d.type === 'select') {
      values[k] = d.options[Math.floor(Math.random() * d.options.length)];
    } else if (d.type === 'color') {
      values[k] = '#' + Array.from({ length: 3 }, () =>
        Math.floor(60 + Math.random() * 195).toString(16).padStart(2, '0')).join('');
    }
  }
  const res = await api('anim-params', { name: current, values });
  spec.values = res.values;
  buildInspector(current);
});

$('stop').addEventListener('click', async () => {
  markActive(null);
  await api('stop', {});
});

/* ── saved looks ──────────────────────────────────────────── */
async function renderPresets(list) {
  const host = $('presets');
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing saved yet. Pick a pattern below, adjust it, then Save.';
    host.replaceChildren(p);
    return;
  }
  // Stable sort, so starring something moves it to the front without
  // reshuffling everything else out from under you.
  const sorted = [...list].sort((a, b) => Boolean(b.favorite) - Boolean(a.favorite));
  host.replaceChildren(...sorted.map((preset) => {
    const spec = schemas[preset.animation];
    const el = card({
      cls: 'preset',
      swatch: spec ? swatchFor({ params: spec.params, values: preset.values }) : undefined,
      name: preset.name,
      onClick: async () => {
        const st = await api('presets/load', { id: preset.id });
        schemas[st.animation].values = st.animParams;
        markActive(st.animation);
        buildInspector(st.animation);
        syncPlayback(st);
      },
    });
    // Which pattern this look is built on belongs with the name, above the
    // colour scale rather than orphaned below it.
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = spec?.label ?? preset.animation;
    el.insertBefore(meta, el.querySelector('.swatch'));

    // Favourite before delete in DOM order, so the destructive control is last
    // in the tab sequence rather than sitting between load and favourite. A
    // saved look stores its own star, so this one does not go through
    // favorites.json like the pattern and effect stars do.
    addStar(el, {
      on: Boolean(preset.favorite),
      label: preset.name,
      onToggle: async () => renderPresets(await api('presets', { favorite: preset.id })),
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete ${preset.name}`);
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      renderPresets(await api('presets', { delete: preset.id }));
    });
    el.appendChild(del);
    return el;
  }));
}

$('save-preset').addEventListener('click', async () => {
  const el = $('preset-name');
  const name = el.value.trim();
  if (!name || !current) return;
  await renderPresets(await api('presets', { name }));
  el.value = '';
});
$('preset-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('save-preset').click();
});

/* ── modifiers rail ───────────────────────────────────────── */

/* One brightness control. There used to be two - a local multiplier and the
   device's own - and they fought: streaming pins the device to 255 so the
   multiplier has full range, the device slider would undo that, and Stop then
   reverted the user's edit. The server routes this to whichever is driving. */
const brightness = $('brightness');
brightness.addEventListener('input', () => {
  brightnessSynced = true;
  $('brightness-out').textContent = brightness.value;
  pushBrightness();
});
const pushBrightness = debounce(() => {
  api('brightness', { value: Number(brightness.value) }).catch(() => {});
}, 90);

$('power').addEventListener('change', (e) => api('device/state', { on: e.target.checked }));

function bindSeg(id, onPick) {
  const host = $(id);
  host.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of host.children) x.classList.toggle('is-on', x === b);
    onPick(b.dataset.v);
  });
}
bindSeg('fx-sparkle', (v) => api('device/state', { sparkle: Number(v) }));

// Ours, for streamed animations. Continuous rather than the firmware's three
// steps, and it actually reaches the 44 addresses that have LEDs behind them.
(() => {
  const el = $('sparkle-studio');
  el.addEventListener('input', () => {
    $('sparkle-studio-out').textContent = el.value;
    api('params', { sparkle: Number(el.value) / 100 }).catch(() => {});
  });
})();

/* Two symmetry controls, because they are two different things and each only
   works in one place. Ours folds the sampling index of a streamed animation;
   the firmware's folds its own effect renderer, which realtime data bypasses.
   Putting each beside what it affects is the only non-confusing arrangement. */
const OUR_SYMMETRY = {
  none: 'None', reverse: 'Reverse', mirror: 'Mirror',
  cyclic2: 'Cyclic ×2', cyclic4: 'Cyclic ×4', edgeMirror: 'Edge mirror',
};
function fillSymmetry(names) {
  const el = $('symmetry');
  if (el.dataset.filled) return;
  el.dataset.filled = '1';
  el.replaceChildren(...names.map((n) => {
    const o = document.createElement('option');
    o.value = n; o.textContent = OUR_SYMMETRY[n] ?? n;
    return o;
  }));
  el.addEventListener('change', () => api('params', { symmetry: el.value }).catch(() => {}));
}

/* Index 0 is not a fold, it is a hand-back: the firmware reads 0 in sym, sx, ix
   and pal alike as "use whatever this pattern wants". Calling it "Default" made
   it look like a ninth symmetry rather than the absence of a choice. */
const FX_SYMMETRY = ['The pattern’s own', 'None', 'Cubic', 'Helical', 'Trigonal',
                     'Mirror', 'Vertex', 'Inversion', 'Cyclic'];
(() => {
  const el = $('fx-symmetry');
  el.replaceChildren(...FX_SYMMETRY.map((n, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = n;
    return o;
  }));
  el.addEventListener('change', () => api('device/state', { seg: [{ sym: Number(el.value) }] }));
})();

/* ── palette picker ──────────────────────────────────────────
 *
 * The cube publishes palette NAMES and nothing else - /json/palx is a bare
 * string array, and the cube's own UI renders them as plain text. The dots come
 * from src/device-palettes.mjs, which is our reading of each name, so the list
 * says so rather than implying the device drew them.
 */
let devicePalettes = [];
let paletteValue = null;

const dotsFor = (stops) => {
  const host = document.createElement('span');
  host.className = 'dots';
  if (!stops) { host.classList.add('is-unknown'); return host; }
  for (const c of stops) {
    const d = document.createElement('i');
    d.style.background = c;
    host.appendChild(d);
  }
  return host;
};

function buildPalettePicker(pals, initial) {
  devicePalettes = pals;
  const list = $('palette-list');
  list.replaceChildren(...pals.map((p) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.tabIndex = -1;
    li.dataset.id = String(p.id);
    const name = document.createElement('span');
    name.textContent = p.label;
    li.append(name, dotsFor(p.stops));
    li.addEventListener('click', () => { setPalette(p.id, true); closePalette(true); });
    return li;
  }));

  const btn = $('palette-btn');
  btn.addEventListener('click', () => (list.hidden ? openPalette() : closePalette(true)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPalette(); }
  });
  list.addEventListener('keydown', (e) => {
    const opts = [...list.children];
    const at = opts.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closePalette(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(opts.length - 1, at + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); opts[Math.max(0, at - 1)]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); opts[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); opts.at(-1)?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setPalette(Number(document.activeElement.dataset.id), true);
      closePalette(true);
    }
  });
  // Clicking away closes it; a picker that only closes on Escape is a trap.
  document.addEventListener('click', (e) => {
    if (!list.hidden && !$('palette').contains(e.target)) closePalette(false);
  });

  setPalette(initial ?? 0, false);
}

function openPalette() {
  const list = $('palette-list');
  list.hidden = false;
  $('palette-btn').setAttribute('aria-expanded', 'true');
  const sel = [...list.children].find((li) => li.dataset.id === String(paletteValue));
  (sel ?? list.firstElementChild)?.focus();
}
function closePalette(refocus) {
  $('palette-list').hidden = true;
  $('palette-btn').setAttribute('aria-expanded', 'false');
  if (refocus) $('palette-btn').focus();
}

/** @param push whether to tell the cube, or just reflect what it already says */
function setPalette(id, push) {
  paletteValue = id;
  const p = devicePalettes.find((x) => x.id === id);
  $('palette-current').textContent = p?.label ?? '—';
  $('palette-current-dots').replaceWith(Object.assign(dotsFor(p?.stops), { id: 'palette-current-dots' }));
  for (const li of $('palette-list').children) {
    li.setAttribute('aria-selected', String(li.dataset.id === String(id)));
  }
  paintEffectDots();
  if (push) api('device/state', { seg: [{ pal: id }] }).catch(() => {});
}

/* ── who owns a device control ───────────────────────────────
 *
 * sym, sx, ix and pal all use 0 to mean "whatever this pattern wants". The UI
 * used to render that as a value like any other, which is why adjusting one
 * and watching it revert looked like the cube overwriting your settings - it
 * was actually the pattern taking back a control you had never taken from it.
 *
 * Speed and intensity additionally reset themselves on every pattern change,
 * because the cube has "reset speed and intensity on pattern change" switched
 * on. Symmetry and palette do not - hence the different note on each.
 */
const OWNS = [
  { key: 'sym', el: 'sym-owner', field: 'sym', resets: false },
  { key: 'sx', el: 'sx-owner', field: 'sx', resets: true },
  { key: 'ix', el: 'ix-owner', field: 'ix', resets: true },
  { key: 'pal', el: 'pal-owner', field: 'pal', resets: false },
];

function renderOwners(dev) {
  for (const o of OWNS) {
    const host = $(o.el);
    if (!host) continue;
    const v = dev?.[o.key];
    if (v == null) { host.replaceChildren(); host.removeAttribute('data-own'); continue; }
    const theirs = v === 0;
    host.dataset.own = theirs ? 'theirs' : 'yours';
    const label = document.createElement('span');
    label.textContent = theirs ? 'the pattern’s own' : 'yours';
    host.replaceChildren(label);
    // Only ever written on the hand-back path, so this can never overwrite a
    // number the user is in the middle of dragging.
    // Only ever written on the hand-back path for sliders, so this can never
    // overwrite a number the user is in the middle of dragging. The palette is
    // safe to mirror either way - it is a discrete pick, not a drag.
    if (theirs) {
      const out = $(`${o.key}-out`);
      if (out) out.textContent = '—';
    }
    if (o.key === 'pal' && devicePalettes.length && v !== paletteValue
        && $('palette-list').hidden) {
      setPalette(v, false);
    }
    if (!theirs) {
      const back = document.createElement('button');
      back.type = 'button';
      back.textContent = 'hand back';
      back.title = 'Let the pattern choose this again';
      back.addEventListener('click', () => {
        api('device/state', { seg: [{ [o.field]: 0 }] }).catch(() => {});
      });
      host.appendChild(back);
    }
  }
}

/* ── auto-cycle ───────────────────────────────────────────
 *
 * Rotates through a chosen pool across BOTH sources. The pools are separable
 * because a silent room makes sound-reactive effects look broken, while a party
 * wants only those.
 */
let cyclePoolsFilled = false;

function fillCyclePools(pools) {
  if (cyclePoolsFilled || !pools) return;
  cyclePoolsFilled = true;
  const el = $('cycle-pool');
  el.replaceChildren(...Object.entries(pools).map(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    return o;
  }));
}

const pushCycle = () => api('cycle', {
  enabled: $('cycle-on').checked,
  pool: $('cycle-pool').value,
  interval: Number($('cycle-interval').value),
  order: $('cycle-order').value,
}).catch(() => {});

for (const id of ['cycle-on', 'cycle-pool', 'cycle-order']) {
  $(id).addEventListener('change', pushCycle);
}
$('cycle-interval').addEventListener('input', () => {
  const v = Number($('cycle-interval').value);
  $('cycle-interval-out').textContent = v >= 60
    ? `${Math.round(v / 60)}m${v % 60 ? ` ${v % 60}s` : ''}`
    : `${v}s`;
});
$('cycle-interval').addEventListener('change', pushCycle);

/* Who is actually running the rotation is invisible otherwise, and it decides
   whether it keeps going once this server stops. */
function cycleNote(c) {
  const el = $('cycle-note');
  if (!c.enabled) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = c.pool.startsWith('effects')
    ? 'Drostex is switching the effect, so this stops when the server does. '
      + 'For a rotation that runs on its own, use the cube\u2019s own rotations '
      + 'under Built-in effects.'
    : 'Drostex computes these, so the server has to keep running.';
}

function renderCycle(c) {
  if (!c) return;
  fillCyclePools(c.pools);
  if (document.activeElement !== $('cycle-on')) $('cycle-on').checked = c.enabled;
  if (document.activeElement !== $('cycle-pool') && c.pool) $('cycle-pool').value = c.pool;
  cycleNote(c);
  const now = $('cycle-now');
  if (!c.enabled) { now.textContent = ''; return; }
  const left = c.secondsLeft ?? 0;
  const secs = document.createElement('span');
  secs.id = 'cycle-left';
  secs.textContent = `${left}s`;

  now.replaceChildren();
  if (c.current) {
    const b = document.createElement('b');
    b.textContent = c.current;
    now.append('now ', b, ' · next in ', secs);
  } else {
    now.append('next in ', secs);
  }
}

if (!localStorage.getItem('drostex.modnote')) {
  $('mod-note').hidden = false;
  $('mod-note-x').addEventListener('click', () => {
    localStorage.setItem('drostex.modnote', '1');
    $('mod-note').hidden = true;
  });
}

/* ── playback ─────────────────────────────────────────────── */
function bindSlider(id, format, key, scale) {
  const el = $(id);
  const out = $(`${id}-out`);
  const sync = () => { out.textContent = format(Number(el.value)); };
  el.addEventListener('input', () => {
    sync();
    api('params', { [key]: Number(el.value) / scale }).catch(() => {});
  });
  sync();
}
bindSlider('speed', (v) => `${(v / 100).toFixed(1)}×`, 'speed', 100);
bindSlider('fps', (v) => `${v} fps`, 'fps', 1);

/* Brightness is deliberately absent: loading a look must never move the
   brightness control. It is set once for the room and applies to everything. */
function syncPlayback(st) {
  $('speed').value = String(Math.round(st.params.speed * 100));
  $('speed-out').textContent = `${st.params.speed.toFixed(1)}×`;
}

/* ── built-in effects ─────────────────────────────────────── */
let allEffects = [];
let fxFilter = 'all';
let fxQuery = '';
let fxMode = null;         // showing only one playlist's members, or null
let modeIndex = {};        // fx id -> { label, members }

const MODE_DESC = {
  0: 'bright, kaleidoscopic patterns',
  1: 'slow and calm',
  2: 'reacts to sound using the cube\u2019s microphone',
};

const showEmpty = (host, cls, text) => {
  const p = document.createElement('p');
  p.className = `empty ${cls}`.trim();
  p.textContent = text;
  host.replaceChildren(p);
};

async function loadEffects() {
  showEmpty($('effects'), 'is-loading', 'Asking the cube what it can do\u2026');
  let payload;
  try {
    payload = await api('effects');
  } catch {
    // effectsLoaded stays false, so coming back to this tab retries instead of
    // leaving the grid blank forever.
    showEmpty($('effects'), 'is-error', 'Couldn\u2019t load the cube\u2019s effects. Switch tabs to try again.');
    return;
  }
  effectsLoaded = true;
  const { effects, palettes: pals, state } = payload;
  // Modes are playlists; the rest are single effects. Separate lists.
  allEffects = effects.filter((e) => !/^Mode:/.test(e.label));
  const modes = effects.filter((e) => /^Mode:/.test(e.label));
  modeIndex = Object.fromEntries(modes.map((m) => [m.id, {
    label: m.label.replace(/^Mode:\s*/, ''),
    members: m.members ?? [],
  }]));
  const seg = state?.seg?.[0] ?? {};

  buildPalettePicker(pals, seg.pal);

  $('sb').addEventListener('change', (e) => api('device/state', { sb: e.target.checked }));
  $('psd').addEventListener('change', (e) => api('device/state', { seg: [{ psd: e.target.checked }] }));
  $('nl').addEventListener('change', (e) => api('device/state', { nl: { on: e.target.checked } }));

  bindDeviceSlider('sx', (v) => String(v), (v) => api('device/state', { seg: [{ sx: v }] }), seg.sx);
  bindDeviceSlider('ix', (v) => String(v), (v) => api('device/state', { seg: [{ ix: v }] }), seg.ix);

  $('fx-search').addEventListener('input', (e) => { fxQuery = e.target.value.toLowerCase(); renderEffects(); });
  bindSeg('fx-filter', (v) => { fxFilter = v; renderEffects(); });

  const modeGrid = $('modes');
  modeGrid.replaceChildren(...modes.map((m) => {
    const count = modeIndex[m.id]?.members.length ?? 0;
    const el = card({
      name: modeIndex[m.id].label,
      desc: MODE_DESC[m.id] ?? 'a rotating playlist of the cube\u2019s own patterns',
      onClick: async () => {
        for (const c of modeGrid.querySelectorAll('.card')) c.classList.toggle('is-active', c === el);
        for (const c of $('effects').children) c.classList.remove('is-active');
        markActive(null);
        await api('device/state', { seg: [{ fx: m.id }] });
      },
    });
    el.dataset.fx = m.id;
    if (seg.fx === m.id) el.classList.add('is-active');
    addStar(el, {
      on: isFav('effect', m.id),
      label: modeIndex[m.id].label,
      onToggle: () => toggleFav('effect', m.id, () => loadEffects()),
    });

    if (count) {
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = `${count} patterns \u00b7 60s each \u00b7 in order`;
      el.appendChild(n);
    }

    // Sibling, not a child. A button's accessible name is the flattened text
    // of everything inside it, so nesting this would rename the card that
    // actually starts the playlist.
    const wrap = document.createElement('div');
    wrap.className = 'mode-wrap';
    wrap.appendChild(el);
    if (count) {
      const reveal = document.createElement('button');
      reveal.className = 'mode-filter';
      reveal.type = 'button';
      reveal.setAttribute('aria-controls', 'effects');
      reveal.addEventListener('click', () => {
        fxMode = fxMode === m.id ? null : m.id;
        renderEffects();
        syncModeReveals();
        if (fxMode !== null) $('fx-chip').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      reveal.dataset.fx = m.id;
      reveal.dataset.count = String(count);
      wrap.appendChild(reveal);
    }
    return wrap;
  }));
  syncModeReveals();

  renderEffects(seg.fx);
}

/** Keeps every reveal button's label and expanded state in step with fxMode. */
function syncModeReveals() {
  for (const b of document.querySelectorAll('.mode-filter')) {
    const on = fxMode === Number(b.dataset.fx);
    b.setAttribute('aria-expanded', String(on));
    b.textContent = on ? 'Showing them below' : `See its ${b.dataset.count} patterns \u2192`;
  }
  const chip = $('fx-chip');
  if (fxMode === null) { chip.hidden = true; chip.replaceChildren(); return; }
  chip.hidden = false;
  const b = document.createElement('b');
  b.textContent = `Played by ${modeIndex[fxMode].label}`;
  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '\u00d7';
  x.setAttribute('aria-label', 'Show all effects again');
  x.addEventListener('click', () => { fxMode = null; renderEffects(); syncModeReveals(); });
  b.appendChild(x);
  chip.replaceChildren(b);
}

function renderEffects(activeId) {
  const grid = $('effects');
  const matchesKind = (e) => (
    fxFilter === 'all' ? true
      : fxFilter === 'fav' ? isFav('effect', e.id)
        : (fxFilter === 'sound') === Boolean(e.sound));

  const list = allEffects
    .filter((e) => matchesKind(e)
      && (fxMode === null || e.modeId === fxMode)
      && (!fxQuery || e.label.toLowerCase().includes(fxQuery)))
    .sort((a, b) => isFav('effect', b.id) - isFav('effect', a.id));

  if (!list.length) {
    showEmpty(grid, '', fxFilter === 'fav'
      ? 'No starred effects yet. Tap the ☆ on any effect to keep it here.'
      : fxMode !== null
        ? `Nothing in ${modeIndex[fxMode].label} matches that.`
        : 'No effects match that.');
    return;
  }

  grid.replaceChildren(...list.map((e) => {
    const el = card({
      cls: 'compact',
      name: e.label,
      onClick: async () => {
        for (const c of grid.children) c.classList.toggle('is-active', c === el);
        for (const c of $('modes').querySelectorAll('.card')) c.classList.remove('is-active');
        markActive(null);      // the server stops our stream; reflect it now
        await api('device/state', { seg: [{ fx: e.id }] });
      },
    });
    el.dataset.fx = e.id;
    if (activeId === e.id) el.classList.add('is-active');
    addStar(el, {
      on: isFav('effect', e.id),
      label: e.label,
      onToggle: () => toggleFav('effect', e.id, () => renderEffects(activeId)),
    });
    if (e.sound) {
      // Information, not decoration - these do nothing in a silent room.
      const i = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      i.setAttribute('class', 'sound');
      i.setAttribute('viewBox', '0 0 24 24');
      i.setAttribute('fill', 'none');
      i.setAttribute('stroke', 'currentColor');
      i.setAttribute('stroke-width', '2.5');
      i.setAttribute('stroke-linecap', 'round');
      i.setAttribute('role', 'img');
      i.innerHTML = '<title>Sound-reactive</title><path d="M3 12h3l3-7 3 14 3-10 3 5h3"/>';
      el.appendChild(i);
    }
    return el;
  }));
  paintEffectDots();
}

/**
 * Explains what colours the built-in effects will come out in.
 *
 * Deliberately NOT per-card dots. When a palette is chosen every effect uses
 * that one palette, so painting it 95 times says nothing a single line does not
 * say better. And when the palette is Default each effect uses its own colours,
 * which cannot be shown because the cube will not report them: /json/fxdata
 * answers 501, /json/palx returns names with no colour data, and pal=0 is never
 * resolved back to a number in /json/state. Guessing from effect names would be
 * inventing data, so the note says plainly that it is not known.
 */
function paintEffectDots() {
  if (!effectsLoaded) return;
  for (const el of $('effects').children) el.querySelector?.('.dots')?.remove();

  const note = $('fx-colors-note');
  const p = devicePalettes.find((x) => x.id === paletteValue);
  note.hidden = false;
  note.replaceChildren();
  if (p?.stops) {
    note.append(`Every pattern below runs in ${p.label} — `);
    note.appendChild(dotsFor(p.stops));
    note.append(' — until you change the palette.');
  } else if (paletteValue === 0) {
    note.textContent = 'Each pattern below is using its own colours. The cube does not report what those are — '
      + 'there is no endpoint that will say, and its own app cannot show them either. Pick a palette above to '
      + 'set the colours yourself and see them here.';
  } else {
    note.textContent = 'The cube names this palette but never reports its colours, so they cannot be shown.';
  }
}

/** Device sliders are throttled harder: it's an ESP32 on 2.4GHz. */
function bindDeviceSlider(id, format, send, initial) {
  const el = $(id);
  const out = $(`${id}-out`);
  // 0 from the device means "the pattern is deciding", not "zero". The slider
  // cannot represent that (min is 1), so it parks at the midpoint the way the
  // cube's own UI does and the owner line beside it says who is in charge.
  if (initial != null) el.value = String(initial === 0 ? 128 : initial);
  // The owner line under the slider says whose value this is; the output just
  // stops claiming a number that is not really in force.
  out.textContent = initial === 0 ? '—' : format(Number(el.value));
  const push = debounce((v) => send(v), 120);
  el.addEventListener('input', () => {
    const v = Number(el.value);
    out.textContent = format(v);
    push(v);
  });
}

$('warp').addEventListener('click', async () => {
  const b = $('warp');
  b.disabled = true;
  try {
    await api('warp', {});
    markActive(null);   // the server released the stream so warp is visible
  } finally {
    setTimeout(() => { b.disabled = false; }, 15000);
  }
});

/* ── status ───────────────────────────────────────────────── */
const draw = [];

function drawSparkline() {
  const cv = $('sparkline');
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  if (draw.length < 2) return;
  const lo = Math.min(...draw), hi = Math.max(...draw);
  const span = Math.max(12, hi - lo);      // a flat line should look flat, not noisy
  ctx.beginPath();
  draw.forEach((v, i) => {
    const x = (i / (draw.length - 1)) * (w - 2) + 1;
    const y = h - 2 - ((v - lo) / span) * (h - 4);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#7C5CFC';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/**
 * Keeps the built-in grids honest about what the cube is actually showing.
 *
 * Highlighting used to be set once from a snapshot taken when the tab first
 * opened, so anything that changed the effect afterwards - auto-cycle, the
 * cube's own rotation, another browser - left the wrong card lit.
 *
 * One rule covers both readings of how the rotations report themselves: if the
 * cube names a playlist, that playlist is lit; if it names one of the patterns
 * inside a playlist, that pattern is lit and its playlist is marked as the
 * thing that put it there.
 */
function markDeviceFx(fx) {
  if (!effectsLoaded || fx == null) {
    if (effectsLoaded) {
      for (const c of $('modes').querySelectorAll('.card')) c.classList.remove('is-active', 'is-playing-from');
      for (const c of $('effects').children) c.classList?.remove('is-active');
    }
    return;
  }
  const owner = modeIndex[fx] ? Number(fx)
    : Number(Object.keys(modeIndex).find((m) => modeIndex[m].members.includes(fx)) ?? NaN);
  for (const c of $('modes').querySelectorAll('.card')) {
    const id = Number(c.dataset.fx);
    c.classList.toggle('is-active', id === fx);
    c.classList.toggle('is-playing-from', id !== fx && id === owner);
  }
  for (const c of $('effects').children) {
    if (c.dataset?.fx == null) continue;
    c.classList.toggle('is-active', Number(c.dataset.fx) === fx);
  }
}

function setTally(state, text) {
  $('tally').dataset.state = state;
  $('tally-text').textContent = text;
}

function setOffline(off, title, detail) {
  deviceOnline = !off;
  $('offline').hidden = !off;
  document.querySelector('.modifiers').classList.toggle('is-disabled', off);
  if (title) $('offline-title').textContent = title;
  if (detail) $('offline-detail').textContent = detail;
}

async function poll() {
  try {
    const s = await api('status');

    // The page is older than the server it is talking to. Say exactly that,
    // instead of letting the resulting 404s look like a missing cube.
    if (s.build && PAGE_BUILD && s.build !== PAGE_BUILD) {
      setOffline(true, 'This page is out of date.',
        'Drostex was updated while this tab was open. Reload to pick up the new version.');
      setTally('offline', 'reload needed');
      return;
    }

    if (s.online) {
      offlineStrikes = 0;
      setOffline(false);
      fillSymmetry(s.config.symmetries ?? ['none']);
      // Address layout comes from the server's config, so a differently wired
      // unit previews as itself instead of as the one this was written on.
      preview.setGeometry(s.config);
      // The preview has to undo the same gamma the renderer applied, so it
      // reads it from the renderer rather than assuming the default.
      preview.setGamma(s.renderer?.params?.gamma);
    } else if (++offlineStrikes >= 3) {
      setOffline(true, "Can't reach the cube.",
        `Check it's powered on and on the same network as this computer (${s.config.host}).`);
    }

    if (!s.online) {
      setTally(offlineStrikes >= 3 ? 'offline' : 'idle',
               offlineStrikes >= 3 ? 'cube unreachable' : 'reconnecting…');
      return;
    }

    renderCycle(s.cycle);

    if (s.renderer.running) {
      setTally('streaming', `streaming · ${s.renderer.animation}`);
      if (s.renderer.animation !== current) {
        if (s.renderer.animParams && schemas[s.renderer.animation]) {
          schemas[s.renderer.animation].values = s.renderer.animParams;
        }
        markActive(s.renderer.animation);
        buildInspector(s.renderer.animation);
      }
    } else {
      setTally('onboard', 'the cube’s own effect');
      if (current !== null) markActive(null);
    }

    // Seed brightness from wherever it currently lives, until the user takes over.
    if (!brightnessSynced) {
      const v = s.renderer.running
        ? Math.round(s.renderer.params.brightness * 255)
        : (s.renderer.deviceBrightness ?? 150);
      brightness.value = String(v);
      $('brightness-out').textContent = String(v);
    }

    if (s.device) {
      // Not while someone is typing into it: a 2s poll landing mid-edit would
      // otherwise reset the field under their cursor.
      if (!renaming) {
        $('device-name').textContent = s.device.name ?? s.device.product ?? '—';
      }
      $('power').checked = Boolean(s.device.on ?? true);
      if (s.device.sym != null) $('fx-symmetry').value = String(s.device.sym);
      renderOwners(s.device);
      // While we are streaming, the cube's own fx is stale - it is what will
      // resume on Stop, not what is on the LEDs - so nothing there is lit.
      markDeviceFx(s.renderer.running ? null : s.device.fx);
      if (s.device.sparkle != null) {
        for (const b of $('fx-sparkle').children) {
          b.classList.toggle('is-on', b.dataset.v === String(s.device.sparkle));
        }
      }
      if (s.device.power != null) {
        $('device-power').textContent = `${s.device.power} mA`;
        draw.push(s.device.power);
        if (draw.length > 40) draw.shift();
        drawSparkline();
      }
    }
  } catch (e) {
    if (++offlineStrikes < 3) { setTally('idle', 'reconnecting…'); return; }
    setTally('offline', 'server unreachable');
    // A 404 means the server is running older code than this page expects,
    // which happens whenever the server was left up across an update. That is a
    // completely different problem from the cube being unplugged, and saying
    // "stopped responding" for it sends you looking in the wrong place.
    if (e?.status === 404) {
      setOffline(true, 'Drostex needs restarting.',
        'The server is running an older version than this page. Stop it and run npm start again.');
    } else {
      setOffline(true, 'Lost the Drostex server.',
        'The local server stopped responding. Is it still running in your terminal?');
    }
  }
}

$('retry').addEventListener('click', () => { offlineStrikes = 0; poll(); });

try {
  // Before the grids, so the first paint already knows what is starred.
  favorites = await api('favorites');
  await loadAnimations();
  await renderPresets(await api('presets'));
  renderCycle(await api('cycle'));
} catch (e) {
  setOffline(true,
    e?.status === 404 ? 'Drostex needs restarting.' : 'Could not start.',
    e?.status === 404
      ? 'The server is running an older version than this page. Stop it and run npm start again.'
      : `Failed to load: ${e.message}`);
}
/* ── theme ────────────────────────────────────────────────────
   Three states, and "system" is an explicit one rather than the absence of a
   choice. No attribute means dark, which is what this app has always been;
   picking "system" opts into following the OS, and the media query in
   style.css keeps deciding for as long as that is selected, including if the
   OS flips while the tab is open. The head script has already applied any
   stored choice, so this only wires the control and keeps it in step. */
(function theme() {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll('[data-theme-choice]')];

  const current = () => root.getAttribute('data-theme') ?? 'dark';

  function paint() {
    const now = current();
    for (const b of buttons) {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === now));
    }
  }

  function set(choice) {
    // Every choice, including system, is stored explicitly. Absence of the
    // attribute means dark, so "system" has to be written down to take effect.
    root.setAttribute('data-theme', choice);
    try { localStorage.setItem('drostex-theme', choice); }
    catch { /* storage blocked; the choice still holds for this tab */ }
    paint();
  }

  for (const b of buttons) b.addEventListener('click', () => set(b.dataset.themeChoice));
  paint();
})();

/* ── renaming the cube ────────────────────────────────────────
   The h1 IS the device name, so it is also the edit affordance. The write goes
   to the cube, not to a local setting: /json/info is where every client reads
   the name from, this page included. */
let renaming = false;

function startRename() {
  if (renaming || !deviceOnline) return;
  renaming = true;
  const label = $('device-name');
  const input = $('device-rename');
  input.value = label.textContent.trim() === '—' ? '' : label.textContent.trim();
  label.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

async function commitRename() {
  if (!renaming) return;
  renaming = false;
  const label = $('device-name');
  const input = $('device-rename');
  const next = input.value.trim();
  input.hidden = true;
  label.hidden = false;

  if (!next || next === label.textContent.trim()) return;

  const previous = label.textContent;
  label.textContent = next;                 // optimistic; poll confirms
  try {
    const r = await api('device/name', { name: next });
    // The device is the authority on its own name, so adopt what it reports
    // rather than what we asked for.
    label.textContent = r.name;
    if (!r.verified) {
      // The rename landed but the read-back says something else on that
      // settings page moved. Better to say so than to let them find it.
      setOffline(true, 'Renamed, but check the cube’s settings.',
        `Other settings changed unexpectedly: ${r.drifted.join(', ')}`);
    }
  } catch (e) {
    label.textContent = previous;
    setOffline(true, 'Could not rename the cube.', e.message);
  }
}

function cancelRename() {
  if (!renaming) return;
  renaming = false;
  $('device-rename').hidden = true;
  $('device-name').hidden = false;
}

$('device-name').addEventListener('click', startRename);
$('device-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startRename(); }
});
$('device-rename').addEventListener('blur', commitRename);
$('device-rename').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('device-rename').blur(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
});

/* ── finding the cube ─────────────────────────────────────────
   Offered from the offline banner, where a wrong address is the most likely
   cause. mDNS does not cross VLANs and plenty of networks block it, so the
   failure message has to name the manual route rather than just say "none". */
$('find-cube').addEventListener('click', async () => {
  const b = $('find-cube');
  b.disabled = true;
  const was = b.textContent;
  b.textContent = 'Looking…';
  try {
    const { devices, current } = await api('discover');
    if (!devices.length) {
      $('offline-detail').textContent =
        'Nothing answered on the network. mDNS does not cross VLANs and some '
        + 'networks block it, so set the address by hand in config.json.';
    } else {
      const list = devices.map((d) => `${d.name} at ${d.host}`).join(', ');
      $('offline-detail').textContent = devices.some((d) => d.host === current)
        ? `Found ${list}, which is the address already configured. The cube is `
          + 'on the network but not answering, so try power-cycling it.'
        : `Found ${list}. Put that address in config.json and restart Drostex.`;
    }
  } catch (e) {
    $('offline-detail').textContent = `Could not search: ${e.message}`;
  } finally {
    b.textContent = was;
    b.disabled = false;
  }
});

/* ── cube preview ─────────────────────────────────────────────
   Frames are read back from the server rather than recomputed here, so the
   preview cannot drift from what was actually sent. It only runs while WE are
   the pixel source: during a firmware effect the server has no idea what the
   LEDs are doing, and a stale frame shown as live would be a lie. */
const preview = new CubePreview($('cube'));

async function pumpPreview() {
  // Nothing to draw into: the inspector is closed, so skip the request
  // entirely rather than polling for pixels nobody can see.
  if ($('inspector').hidden) return;
  try {
    const { pixels, running } = await api('pixels');
    preview.setPixels(pixels, running);
    $('preview').dataset.live = String(Boolean(running));
  } catch {
    // A dropped readback is not worth surfacing; the next tick will do.
    $('preview').dataset.live = 'false';
  }
}
// 100ms against our own local server, not the cube. This is a loopback HTTP
// call that reads a Buffer already in memory, so it costs the ESP32 nothing.
setInterval(pumpPreview, 100);

await poll();
// 2s is plenty for status, but the auto-cycle countdown reads badly at that
// rate, so it ticks locally between polls.
setInterval(poll, 2000);
setInterval(() => {
  // Only the seconds node, so the item name beside it survives.
  const el = $('cycle-left');
  if (!el) return;
  const n = parseInt(el.textContent, 10);
  if (Number.isFinite(n) && n > 0) el.textContent = `${n - 1}s`;
}, 1000);
