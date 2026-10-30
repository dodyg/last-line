import { expect, it } from 'vitest';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

it.each(['rifle', 'gun_truck'] as const)('wounded %s resumes the advance after losing contact instead of stalling the wave', (role) => {
  const terrain = generateTerrain(4242, false, 2);
  terrain.terrain.blocked.fill(0);
  terrain.terrain.baseBlocked?.fill(0);
  terrain.kinds.fill(0);
  terrain.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(4242, undefined, terrain, false);
  sim.state.units = [];
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.spawnEnemy(role, { x: 480, y: 300 });
  const enemy = sim.state.units[0]!;
  enemy.health = 1;
  enemy.path = [];
  enemy.moveGoal = null;
  const startY = enemy.pos.y;
  for (let i = 0; i < 90; i++) sim.step();
  expect(enemy.advance).toBe(true);
  expect(enemy.pos.y).toBeGreaterThan(startY + 10);
});
