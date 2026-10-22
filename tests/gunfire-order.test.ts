import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { recordNightGunfire } from '../src/simulation/perception';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, TERRAIN_KIND } from '../src/simulation/terrain';
import { fireOrdersForRole, type Unit } from '../src/simulation/types';

function fixture(night = false) {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false), unit = sim.state.units[0]!;
  sim.state.units = [unit]; unit.pos = { x: 300, y: 612 }; unit.prevPos = { ...unit.pos };
  unit.grenades = 0; unit.reloadTimer = 100_000; unit.morale = 100;
  sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  if (night) { sim.state.ticks = 4500; sim.state.dayNightStartTick = 0; sim.state.wavesCompleted = 3; }
  const enemy = (x: number, y: number) => {
    sim.spawnEnemy('rifle', { x, y });
    const source = sim.state.units.at(-1)!; source.grenades = 0; source.reloadTimer = 100_000;
    source.buildingCooldown = 100_000;
    return source;
  };
  const hear = (source: Unit) => recordNightGunfire(sim.state, source, data.kinds, sim.weaponOf(source)!);
  const order = () => sim.command({ type: 'fireOrder', unitIds: [unit.id], order: 'seekGunfire' });
  const tick = (n: number) => { for (let i = 0; i < n; i++) sim.step(); };
  return { sim, unit, data, enemy, hear, order, tick };
}

describe('run to gunfire fire order', () => {
  it.each([false, true])('runs toward the nearest personal audible shot, night=%s', (night) => {
    const { sim, unit, enemy, hear, order } = fixture(night);
    const near = enemy(300, 360), far = enemy(600, 612);
    hear(near); hear(far); // Latest is deliberately farther away.
    expect(order().ok).toBe(true);
    sim.state.units = [unit]; sim.step();
    expect(unit.gunfirePursuit?.sourceId).toBe(near.id);
    expect(unit.moveGoal).toEqual({ x: 300, y: 372 });
    expect(unit.pos.y).toBeLessThan(612); expect(unit.running).toBe(true);
    expect(unit.stamina).toBeLessThan(1);
    if (!night) expect(unit.nightContacts).toBeUndefined();
  });

  it('ignores friendly shots and enemies outside weather-adjusted hearing', () => {
    const { sim, unit, enemy, hear } = fixture();
    hear(unit); expect(unit.heardGunfire).toBeUndefined();
    const far = enemy(900, 612); hear(far); expect(unit.heardGunfire).toBeUndefined();
    const source = enemy(580, 612); sim.state.weather = 'heavyRain'; hear(source);
    expect(unit.heardGunfire).toBeUndefined();
    sim.state.weather = 'clear'; hear(source);
    expect(unit.heardGunfire?.[0]?.sourceId).toBe(source.id);
  });

  it('runs to a last-heard position without tracking a hidden moving enemy', () => {
    const { sim, unit, data, enemy, hear, order } = fixture();
    const source = enemy(300, 360);
    for (let col = 10; col <= 14; col++) {
      const index = 20 * data.terrain.cols + col;
      data.terrain.blocked[index] = 1; data.kinds[index] = TERRAIN_KIND.obstacle;
    }
    hear(source); source.pos = { x: 850, y: 360 }; source.prevPos = { ...source.pos };
    order(); sim.step();
    expect(unit.targetId).toBeNull(); expect(unit.gunfirePursuit?.pos).toEqual({ x: 300, y: 360 });
    expect(unit.moveGoal!.x).toBe(300); expect(unit.path.length).toBeGreaterThan(0);
    expect(unit.path.some((point) => point.x !== 300)).toBe(true);
  });

  it('stops running and shoots when an enemy can be engaged', () => {
    const { sim, unit, enemy, hear, order } = fixture();
    const source = enemy(300, 300); hear(source); sim.state.units = [unit]; order(); sim.step();
    expect(unit.running).toBe(true);
    const visible = enemy(300, 450); visible.pinned = true; visible.suppression = CONFIG.suppression.max;
    unit.reloadTimer = 0;
    const pos = { ...unit.pos }, events = sim.step();
    expect(unit.pos).toEqual(pos); expect(unit.path).toEqual([]); expect(unit.running).toBe(false);
    expect(unit.targetId).toBe(visible.id);
    expect(events.some((event) => event.type === 'shot' && event.shooterId === unit.id)).toBe(true);
  });

  it('holds while pinned, then resumes the heard route after recovery', () => {
    const { sim, unit, enemy, hear, order } = fixture();
    hear(enemy(300, 360)); sim.state.units = [unit]; order();
    unit.pinned = true; unit.suppression = CONFIG.suppression.max;
    const pos = { ...unit.pos }; sim.step(); expect(unit.pos).toEqual(pos); expect(unit.running).toBe(false);
    unit.suppression = 0; sim.step(); expect(unit.pos.y).toBeLessThan(pos.y); expect(unit.running).toBe(true);
  });

  it('walks after exhaustion instead of restarting an infinite sprint', () => {
    const { sim, unit, enemy, hear, order, tick } = fixture();
    hear(enemy(300, 300)); sim.state.units = [unit]; order();
    unit.stamina = .01; unit.movementPace = 'run'; tick(4);
    expect(unit.stamina).toBeGreaterThanOrEqual(0); expect(unit.running).toBe(false);
    const y = unit.pos.y; tick(30);
    expect(unit.pos.y).toBeLessThan(y); expect(unit.running).toBe(false); expect(unit.stamina).toBeLessThan(.75);
  });

  it('consumes a searched location and waits without pacing back and forth', () => {
    const { sim, unit, enemy, hear, order, tick } = fixture();
    hear(enemy(300, 360)); sim.state.units = [unit]; order(); tick(300);
    expect(unit.gunfirePursuit).toBeUndefined(); expect(unit.path).toEqual([]); expect(unit.moveGoal).toBeNull();
    const pos = { ...unit.pos }; tick(60); expect(unit.pos).toEqual(pos);
    expect(unit.fireOrder).toBe('seekGunfire');
  });

  it('abandons expired sounds and starts again on a fresh shot', () => {
    const { sim, unit, enemy, hear, order } = fixture();
    const source = enemy(300, 360); hear(source); sim.state.units = [unit]; order(); sim.step();
    sim.state.ticks = unit.heardGunfire![0]!.expiresTick - 1; sim.step();
    expect(unit.heardGunfire).toBeUndefined(); expect(unit.path).toEqual([]); expect(unit.gunfirePursuit).toBeUndefined();
    hear(source); sim.step(); expect(unit.gunfirePursuit).toBeDefined(); expect(unit.running).toBe(true);
  });

  it.each(['move', 'patrol', 'auto'] as const)('a direct %s command cancels pursuit without restoring the old route', (command) => {
    const { sim, unit, enemy, hear, order } = fixture();
    hear(enemy(300, 360)); sim.state.units = [unit]; order(); sim.step();
    const result = command === 'move' ? sim.command({ type: 'move', unitId: unit.id, pos: { x: 540, y: 612 } })
      : command === 'patrol' ? sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: 240, y: 552 }, to: { x: 552, y: 696 } })
        : sim.command({ type: 'fireOrder', unitIds: [unit.id], order: 'auto' });
    expect(result.ok).toBe(true); expect(unit.fireOrder).toBe('auto'); expect(unit.gunfirePursuit).toBeUndefined();
    const goal = structuredClone(unit.moveGoal); sim.step(); expect(unit.moveGoal).toEqual(goal);
  });

  it('rejects the order for medics, mortarmen, and vehicles', () => {
    const { unit, order } = fixture();
    for (const role of ['medic', 'mortarman', 'gun_truck', 'vehicle'] as const) {
      unit.role = role; expect(fireOrdersForRole(role)).not.toContain('seekGunfire'); expect(order().ok).toBe(false);
    }
  });

  it('saves hearing, pursuit, and stamina and resumes deterministically', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    sim.state.units = [unit]; unit.pos = { x: 36, y: 600 }; unit.prevPos = { ...unit.pos }; unit.grenades = 0;
    sim.state.scheduler.prepTicksLeft = 100_000; sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
    sim.spawnEnemy('rifle', { x: 36, y: 300 }); const source = sim.state.units.at(-1)!;
    sim.fireShot(source, unit, sim.weaponOf(source)!); sim.state.units = [unit];
    expect(sim.command({ type: 'fireOrder', unitIds: [unit.id], order: 'seekGunfire' }).ok).toBe(true); sim.step();
    const snapshot = JSON.parse(JSON.stringify(sim.snapshot())), valid = validateSnapshot(snapshot);
    if ('error' in valid) throw new Error(valid.error);
    expect(valid.snap.units[0]!.gunfirePursuit).toBeDefined();
    const resumed = Simulation.fromSnapshot(valid.snap);
    for (let i = 0; i < 100; i++) expect(resumed.step()).toEqual(sim.step());
    expect(resumed.snapshot()).toEqual(sim.snapshot());
    snapshot.units[0].gunfirePursuit.pos.x = 'broken'; expect(validateSnapshot(snapshot)).toHaveProperty('error');
  });
});
