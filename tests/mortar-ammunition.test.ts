import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false); sim.state.units = [];
  const soldier = sim.spawnFriendly('mortarman', { x: 588, y: 612 });
  const officer = sim.spawnFriendly('supply_officer', { x: 156, y: 612 });
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  officer.reloadTimer = 100_000;
  const call = () => sim.command({ type: 'callMortarSupplies', unitId: soldier.id });
  const tick = (count: number) => Array.from({ length: count }, () => sim.step()).flat();
  const target = () => {
    sim.spawnEnemy('rifle', { x: 588, y: 372 }); const enemy = sim.state.units.at(-1)!;
    enemy.health = 100_000; enemy.reloadTimer = 100_000;
    return enemy;
  };
  return { sim, soldier, officer, call, tick, target };
}

describe('mortar ammunition and Supply Officer deliveries', () => {
  it('starts mortarmen with six bombs and gives no mortar ammunition to other roles', () => {
    const { sim, soldier, officer } = fixture();
    expect(soldier.mortarBombs).toBe(6); expect(officer.mortarBombs).toBe(0);
    expect(sim.spawnFriendly('at', { x: 300, y: 612 }).mortarBombs).toBe(0);
  });

  it.each([false, true])('spends one bomb per launch and stops after six, mortar pit=%s', (pit) => {
    const { sim, soldier, target } = fixture(); const enemy = target();
    if (pit) sim.state.mortarPits.push({ id: sim.state.nextEntityId++, pos: { ...soldier.pos } });
    const events = [];
    const interval = Math.round(CONFIG.mortar.intervalSeconds * CONFIG.tickRate * (pit ? CONFIG.mortarPit.reloadTimeMult : 1));
    for (let i = 0; i < interval * 8; i++) {
      enemy.pinned = true; enemy.suppression = CONFIG.suppression.max;
      const before = soldier.mortarBombs!; const next = sim.step();
      expect(before - soldier.mortarBombs!).toBe(next.some((event) => event.type === 'mortarFired') ? 1 : 0);
      events.push(...next);
    }
    expect(events.filter((event) => event.type === 'mortarFired')).toHaveLength(6);
    expect(soldier.mortarBombs).toBe(0); expect(soldier.mortarTimer).toBe(0);
    expect(sim.state.strikes.filter((strike) => strike.delivery === 'mortar')).toHaveLength(0);
  });

  it.each(['noTarget', 'tooClose', 'moving', 'pinned', 'reloading', 'upgrading'] as const)('does not waste bombs when %s', (condition) => {
    const { soldier, target, tick } = fixture(); soldier.mortarTimer = 0;
    if (condition !== 'noTarget') { const enemy = target(); enemy.pinned = true; enemy.suppression = CONFIG.suppression.max; if (condition === 'tooClose') enemy.pos = { x: 588, y: 550 }; }
    if (condition === 'moving') { soldier.path = [{ x: 800, y: 612 }]; soldier.moveGoal = { x: 800, y: 612 }; }
    if (condition === 'pinned') { soldier.pinned = true; soldier.suppression = CONFIG.suppression.max; }
    if (condition === 'reloading') soldier.mortarTimer = 100;
    if (condition === 'upgrading') soldier.upgradeTimer = 100;
    expect(tick(5).some((event) => event.type === 'mortarFired')).toBe(false); expect(soldier.mortarBombs).toBe(6);
  });

  it('requires physical delivery and automatically resumes after an empty mortar is refilled', () => {
    const { sim, soldier, officer, call, tick } = fixture(); soldier.mortarBombs = 0;
    expect(call().ok).toBe(true); tick(120);
    expect(officer.pos.x).toBeGreaterThan(156); expect(soldier.mortarBombs).toBe(0);
    expect(tick(600)).toContainEqual({ type: 'mortarBombsResupplied', officerId: officer.id, targetId: soldier.id, amount: 6 });
    expect(soldier.mortarBombs).toBe(6); expect(sim.state.grenadeSupplyQueue).toEqual([]);
    sim.spawnEnemy('rifle', { x: 588, y: 372 }); soldier.mortarTimer = 0;
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'mortarFired', unitId: soldier.id })); expect(soldier.mortarBombs).toBe(5);
  });

  it('tops up partial loads without resetting mortar reload time', () => {
    const { sim, soldier, officer, call } = fixture(); soldier.mortarBombs = 4; soldier.mortarTimer = 100;
    officer.pos = { x: 564, y: 612 }; officer.prevPos = { ...officer.pos };
    expect(call().ok).toBe(true);
    expect(sim.step()).toContainEqual({ type: 'mortarBombsResupplied', officerId: officer.id, targetId: soldier.id, amount: 2 });
    expect(soldier.mortarBombs).toBe(6); expect(soldier.mortarTimer).toBe(99); expect(call().ok).toBe(false);
  });

  it.each([false, true])('shares FIFO order with rockets and grenades, mortar first=%s', (first) => {
    const { sim, soldier, call, tick } = fixture(); soldier.mortarBombs = 0;
    const at = sim.spawnFriendly('at', { x: 180, y: 612 }), rifleman = sim.spawnFriendly('rifleman', { x: 300, y: 612 }); at.rockets = 0; rifleman.grenades = 0;
    const others = () => { expect(sim.command({ type: 'callRocketSupplies', unitId: at.id }).ok).toBe(true); expect(sim.command({ type: 'callGrenadeSupplies', unitId: rifleman.id }).ok).toBe(true); };
    if (first) { expect(call().ok).toBe(true); others(); } else { others(); expect(call().ok).toBe(true); }
    const order = first ? [soldier.id, at.id, rifleman.id] : [at.id, rifleman.id, soldier.id];
    expect(sim.state.grenadeSupplyQueue).toEqual(order);
    const deliveries = tick(2400).filter((event) => event.type === 'mortarBombsResupplied' || event.type === 'rocketsResupplied' || event.type === 'grenadesResupplied');
    expect(deliveries.map((event) => event.targetId)).toEqual(order);
    expect(soldier.mortarBombs).toBe(6); expect(at.rockets).toBe(4); expect(rifleman.grenades).toBe(4);
  });

  it.each(['full', 'dead', 'crossed', 'paused', 'noOfficer', 'wrongRole', 'duplicate'] as const)('rejects %s requests without mutation', (condition) => {
    const { sim, soldier, officer, call } = fixture(); soldier.mortarBombs = condition === 'full' ? 6 : 0;
    if (condition === 'dead') soldier.dead = true;
    if (condition === 'crossed') soldier.crossed = true;
    if (condition === 'paused') sim.paused = true;
    if (condition === 'noOfficer') officer.role = 'officer';
    if (condition === 'wrongRole') soldier.role = 'rifleman';
    if (condition === 'duplicate') expect(call().ok).toBe(true);
    const before = sim.snapshot(); expect(call().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
  });

  it('preserves an empty mortar and pending delivery across save validation and Continue', () => {
    const sim = new Simulation(2026); sim.state.units = []; sim.state.scheduler.prepTicksLeft = 100_000;
    const soldier = sim.spawnFriendly('mortarman', { x: 492, y: 612 }), officer = sim.spawnFriendly('supply_officer', { x: 468, y: 612 }); soldier.mortarBombs = 0;
    sim.step(); expect(sim.command({ type: 'callMortarSupplies', unitId: soldier.id }).ok).toBe(true);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(0);
    expect(restored.state.grenadeSupplyQueue).toEqual([soldier.id]);
    const events = [];
    for (let i = 0; i < 90; i++) { const next = sim.step(); expect(restored.step()).toEqual(next); events.push(...next); }
    expect(restored.snapshot()).toEqual(sim.snapshot());
    expect(events.filter((event) => event.type === 'mortarBombsResupplied')).toEqual([{ type: 'mortarBombsResupplied', officerId: officer.id, targetId: soldier.id, amount: 6 }]);
  });

  it('preserves partial loads and initializes older saves with six bombs', () => {
    const { sim, soldier } = fixture(); soldier.mortarBombs = 3;
    let checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in checked) throw new Error(checked.error);
    expect(Simulation.fromSnapshot(checked.snap).state.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(3);
    const old = sim.snapshot(); old.schemaVersion = 21; delete old.units.find((unit) => unit.id === soldier.id)!.mortarBombs;
    checked = validateSnapshot(JSON.parse(JSON.stringify(old))); if ('error' in checked) throw new Error(checked.error);
    expect(Simulation.fromSnapshot(checked.snap).state.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(6);
    expect(Simulation.fromSnapshot(old).state.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(6);
  });

  it.each([false, true])('restocks only upon arriving at a new map, save/resume=%s', (resume) => {
    let sim = new Simulation(31); sim.state.units = [];
    const soldier = sim.spawnFriendly('mortarman', { x: 300, y: 600 }), rifleman = sim.spawnFriendly('rifleman', { x: 500, y: 600 }); soldier.mortarBombs = 0;
    soldier.pos.y = CONFIG.crossing.thresholdY - 1; sim.step();
    expect(sim.state.mapNumber).toBe(1); expect(sim.state.crossedUnits[0]!.mortarBombs).toBe(0);
    if (resume) sim = Simulation.fromSnapshot(sim.snapshot());
    sim.state.units.find((unit) => unit.id === rifleman.id)!.pos.y = CONFIG.crossing.thresholdY - 1; sim.step();
    expect(sim.state.mapNumber).toBe(2); expect(sim.state.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(6);
  });

  it.each([-1, 7, 1.5, null, 'six'])('rejects invalid saved bomb counts %s', (count) => {
    const { sim, soldier } = fixture(), saved = JSON.parse(JSON.stringify(sim.snapshot()));
    saved.units.find((unit: { id: number }) => unit.id === soldier.id).mortarBombs = count;
    expect(validateSnapshot(saved)).toMatchObject({ error: 'Corrupt mortar ammunition.' });
  });

  it('rejects mortar bombs on other roles', () => {
    const { sim, officer } = fixture(), saved = sim.snapshot(); saved.units.find((unit) => unit.id === officer.id)!.mortarBombs = 1;
    expect(validateSnapshot(JSON.parse(JSON.stringify(saved)))).toMatchObject({ error: 'Corrupt mortar ammunition.' });
  });
});
