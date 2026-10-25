import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { chooseGrenadeTarget, dist, grenadeTargets, isShelteredFrom } from '../src/simulation/combat';
import { latestNightContact } from '../src/simulation/perception';
import { createRng, rngInt } from '../src/simulation/rng';
import { Simulation } from '../src/simulation/simulation';
import type { GameConfig, NightContact, Terrain, Unit } from '../src/simulation/types';

const template = new Simulation(2026).state.units[0]!;
const terrain: Terrain = { cols: 40, rows: 30, cell: 24, blocked: new Uint8Array(1200) };
const shooter: Unit = { ...template, pos: { x: 480, y: 360 }, grenades: 4, grenadeTimer: 0, pinned: false };
const enemy = (id: number, x: number, y: number): Unit => ({ ...template, id, team: 'enemy', pos: { x, y }, health: 100, dead: false });

// Retain the previous ranking as an oracle for behavior-preserving optimization.
function referenceGrenade(candidates: readonly Unit[], config: GameConfig): Unit | null {
  const inRange = grenadeTargets(shooter, candidates, config);
  if (!inRange.length) return null;
  const clusterAt = (centre: Unit) => inRange.filter((other) => dist(other.pos, centre.pos) <= config.grenade.radius).length;
  const best = [...inRange].sort((a, b) => clusterAt(b) - clusterAt(a)
    || dist(shooter.pos, a.pos) - dist(shooter.pos, b.pos) || a.id - b.id)[0]!;
  if (clusterAt(best) >= config.grenade.clusterThreshold) return best;
  return config.grenade.throwAtCoveredTargets ? inRange
    .filter((cand) => isShelteredFrom(terrain, [], [], cand.pos, shooter.pos, config))
    .sort((a, b) => dist(shooter.pos, a.pos) - dist(shooter.pos, b.pos) || a.id - b.id)[0] ?? null : null;
}

describe('grenade target selection', () => {
  it('matches the previous ranking across seeded crowds, cover, and cluster thresholds', () => {
    const rng = createRng(8451);
    for (let trial = 0; trial < 120; trial++) {
      terrain.blocked.fill(0);
      if (trial % 2) for (let row = 0; row < terrain.rows; row++) terrain.blocked[row * terrain.cols + 21] = 1;
      const candidates = Array.from({ length: trial % 45 }, (_, i) => {
        const unit = enemy(100 - i, rngInt(rng, 250, 710), rngInt(rng, 130, 590));
        if (i % 11 === 0) unit.team = 'friendly';
        if (i % 13 === 0) unit.dead = true;
        if (i % 17 === 0) unit.health = 0;
        return unit;
      });
      const config = { ...CONFIG, grenade: { ...CONFIG.grenade, clusterThreshold: trial % 10 + 1, throwAtCoveredTargets: trial % 3 !== 0 } };
      expect(chooseGrenadeTarget(terrain, [], shooter, candidates, config)).toBe(referenceGrenade(candidates, config));
    }
    terrain.blocked.fill(0);
  });

  it('breaks equal cluster sizes by distance, then entity ID, independently of candidate order', () => {
    const far = enemy(1, 600, 360), near = enemy(8, 400, 360), tied = enemy(3, 560, 360);
    const config = { ...CONFIG, grenade: { ...CONFIG.grenade, clusterThreshold: 1, radius: 0 } };
    expect(chooseGrenadeTarget(terrain, [], shooter, [far, near], config)).toBe(near);
    expect(chooseGrenadeTarget(terrain, [], shooter, [near, tied], config)).toBe(tied);
    expect(chooseGrenadeTarget(terrain, [], shooter, [tied, near], config)).toBe(tied);
  });

  it('includes targets exactly at the throw and blast boundaries', () => {
    const a = enemy(2, shooter.pos.x + CONFIG.grenade.range, shooter.pos.y);
    const b = enemy(1, a.pos.x - CONFIG.grenade.radius, a.pos.y);
    expect(chooseGrenadeTarget(terrain, [], shooter, [a, b], CONFIG)).toBe(b);
    expect(chooseGrenadeTarget(terrain, [], { ...shooter, pinned: true }, [a, b], CONFIG)).toBeNull();
    expect(chooseGrenadeTarget(terrain, [], { ...shooter, grenades: 0 }, [a, b], CONFIG)).toBeNull();
    expect(chooseGrenadeTarget(terrain, [], { ...shooter, grenadeTimer: 1 }, [a, b], CONFIG)).toBeNull();
  });
});

describe('latest night contact selection', () => {
  const contact = (sourceId: number, noticedTick: number, x: number, expiresTick = 100): NightContact => ({
    sourceId, noticedTick, pos: { x, y: shooter.pos.y }, expiresTick, height: 0, kind: 'sound',
  });

  it('prefers recency, then proximity, then source ID, excluding expired contacts', () => {
    const contacts = [contact(1, 20, 480, 50), contact(2, 5, 480), contact(8, 10, 470), contact(3, 10, 490), contact(4, 10, 510)];
    expect(latestNightContact({ ...shooter, nightContacts: contacts }, 50)).toBe(contacts[3]);
    expect(contacts.map((item) => item.sourceId)).toEqual([1, 2, 8, 3, 4]);
    expect(latestNightContact({ ...shooter, nightContacts: contacts }, 100)).toBeUndefined();
    expect(latestNightContact({ ...shooter, nightContacts: undefined }, 50)).toBeUndefined();
  });

  it('matches the previous ranking across seeded contact histories', () => {
    const rng = createRng(6731);
    for (let trial = 0; trial < 100; trial++) {
      const contacts = Array.from({ length: trial }, (_, i) => contact(i, rngInt(rng, 0, 10), rngInt(rng, 400, 560), rngInt(rng, 30, 100)));
      const expected = contacts.filter((item) => item.expiresTick > 50).sort((a, b) => b.noticedTick - a.noticedTick
        || dist(shooter.pos, a.pos) - dist(shooter.pos, b.pos) || a.sourceId - b.sourceId)[0];
      expect(latestNightContact({ ...shooter, nightContacts: contacts }, 50)).toBe(expected);
    }
  });
});
