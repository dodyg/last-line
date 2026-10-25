import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import type { FriendlyRole } from '../src/simulation/types';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.terrain.elevation?.heights.fill(0); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] }; data.buildings = [];
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = []; sim.state.points = 100;
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const recruit = (role: FriendlyRole, x = 492, y = 612) => {
    const unit = sim.spawnFriendly(role, { x, y }); unit.reloadTimer = 100_000; unit.grenades = 0; return unit;
  };
  const tick = (count: number) => Array.from({ length: count }, () => sim.step()).flat();
  return { sim, recruit, tick };
}

describe('specialist field abilities', () => {
  it('rallies nearby troops, retains a cooldown after cancelling, and respects pause', () => {
    const { sim, recruit, tick } = fixture(); const officer = recruit('officer'), rifle = recruit('rifleman', 530);
    rifle.suppression = 80; rifle.morale = 30;
    sim.paused = true; expect(sim.command({ type: 'roleAbility', unitId: officer.id }).ok).toBe(false);
    sim.paused = false; expect(sim.command({ type: 'roleAbility', unitId: officer.id }).ok).toBe(true);
    const control = fixture(); control.recruit('officer'); const baseline = control.recruit('rifleman', 530); baseline.suppression = 80; baseline.morale = 30;
    control.tick(CONFIG.tickRate); tick(CONFIG.tickRate);
    expect(rifle.suppression).toBeLessThan(baseline.suppression); expect(rifle.morale).toBeGreaterThan(baseline.morale);
    expect(sim.command({ type: 'roleAbility', unitId: officer.id }).ok).toBe(true);
    expect(sim.command({ type: 'roleAbility', unitId: officer.id }).ok).toBe(false);
  });

  it('pays for finite forward stock and stops dispatching its officer', () => {
    const { sim, recruit, tick } = fixture(); const supply = recruit('supply_officer'), rifle = recruit('rifleman', 530);
    expect(sim.command({ type: 'roleAbility', unitId: supply.id }).ok).toBe(true);
    expect(sim.state.points).toBe(97);
    tick(2 * CONFIG.tickRate); expect(rifle.grenades).toBe(1); expect(supply.roleDuty?.stock).toBe(11);
    expect(supply.pos).toEqual({ x: 492, y: 612 });
    sim.command({ type: 'move', unitId: supply.id, pos: { x: 700, y: 612 } });
    sim.step(); expect(supply.roleDuty).toBeUndefined();
    expect(sim.state.points).toBe(97);
  });

  it('records observed positions, never updates hidden contacts, and expires stale reports', () => {
    const { sim, recruit, tick } = fixture(); const scout = recruit('scout');
    sim.spawnEnemy('rifle', { x: 492, y: 160 }); const enemy = sim.state.units.at(-1)!;
    enemy.pinned = true; enemy.suppression = 100; enemy.reloadTimer = 100_000;
    expect(sim.scoutObserves(enemy)).toBe(false);
    sim.command({ type: 'roleAbility', unitId: scout.id });
    expect(sim.scoutObserves(enemy)).toBe(true);
    tick(CONFIG.tickRate); expect(scout.scoutReports).toHaveLength(1);
    const reported = { ...scout.scoutReports![0]!.pos };
    enemy.pos = { x: 1200, y: 40 }; enemy.prevPos = { ...enemy.pos };
    tick(CONFIG.tickRate); expect(scout.scoutReports![0]!.pos).toEqual(reported);
    tick(13 * CONFIG.tickRate); expect(scout.scoutReports).toHaveLength(0);
  });

  it('suppresses visible infantry without dealing direct damage and refuses blocked ground', () => {
    const { sim, recruit } = fixture(); const mg = recruit('mg'); mg.reloadTimer = 0;
    sim.spawnEnemy('rifle', { x: 492, y: 470 }); const enemy = sim.state.units.at(-1)!;
    enemy.reloadTimer = 100_000; enemy.grenades = 0;
    expect(sim.command({ type: 'roleAbility', unitId: mg.id, pos: { x: 492, y: -1 } }).ok).toBe(false);
    expect(sim.command({ type: 'roleAbility', unitId: mg.id, pos: { x: 492, y: 470 } }).ok).toBe(true);
    const health = enemy.health; const events = sim.step();
    expect(events.some((event) => event.type === 'shot' && event.shooterId === mg.id)).toBe(true);
    expect(enemy.suppression).toBeGreaterThan(0); expect(enemy.health).toBe(health);
  });

  it('queues paid repairs by damage and pauses work when suppressed', () => {
    const { sim, recruit, tick } = fixture(); const engineer = recruit('engineer');
    sim.state.buildings.push({ id: 999, kind: 'house', name: 'Farmhouse', pos: { x: 540, y: 600 }, cols: 2, rows: 2, health: 50, maxHealth: 100, destroyed: false });
    sim.command({ type: 'roleAbility', unitId: engineer.id }); tick(2 * CONFIG.tickRate);
    expect(sim.state.buildings[0]!.health).toBeCloseTo(70); expect(sim.state.points).toBe(99);
    engineer.pinned = true; engineer.suppression = 100;
    sim.step(); expect(sim.state.buildings[0]!.health).toBeCloseTo(70);
  });

  it('round-trips abilities and rejects incompatible or corrupt saved duty state', () => {
    const { sim, recruit } = fixture(); const scout = recruit('scout');
    sim.command({ type: 'roleAbility', unitId: scout.id });
    const snapshot = sim.snapshot();
    expect(validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).toHaveProperty('snap');
    expect(Simulation.fromSnapshot(snapshot).state.units[0]!.roleDuty?.kind).toBe('observe');
    snapshot.units[0]!.roleDuty!.kind = 'supply';
    expect(validateSnapshot(snapshot)).toHaveProperty('error');
  });
});
