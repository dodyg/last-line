import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(42, false, 2);
  data.kinds.fill(0); data.terrain.blocked.fill(0);
  data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.terrain.elevation = undefined; data.buildings = [];
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(42, undefined, data, false);
  sim.state.points = 1000;
  sim.state.scheduler.prepTicksLeft = 100_000;
  const soldier = sim.state.units[0]!;
  const withdraw = () => sim.command({ type: 'withdraw', unitId: soldier.id });
  return { sim, soldier, withdraw };
}

describe('soldier withdrawal', () => {
  it('frees a full squad slot immediately without refund or casualty, and survives saving', () => {
    const { sim, soldier, withdraw } = fixture();
    const recruit = () => sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 200, y: CONFIG.deploymentZone.yMin + 24 } });
    while (sim.state.units.length < CONFIG.caps.friendly) expect(recruit().ok).toBe(true);
    expect(recruit().ok).toBe(false);
    const points = sim.state.points;
    expect(withdraw()).toEqual({ ok: true });
    expect(sim.state.points).toBe(points);
    expect(soldier.dead).toBe(false);
    expect(soldier.health).toBeGreaterThan(0);
    expect(sim.state.units.some((u) => u.id === soldier.id)).toBe(false);
    expect(sim.state.crossedUnits.some((u) => u.id === soldier.id)).toBe(false);
    expect(recruit().ok).toBe(true);
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.state.units.some((u) => u.id === soldier.id)).toBe(false);
    expect(restored.state.units).toHaveLength(CONFIG.caps.friendly);
  });

  it('clears treatment, supply, and targeting references to the withdrawn soldier', () => {
    const { sim, soldier, withdraw } = fixture();
    const medic = sim.state.units[1]!;
    medic.medicalTargetId = soldier.id;
    medic.targetId = soldier.id;
    sim.state.medicalQueue = [soldier.id];
    sim.state.grenadeSupplyQueue = [soldier.id];
    expect(withdraw().ok).toBe(true);
    expect(medic.medicalTargetId).toBeUndefined();
    expect(medic.targetId).toBeNull();
    expect(sim.state.medicalQueue).toEqual([]);
    expect(sim.state.grenadeSupplyQueue).toEqual([]);
    expect(withdraw().ok).toBe(false);
  });

  it.each(['paused', 'over', 'enemy', 'dead', 'crossed', 'last'] as const)('rejects withdrawal when %s without mutation', (condition) => {
    const { sim, soldier, withdraw } = fixture();
    if (condition === 'paused') sim.paused = true;
    if (condition === 'over') sim.state.phase = 'defeat';
    if (condition === 'enemy') soldier.team = 'enemy';
    if (condition === 'dead') soldier.dead = true;
    if (condition === 'crossed') soldier.crossed = true;
    if (condition === 'last') sim.state.units = [soldier];
    const before = sim.snapshot();
    expect(withdraw().ok).toBe(false);
    expect(sim.snapshot()).toEqual(before);
  });
});
