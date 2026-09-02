/**
 * Frame renderer and transmitter.
 *
 * Owns the UDP socket and the animation loop. The browser only ever sends
 * control messages - the pixels are computed here, which is what lets an
 * animation keep running with no page open.
 */

import dgram from 'node:dgram';
import { ANIMATIONS, makeContext, clamp01, defaultParams, SYMMETRIES, hash } from './animations.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WLED DRGB: [2, revert_timeout_seconds, R,G,B ...] */
function drgb(buf) {
  const b = Buffer.allocUnsafe(2 + buf.length);
  b[0] = 2;
  b[1] = 2;
  buf.copy(b, 2);
  return b;
}

export class Renderer {
  constructor(config) {
    this.config = config;
    this.sock = null;
    this.running = false;
    this.animation = null;
    // Global playback settings. sparkle, symmetry and audio reactivity live
    // here rather than per-animation: they are modifiers over whatever is
    // playing, exactly like the firmware's own versions - except these actually
    // reach the addresses that have physical LEDs behind them.
    // Sparkle and symmetry deliberately live on the DEVICE, not here. The
    // firmware applies both to streamed pixels, and its symmetry modes know the
    // cube's real geometry - Cubic, Helical, Trigonal - which we never mapped.
    // Reimplementing them locally would be strictly worse, and duplicated.
    // `symmetry` is ours, not the device's. The firmware's own symmetry was
    // measured not to reach streamed pixels - it runs inside its effect
    // renderer, which realtime data bypasses.
    // `symmetry` and `sparkle` are ours, not the device's.
    //
    // The firmware applies its own versions inside its effect renderer, and
    // realtime data replaces the buffer afterwards - so none of it survives on
    // streamed pixels. The earlier belief that sparkle did survive came from
    // watching the cube's reported power draw fluctuate, but that estimate
    // covers every configured address while, on the Nano, only the first 44
    // of 88 have LEDs behind them: the firmware was sparkling into pixels
    // that do not exist.
    this.params = { brightness: 0.85, speed: 1, fps: 40, gamma: 2.2, symmetry: 'none', sparkle: 0 };
    // The device's own brightness before we touched it. Streaming needs the
    // device at 255 (realtime pixels are scaled by it), but that is OUR
    // requirement, not a change the user asked for - so it gets put back.
    this.savedBrightness = null;
    // Per-animation parameter values, seeded from each schema's defaults and
    // kept independently so switching back and forth does not lose your edits.
    this.animParams = Object.fromEntries(
      Object.keys(ANIMATIONS).map((k) => [k, defaultParams(k)]),
    );
    this.brightnessTouched = false; // true once the user moves our slider
    this.buf = Buffer.alloc(config.ledCount * 3);
    this.frames = 0;
    this.startedAt = 0;
    // Bumped by every stop/play. play() awaits network calls before starting
    // its loop, and a stop landing during that await would otherwise be undone
    // when play resumed and set running = true.
    this.generation = 0;
  }

  async connect() {
    if (this.sock) return;
    this.sock = await new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.on('error', () => {}); // ICMP noise must not kill the loop
      s.connect(this.config.port, this.config.host, () => resolve(s));
      setTimeout(() => reject(new Error('UDP connect timeout')), 3000);
    });
  }

  /**
   * Reads the device's own brightness, then takes the device to 255.
   *
   * Realtime pixels are scaled by the global brightness, so full local control
   * requires the device at maximum. But that setting belongs to the user, so we
   * remember it, adopt it as our starting level (their preference is still
   * honoured - it is just applied here, where it can be gamma-correct), and put
   * it back when streaming stops.
   *
   * The saved value only survives the process. If Drostex is killed mid-stream
   * the device is left at 255; the next clean stop restores whatever it reads.
   */
  async prepareDevice() {
    try {
      const r = await fetch(`http://${this.config.host}/json/state`, {
        signal: AbortSignal.timeout(4000),
      });
      const state = await r.json();
      this.captureBrightness(state.bri);
    } catch {
      /* cube unreachable; fall through and try to stream anyway */
    }

    try {
      await fetch(`http://${this.config.host}/json/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // lor must be 0 or packets are accepted while nothing lights up.
        body: JSON.stringify({ on: true, bri: 255, lor: 0 }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* non-fatal: streaming may still work */
    }
  }

  /**
   * Records the device's brightness as the user's own, once.
   *
   * Called at startup rather than at first play, because the vendor's `warp`
   * animation ends by setting brightness to 255 - so a value read after one has
   * run is ours by accident, not theirs.
   *
   * 255 is refused outright for the same reason, and it is the more common
   * case: streaming pins the device to 255, so a Drostex that was killed
   * mid-stream leaves it there. The next process read that back, adopted it as
   * a preference, and restored 255 on every stop from then on - the value
   * latched and the brightness slider jumped to full whenever a preset was
   * loaded. A genuine wish for full brightness still arrives, via the slider
   * setting savedBrightness explicitly; what cannot be trusted is 255 inferred
   * from a device we may well have put there ourselves.
   */
  captureBrightness(bri) {
    if (this.savedBrightness !== null || typeof bri !== 'number') return;
    if (bri >= 255) return;
    this.savedBrightness = bri;
    if (!this.brightnessTouched) this.params.brightness = bri / 255;
  }

  /** Reads the device's current brightness and remembers it. */
  async captureFromDevice() {
    try {
      const r = await fetch(`http://${this.config.host}/json/state`, {
        signal: AbortSignal.timeout(4000),
      });
      this.captureBrightness((await r.json()).bri);
    } catch { /* cube offline; try again on first play */ }
  }

  /** Merges values into one animation's parameters, ignoring unknown keys. */
  setAnimParams(name, values) {
    const schema = ANIMATIONS[name]?.params;
    if (!schema) throw new Error(`unknown animation: ${name}`);
    const cur = this.animParams[name];
    for (const [k, v] of Object.entries(values ?? {})) {
      const def = schema[k];
      if (!def) continue;
      if (def.type === 'number') {
        const n = Number(v);
        // 'working' is the schema's way of saying "this cube's address count".
        const max = def.max === 'working' ? this.config.working : def.max;
        if (Number.isFinite(n)) cur[k] = Math.min(max ?? n, Math.max(def.min ?? n, n));
      } else if (def.type === 'boolean') {
        cur[k] = Boolean(v);
      } else if (def.type === 'select') {
        if (def.options.includes(v)) cur[k] = v;
      } else {
        cur[k] = String(v);
      }
    }
    return cur;
  }

  resetAnimParams(name) {
    this.animParams[name] = defaultParams(name);
    return this.animParams[name];
  }

  /**
   * Puts the user's brightness back.
   *
   * With nothing saved - which now includes "the device read 255 and we refused
   * to believe it" - fall back to our own slider. While streaming, that slider
   * IS the level being looked at, so handing the same level to the onboard
   * effect keeps the room at the brightness the user actually chose. Returning
   * early instead would leave the cube pinned at the 255 we set.
   */
  async restoreDevice() {
    const bri = this.savedBrightness ?? Math.round(clamp01(this.params.brightness) * 255);
    try {
      await fetch(`http://${this.config.host}/json/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bri }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* best effort */
    }
  }

  setParams(p) {
    if (typeof p.symmetry === 'string' && SYMMETRIES[p.symmetry]) this.params.symmetry = p.symmetry;
    if (Number.isFinite(Number(p.sparkle))) this.params.sparkle = clamp01(Number(p.sparkle));
    if (typeof p.brightness === 'number' && Number.isFinite(p.brightness)) {
      // An explicit choice stops us re-seeding from the device on the next play.
      this.brightnessTouched = true;
    }
    for (const k of ['brightness', 'speed', 'fps', 'gamma']) {
      if (typeof p[k] === 'number' && Number.isFinite(p[k])) this.params[k] = p[k];
    }
    this.params.brightness = clamp01(this.params.brightness);
    this.params.fps = Math.min(60, Math.max(1, this.params.fps));
  }

  async play(name) {
    if (!ANIMATIONS[name]) throw new Error(`unknown animation: ${name}`);
    const gen = ++this.generation;
    await this.connect();
    await this.prepareDevice();
    // Something else took over while we were waiting on the network.
    if (gen !== this.generation) return;
    this.animation = name;
    if (!this.running) {
      this.running = true;
      this.startedAt = Date.now();
      this.loop();
    }
  }

  async stop({ blank = true, restore = true } = {}) {
    this.generation++;
    this.running = false;
    this.animation = null;
    if (this.sock && blank) {
      this.buf.fill(0);
      for (let i = 0; i < 6; i++) {
        try { this.sock.send(drgb(this.buf)); } catch {}
        await sleep(30);
      }
    }
    // Handing over to an onboard effect still restores brightness - the effect
    // should run at the level the user chose, not at whatever we needed.
    if (restore) await this.restoreDevice();
  }

  async loop() {
    const { working: n, perEdge } = this.config;
    let next = Date.now();
    while (this.running) {
      const name = this.animation;
      const anim = ANIMATIONS[name];
      if (!anim) break;

      const t = (Date.now() - this.startedAt) / 1000;
      const { brightness, speed, gamma, symmetry, sparkle } = this.params;
      const params = this.animParams[name];
      const fold = SYMMETRIES[symmetry] ?? SYMMETRIES.none;

      for (let i = 0; i < n; i++) {
        const rgb = anim.fn(makeContext(fold(i, n, perEdge), n, perEdge, t, speed, params));

        let spark = 0;
        if (sparkle > 0) {
          // Each address twinkles on its own phase so they never blink in
          // unison, and thresholds rather than fades, for a hard glint.
          const gate = 1 - sparkle * 0.4;
          const v = Math.sin((t * 3.1 + hash(i * 12.9898) * 43.7) % 6.283);
          if (v > gate) spark = Math.pow((v - gate) / (1 - gate), 0.6);
        }

        for (let k = 0; k < 3; k++) {
          // Gamma last, after brightness, so dimming stays perceptually smooth.
          const v = clamp01(clamp01(rgb[k]) + spark) * brightness;
          this.buf[i * 3 + k] = Math.round(255 * Math.pow(v, gamma));
        }
      }
      try { this.sock.send(drgb(this.buf)); } catch {}
      this.frames++;

      // Drift-corrected: schedule from a fixed epoch rather than sleeping a
      // fixed amount, so timer jitter cannot accumulate.
      next += 1000 / this.params.fps;
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      else next = Date.now();
    }
  }

  /** The last frame we sent, as 0-255 RGB triplets, for UI readback. */
  pixels() {
    const n = this.config.working;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [this.buf[i * 3], this.buf[i * 3 + 1], this.buf[i * 3 + 2]];
    }
    return out;
  }

  status() {
    return {
      running: this.running,
      animation: this.animation,
      params: this.params,
      deviceBrightness: this.savedBrightness,
      animParams: this.animation ? this.animParams[this.animation] : null,
      brightnessTouched: this.brightnessTouched,
      frames: this.frames,
      uptime: this.running ? (Date.now() - this.startedAt) / 1000 : 0,
    };
  }
}
