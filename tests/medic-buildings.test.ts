import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { buildingSlot } from '../src/simulation/buildings';
import { bridgeKey } from '../src/simulation/bridges';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import type { BuildingLevel, Unit } from '../src/simulation/types';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  data.buildings = [{ kind: 'hospital', name: 'Field hospital', col: 10, row: 10, cols: 4, rows: 3 }];
  const sim = new Simulation(2026, undefined, data), patient = sim.state.units[0]!;
  const medic = structuredClone(patient); medic.id = sim.state.nextEntityId++; medic.role = 'medic';
  patient.health = 40; medic.health = 100;
  sim.state.units = [medic, patient]; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  for (const unit of sim.state.units) { unit.grenades = 0; unit.path = []; unit.moveGoal = null; unit.reloadTimer = 100_000; }
  const building = sim.state.buildings[0]!;
  const place = (unit: Unit, level: BuildingLevel, slot: number) => {
    unit.buildingPosition = { buildingId: building.id, level, slot };
    unit.pos = buildingSlot(building, unit.buildingPosition, 24); unit.prevPos = { ...unit.pos };
  };
  return { sim, medic, patient, building, place };
}

describe('medics and building floors', () => {
  it.each(['rifleman', 'engineer', 'at', 'mortarman'] as const)('a Supply Officer reaches an upper-floor %s before delivering ammunition', (role) => {
    const { sim, medic: officer, patient, place } = fixture();
    officer.role = 'supply_officer'; patient.role = role; patient.grenades = 0; patient.rockets = 0; patient.mortarBombs = 0;
    place(patient, 1, 4); officer.pos = { x: 396, y: 612 }; officer.prevPos = { ...officer.pos };
    expect(sim.command({ type: role === 'mortarman' ? 'callMortarSupplies' : role === 'at' ? 'callRocketSupplies' : 'callGrenadeSupplies', unitId: patient.id }).ok).toBe(true);
    expect(officer.buildingOrder?.level).toBe(1); expect(patient.grenades).toBe(0);
    for (let i = 0; i < 1200; i++) sim.step();
    expect(officer.buildingPosition?.level).toBe(1); expect(role === 'mortarman' ? patient.mortarBombs : role === 'at' ? patient.rockets : patient.grenades).toBe(role === 'mortarman' ? 6 : 4); expect(officer.supplyTargetId).toBeUndefined();
  });

  it('dispatches a called ground medic to a casualty on an upper floor', () => {
    const { sim, medic, patient, place } = fixture();
    place(patient, 1, 4);
    medic.pos = { x: 396, y: 612 }; medic.prevPos = { ...medic.pos };
    expect(sim.command({ type: 'callMedic', unitId: patient.id }).ok).toBe(true);
    expect(medic.buildingOrder?.level).toBe(1);
    for (let i = 0; i < 1200; i++) sim.step();
    expect(medic.buildingPosition?.level).toBe(1);
    expect(patient.health).toBe(100); expect(medic.medicalTargetId).toBeUndefined();
  });

  it('approaches a casualty without reversing toward its last completed move order every other tick', () => {
    const { sim, medic, patient } = fixture();
    medic.pos = { x: 396, y: 612 }; medic.prevPos = { ...medic.pos }; medic.moveGoal = { ...medic.pos };
    patient.pos = { x: 396, y: 492 }; patient.prevPos = { ...patient.pos };
    for (let tick = 0; tick < 100; tick++) {
      const before = medic.pos.y;
      sim.step();
      expect(medic.pos.y).toBeLessThanOrEqual(before);
    }
    for (let tick = 0; tick < 200; tick++) sim.step();
    expect(patient.health).toBeGreaterThan(40);
  });

  it.each<[BuildingLevel, BuildingLevel]>([[0, 0], [1, 1], [2, 2], ['roof', 'roof'], [1, 'balcony'], ['balcony', 1], ['balcony', 'balcony']])(
    'heals from %s to %s across the same building floor height', (medicLevel, patientLevel) => {
      const { sim, medic, patient, place } = fixture();
      place(medic, medicLevel, 0); place(patient, patientLevel, patientLevel === 'balcony' ? 1 : 4);
      const post = structuredClone(medic.buildingPosition), pos = { ...medic.pos };
      const events = sim.step();
      expect(patient.health).toBe(65);
      expect(events).toContainEqual(expect.objectContaining({ type: 'healed', medicId: medic.id, targetId: patient.id, amount: 25 }));
      expect(medic.service.healthRestored).toBe(25); expect(medic.healTimer).toBeGreaterThan(0);
      expect(medic.buildingPosition).toEqual(post); expect(medic.pos).toEqual(pos); expect(medic.path).toEqual([]);
      sim.step(); expect(patient.health).toBe(65);
      medic.healTimer = 0; patient.health = 95; sim.step(); expect(patient.health).toBe(100);
    });

  it.each<[BuildingLevel, BuildingLevel]>([[0, 1], [1, 0], [1, 2], [2, 'roof'], ['roof', 2], [0, 'balcony'], ['balcony', 'roof']])(
    'does not heal through floors from %s to %s even at the same map position', (medicLevel, patientLevel) => {
      const { sim, medic, patient, place } = fixture();
      place(medic, medicLevel, 0); place(patient, patientLevel, 0);
      const events = sim.step();
      expect(patient.health).toBe(40); expect(medic.healTimer).toBe(0);
      expect(events.some((event) => event.type === 'healed')).toBe(false);
      expect(medic.path).toEqual([]);
    });

  it.each([0, 1, 'roof'] as const)('allows a nearby ground medic to heal only ground-floor occupants, patient floor=%s', (level) => {
    const { sim, medic, patient, place } = fixture(); place(patient, level, 4);
    medic.pos = { x: patient.pos.x, y: patient.pos.y + 20 }; medic.prevPos = { ...medic.pos };
    sim.step(); expect(patient.health).toBe(level === 0 ? 65 : 40);
    if (level !== 0) expect(medic.path).toEqual([]);
  });

  it('chooses a patient at its own height over a closer patient on another floor', () => {
    const { sim, medic, patient, place } = fixture(); place(medic, 1, 0); place(patient, 1, 4);
    const below = structuredClone(patient); below.id = sim.state.nextEntityId++; place(below, 0, 0);
    sim.state.units.push(below); sim.step();
    expect(patient.health).toBe(65); expect(below.health).toBe(40);
  });

  it('treats its floor instead of trying to leave for a closer outdoor casualty beyond reach', () => {
    const { sim, medic, patient, place } = fixture(); place(medic, 0, 0); place(patient, 0, 4);
    const outside = structuredClone(patient); outside.id = sim.state.nextEntityId++; delete outside.buildingPosition;
    outside.pos = { x: medic.pos.x, y: medic.pos.y - 50 }; outside.prevPos = { ...outside.pos };
    sim.state.units.push(outside); sim.step();
    expect(patient.health).toBe(65); expect(outside.health).toBe(40); expect(medic.path).toEqual([]);
  });

  it('cannot heal while pinned or climbing, or treat a patient on the stairs', () => {
    const { sim, medic, patient, place } = fixture(); place(medic, 1, 0); place(patient, 1, 4);
    medic.suppression = CONFIG.suppression.max; sim.step(); expect(patient.health).toBe(40);
    medic.suppression = 0; medic.pinned = false;
    medic.buildingOrder = { ...medic.buildingPosition!, level: 2, climbTicks: 30 };
    sim.step(); expect(patient.health).toBe(40);
    delete medic.buildingOrder;
    patient.buildingOrder = { ...patient.buildingPosition!, level: 2, climbTicks: 30 };
    sim.step(); expect(patient.health).toBe(40);
    delete patient.buildingOrder; sim.step(); expect(patient.health).toBe(65);
  });

  it('uses the building foundation height, not the ground under the window slot', () => {
    const { sim, medic, patient, place } = fixture();
    sim.state.terrain.elevation = { cell: 12, cols: 81, rows: 61,
      heights: Float32Array.from({ length: 81 * 61 }, (_, i) => Math.floor(i / 81) * .6) };
    place(medic, 1, 0); place(patient, 1, 4); sim.step(); expect(patient.health).toBe(65);
  });

  it('does not heal between a bridge deck and the ground directly below it', () => {
    const { sim, medic, patient } = fixture();
    const bridge = { x: 600, y: 500, axis: 'horizontal' as const, type: 'stone' as const, halfWidth: 18, halfLength: 72 };
    sim.state.terrain.bridges = [bridge];
    for (const unit of [medic, patient]) { unit.pos = { x: 600, y: 500 }; unit.prevPos = { ...unit.pos }; }
    medic.bridgePosition = { key: bridgeKey(bridge), level: 'deck' };
    patient.bridgePosition = { key: bridgeKey(bridge), level: 'under' };
    sim.step(); expect(patient.health).toBe(40);
  });
});
