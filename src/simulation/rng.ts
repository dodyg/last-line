/**
 * Deterministic seeded RNG (mulberry32). The entire state is a single uint32,
 * which makes snapshots trivial to serialize and restore. All gameplay
 * randomness must flow through this; cosmetic randomness belongs to the
 * renderer and must never touch simulation state.
 */
export interface RngState {
  s: number;
}

export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

export function rngNext(state: RngState): number {
  state.s = (state.s + 0x6d2b79f5) | 0;
  let t = state.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform float in [min, max). */
export function rngRange(state: RngState, min: number, max: number): number {
  return min + rngNext(state) * (max - min);
}

/** Uniform integer in [min, max]. */
export function rngInt(state: RngState, min: number, max: number): number {
  return Math.floor(rngRange(state, min, max + 1));
}

/** Pick a random element; array must be non-empty. */
export function rngPick<T>(state: RngState, items: readonly T[]): T {
  return items[rngInt(state, 0, items.length - 1)] as T;
}

/** Fisher-Yates shuffle driven by the given rng state. */
export function rngShuffle<T>(state: RngState, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rngInt(state, 0, i);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

/**
 * Derive an independent rng state from a seed for subsystems that must not
 * consume gameplay randomness (e.g. terrain generation), so that a snapshot
 * only needs the gameplay rng state plus the original seed.
 */
export function deriveRng(seed: number, salt: number): RngState {
  return createRng((seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0);
}
