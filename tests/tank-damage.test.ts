import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { damageTankComponent } from '../src/simulation/tank-damage';
import { generateTerrain } from '../src/simulation/terrain';
import type { TankDamage } from '../src/simulation/types';

const healthy = (): TankDamage => ({ tracks: false, turret: false, machineGun: false });

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false), soldier = sim.state.units[0]!;
  sim.state.units = [soldier]; soldier.pos = { x: 492, y: 612 }; soldier.prevPos = { ...soldier.pos };
  soldier.reloadTimer = 100_000; soldier.grenades = 0;
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.spawnEnemy('vehicle', { x: 492, y: 432 });
  const tank = sim.state.units.at(-1)!;
  tank.reloadTimer = tank.secondaryReloadTimer = 100_000;
  const hit = (seed = 7, damage = 40) => {
    const strike = sim.artilleryStrikeFor(1, { ...tank.pos }); strike.damage = damage;
    sim.state.rng.s = seed;
    return sim.step();
  };
  return { sim, soldier, tank, hit };
}

describe('tank subsystem damage', () => {
  it.each([{ component: 'tracks', seed: 7 }, { component: 'turret', seed: 12 }, { component: 'machineGun', seed: 1 }] as const)('a surviving heavy hit can disable $component and reports it once', ({ component, seed }) => {
    const { tank, hit } = fixture();
    const impact = { ...tank.pos };
    expect(hit(seed)).toContainEqual({ type: 'tankComponentDisabled', unitId: tank.id, component, pos: impact });
    expect(tank.health).toBe(240); expect(tank.tankDamage).toEqual({ ...healthy(), [component]: true });
    const later = hit(seed);
    expect(later.filter((event) => event.type === 'tankComponentDisabled' && event.component === component)).toEqual([]);
    expect(tank.tankDamage![component]).toBe(true);
  });

  it('allows a heavy hit to damage only the hull without causing a subsystem failure', () => {
    const { tank, hit } = fixture();
    expect(hit(2).some((event) => event.type === 'tankComponentDisabled')).toBe(false);
    expect(tank.health).toBe(240); expect(tank.tankDamage).toBeUndefined();
  });

  it('does not let small-arms fire, insignificant hits, or non-tanks lose tank systems', () => {
    const { tank, soldier } = fixture();
    const rng = { s: 7 };
    expect(damageTankComponent(tank, 40, .25, rng)).toBeNull();
    expect(damageTankComponent(tank, 1, 1.5, rng)).toBeNull();
    expect(damageTankComponent(soldier, 40, 1.5, rng)).toBeNull();
    expect(rng.s).toBe(7); expect(tank.tankDamage).toBeUndefined();
  });

  it('keeps a track-disabled tank stationary even while overlapping an ally, with working weapons still firing', () => {
    const { sim, tank } = fixture();
    tank.tankDamage = { ...healthy(), tracks: true };
    tank.reloadTimer = tank.secondaryReloadTimer = 0;
    sim.spawnEnemy('rifle', { x: tank.pos.x + 10, y: tank.pos.y });
    sim.state.units.at(-1)!.reloadTimer = 100_000;
    const start = { ...tank.pos }, events = Array.from({ length: 60 }, () => sim.step()).flat();
    expect(tank.pos).toEqual(start); expect(tank.path).toEqual([]);
    const shots = events.filter((event) => event.type === 'shot' && event.shooterId === tank.id);
    expect(shots.some((event) => event.type === 'shot' && event.weapon === sim.content.weapons.shell!.name)).toBe(true);
    expect(shots.some((event) => event.type === 'shot' && event.weapon === sim.content.weapons.tank_mg!.name)).toBe(true);
  });

  it.each(['turret', 'machineGun'] as const)('a disabled %s cannot fire, while the other weapon remains operational', (component) => {
    const { sim, tank } = fixture();
    tank.tankDamage = { ...healthy(), tracks: true, [component]: true };
    tank.reloadTimer = tank.secondaryReloadTimer = 0;
    tank.burstRemaining = tank.secondaryBurstRemaining = 4;
    const disabled = sim.content.weapons[component === 'turret' ? 'shell' : 'tank_mg']!;
    const working = sim.content.weapons[component === 'turret' ? 'tank_mg' : 'shell']!;
    sim.fireShot(tank, sim.state.units[0]!, disabled);
    const events = Array.from({ length: 30 }, () => sim.step()).flat();
    expect(events.filter((event) => event.type === 'shot' && event.shooterId === tank.id && event.weapon === disabled.name)).toEqual([]);
    expect(events.some((event) => event.type === 'shot' && event.shooterId === tank.id && event.weapon === working.name)).toBe(true);
  });

  it('accumulates all three failures and counts a fully disabled tank as one combat loss', () => {
    const { sim, tank, hit } = fixture();
    const events = [hit(), hit(), hit()].flat();
    expect(tank.tankDamage).toEqual({ tracks: true, turret: true, machineGun: true });
    expect(events.filter((event) => event.type === 'tankComponentDisabled')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'unitDied' && event.unitId === tank.id)).toHaveLength(1);
    expect(tank.dead).toBe(true); expect(sim.state.units).not.toContain(tank);
    expect(sim.state.battleRecord.enemyKills).toBe(1);
  });

  it('a lethal hit uses normal destruction without reporting a surviving-system failure', () => {
    const { tank, hit } = fixture(); tank.health = 10;
    const events = hit();
    expect(events.some((event) => event.type === 'unitDied' && event.unitId === tank.id)).toBe(true);
    expect(events.some((event) => event.type === 'tankComponentDisabled')).toBe(false);
  });

  it('keeps a mobile tank dangerous to the line even with both weapons disabled', () => {
    const { sim, tank } = fixture();
    tank.tankDamage = { ...healthy(), turret: true, machineGun: true };
    const before = tank.pos.y;
    const events = Array.from({ length: CONFIG.tickRate }, () => sim.step()).flat();
    expect(tank.pos.y).toBeGreaterThan(before);
    expect(events.filter((event) => event.type === 'shot' && event.shooterId === tank.id)).toEqual([]);
  });

  it('preserves failures and seeded future damage through a validated save and Continue', () => {
    const sim = new Simulation(2026); sim.spawnEnemy('vehicle', { x: 492, y: 432 });
    const tank = sim.state.units.at(-1)!; tank.tankDamage = { ...healthy(), tracks: true };
    sim.state.scheduler.prepTicksLeft = 100_000;
    for (const unit of sim.state.units) { unit.reloadTimer = unit.secondaryReloadTimer = 100_000; unit.grenades = 0; }
    sim.step(); // Drain initial spawn events before comparing the resumed run.
    sim.artilleryStrikeFor(2, { ...tank.pos }).damage = 40;
    sim.state.rng.s = 7;
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.units.at(-1)!.tankDamage).toEqual(tank.tankDamage);
    for (let i = 0; i < 30; i++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
    const snapshot = sim.snapshot(); snapshot.units.at(-1)!.tankDamage!.turret = false;
    expect(snapshot.units.at(-1)!.tankDamage).not.toBe(tank.tankDamage);
  });

  it('loads older saves with fully operational tanks', () => {
    const { sim, tank } = fixture();
    const snapshot = sim.snapshot(); snapshot.schemaVersion = 18;
    const checked = validateSnapshot(JSON.parse(JSON.stringify(snapshot)));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap), loaded = restored.state.units.find((unit) => unit.id === tank.id)!;
    expect(loaded.tankDamage).toBeUndefined(); expect(restored.weaponOf(loaded)?.kind).toBe('explosive');
  });

  it.each([null, [], true, {}, { tracks: 'broken', turret: false, machineGun: false }, { tracks: true, turret: false, machineGun: false, engine: true }, { tracks: true, turret: true, machineGun: true }])('rejects malformed saved tank damage %j', (damage) => {
    const { sim } = fixture(), snapshot = JSON.parse(JSON.stringify(sim.snapshot()));
    snapshot.units.at(-1).tankDamage = damage;
    expect(validateSnapshot(snapshot)).toMatchObject({ error: 'Corrupt tank damage.' });
  });

  it('rejects tank damage attached to infantry', () => {
    const { sim } = fixture(), snapshot = sim.snapshot(); snapshot.units[0]!.tankDamage = healthy();
    expect(validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).toMatchObject({ error: 'Corrupt tank damage.' });
  });
});
