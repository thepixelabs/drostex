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
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { exec } from 'node:child_process';
import { loadConfig } from '../scripts/lib/config.mjs';
import { Renderer } from '../src/renderer.mjs';
import { ANIMATIONS } from '../src/animations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 7847);

const CONFIG = loadConfig();
const renderer = new Renderer(CONFIG);

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
      let dev = null;
      try { dev = await device('/json/info'); } catch { /* cube offline */ }
      return json(res, 200, {
        renderer: renderer.status(),
        device: dev && {
          name: dev.name, product: dev.product, brand: dev.brand,
          live: dev.live, count: dev.leds?.count, power: dev.leds?.pwr,
        },
        config: { host: CONFIG.host, working: CONFIG.working, perEdge: CONFIG.perEdge },
        online: Boolean(dev),
      });
    }

    if (p === '/api/animations') {
      return json(res, 200, Object.entries(ANIMATIONS).map(([id, a]) => ({
        id, label: a.label ?? id, desc: a.desc ?? '',
      })));
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
        if (body.fx !== undefined || body.pal !== undefined) await renderer.stop({ blank: false });
        return json(res, 200, await device('/json/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));
      }
      return json(res, 200, await device('/json/state'));
    }

    if (p === '/api/effects') {
      const all = await device('/json');
      return json(res, 200, {
        // The firmware pads its table with '-' placeholders; only real entries
        // are worth showing.
        effects: all.effects.map((label, id) => ({ id, label }))
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
