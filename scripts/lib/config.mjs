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

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

  return {
    host,
    source,
    port: file.transport?.port ?? DEFAULTS.port,
    protocol: file.transport?.protocol ?? DEFAULTS.protocol,
    sacnPort: file.transport?.sacnPort ?? DEFAULTS.sacnPort,
    sacnUniverse: file.transport?.sacnUniverse ?? DEFAULTS.sacnUniverse,
    mac: file.device?.mac ?? null,
    name: file.device?.name ?? null,
    ledCount: file.leds?.count ?? 88,
    // Only the first N addresses drive physical LEDs; the rest are configured
    // by the vendor but have no tap. Writing past this is harmless but useless.
    working: file.leds?.working ?? 44,
    perEdge: file.leds?.perEdge ?? 11,
  };
}
