#!/usr/bin/env node
/**
 * Drostex — CLI animation player.
 *
 * A thin wrapper over the same Renderer the server uses, so the two cannot
 * drift. Useful for a quick look without opening the UI, and for running
 * headless on a machine with no browser.
 *
 *   node scripts/play.mjs --list
 *   node scripts/play.mjs aurora
 *   node scripts/play.mjs comet --fps=40 --bri=0.7 --speed=1.5
 */

import { loadConfig, resolveHardware } from './lib/config.mjs';
import { Renderer } from '../src/renderer.mjs';
import { ANIMATIONS } from '../src/animations.mjs';

const flag = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : dflt;
};

function list() {
  console.log('\n  Animations:\n');
  const w = Math.max(...Object.keys(ANIMATIONS).map((k) => k.length));
  for (const [id, a] of Object.entries(ANIMATIONS)) {
    console.log(`    ${id.padEnd(w)}   ${a.desc}`);
  }
  console.log('\n  node scripts/play.mjs <name> [--fps=40] [--bri=0.85] [--speed=1]\n');
}

async function main() {
  if (process.argv.includes('--list')) return list();

  const name = process.argv.slice(2).find((a) => !a.startsWith('--') && !/^\d/.test(a));
  if (!name || !ANIMATIONS[name]) {
    if (name) console.error(`\n  unknown animation: ${name}`);
    list();
    process.exitCode = name ? 1 : 0;
    return;
  }

  const config = await resolveHardware(loadConfig());
  const renderer = new Renderer(config);
  renderer.setParams({
    brightness: flag('bri', 0.85),
    speed: flag('speed', 1),
    fps: flag('fps', 40),
    gamma: flag('gamma', 2.2),
  });

  console.log(`\n  ${name} — ${ANIMATIONS[name].desc}`);
  console.log(`  ${config.modelName ?? 'unknown model'}: ${config.working} addresses, ` +
              `${config.perEdge} per edge @ ${renderer.params.fps}fps, ` +
              `brightness ${renderer.params.brightness}, speed ${renderer.params.speed}`);
  for (const note of config.notes) console.log(`  ! ${note}`);
  console.log('  Ctrl-C to stop.\n');

  await renderer.play(name);

  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(0);
    stopping = true;
    await renderer.stop();
    console.log('\n  Blanked.\n');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
});
