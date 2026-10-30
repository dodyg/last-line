import { describe, expect, it } from 'vitest';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, rebuildBlocked, TERRAIN_KIND } from '../src/simulation/terrain';
import { fenceDemolitionError } from '../src/simulation/fence-demolition';

function fixture(kind: number = TERRAIN_KIND.woodFence) {
  const data = generateTerrain(2026, false, 4);
  const sim = new Simulation(2026, undefined, data, false);
  const cell = 20 * data.terrain.cols + 10;
  const pos = { x: 10.5 * data.terrain.cell, y: 20.5 * data.terrain.cell };
  data.kinds[cell] = kind;
  data.terrain.blocked[cell] = 1;
  data.terrain.baseBlocked![cell] = 1;
  const engineer = sim.state.units[0]!;
  engineer.role = 'engineer'; engineer.pos = { x: pos.x - 24, y: pos.y };
  const demolish = () => sim.command({ type: 'demolishFence', unitId: engineer.id, pos });
  return { sim, data, cell, pos, engineer, demolish };
}

describe('combat engineer fence demolition', () => {
  it.each([TERRAIN_KIND.woodFence, TERRAIN_KIND.stoneFence])('opens a persistent gap in fence kind %s', (kind) => {
    const { sim, data, cell, demolish } = fixture(kind);
    const points = sim.state.points;
    expect(demolish()).toEqual({ ok: true });
    expect(data.kinds[cell]).toBe(TERRAIN_KIND.open);
    expect(data.terrain.blocked[cell]).toBe(0);
    expect(sim.state.points).toBe(points);
    rebuildBlocked(data.terrain, sim.state.buildings);
    expect(data.terrain.blocked[cell]).toBe(0);
    expect(sim.step()).toContainEqual(expect.objectContaining({ type: 'fenceDemolished', cell }));
    expect(demolish().ok).toBe(false);
    const validated = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in validated) throw new Error(validated.error);
    const restored = Simulation.fromSnapshot(validated.snap);
    expect(restored.state.terrain.kinds![cell]).toBe(TERRAIN_KIND.open);
    expect(restored.state.terrain.blocked[cell]).toBe(0);
    expect(restored.terrainData().kinds[cell]).toBe(TERRAIN_KIND.open);
    expect(restored.snapshot().demolishedFenceCells).toEqual([cell]);
  });

  it.each(['rifleman', 'enemy', 'pinned', 'dead', 'crossed', 'busy', 'distant', 'paused', 'over', 'building'] as const)('rejects %s without changing the fence', (condition) => {
    const { sim, data, cell, engineer, demolish } = fixture();
    if (condition === 'rifleman') engineer.role = 'rifleman';
    if (condition === 'enemy') engineer.team = 'enemy';
    if (condition === 'pinned') engineer.pinned = true;
    if (condition === 'dead') engineer.dead = true;
    if (condition === 'crossed') engineer.crossed = true;
    if (condition === 'busy') engineer.upgradeTimer = 10;
    if (condition === 'distant') engineer.pos.x -= 200;
    if (condition === 'paused') sim.paused = true;
    if (condition === 'over') sim.state.phase = 'defeat';
    if (condition === 'building') engineer.buildingOrder = { buildingId: 1, level: 0, slot: 0, climbTicks: 1 };
    const before = sim.snapshot();
    expect(demolish().ok).toBe(false);
    expect(data.terrain.blocked[cell]).toBe(1);
    expect(sim.snapshot()).toEqual(before);
  });

  it('rejects other terrain and invalid coordinates', () => {
    const { sim, data, cell, engineer, pos } = fixture(TERRAIN_KIND.rocks);
    expect(fenceDemolitionError(sim.state, engineer, pos)).toContain('fence section');
    for (const x of [NaN, Infinity, -1, 1e6]) expect(sim.command({ type: 'demolishFence', unitId: engineer.id, pos: { x, y: pos.y } }).ok).toBe(false);
    expect(data.terrain.blocked[cell]).toBe(1);
  });
});
