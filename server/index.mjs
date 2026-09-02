#!/usr/bin/env node
/**
 * Drostex server.
 *
 * Serves the UI and owns the UDP socket. A browser cannot send UDP - there is
 * no API for it - so something local has to hold that socket. Pixels are
 * computed here rather than in the page, which means an animation keeps running
 * after you close the tab.
 *
 * Zero runtime dependencies: node:http, node:fs, node:dgram. Nothing to install
 * and no native build, which is the difference between "clone and run" and
 * "clone and debug node-gyp".
 *
 *     npm start          or      node server/index.mjs
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { exec } from 'node:child_process';
import { loadConfig, resolveHardware } from '../scripts/lib/config.mjs';
import { Renderer } from '../src/renderer.mjs';
import { ANIMATIONS, PALETTES, iq, SYMMETRY_NAMES, resolveSchema } from '../src/animations.mjs';
import { Cycler, POOLS } from '../src/cycler.mjs';
import { paletteStops } from '../src/device-palettes.mjs';
import { discover, localAddresses } from '../src/discover.mjs';
import { setDeviceName } from '../src/device-name.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 7847);
/**
 * Remote: whether a phone on the network can reach the UI.
 *
 * Off at every start, and switched from the page rather than the terminal.
 * The loopback listener never goes away; switching Remote on adds a listener
 * on each of this machine's LAN addresses, on the same port, and switching it
 * off closes them again along with every connection they accepted. Nothing
 * persists: a restart is back to this machine only, because Remote changes
 * who can control the cube from "this computer" to "anyone on the Wi-Fi",
 * with no password in between. --lan (or DROSTEX_LAN=1) starts with it
 * already on, for a machine that only ever sits on a network you trust.
 *
 * Only a request from a loopback socket may flip it. The phone gets the UI;
 * it does not get to decide whether the door stays open.
 */
const START_REMOTE = process.argv.includes('--lan') || process.env.DROSTEX_LAN === '1';
const remote = new Map(); // LAN address -> the http.Server listening on it
const remoteOn = () => remote.size > 0;

/**
 * Resolves the device address, looking on the network if nobody named one.
 *
 * `source: 'example'` means the address came from the committed template, so
 * it is a placeholder rather than a choice, and asking mDNS is strictly better
 * than streaming at 192.168.1.50 and reporting the cube offline. Anything the
 * user actually configured wins without a query being sent: discovery costs
 * two seconds and should not be on the path of a working setup.
 */
async function resolveConfig() {
  const cfg = loadConfig();
  if (cfg.source !== 'example') return cfg;

  console.log('\n  No device configured. Looking for one on the network...');
  const found = await discover({ timeout: 2500 });

  if (!found.length) {
    console.log('  Found nothing. mDNS does not cross VLANs and some networks block it.');
    console.log('  Set the address by hand:  cp config.example.json config.json\n');
    return cfg;
  }
  const pick = found[0];
  console.log(`  Found ${pick.name} at ${pick.host}${found.length > 1 ? ` (and ${found.length - 1} more)` : ''}`);
  console.log('  Using it for this run. To make it permanent, put it in config.json.');
  return loadConfig({ host: pick.host });
}

// Then ask the cube what it is. One /json/info with a short timeout settles
// the model, the address count and the LEDs per edge before the renderer
// sizes its buffer; a cube that is off right now just leaves the config as
// config.json and the model table had it.
const CONFIG = await resolveHardware(await resolveConfig());
const renderer = new Renderer(CONFIG);

/**
 * Which patterns each `Mode:` playlist rotates through.
 *
 * The firmware will not tell us - /json/fxdata answers 501, and `pl` is pinned
 * at -1 because these rotations are not WLED playlists. But the cube's own web
 * UI partitions the effect table by fixed index ranges to build its dropdown
 * (`splice(0,5)` past the modes, then 75, then 40, then the remainder), and
 * those boundaries land exactly on the blank-line group breaks in the array.
 * No name straddles one.
 *
 * Reading the ranges off that partition rather than hand-listing 95 names means
 * a firmware update that reshuffles the table moves one constant instead of
 * silently lying about what a playlist plays.
 */
const MODE_RANGES = { 0: [5, 79], 1: [80, 119], 2: [120, 159] };
function modeOf(id) {
  // Kaleidoscopic is mode 0, so this returns null explicitly rather than
  // leaning on falsiness - `|| null` would swallow it.
  for (const [mode, [lo, hi]] of Object.entries(MODE_RANGES)) {
    if (id >= lo && id <= hi) return Number(mode);
  }
  return null;
}

/** Effects are static for a given firmware, so fetch the list once. */
let effectsCache = null;
async function listEffects() {
  if (effectsCache) return effectsCache;
  const all = await device('/json');
  const real = all.effects
    .map((label, id) => ({ id, label, sound: isSoundReactive(id, label), mode: /^Mode:/.test(label) }))
    .filter((e) => e.label && e.label !== '-');
  effectsCache = real.map((e) => (e.mode
    // Members are resolved against the SAME filtered list, so the counts the UI
    // shows are the patterns you can actually see, not the padded range width.
    ? { ...e, members: real.filter((x) => !x.mode && modeOf(x.id) === e.id).map((x) => x.id) }
    : { ...e, modeId: modeOf(e.id) }));
  return effectsCache;
}

const cycler = new Cycler({
  renderer,
  device: (path, init) => device(path, init),
  listPresets: () => loadPresets(),
  listFavorites: () => loadFavorites(),
  listEffects,
  animations: ANIMATIONS,
});

/**
 * A build stamp over the served assets, injected into the page and reported by
 * /api/status. If the two disagree the page is older than the server, which
 * happens whenever a server is left running across an update - a failure that
 * previously surfaced as "can't reach the cube" and sent people looking at
 * their network.
 */
const BUILD = createHash('sha1')
  .update(await readFile(join(ROOT, 'web/app.js')))
  .update(await readFile(join(ROOT, 'web/cube.mjs')))
  .update(await readFile(join(ROOT, 'web/qr.mjs')))
  .update(await readFile(join(ROOT, 'web/index.html')))
  .update(await readFile(join(ROOT, 'web/style.css')))
  .digest('hex').slice(0, 8);

const PRESETS = join(ROOT, 'presets.json');
const FAVORITES = join(ROOT, 'favorites.json');

/**
 * Stars on things Drostex does not own.
 *
 * A saved look carries its own `favorite` flag inside presets.json, because it
 * is user data with a home already - and deleting the look takes the star with
 * it for free. Patterns and the firmware's effects are fixed catalogues with
 * nowhere to put a flag, so their stars live here, keyed by id.
 */
async function loadFavorites() {
  try {
    const f = JSON.parse(await readFile(FAVORITES, 'utf8'));
    return { animation: f.animation ?? [], effect: f.effect ?? [] };
  } catch { return { animation: [], effect: [] }; }
}
async function saveFavorites(f) {
  await writeFile(FAVORITES, JSON.stringify(f, null, 2) + '\n');
}

/** Presets live in a plain JSON file - they are user data, not source. */
async function loadPresets() {
  try { return JSON.parse(await readFile(PRESETS, 'utf8')); } catch { return []; }
}
async function savePresets(list) {
  await writeFile(PRESETS, JSON.stringify(list, null, 2) + '\n');
}

/**
 * Whether an effect needs sound to do anything.
 *
 * The firmware exposes no flag for this, but the 31 sound-reactive effects sit
 * in a contiguous block and their names cluster unmistakably. Worth marking,
 * because they look broken in a silent room.
 */
const SOUND_WORDS = /sonic|sound|spectrogram|harmonic|resonan|aural|acoustic|melodic|rhythmic|tonal|symphon|beat|ultrasonic|hypersonic|synesthesia|light sound/i;
const isSoundReactive = (id, label) => id >= 120 || SOUND_WORDS.test(label);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Without this, .mjs falls through to application/octet-stream and the
  // browser refuses to execute the module outright: strict MIME checking on
  // ES modules is not advisory. Symptom is a blank page and one console line.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req) => new Promise((resolve) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
});

/** Proxies the cube's own JSON API, for control-plane calls. */
async function device(path, init) {
  const r = await fetch(`http://${CONFIG.host}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
  });
  return r.json();
}

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  // normalize + prefix check keeps ../ out of the served tree
  const file = normalize(join(WEB, path));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    let body = await readFile(file);
    if (file.endsWith('index.html')) {
      body = Buffer.from(body.toString().replace('__BUILD__', BUILD));
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOOPBACK_SOCKETS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whether a Host header names this machine.
 *
 * Loopback always does. With Remote on, so does each LAN address that has a
 * listener right now, which is what a phone on the network sends. Only
 * literal addresses, never a hostname: a DNS name an attacker controls can be
 * pointed at us, but 192.168.1.20 cannot be made to mean anything other than
 * what it is.
 */
function hostIsUs(host) {
  return LOOPBACK.has(host) || remote.has(host);
}

/** Whether the request came in over loopback, which no header can fake. */
const fromThisMachine = (req) => LOOPBACK_SOCKETS.has(req.socket.remoteAddress);

/**
 * The addresses worth putting in front of a phone, most likely first.
 *
 * A laptop often has several: the Wi-Fi one, a VPN, a container bridge, a
 * link-local leftover. The phone is on the same network as the cube, so the
 * address that shares the cube's /24 wins outright; after that home-router
 * ranges rank ahead of the rest and 169.254 goes last. Without that first
 * rule a machine with a few VPN tunnels in 192.168.x showed whichever the
 * OS listed first, which was right only by luck.
 */
function shareAddresses() {
  const subnet = (a) => a.split('.').slice(0, 3).join('.');
  const cube = subnet(CONFIG.host ?? '');
  const rank = (a) => (subnet(a) === cube ? -1
    : a.startsWith('192.168.') ? 0
    : a.startsWith('10.') ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2
    : a.startsWith('169.254.') ? 9 : 5);
  return [...localAddresses()].sort((a, b) => rank(a) - rank(b));
}

/** What a phone should scan: the addresses with a listener, most likely first. */
const remoteUrls = () => shareAddresses().filter((a) => remote.has(a)).map((a) => `http://${a}:${PORT}`);

/**
 * Switches Remote on: one listener per LAN address, sharing the loopback
 * server's handler. An address that refuses to bind is reported rather than
 * fatal, so a VPN interface cannot take the Wi-Fi one down with it.
 */
async function openRemote() {
  const problems = [];
  for (const addr of shareAddresses()) {
    if (remote.has(addr)) continue;
    const s = http.createServer(handle);
    try {
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(PORT, addr, () => { s.off('error', reject); resolve(); });
      });
      s.on('error', (e) => console.error(`  ! Remote listener on ${addr}: ${e.message}`));
      remote.set(addr, s);
    } catch (e) {
      problems.push(`${addr}: ${e.code ?? e.message}`);
    }
  }
  if (!remote.size && !problems.length) problems.push('No network address found on this computer. Is it on Wi-Fi?');
  if (remote.size) {
    console.log(`\n  Remote  on: ${remoteUrls().join(', ')}`);
    console.log(`          anyone on this network can control the cube. No password.\n`);
  }
  return problems;
}

/** Switches Remote off: stops accepting, then drops every open connection. */
async function closeRemote() {
  const servers = [...remote.values()];
  remote.clear();
  await Promise.all(servers.map((s) => new Promise((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections();
  })));
  if (servers.length) console.log(`\n  Remote  off: this computer only.\n`);
}

const handle = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // DNS-rebinding guard: only accept Hosts that name this machine.
  const host = (req.headers.host ?? '').split(':')[0];
  if (!hostIsUs(host)) {
    res.writeHead(403); return res.end('forbidden host');
  }

  /**
   * CSRF guard on everything that changes something.
   *
   * The Host check above stops DNS rebinding, but not a plain form on a page
   * you happen to have open. An HTML form can POST cross-origin with no
   * preflight, and readBody ignores content-type, so a form whose urlencoded
   * body happens to parse as JSON reaches these handlers - which now includes
   * one that writes to the user's hardware.
   *
   * Requiring application/json closes it: that content type is not one a form
   * can produce, so a cross-origin attempt becomes a preflight, and we answer
   * no CORS headers at all. Our own page already sends it on every POST.
   */
  if (req.method === 'POST' && p.startsWith('/api/')) {
    const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
    if (ct !== 'application/json') {
      return json(res, 415, { error: 'POST requires content-type: application/json' });
    }
  }

  try {
    if (p === '/api/status') {
      // allSettled, not all: these are two separate requests to an ESP32 that
      // is also receiving 40 UDP packets a second, and it drops one now and
      // then. With Promise.all a single dropped /json/state marked the whole
      // cube unreachable while every control still worked.
      const [i, st] = await Promise.allSettled([device('/json/info'), device('/json/state')]);
      const dev = i.status === 'fulfilled' ? i.value : null;
      const dstate = st.status === 'fulfilled' ? st.value : null;
      return json(res, 200, {
        renderer: renderer.status(),
        cycle: cycler.status(),
        device: dev && {
          name: dev.name, product: dev.product, brand: dev.brand,
          live: dev.live, count: dev.leds?.count, power: dev.leds?.pwr,
          on: dstate?.on, bri: dstate?.bri, sb: dstate?.sb, sparkle: dstate?.sparkle,
          // fx/sx/ix/pal ride along off the /json/state we already fetched, so
          // the page can keep its effect highlighting honest between polls and
          // show which of the four device controls are still on the effect's
          // own defaults. No extra request to a busy ESP32.
          sym: dstate?.seg?.[0]?.sym, fx: dstate?.seg?.[0]?.fx,
          sx: dstate?.seg?.[0]?.sx, ix: dstate?.seg?.[0]?.ix,
          pal: dstate?.seg?.[0]?.pal,
        },
        config: {
          host: CONFIG.host, working: CONFIG.working, perEdge: CONFIG.perEdge,
          // Which model, how sure, and how its edges gang together, so the
          // preview draws this cube rather than the one this was written on.
          model: CONFIG.model, modelName: CONFIG.modelName, modelStatus: CONFIG.modelStatus,
          blocks: CONFIG.blocks,
          symmetries: SYMMETRY_NAMES,
        },
        online: Boolean(dev),
        remote: remoteOn(),
        build: BUILD,
      });
    }

    if (p === '/api/share') {
      // The Remote switch. GET reports it; POST {on} flips it, and only from
      // a loopback socket: the phone gets the UI, not the say over whether
      // the door stays open. Literal addresses, not a hostname: they are what
      // the Host guard accepts, and they need no mDNS on the phone.
      let problems = [];
      if (req.method === 'POST') {
        if (!fromThisMachine(req)) {
          return json(res, 403, { error: 'Only the computer running Drostex can switch Remote on or off.' });
        }
        const { on } = await readBody(req);
        if (on) problems = await openRemote();
        else await closeRemote();
      }
      return json(res, 200, { on: remoteOn(), port: PORT, urls: remoteUrls(), problems });
    }

    if (p === '/api/discover') {
      // Deliberately not cached. The answer is "what is on the network right
      // now", and a cube that just moved is exactly when someone asks.
      return json(res, 200, {
        devices: await discover({ timeout: Number(url.searchParams.get('t')) || 2500 }),
        current: CONFIG.host,
      });
    }

    if (p === '/api/device/name' && req.method === 'POST') {
      // Writes through to the cube, because the name in the header comes from
      // the device's own /json/info. A local nickname would disagree with
      // every other client on the network, including the cube's own web UI.
      const { name } = await readBody(req);
      try {
        const r = await setDeviceName(CONFIG.host, name);
        // /json/info is what the UI reads the name from, and it is cached
        // nowhere, so nothing else needs invalidating.
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: String(e.message ?? e) });
      }
    }

    if (p === '/api/animations') {
      return json(res, 200, Object.entries(ANIMATIONS).map(([id, a]) => ({
        id, label: a.label ?? id, desc: a.desc ?? '',
        // Sized to this cube: a slider that says "LEDs" tops out at however
        // many this one has, not at a number measured on another.
        params: resolveSchema(a.params, CONFIG),
        values: renderer.animParams[id],
        swatch: a.swatch ?? null,
      })));
    }

    if (p === '/api/cycle') {
      if (req.method === 'POST') return json(res, 200, await cycler.set(await readBody(req)));
      return json(res, 200, { ...cycler.status(), pools: POOLS });
    }

    if (p === '/api/palettes') {
      // Gradient stops per palette, so the UI can show what each one looks like
      // instead of listing names. Computed here to keep the iq() maths in one
      // place rather than reimplemented client-side.
      return json(res, 200, Object.fromEntries(Object.entries(PALETTES).map(([name, c]) => [
        name,
        Array.from({ length: 7 }, (_, i) =>
          iq(i / 6, ...c).map((x) => Math.round(x * 255))),
      ])));
    }

    if (p === '/api/brightness' && req.method === 'POST') {
      // ONE brightness control, whose meaning depends on what is driving the
      // LEDs. Two separate sliders fought each other: the device one would
      // overwrite the 255 that streaming pins it to, breaking the local
      // multiplier's range, and Stop would then revert the user's edit.
      const { value } = await readBody(req);
      const v = Math.min(255, Math.max(0, Number(value) || 0));
      if (renderer.running) {
        renderer.setParams({ brightness: v / 255 });
      } else {
        renderer.savedBrightness = v;
        await device('/json/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bri: v }),
        });
      }
      return json(res, 200, { value: v, applied: renderer.running ? 'stream' : 'device' });
    }

    if (p === '/api/pixels') {
      // The last frame actually sent. With no 3D preview and no reliable map
      // from address to physical edge, this is the only honest visual feedback
      // available: it shows what we computed, not where it landed.
      return json(res, 200, { pixels: renderer.pixels(), running: renderer.running });
    }

    if (p === '/api/anim-params' && req.method === 'POST') {
      const { name, values, reset } = await readBody(req);
      const target = name ?? renderer.animation;
      if (!target) return json(res, 400, { error: 'no animation selected' });
      const out = reset ? renderer.resetAnimParams(target)
                        : renderer.setAnimParams(target, values);
      return json(res, 200, { name: target, values: out });
    }

    if (p === '/api/presets') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const presets = await loadPresets();
        if (body.delete) {
          const next = presets.filter((x) => x.id !== body.delete);
          await savePresets(next);
          return json(res, 200, next);
        }
        // Toggled here rather than sent as a target boolean, so two tabs cannot
        // race each other into disagreeing about the star. Unknown id is a
        // silent no-op, matching what delete above already does.
        if (body.favorite) {
          const next = presets.map((x) =>
            (x.id === body.favorite ? { ...x, favorite: !x.favorite } : x));
          await savePresets(next);
          return json(res, 200, next);
        }
        // A preset describes a LOOK: which animation, its parameter values, and
        // how fast it runs. Brightness is deliberately excluded - it is a
        // property of the room, not of the look, and a saved one would fight
        // the brightness control every time a preset was recalled.
        const entry = {
          id: `p${Date.now().toString(36)}`,
          name: String(body.name ?? 'Untitled').slice(0, 60),
          animation: renderer.animation,
          values: { ...renderer.animParams[renderer.animation] },
          playback: { speed: renderer.params.speed },
        };
        if (!entry.animation) return json(res, 400, { error: 'nothing is playing to save' });
        const next = [...presets, entry];
        await savePresets(next);
        return json(res, 200, next);
      }
      return json(res, 200, await loadPresets());
    }

    if (p === '/api/favorites') {
      if (req.method === 'POST') {
        const { kind, id } = await readBody(req);
        if (kind !== 'animation' && kind !== 'effect') {
          return json(res, 400, { error: 'kind must be animation or effect' });
        }
        const f = await loadFavorites();
        // Effect ids arrive as numbers, animation ids as strings; compare after
        // normalising so a round-trip through JSON cannot desync them.
        const key = kind === 'effect' ? Number(id) : String(id);
        f[kind] = f[kind].some((x) => x === key)
          ? f[kind].filter((x) => x !== key)
          : [...f[kind], key];
        await saveFavorites(f);
        return json(res, 200, f);
      }
      return json(res, 200, await loadFavorites());
    }

    if (p === '/api/presets/load' && req.method === 'POST') {
      const { id } = await readBody(req);
      const entry = (await loadPresets()).find((x) => x.id === id);
      if (!entry) return json(res, 404, { error: 'no such preset' });
      renderer.setAnimParams(entry.animation, entry.values);
      if (entry.playback) {
        // Ignore any brightness in older saved presets, for the same reason we
        // no longer record it.
        const { brightness, ...playback } = entry.playback;
        renderer.setParams(playback);
      }
      await renderer.play(entry.animation);
      return json(res, 200, renderer.status());
    }

    if (p === '/api/play' && req.method === 'POST') {
      const { name } = await readBody(req);
      if (cycler.enabled) await cycler.set({ enabled: false });
      await renderer.play(name);
      return json(res, 200, renderer.status());
    }

    if (p === '/api/stop' && req.method === 'POST') {
      await renderer.stop();
      return json(res, 200, renderer.status());
    }

    if (p === '/api/params' && req.method === 'POST') {
      renderer.setParams(await readBody(req));
      return json(res, 200, renderer.status());
    }

    if (p === '/api/device/state') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        // Any onboard-effect change means we are no longer the pixel source.
        const seg = body.seg?.[0] ?? {};
        if (seg.fx !== undefined && cycler.enabled) await cycler.set({ enabled: false });
        // Choosing an effect means the firmware is the pixel source now. Do not
        // blank first - that would flash black between the two sources.
        if (seg.fx !== undefined) await renderer.stop({ blank: false });
        return json(res, 200, await device('/json/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));
      }
      return json(res, 200, await device('/json/state'));
    }

    if (p === '/api/warp' && req.method === 'POST') {
      // Streaming would overwrite the warp animation on the very next frame,
      // making the button look broken. Release the LEDs first.
      //
      // Unconditional on purpose: `running` is still false while a play() is
      // awaiting the network, so a guarded stop would skip exactly the case
      // that needs cancelling, and play would start a loop straight over the
      // warp. stop() bumps the generation, which is what cancels it.
      await renderer.stop({ blank: false });
      // One-shot vendor animation with a 15s cooldown in their own UI.
      return json(res, 200, await device('/json/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warp: true }),
      }));
    }

    if (p === '/api/effects') {
      const all = await device('/json');
      return json(res, 200, {
        // The firmware pads its table with '-' placeholders; only real entries
        // are worth showing.
        effects: await listEffects(),
        // `stops` are ours, not the firmware's - it publishes palette names and
        // nothing else. See src/device-palettes.mjs.
        palettes: all.palettes.map((label, id) => ({ id, label, stops: paletteStops(label) }))
          .filter((p2) => p2.label && p2.label !== '-'),
        state: all.state,
      });
    }

    if (p.startsWith('/api/')) { res.writeHead(404); return res.end('no such endpoint'); }

    return serveStatic(req, res);
  } catch (e) {
    return json(res, 500, { error: String(e.message ?? e) });
  }
};

const server = http.createServer(handle);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Another Drostex is probably running - open http://127.0.0.1:${PORT}`);
    console.error(`  or start this one elsewhere:  PORT=7848 npm start\n`);
    process.exit(1);
  }
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
});

// Deliberately NOT awaited before listen(): this is a request to a cube that
// may be slow or absent, and blocking the port on it means the UI is
// unreachable until the network answers. The value is only needed on the first
// play, which cannot happen before the server is up anyway.
renderer.captureFromDevice();

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  Drostex\n`);
  console.log(`  UI      ${url}`);
  console.log(`  Device  ${CONFIG.name ?? CONFIG.host} @ ${CONFIG.host}`);
  const sure = CONFIG.modelStatus === 'measured' ? 'measured'
    : CONFIG.modelStatus === 'spec-sheet' ? 'from the spec sheet, untested'
    : 'unknown model';
  console.log(`  Model   ${CONFIG.modelName ?? 'not recognised'} (${sure})`);
  console.log(`  Pixels  ${CONFIG.working} of ${CONFIG.ledCount} addresses drive LEDs, ${CONFIG.perEdge} per edge\n`);
  for (const note of CONFIG.notes) console.log(`  ! ${note}\n`);
  if (START_REMOTE) {
    for (const problem of await openRemote()) console.log(`  ! Remote: ${problem}\n`);
  } else {
    console.log(`  Phone   the QR button in the top bar switches Remote on for this run\n`);
  }
  console.log(`  Ctrl-C to stop.\n`);
  if (!process.argv.includes('--no-open')) {
    const open = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${open} ${url}`);
  }
});

let closing = false;
process.on('SIGINT', async () => {
  if (closing) process.exit(0);
  closing = true;
  console.log('\n  Stopping…');
  cycler.stopTimer();
  await renderer.stop();
  for (const r of remote.values()) r.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
