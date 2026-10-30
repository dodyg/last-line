import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import { buildingSlot } from '../src/simulation/buildings';
import { targetIsValid } from '../src/simulation/combat';
import type { EnemyArchetype, FriendlyRole } from '../src/simulation/types';

const content = getContent();
const roles = ['grenadier', 'flamethrower'] as const;

function fixture(building = false) {
  const data = generateTerrain(2026, false, 2);
  data.kinds.fill(0); data.terrain.blocked.fill(0);
  data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.terrain.elevation?.heights.fill(0);
  data.buildings = building ? [{ kind: 'barn', name: 'Test barn', col: 10, row: 10, ...CONFIG.buildings.footprints.barn }] : []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = []; sim.state.points = 1000;
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const enemy = (x: number, y: number, role: EnemyArchetype = 'rifle') => {
    sim.spawnEnemy(role, { x, y });
    const unit = sim.state.units.at(-1)!;
    unit.reloadTimer = 100_000; unit.secondaryReloadTimer = 100_000;
    unit.pinned = true; unit.suppression = CONFIG.suppression.max;
    return unit;
  };
  return { sim, enemy, tick: (n: number) => Array.from({ length: n }, () => sim.step()).flat() };
}

describe('grenadiers and flamethrower operators', () => {
  it.each(roles)('recruits %s with its kit, and preserves spent ammunition and upgrades in saves', (role) => {
    const { sim } = fixture();
    expect(sim.command({ type: 'recruit', role, pos: { x: 492, y: 612 }, build: { stance: 'crouching' } }).ok).toBe(true);
    const unit = sim.state.units.at(-1)!;
    expect(sim.state.points).toBe(1000 - CONFIG.costs.recruit[role]);
    expect(unit.specialistAmmo).toBe(content.friendly[role].specialistAmmo);
    unit.specialistAmmo = (unit.specialistAmmo ?? 0) - 1; unit.weaponUpgrades.damage = 1;
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.units.at(-1)).toEqual(unit);
    expect(restored.weaponOf(restored.state.units.at(-1)!)).toEqual(sim.weaponOf(unit));
  });

  it('launches a delayed grenade over solid cover, with splash damage and friendly fire', () => {
    const { sim, enemy, tick } = fixture();
    const shooter = sim.spawnFriendly('grenadier', { x: 492, y: 612 });
    const target = enemy(492, 400), neighbor = enemy(512, 400);
    const ally = sim.spawnFriendly('rifleman', { x: 480, y: 400 });
    ally.reloadTimer = 100_000; ally.grenades = 0;
    const terrain = sim.state.terrain;
    terrain.blocked[Math.floor(500 / terrain.cell) * terrain.cols + Math.floor(492 / terrain.cell)] = 1;
    sim.state.rng.s = 7; // First roll is a hit.
    expect(sim.fireShot(shooter, target, sim.weaponOf(shooter)!)).toBe(true);
    expect(shooter.specialistAmmo).toBe(5);
    expect(target.health).toBe(70);
    expect(sim.state.projectiles[0]).toMatchObject({ arc: true, target: target.pos });
    shooter.reloadTimer = 100_000;
    tick(40);
    expect(target.health).toBeLessThan(70);
    expect(neighbor.health).toBeLessThan(70);
    expect(ally.health).toBeLessThan(100);
  });

  it('sweeps a flame cone through covered infantry without hitting flankers or allies', () => {
    const { sim, enemy } = fixture();
    const shooter = sim.spawnFriendly('flamethrower', { x: 492, y: 500 });
    const target = enemy(492, 590), neighbor = enemy(502, 580), flank = enemy(555, 550);
    target.stance = 'prone'; target.suppression = 0; target.pinned = false;
    sim.state.sandbags.push({ id: sim.state.nextEntityId++, pos: { x: 492, y: 570 } });
    const ally = sim.spawnFriendly('rifleman', { x: 488, y: 580 });
    expect(sim.fireShot(shooter, target, sim.weaponOf(shooter)!)).toBe(true);
    expect(target.health).toBe(46);
    expect(target.suppression).toBeGreaterThan(0);
    expect(neighbor.health).toBe(46);
    expect(flank.health).toBe(70);
    expect(ally.health).toBe(100);
    expect(shooter.specialistAmmo).toBe(11);
  });

  it('blocks flames at solid obstacles and smoke, and refuses targets outside range', () => {
    const { sim, enemy } = fixture();
    const shooter = sim.spawnFriendly('flamethrower', { x: 492, y: 500 });
    const target = enemy(492, 600), weapon = sim.weaponOf(shooter)!;
    const terrain = sim.state.terrain;
    const cell = Math.floor(550 / terrain.cell) * terrain.cols + Math.floor(492 / terrain.cell);
    terrain.blocked[cell] = 1;
    expect(sim.fireShot(shooter, target, weapon)).toBe(false);
    terrain.blocked[cell] = 0;
    sim.state.smokes.push({ id: sim.state.nextEntityId++, pos: { x: 492, y: 550 }, radius: 20, ticksRemaining: 100 });
    expect(sim.fireShot(shooter, target, weapon)).toBe(false);
    sim.state.smokes = []; target.pos.y = 620;
    expect(sim.fireShot(shooter, target, weapon)).toBe(false);
    expect(shooter.specialistAmmo).toBe(12);
    expect(target.health).toBe(70);
  });

  it('burns a window garrison from outside and uses a rifle for interior fighting', () => {
    const { sim, enemy, tick } = fixture(true);
    const building = sim.state.buildings[0]!;
    const position = { buildingId: building.id, level: 0 as const, slot: 4 };
    const window = buildingSlot(building, position, sim.state.terrain.cell);
    const shooter = sim.spawnFriendly('flamethrower', { x: window.x, y: window.y + 75 });
    const defender = enemy(window.x, window.y);
    defender.buildingPosition = position;
    expect(sim.fireShot(shooter, defender, sim.weaponOf(shooter)!)).toBe(true);
    expect(defender.health).toBe(46);
    expect(shooter.specialistAmmo).toBe(11);
    shooter.buildingPosition = { ...position, slot: 5 };
    shooter.pos = buildingSlot(building, shooter.buildingPosition, sim.state.terrain.cell);
    shooter.reloadTimer = 0;
    const events = tick(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'shot', shooterId: shooter.id, weapon: 'M1 Garand' }));
    expect(shooter.specialistAmmo).toBe(11);
  });

  it('flames do little damage to armor', () => {
    const { sim, enemy } = fixture();
    const shooter = sim.spawnFriendly('flamethrower', { x: 492, y: 500 });
    const tank = enemy(492, 580, 'vehicle');
    sim.fireShot(shooter, tank, sim.weaponOf(shooter)!);
    expect(tank.health).toBeGreaterThan(275);
  });

  it.each(roles)('%s uses a backup rifle when empty and resumes specialist fire after delivery', (role) => {
    const { sim, tick } = fixture();
    const shooter = sim.spawnFriendly(role, { x: 492, y: 612 });
    const primary = sim.weaponOf(shooter)!;
    shooter.specialistAmmo = 0;
    expect(sim.weaponOf(shooter)?.name).toBe('M1 Garand');
    sim.spawnFriendly('supply_officer', { x: 516, y: 612 });
    expect(sim.command({ type: 'callSpecialistSupplies', unitId: shooter.id }).ok).toBe(true);
    const events = tick(2);
    expect(shooter.specialistAmmo).toBe(content.friendly[role].specialistAmmo);
    expect(sim.weaponOf(shooter)).toEqual(primary);
    expect(events.some((event) => event.type === 'specialistResupplied' && event.targetId === shooter.id)).toBe(true);
  });

  it.each(roles)('forward supply replenishes %s ammunition and veteran empty calls enter the delivery queue', (role) => {
    const { sim, tick } = fixture();
    const shooter = sim.spawnFriendly(role, { x: 492, y: 612 });
    const officer = sim.spawnFriendly('supply_officer', { x: 516, y: 612 });
    shooter.specialistAmmo = 0;
    expect(sim.command({ type: 'roleAbility', unitId: officer.id }).ok).toBe(true);
    tick(CONFIG.tickRate * 2);
    expect(shooter.specialistAmmo).toBe(1);
    expect(officer.roleDuty?.stock).toBe(11);
    sim.command({ type: 'roleAbility', unitId: officer.id });
    shooter.specialistAmmo = 0; shooter.xp = CONFIG.automaticSupport.unlockXp;
    expect(tick(1)).toContainEqual({ type: 'automaticSupportRequested', unitId: shooter.id, kind: 'specialistAmmo' });
  });

  it.each(roles)('rejects corrupt %s ammunition and preserves legacy saves without the field', (role) => {
    const { sim } = fixture();
    const unit = sim.spawnFriendly(role, { x: 492, y: 612 });
    for (const value of [-1, 1.5, 100]) {
      unit.specialistAmmo = value;
      expect(validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())))).toHaveProperty('error');
    }
    delete unit.specialistAmmo;
    expect(validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())))).toHaveProperty('snap');
  });

  it('retains the long range and arc distinction between grenades and flame', () => {
    const { sim, enemy } = fixture();
    const target = enemy(492, 300);
    for (const role of roles) {
      const shooter = sim.spawnFriendly(role as FriendlyRole, { x: 492, y: 612 });
      expect(targetIsValid(content, sim.state.terrain, [], shooter, target, sim.weaponOf(shooter)!, CONFIG)).toBe(role === 'grenadier');
    }
  });
});
