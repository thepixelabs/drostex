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

/** A gradient that hints at what a pattern looks like, from its own defaults. */
function swatchFor(spec) {
  const v = spec.values ?? {};
  if (v.paletteName && palettes[v.paletteName]) return css(palettes[v.paletteName]);
  const cols = Object.entries(spec.params ?? {})
    .filter(([, d]) => d.type === 'color')
    .map(([k]) => v[k]);
  if (cols.length >= 2) return `linear-gradient(90deg, ${cols.join(',')})`;
  if (cols.length === 1) return `linear-gradient(90deg, #0A0B0F, ${cols[0]})`;
  return palettes.spectrum ? css(palettes.spectrum) : 'linear-gradient(90deg,#444,#888)';
}

function card({ cls = '', swatch, name, desc, onClick }) {
  const el = document.createElement('button');
  el.className = `card ${cls}`.trim();
  if (swatch) {
    const s = document.createElement('span');
    s.className = 'swatch';
    s.style.setProperty('--sw', swatch);
    el.appendChild(s);
  }
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
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/* ── patterns ─────────────────────────────────────────────── */
async function loadAnimations() {
  palettes = await api('palettes');
  const list = await api('animations');
  schemas = Object.fromEntries(list.map((a) => [a.id, a]));

  const grid = $('animations');
  const cards = list.filter((a) => a.id !== 'custom').map((a) => {
    const el = card({ swatch: swatchFor(a), name: a.label, desc: a.desc, onClick: () => play(a.id) });
    el.dataset.id = a.id;
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
  host.replaceChildren(...list.map((preset) => {
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
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = spec?.label ?? preset.animation;
    el.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete';
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

const FX_SYMMETRY = ['Default', 'None', 'Cubic', 'Helical', 'Trigonal',
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

const MODE_DESC = {
  0: 'bright, kaleidoscopic patterns',
  1: 'slow and calm',
  2: 'reacts to sound using the cube\u2019s microphone',
};

async function loadEffects() {
  effectsLoaded = true;
  const { effects, palettes: pals, state } = await api('effects');
  // Modes are playlists; the rest are single effects. Separate lists.
  allEffects = effects.filter((e) => !/^Mode:/.test(e.label));
  const modes = effects.filter((e) => /^Mode:/.test(e.label));
  const seg = state?.seg?.[0] ?? {};

  const sel = $('palette');
  sel.replaceChildren(...pals.map((p) => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.label;
    return o;
  }));
  if (seg.pal != null) sel.value = String(seg.pal);
  sel.addEventListener('change', () => api('device/state', { seg: [{ pal: Number(sel.value) }] }));

  $('sb').addEventListener('change', (e) => api('device/state', { sb: e.target.checked }));
  $('psd').addEventListener('change', (e) => api('device/state', { seg: [{ psd: e.target.checked }] }));
  $('nl').addEventListener('change', (e) => api('device/state', { nl: { on: e.target.checked } }));

  bindDeviceSlider('sx', (v) => String(v), (v) => api('device/state', { seg: [{ sx: v }] }), seg.sx);
  bindDeviceSlider('ix', (v) => String(v), (v) => api('device/state', { seg: [{ ix: v }] }), seg.ix);

  $('fx-search').addEventListener('input', (e) => { fxQuery = e.target.value.toLowerCase(); renderEffects(); });
  bindSeg('fx-filter', (v) => { fxFilter = v; renderEffects(); });

  const modeGrid = $('modes');
  modeGrid.replaceChildren(...modes.map((m) => {
    const el = card({
      name: m.label.replace(/^Mode:\s*/, ''),
      desc: MODE_DESC[m.id] ?? 'a rotating playlist of the cube\u2019s own patterns',
      onClick: async () => {
        for (const c of modeGrid.children) c.classList.toggle('is-active', c === el);
        for (const c of $('effects').children) c.classList.remove('is-active');
        markActive(null);
        await api('device/state', { seg: [{ fx: m.id }] });
      },
    });
    el.dataset.fx = m.id;
    if (seg.fx === m.id) el.classList.add('is-active');
    return el;
  }));

  renderEffects(seg.fx);
}

function renderEffects(activeId) {
  const grid = $('effects');
  const list = allEffects.filter((e) =>
    (fxFilter === 'all' || (fxFilter === 'sound') === Boolean(e.sound)) &&
    (!fxQuery || e.label.toLowerCase().includes(fxQuery)));

  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No effects match that.';
    grid.replaceChildren(p);
    return;
  }

  grid.replaceChildren(...list.map((e) => {
    const el = card({
      cls: 'compact',
      name: e.label,
      onClick: async () => {
        for (const c of grid.children) c.classList.toggle('is-active', c === el);
        for (const c of $('modes').children) c.classList.remove('is-active');
        markActive(null);      // the server stops our stream; reflect it now
        await api('device/state', { seg: [{ fx: e.id }] });
      },
    });
    el.dataset.fx = e.id;
    if (activeId === e.id) el.classList.add('is-active');
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
}

/** Device sliders are throttled harder: it's an ESP32 on 2.4GHz. */
function bindDeviceSlider(id, format, send, initial) {
  const el = $(id);
  const out = $(`${id}-out`);
  if (initial != null) el.value = String(initial);
  out.textContent = format(Number(el.value));
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
      $('device-name').textContent = s.device.name ?? s.device.product ?? '—';
      $('power').checked = Boolean(s.device.on ?? true);
      if (s.device.sym != null) $('fx-symmetry').value = String(s.device.sym);
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
