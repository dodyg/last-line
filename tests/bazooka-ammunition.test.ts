import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false); sim.state.units = [];
  const soldier = sim.spawnFriendly('at', { x: 588, y: 612 });
  const officer = sim.spawnFriendly('supply_officer', { x: 156, y: 612 });
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  officer.reloadTimer = 100_000;
  const call = () => sim.command({ type: 'callRocketSupplies', unitId: soldier.id });
  const tick = (count: number) => Array.from({ length: count }, () => sim.step()).flat();
  return { sim, soldier, officer, call, tick };
}

describe('bazooka ammunition and supply deliveries', () => {
  it('starts anti-tank recruits with four rockets and grants no rockets to other roles', () => {
    const { sim, soldier, officer } = fixture();
    expect(soldier.rockets).toBe(4); expect(officer.rockets).toBe(0);
    const rifleman = sim.spawnFriendly('rifleman', { x: 300, y: 612 }); expect(rifleman.rockets).toBe(0);
  });

  it('spends exactly one rocket on each hit or miss, and direct firing cannot bypass an empty loadout', () => {
    const { sim, soldier } = fixture(); sim.spawnEnemy('rifle', { x: 588, y: 432 }); const enemy = sim.state.units.at(-1)!;
    for (const seed of [7, 4, 7, 4]) {
      const before = soldier.rockets!; sim.state.rng.s = seed;
      expect(sim.fireShot(soldier, enemy, sim.weaponOf(soldier)!)).toBe(true);
      expect(soldier.rockets).toBe(before - 1);
    }
    expect(sim.state.projectiles).toHaveLength(4);
    expect(sim.state.projectiles.some((rocket) => rocket.target.x !== enemy.pos.x || rocket.target.y !== enemy.pos.y)).toBe(true);
    const before = sim.snapshot(); expect(sim.fireShot(soldier, enemy, getContent().weapons.at!)).toBe(false);
    expect(sim.snapshot()).toEqual(before);
    expect(sim.weaponOf(soldier)?.name).toBe('M1 Garand');
    expect(sim.fireShot(soldier, enemy, sim.weaponOf(soldier)!)).toBe(true); expect(soldier.rockets).toBe(0);
    expect(sim.state.projectiles).toHaveLength(4);
  });

  it('does not spend rockets while moving, pinned, reloading, or upgrading a weapon', () => {
    const { sim, soldier, tick } = fixture(); sim.spawnEnemy('rifle', { x: 588, y: 432 });
    soldier.path = [{ x: 800, y: 612 }]; soldier.moveGoal = { x: 800, y: 612 }; tick(5);
    expect(soldier.rockets).toBe(4); soldier.path = []; soldier.moveGoal = null;
    soldier.pinned = true; soldier.suppression = CONFIG.suppression.max; tick(5);
    expect(soldier.rockets).toBe(4); soldier.pinned = false; soldier.suppression = 0;
    soldier.reloadTimer = 100; tick(5); expect(soldier.rockets).toBe(4);
    soldier.reloadTimer = 0; soldier.upgradeTimer = 100; tick(5); expect(soldier.rockets).toBe(4);
  });

  it('switches to rifle fire after four rockets and resumes bazooka fire after resupply', () => {
    const { sim, soldier, officer, call } = fixture();
    sim.spawnEnemy('rifle', { x: 588, y: 432 }); const enemy = sim.state.units.at(-1)!; enemy.health = 100_000; enemy.reloadTimer = 100_000;
    const events = [];
    const duration = sim.weaponOf(soldier)!.reloadTicks * 6;
    for (let i = 0; i < duration; i++) {
      enemy.pinned = true; enemy.suppression = CONFIG.suppression.max; events.push(...sim.step());
    }
    expect(events.filter((event) => event.type === 'shot' && event.shooterId === soldier.id && event.weapon === 'M1A1 Bazooka')).toHaveLength(4);
    expect(events.some((event) => event.type === 'shot' && event.shooterId === soldier.id && event.weapon === 'M1 Garand')).toBe(true);
    expect(soldier.rockets).toBe(0);
    officer.pos = { x: soldier.pos.x - 24, y: soldier.pos.y }; officer.prevPos = { ...officer.pos };
    expect(call().ok).toBe(true);
    expect(sim.step()).toContainEqual({ type: 'rocketsResupplied', officerId: officer.id, targetId: soldier.id, amount: 4 });
    expect(soldier.rockets).toBe(4);
    const resumed = [];
    for (let i = 0; i < getContent().weapons.rifle!.reloadTicks + 1; i++) resumed.push(...sim.step());
    expect(resumed).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: soldier.id, weapon: 'M1A1 Bazooka' }));
    expect(soldier.rockets).toBe(3);
  });

  it('requires the officer to reach the recipient before restoring rockets', () => {
    const { soldier, officer, call, tick } = fixture(); soldier.rockets = 0;
    expect(call().ok).toBe(true); expect(officer.supplyTargetId).toBe(soldier.id);
    tick(120); expect(officer.pos.x).toBeGreaterThan(156); expect(soldier.rockets).toBe(0);
    const events = tick(600);
    expect(events).toContainEqual({ type: 'rocketsResupplied', officerId: officer.id, targetId: soldier.id, amount: 4 });
    expect(soldier.rockets).toBe(4); expect(officer.supplyTargetId).toBeUndefined();
  });

  it('tops up only missing rockets and rejects another request at capacity', () => {
    const { sim, soldier, officer, call } = fixture(); soldier.rockets = 3;
    officer.pos = { x: soldier.pos.x - 24, y: soldier.pos.y }; officer.prevPos = { ...officer.pos };
    expect(call().ok).toBe(true);
    expect(sim.step()).toContainEqual({ type: 'rocketsResupplied', officerId: officer.id, targetId: soldier.id, amount: 1 });
    expect(soldier.rockets).toBe(4); expect(call().ok).toBe(false);
    expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it.each(['rockets', 'grenades'] as const)('shares request order across ammunition types when %s are requested first', (first) => {
    const { sim, soldier, officer, call, tick } = fixture(); soldier.rockets = 0;
    const rifleman = sim.spawnFriendly('rifleman', { x: first === 'rockets' ? 180 : 588, y: 612 }); rifleman.grenades = 0;
    if (first === 'grenades') { soldier.pos = { x: 180, y: 612 }; soldier.prevPos = { ...soldier.pos }; }
    const grenades = () => sim.command({ type: 'callGrenadeSupplies', unitId: rifleman.id });
    const [oldest, later] = first === 'rockets' ? [soldier.id, rifleman.id] : [rifleman.id, soldier.id];
    if (first === 'rockets') { expect(call().ok).toBe(true); expect(grenades().ok).toBe(true); }
    else { expect(grenades().ok).toBe(true); expect(call().ok).toBe(true); }
    expect(sim.state.grenadeSupplyQueue).toEqual([oldest, later]);
    const events = tick(1500).filter((event) => event.type === 'rocketsResupplied' || event.type === 'grenadesResupplied');
    expect(events.map((event) => event.targetId)).toEqual([oldest, later]);
    expect(soldier.rockets).toBe(4); expect(rifleman.grenades).toBe(4); expect(officer.supplyTargetId).toBeUndefined();
  });

  it('keeps rocket calls queued while the officer is pinned, rejects duplicates, and reassigns after an officer dies', () => {
    const { sim, soldier, officer, call, tick } = fixture(); soldier.rockets = 0; officer.pinned = true; officer.suppression = CONFIG.suppression.max;
    expect(call().ok).toBe(true); expect(officer.supplyTargetId).toBeUndefined();
    const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
    officer.dead = true; officer.health = 0;
    const replacement = sim.spawnFriendly('supply_officer', { x: 156, y: 612 });
    tick(1); expect(replacement.supplyTargetId).toBe(soldier.id);
    tick(900); expect(soldier.rockets).toBe(4); expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it.each(['full', 'dead', 'crossed', 'paused', 'noOfficer', 'wrongRole'] as const)('rejects %s requests without mutation', (condition) => {
    const { sim, soldier, officer, call } = fixture(); soldier.rockets = condition === 'full' ? 4 : 0;
    if (condition === 'dead') soldier.dead = true;
    if (condition === 'crossed') soldier.crossed = true;
    if (condition === 'paused') sim.paused = true;
    if (condition === 'noOfficer') officer.role = 'officer';
    if (condition === 'wrongRole') soldier.role = 'rifleman';
    const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
  });

  it('saves an empty bazooka and pending delivery, then continues the same refill without duplicates', () => {
    const sim = new Simulation(2026); sim.state.units = []; sim.state.scheduler.prepTicksLeft = 100_000;
    const soldier = sim.spawnFriendly('at', { x: 492, y: 612 }), officer = sim.spawnFriendly('supply_officer', { x: 468, y: 612 });
    soldier.rockets = 0; sim.step();
    expect(sim.command({ type: 'callRocketSupplies', unitId: soldier.id }).ok).toBe(true);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(0);
    expect(restored.state.grenadeSupplyQueue).toEqual([soldier.id]);
    expect(restored.state.units.find((unit) => unit.id === officer.id)!.supplyTargetId).toBe(soldier.id);
    const events = [];
    for (let i = 0; i < 90; i++) { const next = sim.step(); expect(restored.step()).toEqual(next); events.push(...next); }
    expect(restored.snapshot()).toEqual(sim.snapshot()); expect(events.filter((event) => event.type === 'rocketsResupplied')).toHaveLength(1);
  });

  it('restores spent and empty loadouts exactly, while older saves begin with four rockets', () => {
    const { sim, soldier } = fixture();
    for (const count of [0, 2]) {
      soldier.rockets = count;
      const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
      if ('error' in checked) throw new Error(checked.error);
      expect(Simulation.fromSnapshot(checked.snap).state.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(count);
    }
    const old = sim.snapshot(); old.schemaVersion = 20; delete old.units.find((unit) => unit.id === soldier.id)!.rockets;
    const checked = validateSnapshot(JSON.parse(JSON.stringify(old)));
    if ('error' in checked) throw new Error(checked.error);
    expect(Simulation.fromSnapshot(checked.snap).state.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(4);
    expect(Simulation.fromSnapshot(old).state.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(4);
  });

  it.each([false, true])('restocks rockets only after arriving on a new map, save/resume=%s', (resume) => {
    let sim = new Simulation(31); sim.state.units = [];
    const soldier = sim.spawnFriendly('at', { x: 300, y: 600 }), rifleman = sim.spawnFriendly('rifleman', { x: 500, y: 600 }); soldier.rockets = 0;
    soldier.pos.y = CONFIG.crossing.thresholdY - 1; sim.step();
    expect(sim.state.mapNumber).toBe(1); expect(sim.state.crossedUnits[0]!.rockets).toBe(0);
    if (resume) sim = Simulation.fromSnapshot(sim.snapshot());
    sim.state.units.find((unit) => unit.id === rifleman.id)!.pos.y = CONFIG.crossing.thresholdY - 1; sim.step();
    expect(sim.state.mapNumber).toBe(2); expect(sim.state.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(4);
  });

  it.each([-1, 5, 1.5, null, 'four'])('rejects malformed saved rocket counts %s', (count) => {
    const { sim, soldier } = fixture(), saved = JSON.parse(JSON.stringify(sim.snapshot()));
    saved.units.find((unit: { id: number }) => unit.id === soldier.id).rockets = count;
    expect(validateSnapshot(saved)).toMatchObject({ error: 'Corrupt bazooka ammunition.' });
  });

  it('rejects rockets saved on a role without a bazooka', () => {
    const { sim, officer } = fixture(), saved = sim.snapshot(); saved.units.find((unit) => unit.id === officer.id)!.rockets = 1;
    expect(validateSnapshot(JSON.parse(JSON.stringify(saved)))).toMatchObject({ error: 'Corrupt bazooka ammunition.' });
  });
});
