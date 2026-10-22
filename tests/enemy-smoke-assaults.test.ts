import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { targetIsValid } from '../src/simulation/combat';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture(realTerrain = false) {
  const data = generateTerrain(2026, false, 2);
  if (!realTerrain) {
    data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
    data.terrain.elevation?.heights.fill(0); data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  }
  const sim = new Simulation(2026, undefined, data, false); sim.state.units = [];
  const defender = sim.spawnFriendly('rifleman', { x: 492, y: 612 });
  sim.spawnEnemy('assault', { x: 492, y: 372 }); const leader = sim.state.units.at(-1)!;
  sim.spawnEnemy('rifle', { x: 516, y: 372 }); const rifle = sim.state.units.at(-1)!;
  sim.state.scheduler.waveIndex = 3; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  for (const unit of sim.state.units) { unit.reloadTimer = 100_000; unit.grenades = 0; unit.morale = 100; }
  const tick = (count: number) => Array.from({ length: count }, () => sim.step()).flat();
  return { sim, defender, leader, rifle, tick };
}

describe('enemy smoke-screen assaults', () => {
  it('warns before deploying one shared screen, spends one grenade, and advances the squad', () => {
    const { sim, leader, rifle, tick } = fixture();
    expect(leader.smokeGrenades).toBe(1); expect(rifle.smokeGrenades).toBe(0);
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'enemySmokeAssaultWarned', unitId: leader.id }));
    const plan = sim.state.enemySmokeAssaults![0]!;
    expect(plan.unitIds).toEqual([leader.id, rifle.id]); expect(plan.deployed).toBe(false); expect(sim.state.smokes).toEqual([]);
    const before = { ...leader.pos }; tick(plan.deployTick - sim.state.ticks - 1);
    expect(leader.pos.y).toBeCloseTo(before.y); expect(sim.state.smokes).toEqual([]); expect(leader.smokeGrenades).toBe(1);
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'enemySmokeAssaultDeployed', unitId: leader.id, ticks: CONFIG.tickRate * CONFIG.smoke.durationSeconds }));
    expect(leader.smokeGrenades).toBe(0); expect(sim.state.smokes).toHaveLength(1);
    expect(sim.state.smokes[0]!.radius).toBe(CONFIG.smoke.radius); expect(plan.deployed).toBe(true);
    const leadY = leader.pos.y, rifleY = rifle.pos.y; tick(60);
    expect(leader.pos.y).toBeGreaterThan(leadY); expect(rifle.pos.y).toBeGreaterThan(rifleY);
    expect(leader.running).toBe(false); expect(rifle.running).toBe(false);
  });

  it.each(['earlyWave', 'alone', 'noGrenade', 'pinned', 'wounded', 'crew', 'vehicle', 'observer', 'camouflagedTarget', 'tooClose', 'tooFar', 'smokeAlreadyPresent', 'crossing'] as const)('does not initiate an assault when %s', (condition) => {
    const { sim, leader, rifle, defender } = fixture();
    if (condition === 'earlyWave') sim.state.scheduler.waveIndex = 2;
    if (condition === 'alone') { rifle.dead = true; rifle.health = 0; }
    if (condition === 'noGrenade') leader.smokeGrenades = 0;
    if (condition === 'pinned') { leader.pinned = true; leader.suppression = CONFIG.suppression.max; }
    if (condition === 'wounded') leader.health = 10;
    if (condition === 'crew') leader.tankCrew = { tankId: 1, behavior: 'fight', exit: { x: 492, y: 0 }, retryTick: 0, bailoutTicks: 0 };
    if (condition === 'vehicle') leader.role = 'vehicle';
    if (condition === 'observer') leader.role = 'observer';
    if (condition === 'camouflagedTarget') defender.specialization = 'camouflage';
    if (condition === 'tooClose') defender.pos.y = 430;
    if (condition === 'tooFar') defender.pos.y = 700;
    if (condition === 'smokeAlreadyPresent') sim.state.smokes.push({ id: sim.state.nextEntityId++, pos: { x: 492, y: 504 }, radius: 72, ticksRemaining: 240 });
    if (condition === 'crossing') sim.state.scheduler.phase = 'crossing';
    expect(sim.step().some((event) => event.type === 'enemySmokeAssaultWarned')).toBe(false);
    expect(sim.state.enemySmokeAssaults).toEqual([]);
  });

  it('cannot target a defender behind a solid wall', () => {
    const { sim } = fixture(); const terrain = sim.state.terrain;
    for (let col = 0; col < terrain.cols; col++) terrain.blocked[Math.floor(500 / terrain.cell) * terrain.cols + col] = 1;
    expect(sim.step().some((event) => event.type === 'enemySmokeAssaultWarned')).toBe(false);
  });

  it.each(['pinned', 'killed', 'squadKilled'] as const)('cancels a pending throw when %s without spending smoke', (condition) => {
    const { sim, leader, rifle, tick } = fixture(); sim.step();
    if (condition === 'pinned') { leader.pinned = true; leader.suppression = CONFIG.suppression.max; }
    if (condition === 'killed') { leader.dead = true; leader.health = 0; }
    if (condition === 'squadKilled') { rifle.dead = true; rifle.health = 0; }
    expect(sim.step()).toContainEqual({ type: 'enemySmokeAssaultCancelled', unitId: leader.id });
    expect(leader.smokeGrenades).toBe(1);
    if (condition === 'pinned') leader.smokeGrenades = 0;
    expect(tick(60).some((event) => event.type === 'enemySmokeAssaultDeployed')).toBe(false);
    expect(sim.state.smokes).toEqual([]);
  });

  it('blocks both teams small arms but permits rockets through the screen', () => {
    const { sim, defender, leader, tick } = fixture(); sim.step(); tick(CONFIG.enemy.smokeAssault.warningSeconds * CONFIG.tickRate);
    const valid = (from: typeof defender, to: typeof leader, weapon = sim.weaponOf(from)!) => targetIsValid(sim.content, sim.state.terrain, [], from, to, weapon, CONFIG, [], sim.state.smokes);
    expect(valid(defender, leader)).toBe(false);
    expect(valid(leader, defender, sim.content.weapons.enemy_rifle!)).toBe(false);
    expect(valid(defender, leader, sim.content.weapons.at!)).toBe(true);
    defender.reloadTimer = 0; leader.reloadTimer = 0;
    expect(tick(30).some((event) => event.type === 'shot')).toBe(false);
  });

  it('preserves a deployed screen after the thrower dies and expires it on schedule', () => {
    const { sim, leader, rifle, tick } = fixture(); sim.step(); const plan = sim.state.enemySmokeAssaults![0]!;
    tick(plan.deployTick - sim.state.ticks); leader.dead = true; leader.health = 0;
    const before = rifle.pos.y; tick(30);
    expect(sim.state.smokes).toHaveLength(1); expect(rifle.pos.y).toBeGreaterThan(before);
    tick(plan.endTick - sim.state.ticks);
    expect(sim.state.smokes).toEqual([]); expect(sim.state.enemySmokeAssaults).toEqual([]);
    expect(tick(60).some((event) => event.type === 'enemySmokeAssaultDeployed')).toBe(false);
  });

  it('allows real bazooka launches and mortar bombs to counter the protected attackers', () => {
    const { sim, tick } = fixture(); sim.step(); tick(45);
    const at = sim.spawnFriendly('at', { x: 516, y: 612 }), mortar = sim.spawnFriendly('mortarman', { x: 300, y: 612 });
    at.reloadTimer = 0; mortar.mortarTimer = 0;
    const events = sim.step();
    expect(events).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: at.id, weapon: 'M1A1 Bazooka' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'mortarFired', unitId: mortar.id }));
    expect(at.rockets).toBe(3); expect(mortar.mortarBombs).toBe(5);
  });

  it('drops screens and assault orders when the squad arrives on a new map', () => {
    const { sim, defender, tick } = fixture(); sim.step(); tick(45);
    defender.pos.y = CONFIG.crossing.thresholdY - 1; sim.step();
    expect(sim.state.mapNumber).toBe(2); expect(sim.state.smokes).toEqual([]); expect(sim.state.enemySmokeAssaults).toEqual([]);
  });

  it('assigns a squad to one thrower, preventing duplicate overlapping deployments', () => {
    const { sim, tick } = fixture(); sim.spawnEnemy('assault', { x: 468, y: 372 }); sim.state.units.at(-1)!.reloadTimer = 100_000;
    expect(sim.step().filter((event) => event.type === 'enemySmokeAssaultWarned')).toHaveLength(1);
    expect(tick(60).filter((event) => event.type === 'enemySmokeAssaultDeployed')).toHaveLength(1);
    expect(sim.state.smokes).toHaveLength(1);
  });

  it('pinned participants stop instead of continuing the protected push', () => {
    const { sim, rifle, tick } = fixture(); sim.step(); tick(45);
    rifle.pinned = true; rifle.suppression = CONFIG.suppression.max; const y = rifle.pos.y;
    tick(10); expect(rifle.pos.y).toBeCloseTo(y); expect(rifle.path).toEqual([]);
  });

  it.each([false, true])('continues the same warned or deployed assault deterministically, deployed=%s', (deployed) => {
    const { sim, tick } = fixture(true); sim.step(); if (deployed) tick(45);
    expect(sim.state.enemySmokeAssaults).toHaveLength(1);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap), events = [];
    for (let i = 0; i < 320; i++) { const next = sim.step(); expect(restored.step()).toEqual(next); events.push(...next); }
    expect(restored.snapshot()).toEqual(sim.snapshot());
    expect(events.filter((event) => event.type === 'enemySmokeAssaultDeployed')).toHaveLength(deployed ? 0 : 1);
  });

  it('loads older saves without inventing a pending assault', () => {
    const { sim } = fixture(); const old = sim.snapshot(); old.schemaVersion = 22; delete old.enemySmokeAssaults;
    const checked = validateSnapshot(JSON.parse(JSON.stringify(old))); if ('error' in checked) throw new Error(checked.error);
    expect(checked.snap.schemaVersion).toBe(30); expect(checked.snap.enemySmokeAssaults).toEqual([]);
  });

  it.each(['badPosition', 'badTicks', 'duplicateSquad', 'duplicatePlans', 'badLeader', 'badFlag'] as const)('rejects malformed saved plans: %s', (condition) => {
    const { sim } = fixture(); sim.step(); const saved = JSON.parse(JSON.stringify(sim.snapshot())), plan = saved.enemySmokeAssaults[0];
    if (condition === 'badPosition') plan.pos.y = -1;
    if (condition === 'badTicks') plan.endTick = plan.deployTick;
    if (condition === 'duplicateSquad') plan.unitIds.push(plan.unitIds[0]);
    if (condition === 'duplicatePlans') saved.enemySmokeAssaults.push(plan);
    if (condition === 'badLeader') plan.leaderId = 1.5;
    if (condition === 'badFlag') plan.deployed = 'yes';
    expect(validateSnapshot(saved)).toHaveProperty('error');
  });
});
