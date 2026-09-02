/**
 * Auto-cycle.
 *
 * Rotates through a chosen pool on an interval, in the spirit of the cube's own
 * behaviour (its patterns change every 60s by default) but across both pixel
 * sources: our streamed looks and the firmware's built-in effects.
 *
 * The pools exist because "shuffle everything" is rarely what you want. Sound-
 * reactive effects look broken in a silent room, and a party wants only those -
 * so the two are separable rather than merged into one bag.
 */

export const POOLS = {
  looks: 'My saved looks',
  favorites: 'My favourites',
  patterns: 'My patterns',
  effects: 'Built-in effects — all',
  'effects-sound': 'Built-in effects — sound-reactive',
  'effects-static': 'Built-in effects — not sound-reactive',
  all: 'Everything',
};

export class Cycler {
  /**
   * @param deps.renderer      the Renderer, for streamed items
   * @param deps.device        (path, init) => Promise<json>, for firmware items
   * @param deps.listPresets   () => Promise<preset[]>
   * @param deps.listEffects   () => Promise<{id,label,sound}[]>
   * @param deps.animations    the ANIMATIONS registry
   */
  constructor(deps) {
    this.deps = deps;
    this.enabled = false;
    this.pool = 'effects-sound';
    this.interval = 60;          // seconds, matching the cube's own default
    this.order = 'shuffle';      // shuffle | sequential
    this.timer = null;
    this.nextAt = 0;
    this.currentLabel = null;
    this.queue = [];             // remaining items this pass
    this.cursor = 0;
  }

  status() {
    return {
      enabled: this.enabled,
      pool: this.pool,
      interval: this.interval,
      order: this.order,
      current: this.currentLabel,
      // Lets the UI count down without needing its own timer to stay in step.
      secondsLeft: this.enabled ? Math.max(0, Math.round((this.nextAt - Date.now()) / 1000)) : null,
    };
  }

  async set({ enabled, pool, interval, order }) {
    if (typeof pool === 'string' && POOLS[pool]) { this.pool = pool; this.queue = []; }
    if (Number.isFinite(Number(interval))) {
      // Below ~5s the cube spends more time transitioning than showing anything.
      this.interval = Math.min(3600, Math.max(5, Math.round(Number(interval))));
    }
    if (order === 'shuffle' || order === 'sequential') { this.order = order; this.queue = []; }

    if (typeof enabled === 'boolean' && enabled !== this.enabled) {
      this.enabled = enabled;
      if (enabled) await this.startTimer(true);
      else this.stopTimer();
    } else if (this.enabled) {
      await this.startTimer(false);   // reschedule against the new interval
    }
    return this.status();
  }

  stopTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.currentLabel = null;
    this.nextAt = 0;
  }

  async startTimer(advanceNow) {
    clearTimeout(this.timer);
    if (advanceNow) await this.advance();
    this.nextAt = Date.now() + this.interval * 1000;
    this.timer = setTimeout(() => this.tick(), this.interval * 1000);
  }

  async tick() {
    if (!this.enabled) return;
    try { await this.advance(); } catch { /* keep cycling despite one bad item */ }
    this.nextAt = Date.now() + this.interval * 1000;
    this.timer = setTimeout(() => this.tick(), this.interval * 1000);
  }

  /** Builds the candidate list for the current pool. */
  async items() {
    const { listPresets, listEffects, animations } = this.deps;
    const out = [];

    if (this.pool === 'looks' || this.pool === 'all') {
      for (const p of await listPresets()) {
        out.push({ kind: 'preset', id: p.id, label: p.name });
      }
    }
    // Standalone, deliberately not folded into the `all` branch above: `all`
    // already walks every preset, so OR-ing this in would enter a starred look
    // twice and skew the shuffle towards it.
    //
    // Spans all three kinds, because a star means the same thing wherever it
    // was put - "play this one" - and a favourites rotation that silently
    // skipped the starred effects would be lying about its own name.
    if (this.pool === 'favorites') {
      for (const p of await listPresets()) {
        if (p.favorite) out.push({ kind: 'preset', id: p.id, label: p.name });
      }
      const fav = this.deps.listFavorites ? await this.deps.listFavorites() : { animation: [], effect: [] };
      for (const id of fav.animation) {
        if (animations[id]) out.push({ kind: 'animation', id, label: animations[id].label ?? id });
      }
      // Modes are excluded for the same reason they are excluded everywhere
      // else: they are the firmware's own rotations, and cycling one alongside
      // single effects is two rotations fighting over the same LEDs.
      const byId = new Map((await listEffects()).map((e) => [e.id, e]));
      for (const id of fav.effect) {
        const e = byId.get(id);
        if (e && !e.mode) out.push({ kind: 'effect', id: e.id, label: e.label });
      }
    }
    if (this.pool === 'patterns' || this.pool === 'all') {
      for (const [id, a] of Object.entries(animations)) {
        out.push({ kind: 'animation', id, label: a.label ?? id });
      }
    }
    if (this.pool.startsWith('effects') || this.pool === 'all') {
      // Exclude the three "Mode:" entries: they are the firmware's own rotating
      // playlists, so cycling them alongside single effects means two rotations
      // fighting over the same LEDs.
      const fx = (await listEffects()).filter((e) => !e.mode);
      const want = this.pool === 'effects-sound' ? (e) => e.sound
        : this.pool === 'effects-static' ? (e) => !e.sound
        : () => true;
      for (const e of fx.filter(want)) {
        out.push({ kind: 'effect', id: e.id, label: e.label });
      }
    }
    return out;
  }

  async advance() {
    let all = await this.items();
    if (!all.length) { this.currentLabel = null; return; }

    // Refill on exhaustion rather than picking at random each tick: a shuffled
    // pass shows everything once before repeating, which is what people expect
    // from shuffle and what pure random conspicuously fails to do.
    if (!this.queue.length) {
      this.queue = all.slice();
      if (this.order === 'shuffle') {
        for (let i = this.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
      }
    }

    const item = this.queue.shift();
    await this.apply(item);
    this.currentLabel = item.label;
  }

  async apply(item) {
    const { renderer, device, listPresets } = this.deps;

    if (item.kind === 'effect') {
      // Realtime data overrides the firmware's effects, so release first.
      await renderer.stop({ blank: false });
      await device('/json/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seg: [{ fx: item.id }] }),
      });
      return;
    }

    if (item.kind === 'preset') {
      const entry = (await listPresets()).find((p) => p.id === item.id);
      if (!entry) return;
      renderer.setAnimParams(entry.animation, entry.values);
      if (entry.playback) {
        // Brightness is never restored from a preset; it belongs to the room.
        const { brightness, ...playback } = entry.playback;
        renderer.setParams(playback);
      }
      await renderer.play(entry.animation);
      return;
    }

    await renderer.play(item.id);
  }
}
