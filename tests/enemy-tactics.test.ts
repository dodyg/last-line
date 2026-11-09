import { expect, it, vi } from 'vitest';
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
  const strike = sim.state.strikes.find((candidate) => candidate.sourceId === mortar.id)!;
  expect(mortar.mortarBombs).toBe(CONFIG.enemy.mortarTeam.bombs - 1);
  spotter.health = 0; mortar.mortarTimer = 0;
  expect(sim.step().some((event) => event.type === 'mortarFired')).toBe(false);
  let impact = false;
  while (sim.state.ticks < strike.landTick) {
    impact ||= sim.step().some((event) => event.type === 'explosion' && event.pos.x === strike.pos.x && event.pos.y === strike.pos.y);
  }
  expect(impact).toBe(true);
  expect(sim.state.strikes.some((candidate) => candidate.id === strike.id)).toBe(false);
});

it('only aims enemy artillery at soldiers an active observer can see', () => {
  const { sim, defender } = fixture();
  defender.pos = { x: 850, y: 620 };
  const hidden = sim.spawnFriendly('rifleman', { x: 20, y: 620 });
  sim.spawnEnemy('observer', { x: 850, y: 600 });
  sim.state.terrain.elevation = undefined;
  sim.state.scheduler.phase = 'active';
  sim.state.scheduler.waveIndex = CONFIG.enemyArtillery.firstWaveWithBarrage - 1;
  const fire = vi.spyOn(sim, 'fireEnemyBarrage').mockReturnValue([]);
  for (let i = 0; i < 3000 && fire.mock.calls.length < 8; i++) sim['updateEnemyArtillery']();
  expect(fire.mock.calls.length).toBeGreaterThan(0);
  expect(fire.mock.calls.every(([target]) => target.id === defender.id && target.id !== hidden.id)).toBe(true);
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

it('scores exposure along the route, including detours away from a defender', () => {
  const { sim, defender } = fixture();
  defender.pos = { x: 480, y: 450 };
  const exposed = sim['enemyRouteExposure']({ x: 480, y: 300 }, [{ x: 480, y: 500 }], [defender]);
  const distant = sim['enemyRouteExposure']({ x: 50, y: 300 }, [{ x: 50, y: 500 }], [defender]);
  expect(exposed).toBeGreaterThan(distant);
});

it('abandons a flank when the covering soldier is pinned', () => {
  const { sim, defender } = fixture();
  sim.state.units = [defender]; defender.pos = { x: 480, y: 500 };
  sim.state.nextEntityId = 100; sim.state.scheduler.waveIndex = 10;
  sim.spawnEnemy('rifle', { x: 480, y: 300 });
  const flanker = sim.state.units.at(-1)!;
  sim.spawnEnemy('mg_team', { x: 510, y: 300 });
  const covering = sim.state.units.at(-1)!;
  covering.targetId = defender.id; covering.advance = false;
  expect(sim['enemyFlankBehavior'](flanker, defender, sim['weaponOf'](flanker))).toBe(true);
  covering.pinned = true;
  expect(sim['enemyFlankBehavior'](flanker, defender, sim['weaponOf'](flanker))).toBe(false);
  expect(flanker.flankUntilTick).toBeUndefined();
  expect(flanker.path).toHaveLength(0);
});

it('remembers the actual source of incoming suppression and preserves it in saves', () => {
  const { sim, defender } = fixture();
  sim.state.units = [defender]; defender.pos = { x: 480, y: 500 };
  sim.spawnEnemy('rifle', { x: 480, y: 350 });
  const victim = sim.state.units.at(-1)!;
  const weapon = sim['weaponOf'](defender)!;
  expect(sim.fireShot(defender, victim, weapon)).toBe(true);
  expect(victim.heardGunfire).toContainEqual(expect.objectContaining({ sourceId: defender.id, pos: defender.pos }));
  const result = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
  if ('error' in result) throw new Error(result.error);
  expect(Simulation.fromSnapshot(result.snap).state.units.find((u) => u.id === victim.id)?.heardGunfire).toEqual(victim.heardGunfire);
});

it('does not use unobserved defenders when picking an approach lane', () => {
  const { sim, defender } = fixture();
  sim.state.units = [defender];
  const exposure = vi.spyOn(sim as any, 'enemyRouteExposure');
  sim['chooseEnemyApproachLane'](480);
  expect(exposure).toHaveBeenCalled();
  expect(exposure.mock.calls.every((call) => (call[2] as unknown[]).length === 0)).toBe(true);
});

it('prioritizes the defender who recently suppressed a pinned comrade', () => {
  const { sim, defender } = fixture();
  sim.state.units = [defender]; defender.pos = { x: 480, y: 500 };
  const decoy = sim.spawnFriendly('rifleman', { x: 470, y: 490 });
  sim.spawnEnemy('rifle', { x: 480, y: 350 });
  const victim = sim.state.units.at(-1)!;
  sim.spawnEnemy('mg_team', { x: 510, y: 350 });
  const helper = sim.state.units.at(-1)!;
  expect(sim.fireShot(defender, victim, sim['weaponOf'](defender)!)).toBe(true);
  victim.pinned = true;
  expect(sim['pinnedComradeSuppressor'](helper, [decoy, defender], sim['weaponOf'](helper)!, () => 1)?.id).toBe(defender.id);
});

it('pairs nearby attackers against the same contact for alternating bounds', () => {
  const { sim, defender } = fixture();
  sim.state.units = [defender]; defender.pos = { x: 480, y: 500 };
  sim.spawnEnemy('rifle', { x: 460, y: 300 });
  const first = sim.state.units.at(-1)!;
  sim.spawnEnemy('rifle', { x: 500, y: 300 });
  const second = sim.state.units.at(-1)!;
  first.targetId = second.targetId = defender.id;
  vi.spyOn(sim as any, 'moveEnemyToCover').mockReturnValue(false);
  vi.spyOn(sim as any, 'enemyHasCover').mockReturnValue(false);
  sim['enemyBehavior'](first, defender, sim['weaponOf'](first));
  sim['enemyBehavior'](second, defender, sim['weaponOf'](second));
  expect(first.advance).not.toBe(second.advance);
});
