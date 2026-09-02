/**
 * Cube preview.
 *
 * Draws the cube standing on a corner and lights its edges from the frames the
 * server is actually sending. This is a readback, not a simulation: the pixels
 * come from /api/pixels, which is the last buffer handed to the UDP socket. If
 * the preview and the object disagree, the bug is downstream of here.
 *
 * On the Nano the wiring is branching-parallel and the fan-out is UNEVEN. One
 * data line enters on an edge and splits at corners; every edge downstream of
 * a split carries the same signal and therefore always shows the same colour.
 * Measured on the real unit (profiles/nano-topology.json), the four address
 * blocks drive 1, 2, 4 and 5 edges respectively, which sums to 12 edges.
 *
 * That is why there is no single "LEDs per address" number. An earlier guess
 * of 3 came from dividing 132 by 44, and the hardware does not agree with it.
 *
 * Which blocks drive how many edges arrives from the server with the rest of
 * the geometry (src/models.mjs), because it is a fact about one model, not
 * about cubes. A model nobody has probed yet gets an even split, so it still
 * previews as something. What is unknown on every model is WHICH edges belong
 * to which block: the counts are measured, the assignment is nominal, chosen
 * to be stable rather than true. So read this as "what the frame looks like
 * and how many edges move together", never as "which corner is lit".
 *
 * It follows that this is only honest while WE are the pixel source. When a
 * firmware effect is running the server has no idea what the LEDs are doing,
 * so the preview says so rather than showing a stale frame as if it were live.
 */

/* Cube vertices, then the 12 edges as pairs differing in one coordinate. */
const V = [];
for (let x = 0; x < 2; x++)
  for (let y = 0; y < 2; y++)
    for (let z = 0; z < 2; z++) V.push([x * 2 - 1, y * 2 - 1, z * 2 - 1]);

const E = [];
for (let a = 0; a < 8; a++)
  for (let b = a + 1; b < 8; b++) {
    let d = 0;
    for (let k = 0; k < 3; k++) if (V[a][k] !== V[b][k]) d++;
    if (d === 1) E.push([a, b]);
  }

const norm = (v) => { const m = Math.hypot(...v); return v.map((x) => x / m); };
const cross = (p, q) => [
  p[1] * q[2] - p[2] * q[1],
  p[2] * q[0] - p[0] * q[2],
  p[0] * q[1] - p[1] * q[0],
];

/* Re-basis so the (1,1,1) body diagonal is vertical: the cube rests on a
   vertex on its stand, which changes the silhouette completely. */
const UP = norm([1, 1, 1]);
const RIGHT = norm(cross(UP, [1, 0, 0]));
const FWD = cross(RIGHT, UP);
const BASIS = V.map((p) => [
  p[0] * RIGHT[0] + p[1] * RIGHT[1] + p[2] * RIGHT[2],
  p[0] * UP[0] + p[1] * UP[1] + p[2] * UP[2],
  p[0] * FWD[0] + p[1] * FWD[1] + p[2] * FWD[2],
]);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Maps each edge index to the address block driving it.
 *
 * `measured` is the per-block edge count from the server (on the Nano,
 * [1, 2, 4, 5]: the unevenness is the whole point, a moving dot appears on one
 * edge in block 0 and on five at once in block 3, which is a visible property
 * of the object and the reason per-edge independent control does not exist).
 * It is only trusted when it accounts for every edge. Anything else, including
 * a model nobody has probed, gets an even split, so a differently wired device
 * still previews as something rather than nothing.
 */
function edgeBlocks(blocks, edgeCount, measured) {
  const sizes = (Array.isArray(measured)
    && measured.length === blocks
    && measured.reduce((a, b) => a + b, 0) === edgeCount)
    ? measured
    : Array.from({ length: blocks }, (_, i) =>
      Math.floor((edgeCount * (i + 1)) / blocks) - Math.floor((edgeCount * i) / blocks));

  const map = [];
  sizes.forEach((n, block) => { for (let k = 0; k < n; k++) map.push(block); });
  while (map.length < edgeCount) map.push(sizes.length - 1);
  return map;
}

export class CubePreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pixels = [];
    this.live = false;
    this.perEdge = 11;
    this.working = 44;
    this.blocks = null;                    // measured edges per block, if any
    this.gamma = 2.2;                      // matches the renderer's default
    this.yaw = 0;
    this.raf = null;
    this.last = 0;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.resize();

    // A canvas that is scrolled out of view or in a hidden tab should not be
    // spinning a rAF loop; on a laptop that is a measurable amount of battery
    // for something nobody is looking at.
    if ('IntersectionObserver' in window) {
      this.io = new IntersectionObserver(
        ([e]) => (e.isIntersecting ? this.start() : this.stop()),
        { threshold: 0.01 },
      );
      this.io.observe(canvas);
    } else {
      this.start();
    }
    this.onVis = () => (document.hidden ? this.stop() : this.start());
    document.addEventListener('visibilitychange', this.onVis);
  }

  /** Geometry comes from the server's config, not from constants here. */
  setGeometry({ working, perEdge, blocks } = {}) {
    if (Number.isFinite(working) && working > 0) this.working = working;
    if (Number.isFinite(perEdge) && perEdge > 0) this.perEdge = perEdge;
    this.blocks = Array.isArray(blocks) ? blocks : null;
  }

  /**
   * The gamma the renderer encoded the frame with, so we can undo it.
   *
   * See setPixels. Anything outside a sane range would distort rather than
   * correct, so it is clamped instead of trusted.
   */
  setGamma(gamma) {
    if (Number.isFinite(gamma) && gamma > 0.1) this.gamma = Math.min(4, Math.max(1, gamma));
  }

  /**
   * `pixels` is [[r,g,b], ...] in 0..255, straight off /api/pixels.
   *
   * Those bytes are gamma ENCODED. The renderer sends `255 * v^gamma` because
   * an LED driver is linear in current while the eye is not, so the encoding is
   * what makes dimming look smooth on the cube. A monitor already applies that
   * curve itself, so painting the wire bytes directly applies gamma twice and
   * the preview comes out far darker than the object it is previewing. At the
   * default brightness of 150 a full-white pixel landed at 31% on screen
   * instead of 59%, and a half-lit one at 7% instead of 29%, which is why it
   * was barely visible.
   *
   * Decoding back to `v` returns the perceptual value, which is the thing your
   * eye actually reads off the cube. The preview is still a readback of the
   * real frame; this only undoes an encoding meant for the LEDs, not for you.
   */
  setPixels(pixels, live) {
    if (Array.isArray(pixels)) {
      const inv = 1 / (this.gamma || 2.2);
      this.pixels = pixels.map((p) => (p && p.length === 3
        ? [
          255 * Math.pow(p[0] / 255, inv),
          255 * Math.pow(p[1] / 255, inv),
          255 * Math.pow(p[2] / 255, inv),
        ]
        : p));
    }
    this.live = Boolean(live);
    if (this.reduced) this.draw(0);        // no loop running; paint once
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 260;
    const h = Math.round(w * 0.92);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    if (this.reduced) this.draw(0);
  }

  start() {
    if (this.raf !== null || this.reduced) { if (this.reduced) this.draw(0); return; }
    this.last = performance.now();
    const loop = (t) => {
      this.yaw += (t - this.last) / 1000 * 0.22;
      this.last = t;
      this.draw(this.yaw);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf !== null) { cancelAnimationFrame(this.raf); this.raf = null; }
  }

  destroy() {
    this.stop();
    this.io?.disconnect();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVis);
  }

  project(p, yaw) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const x = p[0] * cs - p[2] * sn;
    const z = p[0] * sn + p[2] * cs;
    const k = 3.6 / (3.6 + z);
    return { x: x * k, y: -p[1] * k, z };
  }

  draw(yaw) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    const dpr = this.dpr || 1;
    const blocks = Math.max(1, Math.round(this.working / this.perEdge));
    const blockOf = edgeBlocks(blocks, E.length, this.blocks);

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    // The cube stands on a vertex, so its silhouette is a hexagon reaching
    // further than a face-on cube would, and each lit address carries a glow
    // wider than the point itself. Sized so the top and bottom vertices plus
    // their halos stay inside the panel rather than clipping against it.
    const scale = Math.min(w, h) * 0.245;

    const order = E.map((e, i) => {
      const a = this.project(BASIS[e[0]], yaw);
      const b = this.project(BASIS[e[1]], yaw);
      return { i, a, b, z: (a.z + b.z) / 2 };
    }).sort((p, q) => q.z - p.z);

    for (const seg of order) {
      const depth = 1 - clamp01((seg.z + 1.5) / 3);
      const fade = 0.34 + 0.66 * depth;

      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(130,144,184,${(0.07 + 0.09 * depth).toFixed(3)})`;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(seg.a.x * scale, seg.a.y * scale);
      ctx.lineTo(seg.b.x * scale, seg.b.y * scale);
      ctx.stroke();

      if (!this.pixels.length) continue;
      ctx.globalCompositeOperation = 'lighter';

      // Every edge in a block is electrically ganged, so they cannot differ in
      // colour. Drawing them from the same addresses is not a shortcut here,
      // it is the behaviour.
      const block = blockOf[seg.i] ?? 0;
      for (let pos = 0; pos < this.perEdge; pos++) {
        const rgb = this.pixels[block * this.perEdge + pos];
        if (!rgb) continue;
        const r = Math.round(rgb[0] * fade);
        const g = Math.round(rgb[1] * fade);
        const b = Math.round(rgb[2] * fade);
        const lum = (r + g + b) / 765;
        if (lum < 0.012) continue;

        const f = (pos + 0.5) / this.perEdge;
        const px = (seg.a.x + (seg.b.x - seg.a.x) * f) * scale;
        const py = (seg.a.y + (seg.b.y - seg.a.y) * f) * scale;
        const rad = (2.2 + 6 * lum) * dpr * (0.72 + 0.28 * depth);

        const grad = ctx.createRadialGradient(px, py, 0, px, py, rad * 2.6);
        grad.addColorStop(0, `rgba(${r},${g},${b},${(0.95 * fade).toFixed(3)})`);
        grad.addColorStop(0.32, `rgba(${r},${g},${b},${(0.3 * fade).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, rad * 2.6, 0, 6.2832);
        ctx.fill();

        // Hot core, brightened along its own hue rather than toward white.
        // Adding a flat +60 to every channel desaturates, which cost the blues
        // most: a pure blue point turned pale instead of bright, and on a dark
        // blue panel it read as almost nothing.
        const peak = Math.max(r, g, b) || 1;
        const boost = Math.min(255 / peak, 1.7);
        ctx.fillStyle = `rgba(${Math.round(r * boost)},${Math.round(g * boost)},${Math.round(b * boost)},${(0.9 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.9, rad * 0.36), 0, 6.2832);
        ctx.fill();
      }
    }

    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }
}
