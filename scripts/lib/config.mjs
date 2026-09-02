/**
 * Shared config loader.
 *
 * Device identity (LAN address, MAC) is per-installation and does not belong in
 * source. It lives in config.json, which is gitignored; config.example.json is
 * the committed template.
 *
 * Resolution order, first match wins:
 *   1. an explicit override    loadConfig({ host })
 *   2. a bare IPv4 argument    node scripts/blink.mjs 192.168.1.50
 *   3. DROSTEX_HOST env var
 *   4. config.json
 *   5. config.example.json
 *
 * The override exists for mDNS: the server looks for a cube on the network
 * when nothing else named one, and needs to feed that answer back through the
 * same resolution so every other field keeps its usual source. Discovery is
 * deliberately NOT a step in this list. It is a fallback the caller reaches
 * for after this throws, so a configured host always wins over whatever
 * happens to be answering on the network today.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveModel, applyModel } from '../../src/models.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULTS = {
  host: null,
  port: 21324, // WLED native realtime UDP, measured working
  protocol: 'wled-drgb',
  sacnPort: 5568,
  sacnUniverse: 1,
};

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig({ host: override = null } = {}) {
  const local = readJSON(join(ROOT, 'config.json'));
  const example = readJSON(join(ROOT, 'config.example.json'));
  const file = local ?? example ?? {};

  const cliHost = process.argv.slice(2).find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  const host = override ?? cliHost ?? process.env.DROSTEX_HOST ?? file.device?.host ?? DEFAULTS.host;

  // Where the address came from. `example` means nobody chose it: the template
  // ships with a placeholder, so this function cannot throw on a fresh clone
  // and callers cannot tell a real address from a stand-in without being told.
  // The server uses this to decide whether to go looking on the network.
  const source = override ? 'override'
    : cliHost ? 'argv'
    : process.env.DROSTEX_HOST ? 'env'
    : local?.device?.host ? 'config'
    : 'example';

  if (!host) {
    throw new Error(
      'No device address. Copy config.example.json to config.json and set device.host, ' +
      'or pass one: node scripts/<name>.mjs 192.168.1.50',
    );
  }

  if (!local && !override && !cliHost && !process.env.DROSTEX_HOST) {
    console.warn(
      '  ! Using config.example.json — copy it to config.json and set your own device.host.\n',
    );
  }

  const modelKey = file.device?.model ?? 'auto';
  // Anything set here was measured by the owner and beats the model table.
  // `working` is the one most worth setting: only the first N addresses drive
  // physical LEDs on the Nano; the rest are configured with no tap behind
  // them, and writing past N is harmless but useless.
  const ledsOverride = {
    count: file.leds?.count ?? null,
    working: file.leds?.working ?? null,
    perEdge: file.leds?.perEdge ?? null,
    blocks: Array.isArray(file.leds?.blocks) ? file.leds.blocks : null,
  };

  const base = {
    host,
    source,
    port: file.transport?.port ?? DEFAULTS.port,
    protocol: file.transport?.protocol ?? DEFAULTS.protocol,
    sacnPort: file.transport?.sacnPort ?? DEFAULTS.sacnPort,
    sacnUniverse: file.transport?.sacnUniverse ?? DEFAULTS.sacnUniverse,
    mac: file.device?.mac ?? null,
    name: file.device?.name ?? null,
    modelKey,
    ledsOverride,
  };

  // Synchronous answer: what config.json and the model table know without
  // asking the cube. `resolveHardware` refines it once the cube has answered,
  // which is what the server and the player do; the probe scripts run on
  // this, because measuring the hardware is the whole point of them.
  return applyModel(base, { model: resolveModel({ key: modelKey }) });
}

/**
 * Asks the cube what it is, and settles the LED numbers against it.
 *
 * One request to `/json/info` with a short timeout. A cube that does not
 * answer leaves the synchronous config untouched, plus a note. `fetchInfo`
 * exists so tests can hand in a canned answer instead of a network.
 */
export async function resolveHardware(cfg, { timeout = 1500, fetchInfo = getInfo } = {}) {
  let info = null;
  try {
    info = await fetchInfo(cfg.host, timeout);
  } catch {
    info = null;
  }
  const model = resolveModel({ key: cfg.modelKey, info });
  const out = applyModel(cfg, { model, info });
  if (!info) out.notes.push('The cube did not answer /json/info, so its address count is assumed, not read.');
  return out;
}

async function getInfo(host, timeout) {
  const r = await fetch(`http://${host}/json/info`, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`GET /json/info -> HTTP ${r.status}`);
  return r.json();
}
