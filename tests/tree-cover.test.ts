import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, hasLineOfSight, TERRAIN_KIND } from '../src/simulation/terrain';
import { findPath } from '../src/simulation/navigation';
import type { Team } from '../src/simulation/types';

const species = ['oak', 'beech', 'birch', 'pine', 'fruitTree', 'trees'] as const;

function fixture(team: Team = 'friendly', distance = 252) {
  const data = generateTerrain(2026, false, 2);
  data.kinds.fill(TERRAIN_KIND.open);
  data.terrain.blocked.fill(0);
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.weather = 'clear';
  const friendly = sim.state.units[0]!;
  sim.spawnEnemy('rifle', { x: 0, y: 0 });
  const enemy = sim.state.units.find((unit) => unit.team === 'enemy')!;
  sim.state.units = [friendly, enemy];
  const shooter = team === 'friendly' ? friendly : enemy;
  const target = team === 'friendly' ? enemy : friendly;
  shooter.pos = { x: 132, y: 132 };
  target.pos = { x: 132 + distance, y: 132 };
  for (const unit of sim.state.units) {
    unit.prevPos = { ...unit.pos };
    unit.grenades = 0;
  }
  const putTree = (x: number, kind: number) => {
    data.kinds[Math.floor(132 / data.terrain.cell) * data.terrain.cols + Math.floor(x / data.terrain.cell)] = kind;
  };
  return { sim, shooter, target, data, putTree };
}

function rifleDamage({ sim, shooter, target, data }: ReturnType<typeof fixture>): number {
  target.health = 100_000;
  const standingTrees = data.kinds.slice();
  // Independent accuracy trials against standing foliage; cumulative destruction has its own tests.
  for (let i = 0; i < 1000; i++) {
    data.kinds.set(standingTrees); sim.state.treeDamage = [];
    sim.fireShot(shooter, target, sim.content.weapons.rifle!);
  }
  return 100_000 - target.health;
}

describe('tree cover across species', () => {
  it.each(species)('%s reduces actual rifle hits without making infantry impassable', (species) => {
    const exposed = fixture('friendly', 120);
    const sheltered = fixture('friendly', 120);
    sheltered.putTree(sheltered.target.pos.x, TERRAIN_KIND[species]);
    expect(rifleDamage(sheltered)).toBeLessThan(rifleDamage(exposed) * .8);
    expect(hasLineOfSight(sheltered.sim.state.terrain, sheltered.shooter.pos, sheltered.target.pos)).toBe(true);
    expect(findPath(sheltered.sim.state.terrain, sheltered.shooter.pos, sheltered.target.pos).reachable).toBe(true);
  });

  for (const team of ['friendly', 'enemy'] as const) {
    it.each(species)(`${team} detects a distant target in the open but loses it under %s`, (species) => {
      const { sim, shooter, target, putTree } = fixture(team);
      sim.step();
      expect(shooter.targetId).toBe(target.id);
      putTree(target.pos.x, TERRAIN_KIND[species]);
      sim.step();
      expect(shooter.targetId).toBeNull();
    });

    it(`${team} loses distant sight through a stand of trees but can still engage at close range`, () => {
      const { sim, shooter, target, putTree } = fixture(team);
      sim.step();
      expect(shooter.targetId).toBe(target.id);
      for (const x of [180, 228, 276]) putTree(x, TERRAIN_KIND.pine);
      sim.step();
      expect(shooter.targetId).toBeNull();
      target.pos = { x: 240, y: 132 };
      target.prevPos = { ...target.pos };
      sim.step();
      expect(shooter.targetId).toBe(target.id);
    });
  }

  it('adds bullet protection with each intervening tree', () => {
    const open = fixture('friendly', 192);
    const wooded = fixture('friendly', 192);
    for (const x of [180, 228, 276]) wooded.putTree(x, TERRAIN_KIND.oak);
    expect(rifleDamage(wooded)).toBeLessThan(rifleDamage(open) * .8);
  });
});
