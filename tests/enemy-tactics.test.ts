import { expect, it } from 'vitest';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { buildSpawnQueue } from '../src/simulation/waves';

function fixture() {
  const data = generateTerrain(4242, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked?.fill(0);
  data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(4242, undefined, data, false);
  sim.state.units = []; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.spawnEnemy('mortar_team', { x: 480, y: 100 });
  const mortar = sim.state.units[0]!;
  const defender = sim.spawnFriendly('rifleman', { x: 480, y: 620 });
  defender.reloadTimer = 100_000; defender.grenades = 0;
  return { sim, mortar, defender };
}

it('requires a visual spotter and fires a hostile mortar strike after setup', () => {
  const { sim, mortar } = fixture();
  mortar.mortarTimer = 0;
  expect(sim.step().some((event) => event.type === 'mortarFired')).toBe(false);
  sim.spawnEnemy('rifle', { x: 480, y: 430 });
  const spotter = sim.state.units.at(-1)!; spotter.reloadTimer = 100_000;
  mortar.path = []; mortar.mortarTimer = 1;
  expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'mortarFired', unitId: mortar.id }));
  expect(sim.state.strikes).toContainEqual(expect.objectContaining({ source: 'enemy', sourceId: mortar.id, delivery: 'mortar' }));
  expect(mortar.mortarBombs).toBe(CONFIG.enemy.mortarTeam.bombs - 1);
  spotter.health = 0; mortar.mortarTimer = 0;
  expect(sim.step().some((event) => event.type === 'mortarFired')).toBe(false);
});

it('holds fire when pinned and advances when empty', () => {
  const { sim, mortar } = fixture();
  sim.spawnEnemy('rifle', { x: 480, y: 430 });
  mortar.pinned = true; mortar.suppression = CONFIG.suppression.max; mortar.mortarTimer = 0;
  expect(sim.step().some((event) => event.type === 'mortarFired')).toBe(false);
  mortar.pinned = false; mortar.suppression = 0; mortar.mortarBombs = 0;
  const y = mortar.pos.y;
  for (let i = 0; i < 60; i++) sim.step();
  expect(mortar.pos.y).toBeGreaterThan(y);
});

it('preserves mortar ammunition and tactical timers through save validation', () => {
  const sim = new Simulation(4242);
  sim.state.units = []; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.spawnEnemy('mortar_team', { x: 480, y: 100 });
  const mortar = sim.state.units[0]!;
  sim.step();
  mortar.mortarBombs = 2; mortar.nextTacticTick = 200;
  const result = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
  if ('error' in result) throw new Error(result.error);
  const restored = Simulation.fromSnapshot(result.snap);
  for (let i = 0; i < 30; i++) expect(restored.step()).toEqual(sim.step());
  expect(restored.snapshot()).toEqual(sim.snapshot());
});

it('adds mortars to later waves and retains support in veteran sectors', () => {
  const { sim } = fixture();
  sim.state.scheduler.waveIndex = 7;
  expect(buildSpawnQueue({ s: 42 }, sim.state.scheduler, false).queue).toContain('mortar_team');
  sim.state.scheduler.waveIndex = 2;
  expect(buildSpawnQueue({ s: 42 }, sim.state.scheduler, false).queue).not.toContain('mortar_team');
  expect(buildSpawnQueue({ s: 42 }, sim.state.scheduler, false, 2).queue).toContain('mortar_team');
});

it('flanks under covering fire only after tactical experience unlocks', () => {
  const { sim, defender } = fixture();
  sim.state.units = [defender];
  defender.pos = { x: 480, y: 500 }; defender.prevPos = { ...defender.pos };
  sim.state.nextEntityId = 100;
  sim.spawnEnemy('rifle', { x: 480, y: 300 });
  const flanker = sim.state.units.at(-1)!;
  sim.spawnEnemy('mg_team', { x: 510, y: 300 });
  const covering = sim.state.units.at(-1)!;
  covering.targetId = defender.id; covering.advance = false;
  sim.step();
  expect(flanker.flankUntilTick).toBeUndefined();
  sim.state.scheduler.waveIndex = 10;
  flanker.nextTacticTick = 0;
  sim.step();
  expect(flanker.flankUntilTick).toBeGreaterThan(sim.state.ticks);
  expect(flanker.moveGoal!.x).toBeGreaterThan(defender.pos.x + 80);
  expect(flanker.advance).toBe(true);
});

it('withholds mortar fire when assault troops are inside the scatter and blast area', () => {
  const { sim, mortar, defender } = fixture();
  sim.spawnEnemy('assault', { x: defender.pos.x, y: defender.pos.y - 30 });
  const assault = sim.state.units.at(-1)!; assault.reloadTimer = 100_000;
  mortar.mortarTimer = 0;
  expect(sim.step().some((event) => event.type === 'mortarFired')).toBe(false);
  expect(mortar.mortarBombs).toBe(CONFIG.enemy.mortarTeam.bombs);
});
