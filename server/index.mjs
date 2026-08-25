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
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { exec } from 'node:child_process';
import { loadConfig } from '../scripts/lib/config.mjs';
import { Renderer } from '../src/renderer.mjs';
import { ANIMATIONS, PALETTES, iq } from '../src/animations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 7847);

const CONFIG = loadConfig();
const renderer = new Renderer(CONFIG);

const PRESETS = join(ROOT, 'presets.json');

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
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // DNS-rebinding guard: only accept loopback Hosts.
  const host = (req.headers.host ?? '').split(':')[0];
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    res.writeHead(403); return res.end('forbidden host');
  }

  try {
    if (p === '/api/status') {
      let dev = null, dstate = null;
      try {
        [dev, dstate] = await Promise.all([device('/json/info'), device('/json/state')]);
      } catch { /* cube offline */ }
      return json(res, 200, {
        renderer: renderer.status(),
        device: dev && {
          name: dev.name, product: dev.product, brand: dev.brand,
          live: dev.live, count: dev.leds?.count, power: dev.leds?.pwr,
          on: dstate?.on, bri: dstate?.bri, sb: dstate?.sb, sparkle: dstate?.sparkle,
          sym: dstate?.seg?.[0]?.sym,
        },
        config: { host: CONFIG.host, working: CONFIG.working, perEdge: CONFIG.perEdge },
        online: Boolean(dev),
      });
    }

    if (p === '/api/animations') {
      return json(res, 200, Object.entries(ANIMATIONS).map(([id, a]) => ({
        id, label: a.label ?? id, desc: a.desc ?? '',
        params: a.params ?? {},
        values: renderer.animParams[id],
      })));
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

    if (p === '/api/audio' && req.method === 'POST') {
      // Audio arrives from the browser tab, ~25/sec. Loopback, ~60 bytes each.
      renderer.setAudio(await readBody(req));
      res.writeHead(204); return res.end();
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
        // A preset is a complete description of a look: which animation, its
        // parameter values, and the playback settings.
        const entry = {
          id: `p${Date.now().toString(36)}`,
          name: String(body.name ?? 'Untitled').slice(0, 60),
          animation: renderer.animation,
          values: { ...renderer.animParams[renderer.animation] },
          playback: { speed: renderer.params.speed, brightness: renderer.params.brightness },
        };
        if (!entry.animation) return json(res, 400, { error: 'nothing is playing to save' });
        const next = [...presets, entry];
        await savePresets(next);
        return json(res, 200, next);
      }
      return json(res, 200, await loadPresets());
    }

    if (p === '/api/presets/load' && req.method === 'POST') {
      const { id } = await readBody(req);
      const entry = (await loadPresets()).find((x) => x.id === id);
      if (!entry) return json(res, 404, { error: 'no such preset' });
      renderer.setAnimParams(entry.animation, entry.values);
      if (entry.playback) renderer.setParams(entry.playback);
      await renderer.play(entry.animation);
      return json(res, 200, renderer.status());
    }

    if (p === '/api/play' && req.method === 'POST') {
      const { name } = await readBody(req);
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
        effects: all.effects.map((label, id) => ({ id, label, sound: isSoundReactive(id, label) }))
          .filter((e) => e.label && e.label !== '-'),
        palettes: all.palettes.map((label, id) => ({ id, label }))
          .filter((p2) => p2.label && p2.label !== '-'),
        state: all.state,
      });
    }

    if (p.startsWith('/api/')) { res.writeHead(404); return res.end('no such endpoint'); }

    return serveStatic(req, res);
  } catch (e) {
    return json(res, 500, { error: String(e.message ?? e) });
  }
});

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

await renderer.captureFromDevice();

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  Drostex\n`);
  console.log(`  UI      ${url}`);
  console.log(`  Device  ${CONFIG.name ?? CONFIG.host} @ ${CONFIG.host}`);
  console.log(`  Pixels  ${CONFIG.working} addressable, ${CONFIG.perEdge} per edge\n`);
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
  await renderer.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
