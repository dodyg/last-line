import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { insidePatrolArea } from '../src/simulation/patrol';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function makeFixture(role: 'rifleman' | 'sniper' | 'medic') {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false), unit = sim.state.units[0]!;
  unit.role = role;
  sim.state.units = [unit]; unit.pos = { x: 156, y: 612 }; unit.prevPos = { ...unit.pos };
  unit.grenades = 0; unit.reloadTimer = 100_000; unit.morale = 100;
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const order = () => sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: 120, y: 552 }, to: { x: 312, y: 696 } });
  const tick = (n: number) => { for (let i = 0; i < n; i++) sim.step(); };
  return { sim, unit, order, tick };
}

describe.each(['rifleman', 'sniper', 'medic'] as const)('%s area patrol', (role) => {
  const fixture = () => makeFixture(role);
  it('walks repeated circuits inside the selected area and routes around obstacles', () => {
    const { sim, unit, order } = fixture();
    for (let row = 24; row <= 27; row++) sim.state.terrain.blocked[row * 40 + 8] = 1;
    expect(order().ok).toBe(true);
    const patrol = unit.patrol!;
    let previous = patrol.nextPoint, legs = 0;
    for (let i = 0; i < 1800; i++) {
      sim.step();
      expect(insidePatrolArea(patrol.area, unit.pos)).toBe(true);
      expect(sim.state.terrain.blocked[Math.floor(unit.pos.y / 24) * 40 + Math.floor(unit.pos.x / 24)]).toBe(0);
      expect(unit.running).toBe(false);
      if (patrol.nextPoint !== previous) { legs++; previous = patrol.nextPoint; }
    }
    expect(legs).toBeGreaterThan(4);
    expect(unit.patrol).toBe(patrol);
  });

  if (role !== 'medic') it('stops to fire at a visible enemy, then resumes the same patrol when clear', () => {
    const { sim, unit, order, tick } = fixture();
    expect(order().ok).toBe(true); tick(10);
    sim.spawnEnemy('rifle', { x: 156, y: 480 });
    const enemy = sim.state.units.at(-1)!;
    enemy.suppression = CONFIG.suppression.max; enemy.pinned = true; enemy.reloadTimer = 100_000;
    unit.reloadTimer = 0;
    const before = { ...unit.pos }, patrol = structuredClone(unit.patrol);
    const events = sim.step();
    expect(unit.pos).toEqual(before); expect(unit.path).toEqual([]);
    expect(unit.targetId).toBe(enemy.id);
    expect(events.some((event) => event.type === 'shot' && event.shooterId === unit.id)).toBe(true);
    expect(unit.patrol).toEqual(patrol);
    sim.state.units = [unit]; tick(1);
    expect(unit.pos).not.toEqual(before); expect(unit.path.length).toBeGreaterThan(0);
    expect(unit.patrol).toEqual(patrol);
  });

  it('hunkers down while pinned and resumes after recovering', () => {
    const { unit, order, tick } = fixture();
    order(); tick(10); unit.suppression = CONFIG.suppression.max;
    const before = { ...unit.pos };
    tick(20); expect(unit.pinned).toBe(true); expect(unit.pos).toEqual(before); expect(unit.patrol).toBeDefined();
    unit.suppression = 0; tick(1);
    expect(unit.pinned).toBe(false); expect(unit.pos).not.toEqual(before);
  });

  it('can approach an area from outside before starting its bounded circuit', () => {
    const { unit, order, tick } = fixture();
    unit.pos = { x: 60, y: 612 }; unit.prevPos = { ...unit.pos };
    expect(order().ok).toBe(true); tick(300);
    expect(insidePatrolArea(unit.patrol!.area, unit.pos)).toBe(true);
  });

  it('assigns eligible patrol members in a mixed group while leaving other roles alone', () => {
    const { sim, unit } = fixture();
    const ally = structuredClone(unit); ally.id = sim.state.nextEntityId++; ally.pos.x += 48;
    ally.role = role === 'rifleman' ? 'sniper' : 'rifleman';
    const gunner = structuredClone(ally); gunner.id = sim.state.nextEntityId++; gunner.role = 'mg';
    sim.state.units.push(ally, gunner);
    expect(sim.command({ type: 'patrol', unitIds: [unit.id, ally.id, gunner.id], from: { x: 120, y: 552 }, to: { x: 312, y: 696 } }).ok).toBe(true);
    expect(unit.patrol).toBeDefined(); expect(ally.patrol).toBeDefined(); expect(gunner.patrol).toBeUndefined();
  });

  it('keeps its patrol through shell avoidance and returns to the assigned area', () => {
    const { sim, unit, order, tick } = fixture(); order();
    const area = structuredClone(unit.patrol!.area);
    sim.state.strikes = [{ id: sim.state.nextEntityId++, pos: { ...unit.pos }, landTick: 20,
      radius: 42, damage: 0, suppressionAmount: 0, source: 'enemy', delivery: 'mortar' }];
    tick(20); expect(unit.patrol!.area).toEqual(area);
    tick(400); expect(insidePatrolArea(area, unit.pos)).toBe(true); expect(unit.patrol!.area).toEqual(area);
  });

  it('replaces a patrol with a building order', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    unit.role = role;
    sim.state.units = [unit]; unit.pos = { x: 360, y: 600 }; unit.prevPos = { ...unit.pos };
    expect(sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: 330, y: 564 }, to: { x: 552, y: 684 } }).ok).toBe(true);
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: sim.state.buildings[0]!.id, level: 0 }).ok).toBe(true);
    expect(unit.patrol).toBeUndefined(); expect(unit.buildingOrder).toBeDefined();
  });

  it('stops on explicit cancellation or a new move order', () => {
    const { sim, unit, order, tick } = fixture();
    order(); tick(20);
    expect(sim.command({ type: 'stopPatrol', unitIds: [unit.id] }).ok).toBe(true);
    const before = { ...unit.pos }; tick(20);
    expect(unit.patrol).toBeUndefined(); expect(unit.pos).toEqual(before);
    order(); expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 420, y: 612 } }).ok).toBe(true);
    expect(unit.patrol).toBeUndefined();
    order(); expect(sim.command({ type: 'moveGroup', unitIds: [unit.id], pos: { x: 420, y: 612 } }).ok).toBe(true);
    expect(unit.patrol).toBeUndefined();
  });

  it('rejects undersized, out-of-bounds, disconnected, pinned, and unsupported role orders', () => {
    const { sim, unit, order } = fixture();
    const unchanged = structuredClone(unit);
    expect(sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: 120, y: 560 }, to: { x: 130, y: 570 } }).ok).toBe(false);
    expect(sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: -5, y: 560 }, to: { x: 300, y: 700 } }).ok).toBe(false);
    expect(unit).toEqual(unchanged);
    for (let row = 23; row < 30; row++) sim.state.terrain.blocked[row * 40 + 8] = 1;
    expect(order().ok).toBe(false); expect(unit).toEqual(unchanged);
    sim.state.terrain.blocked.fill(0);
    unit.pinned = true; expect(order().ok).toBe(false);
    unit.pinned = false; unit.role = 'mg'; expect(order().ok).toBe(false);
    unit.role = role; sim.paused = true; expect(order().ok).toBe(false);
  });

  it('restores the patrol area and current leg deterministically through a save', () => {
    // Restore regenerates terrain from the seed, so use an unmodified map here.
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    unit.role = role;
    sim.state.units = [unit]; unit.pos = { x: 360, y: 600 }; unit.prevPos = { ...unit.pos };
    sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
    expect(sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: 330, y: 564 }, to: { x: 552, y: 684 } }).ok).toBe(true);
    for (let i = 0; i < 100; i++) sim.step();
    const parsed = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in parsed) throw new Error(parsed.error);
    const restored = Simulation.fromSnapshot(parsed.snap);
    for (let i = 0; i < 300; i++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
  });

  it.each(['area', 'points', 'nextPoint', 'retryTick'])('rejects corrupt saved patrol %s', (key) => {
    const { sim, unit, order } = fixture(); order();
    const snap = JSON.parse(JSON.stringify(sim.snapshot())); snap.units[0].patrol[key] = null;
    expect(validateSnapshot(snap)).toHaveProperty('error');
    expect(unit.patrol).toBeDefined();
  });
});

describe('medical patrol treatment', () => {
  it('pauses to heal nearby wounded without changing its patrol destination, then resumes', () => {
    const { sim, unit: medic, order, tick } = makeFixture('medic');
    const patient = structuredClone(medic); patient.id = sim.state.nextEntityId++; patient.role = 'rifleman'; patient.health = 40;
    patient.pos = { x: medic.pos.x + 12, y: medic.pos.y }; patient.prevPos = { ...patient.pos };
    sim.state.units.push(patient);
    expect(order().ok).toBe(true);
    const patrol = structuredClone(medic.patrol), goal = { ...medic.moveGoal! };
    tick(1); expect(patient.health).toBe(65);
    expect(medic.path).toEqual([]); expect(medic.moveGoal).toEqual(goal); expect(medic.patrol).toEqual(patrol);
    // A neighboring casualty can nudge the medic while it treats them. This
    // must not rebuild a walking route between healing cooldown ticks.
    for (let i = 0; i < 60; i++) {
      tick(1); expect(medic.path).toEqual([]); expect(medic.running).toBe(false); expect(medic.moveGoal).toEqual(goal);
    }
    tick(300);
    expect(patient.health).toBe(100); expect(medic.patrol!.area).toEqual(patrol!.area);
    expect(medic.path.length).toBeGreaterThan(0);
    expect(insidePatrolArea(medic.patrol!.area, medic.pos)).toBe(true);
    expect(medic.service.healthRestored).toBe(60);
  });

  it('keeps its route instead of pursuing casualties beyond treatment range', () => {
    const { sim, unit: medic, order, tick } = makeFixture('medic');
    const patient = structuredClone(medic); patient.id = sim.state.nextEntityId++; patient.role = 'rifleman'; patient.health = 40;
    patient.pos = { x: 420, y: 612 }; patient.prevPos = { ...patient.pos };
    sim.state.units.push(patient); expect(order().ok).toBe(true);
    for (let i = 0; i < 600; i++) { tick(1); expect(insidePatrolArea(medic.patrol!.area, medic.pos)).toBe(true); }
    expect(patient.health).toBe(40); expect(medic.service.healthRestored).toBe(0);
  });
});
