/** Slow feedback avoids reacting to individual explosions, loading, or GC stalls. */
export class AdaptiveResolution {
  scale = 1;
  private elapsed = 0;
  private frames = 0;
  private warmup = 2000;
  private headroom = 0;

  sample(deltaMs: number): number | null {
    if (deltaMs <= 0 || !Number.isFinite(deltaMs)) return null;
    if (deltaMs >= 1000) {
      this.elapsed = this.frames = this.headroom = 0;
      return null; // Tab restoration and debugger pauses are not GPU pressure.
    }
    if (this.warmup > 0) { this.warmup -= deltaMs; return null; }
    this.elapsed += Math.min(deltaMs, 100);
    this.frames++;
    if (this.elapsed < 1000 || this.frames < 8) return null;
    const average = this.elapsed / this.frames;
    const windowMs = this.elapsed;
    this.elapsed = this.frames = 0;
    let next = this.scale;
    if (average > 22) {
      next = Math.max(.5, this.scale - (average > 40 ? .2 : .1));
      this.headroom = 0;
    } else if (average < 18) {
      this.headroom += windowMs;
      if (this.headroom >= 5000) { next = Math.min(1, this.scale + .05); this.headroom = 0; }
    } else this.headroom = 0;
    // Round to avoid drift at either bound over long sessions.
    next = Math.round(next * 100) / 100;
    if (next === this.scale) return null;
    this.scale = next;
    return next;
  }
}
