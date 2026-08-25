/**
 * Frame renderer and transmitter.
 *
 * Owns the UDP socket and the animation loop. The browser only ever sends
 * control messages - the pixels are computed here, which is what lets an
 * animation keep running with no page open.
 */

import dgram from 'node:dgram';
import { ANIMATIONS, makeContext, clamp01 } from './animations.mjs';

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
    this.params = { brightness: 0.85, speed: 1, fps: 40, gamma: 2.2 };
    this.buf = Buffer.alloc(config.ledCount * 3);
    this.frames = 0;
    this.startedAt = 0;
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
   * Realtime pixels are scaled by the device's global brightness, so it has to
   * sit at 255 and dimming has to happen locally where it can be gamma-correct.
   * `lor` must be 0 or packets are accepted and nothing lights up.
   */
  async prepareDevice() {
    try {
      await fetch(`http://${this.config.host}/json/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: true, bri: 255, lor: 0 }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* non-fatal: streaming may still work */
    }
  }

  setParams(p) {
    for (const k of ['brightness', 'speed', 'fps', 'gamma']) {
      if (typeof p[k] === 'number' && Number.isFinite(p[k])) this.params[k] = p[k];
    }
    this.params.brightness = clamp01(this.params.brightness);
    this.params.fps = Math.min(60, Math.max(1, this.params.fps));
  }

  async play(name) {
    if (!ANIMATIONS[name]) throw new Error(`unknown animation: ${name}`);
    await this.connect();
    await this.prepareDevice();
    this.animation = name;
    if (!this.running) {
      this.running = true;
      this.startedAt = Date.now();
      this.loop();
    }
  }

  async stop({ blank = true } = {}) {
    this.running = false;
    this.animation = null;
    if (this.sock && blank) {
      this.buf.fill(0);
      for (let i = 0; i < 6; i++) {
        try { this.sock.send(drgb(this.buf)); } catch {}
        await sleep(30);
      }
    }
  }

  async loop() {
    const { working: n, perEdge } = this.config;
    let next = Date.now();
    while (this.running) {
      const name = this.animation;
      const anim = ANIMATIONS[name];
      if (!anim) break;

      const t = (Date.now() - this.startedAt) / 1000;
      const { brightness, speed, gamma } = this.params;

      for (let i = 0; i < n; i++) {
        const rgb = anim.fn(makeContext(i, n, perEdge, t, speed));
        for (let k = 0; k < 3; k++) {
          // Gamma after brightness, so dimming stays perceptually smooth.
          const v = clamp01(rgb[k]) * brightness;
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

  status() {
    return {
      running: this.running,
      animation: this.animation,
      params: this.params,
      frames: this.frames,
      uptime: this.running ? (Date.now() - this.startedAt) / 1000 : 0,
    };
  }
}
