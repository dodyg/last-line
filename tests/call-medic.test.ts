import { describe, expect, it } from 'vitest';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data), patient = sim.state.units[0]!;
  const medic = structuredClone(patient); medic.id = sim.state.nextEntityId++; medic.role = 'medic';
  medic.health = 100; medic.pos = { x: 156, y: 612 };
  patient.health = 40; patient.pos = { x: 588, y: 612 };
  sim.state.units = [medic, patient];
  for (const unit of sim.state.units) {
    unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null;
    unit.grenades = 0; unit.reloadTimer = 100_000; unit.morale = 100;
  }
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const call = () => sim.command({ type: 'callMedic', unitId: patient.id });
  const tick = (n: number) => { for (let i = 0; i < n; i++) sim.step(); };
  return { sim, medic, patient, call, tick };
}

describe('Call medic', () => {
  it('dispatches beyond automatic seek range and prioritizes the requested casualty until fully healed', () => {
    const { sim, medic, patient, call, tick } = fixture();
    const other = structuredClone(patient); other.id = sim.state.nextEntityId++; other.pos = { x: 180, y: 612 };
    sim.state.units.push(other);
    expect(call()).toEqual({ ok: true });
    expect(medic.medicalTargetId).toBe(patient.id);
    tick(180);
    expect(other.health).toBe(40);
    expect(medic.pos.x).toBeGreaterThan(200);
    tick(1000);
    expect(patient.health).toBe(100);
    expect(medic.medicalTargetId).toBeUndefined();
    expect(medic.service.healthRestored).toBeGreaterThanOrEqual(60);
  });

  it('chooses the nearest available medic and does not steal an assigned medic', () => {
    const { sim, medic, patient, call } = fixture();
    const closer = structuredClone(medic); closer.id = sim.state.nextEntityId++; closer.pos = { x: 540, y: 612 };
    sim.state.units.push(closer);
    expect(call().ok).toBe(true);
    expect(closer.medicalTargetId).toBe(patient.id);
    expect(medic.medicalTargetId).toBeUndefined();
    const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
    const other = structuredClone(patient); other.id = sim.state.nextEntityId++; other.pos.x += 24;
    sim.state.units.push(other);
    expect(sim.command({ type: 'callMedic', unitId: other.id }).ok).toBe(true);
    expect(medic.medicalTargetId).toBe(other.id);
    expect(closer.medicalTargetId).toBe(patient.id);
  });

  it('follows the patient when they move', () => {
    const { medic, patient, call, tick } = fixture();
    expect(call().ok).toBe(true); tick(50);
    patient.pos = { x: 588, y: 420 }; patient.prevPos = { ...patient.pos };
    tick(1200);
    expect(patient.health).toBe(100);
    expect(medic.pos.y).toBeLessThan(480);
  });

  it('skips a nearer medic with no route to the casualty', () => {
    const { sim, medic, patient, call } = fixture();
    const trapped = structuredClone(medic); trapped.id = sim.state.nextEntityId++;
    trapped.pos = { x: 492, y: 612 }; trapped.prevPos = { ...trapped.pos }; sim.state.units.push(trapped);
    const terrain = sim.state.terrain, col = Math.floor(trapped.pos.x / terrain.cell), row = Math.floor(trapped.pos.y / terrain.cell);
    for (let y = row - 1; y <= row + 1; y++) for (let x = col - 1; x <= col + 1; x++) {
      if (x !== col || y !== row) terrain.blocked[y * terrain.cols + x] = 1;
    }
    expect(call().ok).toBe(true);
    expect(medic.medicalTargetId).toBe(patient.id); expect(trapped.medicalTargetId).toBeUndefined();
  });

  it('rejects a saved assignment on a non-medic or with an invalid target id', () => {
    const { sim, medic, call } = fixture(); expect(call().ok).toBe(true);
    for (const invalid of [null, -1, 1.5, 'soldier']) {
      const snapshot = JSON.parse(JSON.stringify(sim.snapshot())); snapshot.units[0].medicalTargetId = invalid;
      expect(validateSnapshot(snapshot)).toHaveProperty('error');
    }
    medic.role = 'rifleman';
    expect(validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())))).toHaveProperty('error');
  });

  it.each(['move', 'moveGroup', 'patrol'] as const)('a new %s order cancels treatment priority', (type) => {
    const { sim, medic, call } = fixture();
    expect(call().ok).toBe(true);
    const result = type === 'move' ? sim.command({ type, unitId: medic.id, pos: { x: 156, y: 684 } })
      : type === 'moveGroup' ? sim.command({ type, unitIds: [medic.id], pos: { x: 156, y: 684 } })
        : sim.command({ type, unitIds: [medic.id], from: { x: 120, y: 552 }, to: { x: 312, y: 696 } });
    expect(result.ok).toBe(true); expect(medic.medicalTargetId).toBeUndefined();
  });

  it('releases the assignment when the casualty dies or leaves the map', () => {
    for (const disposition of ['dead', 'crossed'] as const) {
      const { medic, patient, call, tick } = fixture();
      expect(call().ok).toBe(true); patient[disposition] = true; tick(1);
      expect(medic.medicalTargetId).toBeUndefined(); expect(medic.path).toEqual([]);
    }
  });

  it('rejects missing medics, healthy soldiers, and paused orders without mutation', () => {
    const { sim, medic, patient, call } = fixture();
    for (const condition of ['healthy', 'dead', 'crossed', 'paused'] as const) {
      patient.health = condition === 'healthy' ? 100 : 40;
      medic.dead = condition === 'dead'; medic.crossed = condition === 'crossed';
      sim.paused = condition === 'paused';
      const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
    }
  });

  it('serves three callers first come first served even when later callers are closer', () => {
    const { sim, medic, patient, call, tick } = fixture();
    const second = structuredClone(patient); second.id = sim.state.nextEntityId++; second.pos = { x: 444, y: 612 };
    const third = structuredClone(patient); third.id = sim.state.nextEntityId++; third.pos = { x: 180, y: 612 };
    sim.state.units.push(third, second); // Unit array order must not determine service order.
    expect(call().ok).toBe(true);
    expect(sim.command({ type: 'callMedic', unitId: second.id }).ok).toBe(true);
    expect(sim.command({ type: 'callMedic', unitId: third.id }).ok).toBe(true);
    expect(sim.state.medicalQueue).toEqual([patient.id, second.id, third.id]);
    const starts = [medic.medicalTargetId]; let previous = medic.medicalTargetId;
    for (let i = 0; i < 3000; i++) {
      tick(1);
      if (medic.medicalTargetId !== undefined && medic.medicalTargetId !== previous) starts.push(medic.medicalTargetId);
      previous = medic.medicalTargetId;
      if (patient.health < 100) { expect(second.health).toBe(40); expect(third.health).toBe(40); }
      if (second.health < 100) expect(third.health).toBe(40);
    }
    expect(starts).toEqual([patient.id, second.id, third.id]);
    expect([patient.health, second.health, third.health]).toEqual([100, 100, 100]);
    expect(sim.state.medicalQueue).toEqual([]);
  });

  it('keeps calls queued while all medics are pinned and ignores duplicate calls', () => {
    const { sim, medic, patient, call, tick } = fixture();
    medic.pinned = true; medic.suppression = 100;
    expect(call().ok).toBe(true);
    expect(medic.medicalTargetId).toBeUndefined(); expect(sim.state.medicalQueue).toEqual([patient.id]);
    const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
    medic.pinned = false; medic.suppression = 0; tick(1);
    expect(medic.medicalTargetId).toBe(patient.id);
  });

  it('skips queued casualties who die, leave, or recover before their turn', () => {
    for (const disposition of ['dead', 'crossed', 'recovered'] as const) {
      const { sim, medic, patient, call, tick } = fixture();
      const second = structuredClone(patient); second.id = sim.state.nextEntityId++;
      const third = structuredClone(patient); third.id = sim.state.nextEntityId++; third.pos.x -= 72;
      sim.state.units.push(second, third);
      expect(call().ok).toBe(true);
      for (const unit of [second, third]) expect(sim.command({ type: 'callMedic', unitId: unit.id }).ok).toBe(true);
      if (disposition === 'recovered') second.health = 100;
      else second[disposition] = true;
      patient.health = 100; tick(1);
      expect(medic.medicalTargetId).toBe(third.id); expect(sim.state.medicalQueue).toEqual([third.id]);
    }
  });

  it('returns an interrupted caller to the front when their medic dies', () => {
    const { sim, medic, patient, call, tick } = fixture();
    const second = structuredClone(patient); second.id = sim.state.nextEntityId++; sim.state.units.push(second);
    expect(call().ok).toBe(true); expect(sim.command({ type: 'callMedic', unitId: second.id }).ok).toBe(true);
    medic.dead = true;
    const replacement = structuredClone(medic); replacement.id = sim.state.nextEntityId++;
    replacement.dead = false; delete replacement.medicalTargetId; sim.state.units.push(replacement);
    tick(1);
    expect(replacement.medicalTargetId).toBe(patient.id); expect(sim.state.medicalQueue).toEqual([patient.id, second.id]);
  });

  it.each([null, 'patient', [1, 1], [-1], [1.5]])('rejects corrupt saved queue %j', (invalid) => {
    const { sim } = fixture(); const snapshot = JSON.parse(JSON.stringify(sim.snapshot())); snapshot.medicalQueue = invalid;
    expect(validateSnapshot(snapshot)).toHaveProperty('error');
  });

  it('preserves treatment priority through a validated save and Continue', () => {
    const sim = new Simulation(2026), patient = sim.state.units[0]!, medic = structuredClone(patient);
    medic.id = sim.state.nextEntityId++; medic.role = 'medic'; medic.health = 100; medic.pos = { x: 360, y: 600 };
    patient.health = 40; patient.pos = { x: 552, y: 600 };
    sim.state.units = [medic, patient]; sim.state.scheduler.prepTicksLeft = 100_000;
    const waiting = structuredClone(patient); waiting.id = sim.state.nextEntityId++; waiting.pos = { x: 480, y: 600 };
    sim.state.units.push(waiting);
    sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
    expect(sim.command({ type: 'callMedic', unitId: patient.id }).ok).toBe(true);
    expect(sim.command({ type: 'callMedic', unitId: waiting.id }).ok).toBe(true);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap); restored.paused = false;
    expect(restored.state.units.find((u) => u.id === medic.id)!.medicalTargetId).toBe(patient.id);
    expect(restored.state.medicalQueue).toEqual([patient.id, waiting.id]);
    for (let i = 0; i < 1500; i++) restored.step();
    expect(restored.state.units.find((u) => u.id === patient.id)!.health).toBe(100);
    expect(restored.state.units.find((u) => u.id === waiting.id)!.health).toBe(100);
  });
});
