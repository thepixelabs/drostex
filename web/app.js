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
async function loadAnimations() {
  const list = await api('animations');
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
}

$('stop').addEventListener('click', async () => {
  markActive(null);
  await api('stop', {});
});

/* Sliders push params live. Sending on every input event is fine here: the
   payload is tiny, it goes to loopback, and the renderer just reads the values
   on its next frame. */
const params = () => ({
  brightness: Number($('brightness').value) / 100,
  speed: Number($('speed').value) / 100,
  fps: Number($('fps').value),
});

function bindSlider(id, format) {
  const el = $(id);
  const out = $(`${id}-out`);
  const sync = () => { out.textContent = format(Number(el.value)); };
  el.addEventListener('input', () => { sync(); api('params', params()); });
  sync();
}
bindSlider('brightness', (v) => `${v}%`);
bindSlider('speed', (v) => `${(v / 100).toFixed(1)}×`);
bindSlider('fps', (v) => `${v} fps`);

/* ── onboard effects ──────────────────────────────────────── */
async function loadEffects() {
  effectsLoaded = true;
  const { effects, palettes, state } = await api('effects');

  const sel = $('palette');
  sel.replaceChildren(...palettes.map((p) => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.label;
    return o;
  }));
  if (state?.seg?.[0]) sel.value = state.seg[0].pal;
  sel.addEventListener('change', () => {
    api('device/state', { seg: [{ pal: Number(sel.value) }] });
  });

  const grid = $('effects');
  grid.replaceChildren(...effects.map((e) => {
    const el = document.createElement('button');
    el.className = 'card compact';
    el.dataset.fx = e.id;
    el.innerHTML = `<span class="name"></span>`;
    el.querySelector('.name').textContent = e.label;
    el.addEventListener('click', async () => {
      for (const c of grid.children) c.classList.toggle('is-active', c === el);
      markActive(null); // the stream is stopped server-side; reflect that here
      await api('device/state', { seg: [{ fx: e.id }] });
    });
    return el;
  }));
  if (state?.seg?.[0]) {
    const active = grid.querySelector(`[data-fx="${state.seg[0].fx}"]`);
    active?.classList.add('is-active');
  }
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
      if (s.renderer.animation !== current) markActive(s.renderer.animation);
    } else {
      setTally('onboard', 'onboard · not streaming');
      if (current !== null) markActive(null);
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
await poll();
setInterval(poll, 2000);
