import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data), rifleman = sim.state.units[0]!, officer = structuredClone(rifleman);
  officer.id = sim.state.nextEntityId++; officer.role = 'supply_officer'; officer.pos = { x: 156, y: 612 }; officer.health = 90;
  rifleman.role = 'rifleman'; rifleman.grenades = 0; rifleman.pos = { x: 588, y: 612 };
  sim.state.units = [officer, rifleman];
  for (const unit of sim.state.units) { unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.reloadTimer = 100_000; }
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const call = () => sim.command({ type: 'callGrenadeSupplies', unitId: rifleman.id });
  const tick = (n: number) => { for (let i = 0; i < n; i++) sim.step(); };
  return { sim, rifleman, officer, call, tick };
}

describe('Supply Officer grenade deliveries', () => {
  it('is recruitable at its configured cost and carries no personal grenades', () => {
    const sim = new Simulation(2026); sim.state.points = 100;
    expect(sim.command({ type: 'recruit', role: 'supply_officer', pos: { x: 480, y: 680 } }).ok).toBe(true);
    expect(sim.state.points).toBe(100 - CONFIG.costs.recruit.supply_officer);
    expect(sim.state.units.at(-1)!.role).toBe('supply_officer');
    expect(sim.state.units.at(-1)!.grenades).toBe(0);
  });

  it('travels to the rifleman before replenishing the standard four-grenade loadout', () => {
    const { sim, rifleman, officer, call, tick } = fixture();
    expect(call().ok).toBe(true); expect(officer.supplyTargetId).toBe(rifleman.id);
    expect(rifleman.grenades).toBe(0); tick(120);
    expect(officer.pos.x).toBeGreaterThan(156); expect(rifleman.grenades).toBe(0);
    tick(600);
    expect(rifleman.grenades).toBe(4); expect(officer.supplyTargetId).toBeUndefined();
    expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it('tops up a partial loadout without exceeding capacity and can deliver again after grenades are spent', () => {
    const { sim, rifleman, officer, call } = fixture();
    officer.pos = { x: rifleman.pos.x - 24, y: rifleman.pos.y }; rifleman.grenades = 1;
    expect(call().ok).toBe(true);
    expect(sim.step()).toContainEqual({ type: 'grenadesResupplied', officerId: officer.id, targetId: rifleman.id, amount: 3 });
    expect(rifleman.grenades).toBe(4); expect(call().ok).toBe(false);
    rifleman.grenades = 0; expect(call().ok).toBe(true); sim.step(); expect(rifleman.grenades).toBe(4);
  });

  it('serves calls in order instead of supplying a later, closer caller first', () => {
    const { sim, rifleman, officer, call, tick } = fixture();
    const second = structuredClone(rifleman); second.id = sim.state.nextEntityId++; second.pos = { x: 180, y: 612 };
    sim.state.units.unshift(second);
    expect(call().ok).toBe(true); expect(sim.command({ type: 'callGrenadeSupplies', unitId: second.id }).ok).toBe(true);
    expect(sim.state.grenadeSupplyQueue).toEqual([rifleman.id, second.id]);
    for (let i = 0; i < 1200; i++) { tick(1); if (rifleman.grenades === 0) expect(second.grenades).toBe(0); }
    expect(rifleman.grenades).toBe(4); expect(second.grenades).toBe(4); expect(officer.supplyTargetId).toBeUndefined();
  });

  it('follows a moving rifleman and maintains the request while repathing', () => {
    const { rifleman, officer, call, tick } = fixture();
    expect(call().ok).toBe(true); tick(60);
    rifleman.pos = { x: 588, y: 420 }; rifleman.prevPos = { ...rifleman.pos };
    tick(1000); expect(rifleman.grenades).toBe(4); expect(officer.pos.y).toBeLessThan(480);
  });

  it('a supply call replaces gunfire pursuit and a new pursuit order cancels the delivery', () => {
    const { sim, officer, call, tick } = fixture();
    officer.fireOrder = 'seekGunfire'; expect(call().ok).toBe(true); expect(officer.fireOrder).toBe('auto');
    expect(sim.command({ type: 'fireOrder', unitIds: [officer.id], order: 'seekGunfire' }).ok).toBe(true);
    tick(1); expect(officer.supplyTargetId).toBeUndefined(); expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it('keeps calls queued while pinned and rejects duplicate requests without mutation', () => {
    const { sim, officer, rifleman, call, tick } = fixture();
    officer.pinned = true; officer.suppression = CONFIG.suppression.max;
    expect(call().ok).toBe(true); expect(officer.supplyTargetId).toBeUndefined();
    const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
    officer.pinned = false; officer.suppression = 0; tick(1); expect(officer.supplyTargetId).toBe(rifleman.id);
  });

  it.each(['full', 'radioEngineer', 'dead', 'crossed', 'paused', 'noOfficer'] as const)('rejects %s requests without mutation', (condition) => {
    const { sim, rifleman, officer, call } = fixture();
    if (condition === 'full') rifleman.grenades = 4;
    if (condition === 'radioEngineer') rifleman.role = 'radio_engineer';
    if (condition === 'dead') rifleman.dead = true;
    if (condition === 'crossed') rifleman.crossed = true;
    if (condition === 'paused') sim.paused = true;
    if (condition === 'noOfficer') officer.role = 'officer';
    const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
  });

  it('reassigns the oldest delivery if its officer dies and drops callers who leave', () => {
    const { sim, officer, rifleman, call, tick } = fixture();
    expect(call().ok).toBe(true); officer.dead = true;
    const replacement = structuredClone(officer); replacement.id = sim.state.nextEntityId++; replacement.dead = false;
    delete replacement.supplyTargetId; sim.state.units.push(replacement);
    tick(1); expect(replacement.supplyTargetId).toBe(rifleman.id);
    rifleman.crossed = true; tick(1); expect(replacement.supplyTargetId).toBeUndefined(); expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it.each(['move', 'garrison'] as const)('a direct %s order cancels the active delivery', (type) => {
    const { sim, officer, call, tick } = fixture();
    expect(call().ok).toBe(true);
    if (type === 'move') expect(sim.command({ type, unitId: officer.id, pos: { x: 156, y: 684 } }).ok).toBe(true);
    else {
      sim.state.buildings.push({ id: sim.state.nextEntityId++, kind: 'house', name: 'House', pos: { x: 300, y: 300 }, cols: 3, rows: 3, health: 100, maxHealth: 100, destroyed: false });
      expect(sim.command({ type, unitIds: [officer.id], buildingId: sim.state.buildings[0]!.id, level: 0 }).ok).toBe(true);
    }
    tick(1); expect(officer.supplyTargetId).toBeUndefined(); expect(sim.state.grenadeSupplyQueue).toEqual([]);
  });

  it('preserves an officer and ordered pending calls through a validated save and Continue', () => {
    const sim = new Simulation(2026), rifleman = sim.state.units[0]!, second = structuredClone(rifleman), officer = structuredClone(rifleman);
    second.id = sim.state.nextEntityId++; officer.id = sim.state.nextEntityId++; officer.role = 'supply_officer'; officer.health = 90;
    officer.pos = { x: 360, y: 600 }; rifleman.pos = { x: 552, y: 600 }; second.pos = { x: 480, y: 600 };
    rifleman.grenades = second.grenades = officer.grenades = 0;
    sim.state.units = [officer, rifleman, second]; sim.state.scheduler.prepTicksLeft = 100_000;
    for (const unit of sim.state.units) { unit.path = []; unit.moveGoal = null; }
    for (const unit of [rifleman, second]) expect(sim.command({ type: 'callGrenadeSupplies', unitId: unit.id }).ok).toBe(true);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.grenadeSupplyQueue).toEqual([rifleman.id, second.id]);
    for (let i = 0; i < 1000; i++) restored.step();
    expect(restored.state.units.find((u) => u.id === rifleman.id)!.grenades).toBe(4);
    expect(restored.state.units.find((u) => u.id === second.id)!.grenades).toBe(4);
  });

  it.each([null, [-1], [1, 1], ['rifleman']])('rejects corrupt saved queue %j', (queue) => {
    const { sim } = fixture(); const snapshot = JSON.parse(JSON.stringify(sim.snapshot())); snapshot.grenadeSupplyQueue = queue;
    expect(validateSnapshot(snapshot)).toHaveProperty('error');
  });
});
