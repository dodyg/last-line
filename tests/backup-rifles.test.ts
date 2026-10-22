import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture(role: 'at' | 'mortarman') {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false); sim.state.units = [];
  const officer = sim.spawnFriendly('supply_officer', { x: 564, y: 612 }); officer.reloadTimer = 100_000;
  const soldier = sim.spawnFriendly(role, { x: 588, y: 612 }); soldier.reloadTimer = 0; soldier.mortarTimer = 0;
  sim.spawnEnemy('rifle', { x: 588, y: 432 }); const enemy = sim.state.units.at(-1)!;
  enemy.health = 100_000; enemy.reloadTimer = 100_000;
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const empty = () => { soldier.rockets = 0; soldier.mortarBombs = 0; };
  const step = () => { enemy.pinned = true; enemy.suppression = CONFIG.suppression.max; return sim.step(); };
  return { sim, officer, soldier, enemy, empty, step };
}

describe.each(['at', 'mortarman'] as const)('%s backup rifle', (role) => {
  it('automatically switches after the last heavy round and keeps firing without spending heavy ammo', () => {
    const { sim, soldier, step } = fixture(role);
    if (role === 'at') soldier.rockets = 1; else soldier.mortarBombs = 1;
    const launched = step();
    expect(launched).toContainEqual(expect.objectContaining(role === 'at' ? { type: 'shot', shooterId: soldier.id, weapon: 'M1A1 Bazooka' } : { type: 'mortarFired', unitId: soldier.id }));
    expect(sim.weaponOf(soldier)).toEqual(getContent().weapons.rifle);
    const events = [];
    for (let i = 0; i < CONFIG.tickRate * 7; i++) events.push(...step());
    const shots = events.filter((event) => event.type === 'shot' && event.shooterId === soldier.id);
    expect(shots.length).toBeGreaterThan(1); expect(shots.every((event) => event.type === 'shot' && event.weapon === 'M1 Garand')).toBe(true);
    expect(events.some((event) => event.type === 'mortarFired')).toBe(false);
    expect(soldier.rockets).toBe(0); expect(soldier.mortarBombs).toBe(0);
  });

  it('uses ordinary rifle damage, range, and anti-armor strength with no explosive projectile', () => {
    const { sim, soldier, enemy, empty, step } = fixture(role); empty();
    expect(sim.weaponOf(soldier)).toMatchObject({ name: 'M1 Garand', kind: 'hitscan', damage: 34, range: 280, armorMult: .25, splashRadius: 0 });
    expect(step()).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: soldier.id, weapon: 'M1 Garand' }));
    expect(sim.state.projectiles).toEqual([]); expect(sim.state.strikes).toEqual([]);
    soldier.reloadTimer = 0; enemy.pos.y = soldier.pos.y - 310; enemy.prevPos = { ...enemy.pos };
    expect(step().some((event) => event.type === 'shot' && event.shooterId === soldier.id)).toBe(false);
  });

  it.each(['pinned', 'moving', 'reloading', 'upgrading'] as const)('keeps the normal infantry firing restriction while %s', (condition) => {
    const { soldier, empty, step } = fixture(role); empty();
    if (condition === 'pinned') { soldier.pinned = true; soldier.suppression = CONFIG.suppression.max; }
    if (condition === 'moving') { soldier.path = [{ x: 800, y: 612 }]; soldier.moveGoal = { x: 800, y: 612 }; }
    if (condition === 'reloading') soldier.reloadTimer = 100;
    if (condition === 'upgrading') soldier.upgradeTimer = 100;
    expect(step().some((event) => event.type === 'shot' && event.shooterId === soldier.id)).toBe(false);
    expect(soldier.rockets).toBe(0); expect(soldier.mortarBombs).toBe(0);
  });

  it('switches back to its primary weapon when an officer refills it, with no simultaneous rifle shot', () => {
    const { sim, soldier, empty, step } = fixture(role); empty();
    expect(step()).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: soldier.id, weapon: 'M1 Garand' }));
    expect(sim.command({ type: role === 'at' ? 'callRocketSupplies' : 'callMortarSupplies', unitId: soldier.id }).ok).toBe(true);
    const delivery = step();
    expect(delivery).toContainEqual(expect.objectContaining({ type: role === 'at' ? 'rocketsResupplied' : 'mortarBombsResupplied', targetId: soldier.id }));
    expect(delivery.some((event) => event.type === 'shot' && event.shooterId === soldier.id)).toBe(false);
    expect(sim.weaponOf(soldier)?.name ?? null).toBe(role === 'at' ? 'M1A1 Bazooka' : null);
    const events = [...delivery];
    for (let i = 0; i < CONFIG.tickRate * 2; i++) events.push(...step());
    expect(events).toContainEqual(expect.objectContaining(role === 'at' ? { type: 'shot', shooterId: soldier.id, weapon: 'M1A1 Bazooka' } : { type: 'mortarFired', unitId: soldier.id }));
    expect(events.some((event) => event.type === 'shot' && event.shooterId === soldier.id && event.weapon === 'M1 Garand')).toBe(false);
    expect(role === 'at' ? soldier.rockets : soldier.mortarBombs).toBe(role === 'at' ? 3 : 5);
  });

  it('resumes with a rifle and the same pending delivery after save/Continue', () => {
    const { sim, soldier, empty, step } = fixture(role); empty(); step();
    expect(sim.command({ type: role === 'at' ? 'callRocketSupplies' : 'callMortarSupplies', unitId: soldier.id }).ok).toBe(true);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap), savedSoldier = restored.state.units.find((unit) => unit.id === soldier.id)!;
    expect(restored.weaponOf(savedSoldier)).toEqual(getContent().weapons.rifle);
    expect(restored.state.grenadeSupplyQueue).toEqual([soldier.id]);
    for (let i = 0; i < 90; i++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
  });
});
