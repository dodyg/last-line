import { describe, expect, it } from 'vitest';
import { autoplay, passiveRun } from './helpers/autoplay';

/**
 * Balance smoke checks: the fifteen-wave campaign must be winnable with a
 * simple sensible strategy (see helpers/autoplay.ts) and must still defeat a
 * passive defender. These probe overall difficulty, not individual rules.
 */

describe('campaign balance', () => {
  it('an active defender wins across several seeds', () => {
    const results = [11, 2026, 777, 4242].map((seed) => autoplay(seed));
    for (const r of results) {
      expect(
        { victory: r.victory, waveReached: r.waveReached, integrity: r.integrity },
        `seed run reached wave ${r.waveReached} with ${r.breakthroughs} breakthroughs`,
      ).toEqual({ victory: true, waveReached: expect.any(Number), integrity: expect.any(Number) });
    }
    // A normal run should take roughly 15-25 minutes of game time; allow margin.
    const minutes = results.map((r) => r.ticks / (30 * 60));
    for (const m of minutes) {
      expect(m).toBeGreaterThan(10);
      expect(m).toBeLessThan(40);
    }
  }, 240_000);

  it('a passive defender is eventually defeated', () => {
    const r = passiveRun(2026);
    expect(r.victory).toBe(false);
    expect(r.waveReached).toBeLessThan(15);
  }, 240_000);

  /**
   * Regression: Axis infantry used to bound only once they had already closed to
   * their engagement distance, so the entire approach was a silent walk into the
   * defenders' longer-ranged rifles. Measured before the fix, around one Axis
   * soldier in ten ever fired a round in a real game, and Axis fire was under 1%
   * of all shots - the enemy was a moving target rather than a combatant.
   */
  it('Axis infantry return fire instead of dying silent', () => {
    const results = [11, 2026, 777].map((seed) => autoplay(seed));
    const spawned = results.reduce((a, r) => a + r.enemiesSpawned, 0);
    const fired = results.reduce((a, r) => a + r.enemiesThatFired, 0);
    const enemyShots = results.reduce((a, r) => a + r.enemyShots, 0);
    const friendlyShots = results.reduce((a, r) => a + r.friendlyShots, 0);
    // The majority of attackers get a shot away before they are killed.
    expect(fired / spawned).toBeGreaterThan(0.45);
    // And Axis fire is a real share of the battle, not a rounding error.
    expect(enemyShots / (enemyShots + friendlyShots)).toBeGreaterThan(0.05);
  }, 240_000);
});
