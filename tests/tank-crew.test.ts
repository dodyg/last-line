import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { bridgeContains, bridgeKey } from '../src/simulation/bridges';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, nearestOpenCell } from '../src/simulation/terrain';
import type { BridgeSurface, Unit } from '../src/simulation/types';

function fixture(bridge?: BridgeSurface) {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.zones = { river: null, bridges: bridge ? [bridge] : [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false), soldier = sim.state.units[0]!;
  sim.state.units = [soldier]; soldier.pos = { x: 492, y: 612 }; soldier.prevPos = { ...soldier.pos };
  soldier.reloadTimer = 100_000; soldier.grenades = 0;
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.spawnEnemy('vehicle', { x: 492, y: 432 }); const tank = sim.state.units.at(-1)!;
  tank.reloadTimer = tank.secondaryReloadTimer = 100_000;
  if (bridge) tank.bridgePosition = { key: bridgeKey(bridge), level: 'deck' };
  const knockOut = (seed = 7, destroyed = false) => {
    if (destroyed) tank.health = 1;
    else tank.tankDamage = { tracks: true, turret: true, machineGun: false };
    const strike = sim.artilleryStrikeFor(1, { ...tank.pos }); strike.damage = 40; strike.sourceId = soldier.id;
    sim.state.rng.s = seed;
    return sim.step();
  };
  const crew = () => sim.state.units.filter((unit) => unit.tankCrew?.tankId === tank.id);
  return { sim, soldier, tank, knockOut, crew };
}

function readyCrew(unit: Unit, behavior: 'fight' | 'retreat') {
  unit.tankCrew!.behavior = behavior; unit.tankCrew!.bailoutTicks = 0;
  unit.pinned = false; unit.suppression = 0; unit.morale = 100; unit.reloadTimer = 0;
  unit.path = []; unit.moveGoal = null; unit.targetId = null;
}

describe('tank crew bailout', () => {
  it('abandons a fully disabled tank once, spawning four weak crew on distinct reachable ground', () => {
    const { sim, soldier, tank, knockOut, crew } = fixture();
    const events = knockOut(), survivors = crew();
    expect(tank.dead).toBe(true); expect(survivors).toHaveLength(CONFIG.armoredVehicle.crew.size);
    expect(events.filter((event) => event.type === 'tankCrewBailedOut')).toEqual([
      expect.objectContaining({ tankId: tank.id, crewIds: survivors.map((unit) => unit.id), retreating: expect.any(Number), fighting: expect.any(Number) }),
    ]);
    expect(sim.state.battleRecord.enemyKills).toBe(1); expect(soldier.kills).toBe(1);
    expect(sim.state.score).toBe(sim.content.enemy.vehicle.killValue);
    expect(new Set(survivors.map((unit) => `${unit.pos.x},${unit.pos.y}`)).size).toBe(survivors.length);
    for (const unit of survivors) {
      expect(unit.health).toBe(CONFIG.armoredVehicle.crew.health); expect(unit.team).toBe('enemy'); expect(unit.role).toBe('rifle');
      expect(unit.tankDamage).toBeUndefined(); expect(unit.transport).toBeUndefined(); expect(unit.grenades).toBe(0);
      expect(sim.weaponOf(unit)?.name).toBe('Tank crew pistol');
      const terrain = sim.state.terrain, index = Math.floor(unit.pos.y / terrain.cell) * terrain.cols + Math.floor(unit.pos.x / terrain.cell);
      expect(terrain.blocked[index]).toBe(0);
    }
    expect(sim.step().some((event) => event.type === 'tankCrewBailedOut')).toBe(false);
  });

  it('lets explosive destruction kill crew as well as leave survivors, using seeded outcomes', () => {
    const counts: number[] = [];
    for (let seed = 0; seed < 16; seed++) {
      const { knockOut, crew } = fixture(); knockOut(seed, true); counts.push(crew().length);
    }
    expect(counts.some((count) => count === 0)).toBe(true);
    expect(counts.some((count) => count > 0)).toBe(true);
    expect(counts.every((count) => count <= CONFIG.armoredVehicle.crew.size)).toBe(true);
  });

  it('gives newly bailed crew a brief pause before movement or firing', () => {
    const { sim, knockOut, crew } = fixture(); knockOut(); const survivors = crew();
    for (const unit of survivors) unit.suppression = 0;
    const positions = survivors.map((unit) => ({ ...unit.pos }));
    const pause = survivors[0]!.tankCrew!.bailoutTicks;
    const events = Array.from({ length: pause }, () => sim.step()).flat();
    expect(survivors.map((unit) => unit.pos)).toEqual(positions);
    expect(events.filter((event) => event.type === 'shot' && survivors.some((unit) => unit.id === event.shooterId))).toEqual([]);
    expect(survivors.every((unit) => unit.tankCrew!.bailoutTicks === 0)).toBe(true);
  });

  it('fighting crew actually fire short-range pistols and award infantry credit when killed', () => {
    const { sim, soldier, knockOut, crew } = fixture(); knockOut(); const survivor = crew()[0]!;
    sim.state.units = [soldier, survivor]; readyCrew(survivor, 'fight');
    survivor.pos = { x: 492, y: 500 }; survivor.prevPos = { ...survivor.pos };
    const events = sim.step();
    expect(events).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: survivor.id, targetId: soldier.id, weapon: 'Tank crew pistol' }));
    expect(sim.weaponOf(survivor)!.range).toBeLessThan(sim.content.weapons.enemy_rifle!.range);
    const before = { kills: soldier.kills, score: sim.state.score, enemyKills: sim.state.battleRecord.enemyKills };
    const strike = sim.artilleryStrikeFor(1, { ...survivor.pos }); strike.damage = 50; strike.sourceId = soldier.id;
    sim.step();
    expect(soldier.kills).toBe(before.kills + 1); expect(sim.state.score).toBe(before.score + sim.content.enemy.rifle.killValue);
    expect(sim.state.battleRecord.enemyKills).toBe(before.enemyKills + 1);
    expect(sim.state.units.some((unit) => unit.tankCrew)).toBe(false);
  });

  it('retreating crew head north without shooting and can escape without score or integrity loss', () => {
    const { sim, soldier, knockOut, crew } = fixture(); knockOut(); const survivor = crew()[0]!;
    sim.state.units = [soldier, survivor]; readyCrew(survivor, 'retreat');
    survivor.pos = { x: 492, y: 500 }; survivor.prevPos = { ...survivor.pos };
    const before = { kills: sim.state.battleRecord.enemyKills, score: sim.state.score, integrity: sim.state.integrity };
    const events = Array.from({ length: 30 }, () => sim.step()).flat();
    expect(survivor.pos.y).toBeLessThan(500);
    expect(events.filter((event) => event.type === 'shot' && event.shooterId === survivor.id)).toEqual([]);
    survivor.pos = { x: survivor.tankCrew!.exit.x, y: 24 }; survivor.prevPos = { ...survivor.pos }; survivor.path = [];
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'tankCrewEscaped', unitId: survivor.id, tankId: survivor.tankCrew!.tankId }));
    expect(sim.state.units).not.toContain(survivor);
    expect(sim.state.battleRecord.enemyKills).toBe(before.kills); expect(sim.state.score).toBe(before.score); expect(sim.state.integrity).toBe(before.integrity);
  });

  it('keeps a wave active until crew are killed or escape, then grants the clear reward once', () => {
    const { sim, soldier, knockOut, crew } = fixture(); knockOut(); const survivor = crew()[0]!;
    sim.state.units = [soldier, survivor]; readyCrew(survivor, 'retreat');
    Object.assign(sim.state.scheduler, { phase: 'active', spawnQueue: [], rewardGranted: false });
    expect(sim.step().some((event) => event.type === 'waveCleared')).toBe(false);
    survivor.pos = { x: survivor.tankCrew!.exit.x, y: 24 }; survivor.prevPos = { ...survivor.pos }; survivor.path = [];
    expect(sim.step().some((event) => event.type === 'waveCleared')).toBe(false);
    expect(sim.step().filter((event) => event.type === 'waveCleared')).toHaveLength(1);
    expect(sim.step().some((event) => event.type === 'waveCleared')).toBe(false);
  });

  it('fighting crew can still break through the defended line', () => {
    const { sim, soldier, knockOut, crew } = fixture(); knockOut(); const survivor = crew()[0]!;
    sim.state.units = [soldier, survivor]; readyCrew(survivor, 'fight');
    survivor.pos = { x: 492, y: CONFIG.breakthroughY + 1 }; survivor.prevPos = { ...survivor.pos };
    const before = sim.state.integrity;
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'breakthrough', unitId: survivor.id }));
    expect(sim.state.integrity).toBe(before - sim.content.enemy.rifle.breakthroughDamage);
    expect(sim.state.battleRecord.enemyKills).toBe(1);
  });

  it('falls back to fighting if every retreat route is blocked', () => {
    const { sim, soldier, knockOut, crew } = fixture(); knockOut(); const survivor = crew()[0]!;
    sim.state.units = [soldier, survivor]; readyCrew(survivor, 'retreat');
    sim.state.terrain.blocked.fill(1);
    sim.step(); expect(survivor.tankCrew!.behavior).toBe('fight');
  });

  it('never places escaping crew inside solid terrain when no safe dismount is available', () => {
    const { sim, tank, knockOut, crew } = fixture(); sim.state.terrain.blocked.fill(1);
    const events = knockOut(); expect(tank.dead).toBe(true); expect(crew()).toEqual([]);
    expect(events.some((event) => event.type === 'tankCrewBailedOut')).toBe(false);
  });

  it('respects the enemy cap including reserved transport passengers', () => {
    const { sim, knockOut, crew } = fixture(); sim.spawnEnemy('troop_transport', { x: 756, y: 120 });
    for (let i = 0; i < CONFIG.caps.liveEnemies - 8; i++) {
      sim.spawnEnemy('rifle', { x: 36 + i * 24, y: 60 }); sim.state.units.at(-1)!.reloadTimer = 100_000;
    }
    knockOut(); expect(crew()).toHaveLength(1);
    const occupied = sim.state.units.filter((unit) => unit.team === 'enemy').reduce((sum, unit) => sum + 1 + (unit.transport?.passengers ?? 0), 0);
    expect(occupied).toBe(CONFIG.caps.liveEnemies);
  });

  it('places crew on the same bridge deck as their tank', () => {
    const bridge: BridgeSurface = { x: 492, y: 432, axis: 'vertical', type: 'stone', halfWidth: 18, halfLength: 90 };
    const { knockOut, crew } = fixture(bridge); knockOut();
    expect(crew()).not.toHaveLength(0);
    for (const unit of crew()) {
      if (bridgeContains(bridge, unit.pos)) expect(unit.bridgePosition).toEqual({ key: bridgeKey(bridge), level: 'deck' });
    }
  });

  it('a tank that breaks through does not release crew or award a tank kill', () => {
    const { sim, tank, crew } = fixture(); tank.pos.y = CONFIG.breakthroughY + 1; tank.prevPos = { ...tank.pos };
    const events = sim.step();
    expect(events.some((event) => event.type === 'breakthrough' && event.unitId === tank.id)).toBe(true);
    expect(crew()).toEqual([]); expect(sim.state.battleRecord.enemyKills).toBe(0);
  });

  it('replays pending bailout and saved crew orders without duplicates after Continue', () => {
    const sim = new Simulation(2026); sim.state.scheduler.prepTicksLeft = 100_000;
    const pos = nearestOpenCell(sim.state.terrain, { x: 492, y: 432 }, 5)!;
    sim.spawnEnemy('vehicle', pos); const tank = sim.state.units.at(-1)!;
    tank.tankDamage = { tracks: true, turret: true, machineGun: false };
    for (const unit of sim.state.units) { unit.reloadTimer = unit.secondaryReloadTimer = 100_000; unit.grenades = 0; }
    sim.step(); sim.state.rng.s = 7; sim.artilleryStrikeFor(1, { ...tank.pos }).damage = 40;
    const load = () => {
      const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
      if ('error' in checked) throw new Error(checked.error);
      return Simulation.fromSnapshot(checked.snap);
    };
    let restored = load(); expect(restored.step()).toEqual(sim.step());
    const crewIds = sim.state.units.filter((unit) => unit.tankCrew).map((unit) => unit.id); expect(crewIds.length).toBeGreaterThan(0);
    restored = load();
    const events = [];
    for (let i = 0; i < 60; i++) { const next = sim.step(); expect(restored.step()).toEqual(next); events.push(...next); }
    expect(restored.snapshot()).toEqual(sim.snapshot());
    expect(events.some((event) => event.type === 'tankCrewBailedOut')).toBe(false);
    expect(sim.state.units.filter((unit) => unit.tankCrew).map((unit) => unit.id)).toEqual(crewIds);
  });

  it.each([
    { tankId: -1 }, { tankId: 100_000 }, { behavior: 'drive' }, { exit: null }, { exit: { x: -1, y: 12 } },
    { exit: { x: 492, y: 72 } }, { retryTick: -1 }, { retryTick: 100_000 }, { bailoutTicks: -1 }, { bailoutTicks: .5 }, { bailoutTicks: 100 },
  ])('rejects malformed saved crew state %j', (patch) => {
    const { sim, knockOut, crew } = fixture(); knockOut(); const unit = crew()[0]!;
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    Object.assign(snap.units.find((saved: Unit) => saved.id === unit.id).tankCrew, patch);
    expect(validateSnapshot(snap)).toMatchObject({ error: 'Corrupt tank crew.' });
  });

  it.each([null, [], false])('rejects malformed saved crew record %j', (record) => {
    const { sim, knockOut, crew } = fixture(); knockOut(); const unit = crew()[0]!;
    const snap = JSON.parse(JSON.stringify(sim.snapshot())); snap.units.find((saved: Unit) => saved.id === unit.id).tankCrew = record;
    expect(validateSnapshot(snap)).toMatchObject({ error: 'Corrupt tank crew.' });
  });

  it('rejects a crew record on a friendly soldier and loads older tanks without retroactive crew', () => {
    const { sim, knockOut, crew } = fixture(); knockOut(); const snap = sim.snapshot();
    snap.units[0]!.tankCrew = structuredClone(crew()[0]!.tankCrew);
    expect(validateSnapshot(JSON.parse(JSON.stringify(snap)))).toMatchObject({ error: 'Corrupt tank crew.' });
    const legacy = fixture().sim.snapshot(); legacy.schemaVersion = 19;
    const checked = validateSnapshot(JSON.parse(JSON.stringify(legacy)));
    if ('error' in checked) throw new Error(checked.error);
    expect(Simulation.fromSnapshot(checked.snap).state.units.every((unit) => unit.tankCrew === undefined)).toBe(true);
  });
});
