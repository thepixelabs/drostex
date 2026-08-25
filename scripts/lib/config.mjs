/**
 * Shared config loader.
 *
 * Device identity (LAN address, MAC) is per-installation and does not belong in
 * source. It lives in config.json, which is gitignored; config.example.json is
 * the committed template.
 *
 * Resolution order, first match wins:
 *   1. a bare IPv4 argument   node scripts/blink.mjs 192.168.1.50
 *   2. DROSTEX_HOST env var
 *   3. config.json
 *   4. config.example.json
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

export function loadConfig() {
  const local = readJSON(join(ROOT, 'config.json'));
  const example = readJSON(join(ROOT, 'config.example.json'));
  const file = local ?? example ?? {};

  const cliHost = process.argv.slice(2).find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  const host = cliHost ?? process.env.DROSTEX_HOST ?? file.device?.host ?? DEFAULTS.host;

  if (!host) {
    throw new Error(
      'No device address. Copy config.example.json to config.json and set device.host, ' +
      'or pass one: node scripts/<name>.mjs 192.168.1.50',
    );
  }

  if (!local && !cliHost && !process.env.DROSTEX_HOST) {
    console.warn(
      '  ! Using config.example.json — copy it to config.json and set your own device.host.\n',
    );
  }

  return {
    host,
    port: file.transport?.port ?? DEFAULTS.port,
    protocol: file.transport?.protocol ?? DEFAULTS.protocol,
    sacnPort: file.transport?.sacnPort ?? DEFAULTS.sacnPort,
    sacnUniverse: file.transport?.sacnUniverse ?? DEFAULTS.sacnUniverse,
    mac: file.device?.mac ?? null,
    name: file.device?.name ?? null,
  };
}
