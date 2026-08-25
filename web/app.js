/**
 * Drostex UI.
 *
 * Deliberately thin. The server owns the pixels and the UDP socket, so this
 * page only ever sends control messages and reflects state back. That is what
 * lets an animation survive closing the tab.
 */

const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(`/api/${path}`, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};

let current = null;      // active animation id
let effectsLoaded = false;
let brightnessSynced = false;

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

/* ── studio ───────────────────────────────────────────────── */

let schemas = {};   // id -> { params, values }

async function loadAnimations() {
  const list = await api('animations');
  schemas = Object.fromEntries(list.map((a) => [a.id, a]));
  const grid = $('animations');
  grid.replaceChildren(...list.map((a) => {
    const el = document.createElement('button');
    el.className = 'card';
    el.dataset.id = a.id;
    el.innerHTML = `<span class="name"></span><span class="desc"></span>`;
    el.querySelector('.name').textContent = a.label;
    el.querySelector('.desc').textContent = a.desc;
    el.addEventListener('click', () => play(a.id));
    return el;
  }));
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

/**
 * Builds the parameter controls from the animation's declared schema.
 *
 * Nothing here knows about any particular animation - adding a knob is a
 * one-line change in animations.mjs and appears here automatically. This is the
 * same contract the node editor will use for exposed node inputs.
 */
function buildInspector(name) {
  const spec = schemas[name];
  const host = $('params');
  if (!spec) { host.replaceChildren(); return; }

  const values = { ...spec.values };
  const push = debounce(() => api('anim-params', { name, values }), 60);

  host.replaceChildren(...Object.entries(spec.params).map(([key, def]) => {
    const wrap = document.createElement('div');
    wrap.className = 'param';

    const label = document.createElement('label');
    label.textContent = def.label ?? key;
    label.htmlFor = `p-${key}`;
    const out = document.createElement('output');
    label.appendChild(out);
    wrap.appendChild(label);

    let input;
    if (def.type === 'number') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = def.min; input.max = def.max; input.step = def.step ?? 0.01;
      input.value = values[key];
      out.textContent = fmt(values[key]);
      input.addEventListener('input', () => {
        values[key] = Number(input.value);
        out.textContent = fmt(values[key]);
        push();
      });
    } else if (def.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = values[key];
      input.addEventListener('input', () => { values[key] = input.value; push(); });
    } else if (def.type === 'boolean') {
      const sw = document.createElement('label');
      sw.className = 'switch';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(values[key]);
      input.addEventListener('change', () => { values[key] = input.checked; push(); });
      sw.append(input, document.createElement('span'));
      wrap.appendChild(sw);
      if (def.hint) wrap.appendChild(hintEl(def.hint));
      return wrap;
    } else {
      input = document.createElement('select');
      input.replaceChildren(...def.options.map((o) => {
        const el = document.createElement('option');
        el.value = o; el.textContent = o;
        return el;
      }));
      input.value = values[key];
      input.addEventListener('change', () => { values[key] = input.value; push(); });
    }
    input.id = `p-${key}`;
    wrap.appendChild(input);
    if (def.hint) wrap.appendChild(hintEl(def.hint));
    return wrap;
  }));
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(2));
function hintEl(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}
function debounce(fn, ms) {
  let t = null;
  return (...a) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

$('reset-params').addEventListener('click', async () => {
  if (!current) return;
  const { values } = await api('anim-params', { name: current, reset: true });
  schemas[current].values = values;
  buildInspector(current);
});

$('stop').addEventListener('click', async () => {
  markActive(null);
  await api('stop', {});
});

/* ── presets ──────────────────────────────────────────────── */

async function renderPresets(list) {
  const host = $('presets');
  if (!list.length) {
    host.replaceChildren(Object.assign(document.createElement('p'),
      { className: 'empty', textContent: 'Nothing saved yet.' }));
    return;
  }
  host.replaceChildren(...list.map((p) => {
    const row = document.createElement('div');
    row.className = 'preset';
    const load = document.createElement('button');
    load.className = 'load';
    load.textContent = p.name;
    load.addEventListener('click', async () => {
      const st = await api('presets/load', { id: p.id });
      schemas[st.animation].values = st.animParams;
      markActive(st.animation);
      buildInspector(st.animation);
      syncPlayback(st);
    });
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = p.animation;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '\u00d7';
    del.title = 'Delete';
    del.addEventListener('click', async () => renderPresets(await api('presets', { delete: p.id })));
    row.append(load, meta, del);
    return row;
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

/* ── playback sliders ─────────────────────────────────────── */

/* Brightness is 0-255 to match the vendor app, so a number here means the same
   thing it does there. It is applied locally rather than on the device, because
   the device scales realtime pixels by its own brightness and would clip our
   range - but the units are theirs. */
const params = () => ({
  brightness: Number($('brightness').value) / 255,
  speed: Number($('speed').value) / 100,
  fps: Number($('fps').value),
});

function bindSlider(id, format) {
  const el = $(id);
  const out = $(`${id}-out`);
  const sync = () => { out.textContent = format(Number(el.value)); };
  el.addEventListener('input', () => {
    if (id === 'brightness') brightnessSynced = true; // their choice now wins
    sync();
    api('params', params());
  });
  sync();
}
bindSlider('brightness', (v) => String(v));
bindSlider('speed', (v) => `${(v / 100).toFixed(1)}\u00d7`);
bindSlider('fps', (v) => `${v} fps`);

function syncPlayback(st) {
  const b = Math.round(st.params.brightness * 255);
  $('brightness').value = String(b);
  $('brightness-out').textContent = String(b);
  $('speed').value = String(Math.round(st.params.speed * 100));
  $('speed-out').textContent = `${st.params.speed.toFixed(1)}\u00d7`;
}

/* ── onboard effects & device controls ────────────────────
 *
 * Everything here is a control-plane call: the cube's own firmware does the
 * rendering, so these survive closing Drostex. `sb`, `sparkle` and `warp` are
 * vendor additions outside WLED's usual schema, found by reading the cube's
 * own web UI - they are not documented anywhere.
 */

const SYMMETRY = ['Default', 'None', 'Cubic', 'Helical', 'Trigonal',
                  'Mirror', 'Vertex', 'Inversion', 'Cyclic'];

const setState = (body) => api('device/state', body);
const setSeg = (patch) => setState({ seg: [patch] });

async function loadEffects() {
  effectsLoaded = true;
  const { effects, palettes, state } = await api('effects');
  const seg = state?.seg?.[0] ?? {};

  const fill = (el, items, value) => {
    el.replaceChildren(...items.map((it, i) => {
      const o = document.createElement('option');
      o.value = it.id ?? i;
      o.textContent = it.label ?? it;
      return o;
    }));
    if (value != null) el.value = String(value);
  };

  fill($('palette'), palettes, seg.pal);
  fill($('symmetry'), SYMMETRY, seg.sym ?? 0);

  $('palette').addEventListener('change', (e) => setSeg({ pal: Number(e.target.value) }));
  $('symmetry').addEventListener('change', (e) => setSeg({ sym: Number(e.target.value) }));
  $('sparkle').addEventListener('change', (e) => setState({ sparkle: Number(e.target.value) }));

  $('power').addEventListener('change', (e) => setState({ on: e.target.checked }));
  $('psd').addEventListener('change', (e) => setSeg({ psd: e.target.checked }));
  $('nl').addEventListener('change', (e) => setState({ nl: { on: e.target.checked } }));

  // The same underlying setting, surfaced in both tabs - keep them in step.
  for (const id of ['sb', 'sb-studio']) {
    $(id).addEventListener('change', (e) => {
      const on = e.target.checked;
      $('sb').checked = on;
      $('sb-studio').checked = on;
      setState({ sb: on });
    });
  }

  // Vendor one-shot with a 15s cooldown in their own UI; mirror that so the
  // button cannot be hammered into a queue of overlapping animations.
  $('warp').addEventListener('click', async () => {
    const b = $('warp');
    b.disabled = true;
    try { await api('warp', {}); } finally {
      setTimeout(() => { b.disabled = false; }, 15000);
    }
  });

  bindDeviceSlider('dev-bri', (v) => `${Math.round(v / 255 * 100)}%`, (v) => setState({ bri: v }), seg, state?.bri);
  bindDeviceSlider('sx', (v) => String(v), (v) => setSeg({ sx: v }), seg, seg.sx);
  bindDeviceSlider('ix', (v) => String(v), (v) => setSeg({ ix: v }), seg, seg.ix);

  const grid = $('effects');
  grid.replaceChildren(...effects.map((e) => {
    const el = document.createElement('button');
    el.className = 'card compact';
    el.dataset.fx = e.id;
    el.innerHTML = `<span class="name"></span>`;
    el.querySelector('.name').textContent = e.label;
    el.addEventListener('click', async () => {
      for (const c of grid.children) c.classList.toggle('is-active', c === el);
      markActive(null); // the server stops the stream; reflect that immediately
      await setSeg({ fx: e.id });
    });
    return el;
  }));
  grid.querySelector(`[data-fx="${seg.fx}"]`)?.classList.add('is-active');

  // Reflect current device state in the toggles.
  $('power').checked = Boolean(state?.on);
  $('psd').checked = Boolean(seg.psd);
  $('nl').checked = Boolean(state?.nl?.on);
  $('sb').checked = Boolean(state?.sb);
  $('sb-studio').checked = Boolean(state?.sb);
  $('sparkle').value = String(state?.sparkle ?? 0);
}

/** Slider that writes straight to the device, throttled to avoid flooding it. */
function bindDeviceSlider(id, format, send, seg, initial) {
  const el = $(id);
  const out = $(`${id}-out`);
  if (initial != null) el.value = String(initial);
  out.textContent = format(Number(el.value));

  let pending = null, timer = null;
  el.addEventListener('input', () => {
    const v = Number(el.value);
    out.textContent = format(v);
    pending = v;
    // The cube is an ESP32 on 2.4GHz; a POST per input event would swamp it.
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending != null) { send(pending); pending = null; }
    }, 120);
  });
}

/* ── status polling ───────────────────────────────────────── */
function setTally(state, text) {
  $('tally').dataset.state = state;
  $('tally-text').textContent = text;
}

async function poll() {
  try {
    const s = await api('status');
    if (!s.online) {
      setTally('offline', 'cube unreachable');
    } else if (s.renderer.running) {
      setTally('streaming', `streaming · ${s.renderer.animation}`);
      if (s.renderer.animation !== current) {
        if (s.renderer.animParams) schemas[s.renderer.animation].values = s.renderer.animParams;
        markActive(s.renderer.animation);
        buildInspector(s.renderer.animation);
      }
    } else {
      setTally('onboard', 'onboard · not streaming');
      if (current !== null) markActive(null);
    }

    // Seed the slider from the cube's own brightness rather than a hardcoded
    // default, so the app opens at the level the user already chose. Once they
    // move it, their choice wins and we stop syncing.
    if (!brightnessSynced && !s.renderer.brightnessTouched && s.renderer.deviceBrightness != null) {
      const v = Math.round(s.renderer.params.brightness * 255);
      $('brightness').value = String(v);
      $('brightness-out').textContent = String(v);
      brightnessSynced = true;
    }

    if (s.device) {
      $('device-name').textContent = s.device.name ?? s.device.product ?? '—';
      $('device-pixels').textContent = `${s.config.working} px · ${s.config.perEdge}/edge`;
      $('device-power').textContent = s.device.power != null ? `${s.device.power} mA` : '—';
    }
  } catch {
    setTally('offline', 'server unreachable');
  }
}

await loadAnimations();
await renderPresets(await api('presets'));
await poll();
setInterval(poll, 2000);
