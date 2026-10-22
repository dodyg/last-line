import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import type { FriendlyRole, Unit } from '../src/simulation/types';

function fixture(role: FriendlyRole = 'rifleman', realTerrain = false) {
  const data = generateTerrain(2026, false, 2);
  if (!realTerrain) {
    data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
    data.terrain.elevation?.heights.fill(0); data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  }
  const sim = new Simulation(2026, undefined, data, false); sim.state.units = [];
  const soldier = sim.spawnFriendly(role, { x: 588, y: 612 }); soldier.xp = CONFIG.automaticSupport.unlockXp;
  const medic = sim.spawnFriendly('medic', { x: 156, y: 612 }), officer = sim.spawnFriendly('supply_officer', { x: 156, y: 564 });
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const tick = (count: number) => Array.from({ length: count }, () => sim.step()).flat();
  const empty = (unit: Unit = soldier) => { if (unit.role === 'at') unit.rockets = 0; else if (unit.role === 'mortarman') unit.mortarBombs = 0; else unit.grenades = 0; };
  return { sim, soldier, medic, officer, tick, empty };
}

describe('veteran automatic support requests', () => {
  it('unlocks at 3 XP, calls a remote medic for a wound, and heals through the existing delivery route', () => {
    const { sim, soldier, medic, tick } = fixture(); soldier.health -= 1; soldier.xp = CONFIG.automaticSupport.unlockXp - 1;
    expect(sim.step().some((event) => event.type === 'automaticSupportRequested')).toBe(false);
    expect(medic.medicalTargetId).toBeUndefined(); soldier.xp++;
    expect(sim.step()).toContainEqual({ type: 'automaticSupportRequested', unitId: soldier.id, kind: 'medic' });
    expect(medic.medicalTargetId).toBe(soldier.id); const injured = soldier.health;
    const events = tick(120); expect(soldier.health).toBe(injured); expect(medic.pos.x).toBeGreaterThan(156);
    expect(events.some((event) => event.type === 'automaticSupportRequested')).toBe(false);
    tick(900); expect(soldier.health).toBe(sim.maxHealthOf(soldier)); expect(sim.state.medicalQueue).toEqual([]);
  });

  it.each(['rifleman', 'engineer', 'at', 'mortarman'] as const)('automatically resupplies an empty %s but never requests partial loads', (role) => {
    const { sim, soldier, officer, tick, empty } = fixture(role);
    if (role === 'at') soldier.rockets = 1; else if (role === 'mortarman') soldier.mortarBombs = 1; else soldier.grenades = 1;
    expect(sim.step().some((event) => event.type === 'automaticSupportRequested')).toBe(false); empty();
    const kind = role === 'at' ? 'rockets' : role === 'mortarman' ? 'mortarBombs' : 'grenades';
    expect(sim.step()).toContainEqual({ type: 'automaticSupportRequested', unitId: soldier.id, kind });
    expect(officer.supplyTargetId).toBe(soldier.id); tick(120);
    expect(role === 'at' ? soldier.rockets : role === 'mortarman' ? soldier.mortarBombs : soldier.grenades).toBe(0);
    const events = tick(1000);
    expect(role === 'at' ? soldier.rockets : role === 'mortarman' ? soldier.mortarBombs : soldier.grenades).toBe(role === 'mortarman' ? 6 : 4);
    expect(events.filter((event) => event.type === 'automaticSupportRequested')).toHaveLength(0);
    expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it.each(['rifleman', 'engineer', 'at', 'mortarman'] as const)('keeps empty rookies on manual requests: %s', (role) => {
    const { sim, soldier, empty } = fixture(role); empty(); soldier.xp = CONFIG.automaticSupport.unlockXp - 1; soldier.health = 40;
    expect(sim.step().some((event) => event.type === 'automaticSupportRequested')).toBe(false);
    expect(sim.state.medicalQueue).toEqual([]); expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it.each(['at', 'mortarman'] as const)('calls supplies on the same tick the %s launches its last heavy round', (role) => {
    const { sim, soldier, officer } = fixture(role);
    if (role === 'at') soldier.rockets = 1; else soldier.mortarBombs = 1;
    soldier.reloadTimer = 0; soldier.mortarTimer = 0;
    sim.spawnEnemy('rifle', { x: 588, y: 432 }); const enemy = sim.state.units.at(-1)!;
    enemy.health = 10_000; enemy.pinned = true; enemy.suppression = CONFIG.suppression.max; enemy.reloadTimer = 100_000;
    const events = sim.step();
    expect(events).toContainEqual(expect.objectContaining(role === 'at' ? { type: 'shot', shooterId: soldier.id, weapon: 'M1A1 Bazooka' } : { type: 'mortarFired', unitId: soldier.id }));
    expect(events).toContainEqual({ type: 'automaticSupportRequested', unitId: soldier.id, kind: role === 'at' ? 'rockets' : 'mortarBombs' });
    expect(officer.supplyTargetId).toBe(soldier.id);
  });

  it('can request both kinds of help while pinned, waiting once while support is pinned or busy', () => {
    const { sim, soldier, medic, officer, tick, empty } = fixture('at'); soldier.health = 40; empty();
    for (const unit of [soldier, medic, officer]) { unit.pinned = true; unit.suppression = CONFIG.suppression.max; }
    expect(sim.step().filter((event) => event.type === 'automaticSupportRequested')).toHaveLength(2);
    expect(sim.state.medicalQueue).toEqual([soldier.id]); expect(sim.state.grenadeSupplyQueue).toEqual([soldier.id]);
    expect(medic.medicalTargetId).toBeUndefined(); expect(officer.supplyTargetId).toBeUndefined();
    expect(tick(5).filter((event) => event.type === 'automaticSupportRequested')).toHaveLength(0);
    medic.pinned = false; medic.suppression = 0; officer.pinned = false; officer.suppression = 0; sim.step();
    expect(medic.medicalTargetId).toBe(soldier.id); expect(officer.supplyTargetId).toBe(soldier.id);
  });

  it('waits for recruitment when support is absent without spamming failed calls', () => {
    const { sim, soldier, medic, officer, tick, empty } = fixture('mortarman'); empty(); soldier.health = 40;
    sim.state.units = [soldier]; expect(tick(20).some((event) => event.type === 'automaticSupportRequested')).toBe(false);
    expect(soldier.autoMedicCallAfter).toBeUndefined(); expect(soldier.autoSupplyCallAfter).toBeUndefined();
    sim.state.units.push(medic, officer);
    expect(sim.step().filter((event) => event.type === 'automaticSupportRequested')).toHaveLength(2);
  });

  it('appends automatic requests behind older manual calls and avoids duplicate dispatches', () => {
    const { sim, soldier, medic, officer, empty } = fixture('at'); empty(); soldier.health = 40;
    const older = sim.spawnFriendly('rifleman', { x: 300, y: 612 }); older.health = 40; older.grenades = 0;
    medic.pinned = true; medic.suppression = CONFIG.suppression.max; officer.pinned = true; officer.suppression = CONFIG.suppression.max;
    expect(sim.command({ type: 'callMedic', unitId: older.id }).ok).toBe(true);
    expect(sim.command({ type: 'callGrenadeSupplies', unitId: older.id }).ok).toBe(true);
    sim.step(); expect(sim.state.medicalQueue).toEqual([older.id, soldier.id]); expect(sim.state.grenadeSupplyQueue).toEqual([older.id, soldier.id]);
    expect(sim.step().some((event) => event.type === 'automaticSupportRequested')).toBe(false);
  });

  it('does not duplicate an existing manual request from a veteran', () => {
    const { sim, soldier, tick, empty } = fixture('at'); soldier.health = 40; empty();
    expect(sim.command({ type: 'callMedic', unitId: soldier.id }).ok).toBe(true);
    expect(sim.command({ type: 'callRocketSupplies', unitId: soldier.id }).ok).toBe(true);
    expect(tick(20).some((event) => event.type === 'automaticSupportRequested')).toBe(false);
    expect(sim.state.medicalQueue).toEqual([soldier.id]); expect(sim.state.grenadeSupplyQueue).toEqual([soldier.id]);
  });

  it.each(['medic', 'supply'] as const)('respects a replacement move order for %s before retrying after ten seconds', (kind) => {
    const { sim, soldier, medic, officer, tick, empty } = fixture('at');
    if (kind === 'medic') soldier.health = 40; else empty(); sim.step();
    const provider = kind === 'medic' ? medic : officer;
    expect(sim.command({ type: 'move', unitId: provider.id, pos: { x: 156, y: 500 } }).ok).toBe(true);
    const target = () => kind === 'medic' ? provider.medicalTargetId : provider.supplyTargetId;
    expect(target()).toBeUndefined();
    const wait = CONFIG.automaticSupport.retrySeconds * CONFIG.tickRate;
    expect(tick(wait - 1).some((event) => event.type === 'automaticSupportRequested')).toBe(false); expect(target()).toBeUndefined();
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'automaticSupportRequested', unitId: soldier.id }));
    expect(target()).toBe(soldier.id);
  });

  it.each(['dead', 'crossed', 'vehicle', 'enemy', 'paused', 'crossing'] as const)('does not generate calls for %s', (condition) => {
    const { sim, soldier, empty } = fixture(); empty(); soldier.health = 40;
    if (condition === 'dead') { soldier.dead = true; soldier.health = 0; }
    if (condition === 'crossed') soldier.crossed = true;
    if (condition === 'vehicle') soldier.role = 'gun_truck';
    if (condition === 'enemy') { soldier.team = 'enemy'; soldier.role = 'rifle'; }
    if (condition === 'paused') sim.paused = true;
    if (condition === 'crossing') sim.state.scheduler.phase = 'crossing';
    expect(sim.step().some((event) => event.type === 'automaticSupportRequested')).toBe(false);
  });

  it('saves pending calls and timers and continues without duplicate requests', () => {
    const { sim, soldier } = fixture('at', true); soldier.health = 40; soldier.rockets = 0; sim.step();
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap), events = [];
    expect(restored.state.medicalQueue).toEqual([soldier.id]); expect(restored.state.grenadeSupplyQueue).toEqual([soldier.id]);
    expect(restored.state.units[0]!.autoSupplyCallAfter).toBe(soldier.autoSupplyCallAfter);
    for (let i = 0; i < 90; i++) { const next = sim.step(); expect(restored.step()).toEqual(next); events.push(...next); }
    expect(restored.snapshot()).toEqual(sim.snapshot()); expect(events.some((event) => event.type === 'automaticSupportRequested')).toBe(false);
  });

  it('lets veterans in older saves request support immediately after Continue', () => {
    const { sim, soldier } = fixture('at', true); soldier.health = 40; soldier.rockets = 0;
    const old = sim.snapshot(); old.schemaVersion = 23;
    const checked = validateSnapshot(JSON.parse(JSON.stringify(old))); if ('error' in checked) throw new Error(checked.error);
    expect(checked.snap.schemaVersion).toBe(30);
    expect(Simulation.fromSnapshot(checked.snap).step().filter((event) => event.type === 'automaticSupportRequested')).toHaveLength(2);
  });

  it.each([-1, 1.5, null, 'later'])('rejects invalid support retry timers: %s', (timer) => {
    const { sim } = fixture(), saved = JSON.parse(JSON.stringify(sim.snapshot())); saved.units[0].autoMedicCallAfter = timer;
    expect(validateSnapshot(saved)).toMatchObject({ error: 'Corrupt automatic support timer.' });
    delete saved.units[0].autoMedicCallAfter; saved.units[0].autoSupplyCallAfter = timer;
    expect(validateSnapshot(saved)).toMatchObject({ error: 'Corrupt automatic support timer.' });
  });
});
