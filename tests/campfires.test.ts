import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { campfireError } from '../src/simulation/campfires';
import { Simulation, sec } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import type { FriendlyRole } from '../src/simulation/types';

function fixture(role: FriendlyRole = 'rifleman') {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = [];
  const soldier = sim.spawnFriendly(role, { x: 300, y: 500 });
  soldier.grenades = 0; soldier.reloadTimer = 100_000;
  sim.state.ticks = sec(CONFIG.dayNight.cycleSeconds / 2);
  sim.state.dayNightStartTick = 0; sim.state.wavesCompleted = 3;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.state.scheduler.prepTicksLeft = 100_000;
  return { sim, soldier, light: () => sim.command({ type: 'lightFire', unitId: soldier.id }) };
}

describe('small fires at night', () => {
  it.each(['rifleman', 'mg', 'medic', 'at', 'sniper', 'engineer', 'radio_engineer', 'officer', 'mortarman'] as const)('lets a %s light a free fire at their position', (role) => {
    const { sim, soldier, light } = fixture(role);
    sim.state.points = 0;
    expect(light()).toEqual({ ok: true });
    expect(sim.state.points).toBe(0);
    expect(sim.state.campfires[0]).toMatchObject({ unitId: soldier.id, pos: soldier.pos, radius: 70, ticksRemaining: sec(60) });
    expect(sim.step()).toContainEqual({ type: 'campfireLit', unitId: soldier.id, pos: soldier.pos });
  });

  it.each(['day', 'pinned', 'dead', 'crossed', 'vehicle', 'enemy', 'indoors', 'paused', 'duplicate'] as const)('rejects %s without changing state', (condition) => {
    const { sim, soldier, light } = fixture();
    if (condition === 'day') sim.state.dayNightStartTick = null;
    if (condition === 'pinned') soldier.pinned = true;
    if (condition === 'dead') soldier.dead = true;
    if (condition === 'crossed') soldier.crossed = true;
    if (condition === 'vehicle') soldier.role = 'gun_truck';
    if (condition === 'enemy') soldier.team = 'enemy';
    if (condition === 'indoors') soldier.buildingOrder = { buildingId: 1, level: 0, slot: 0, climbTicks: 0 };
    if (condition === 'paused') sim.paused = true;
    if (condition === 'duplicate') expect(light().ok).toBe(true);
    const before = sim.snapshot();
    expect(light().ok).toBe(false);
    expect(sim.snapshot()).toEqual(before);
  });

  it('leaves fires at their original position, expires them, and lets the soldier relight', () => {
    const { sim, soldier, light } = fixture();
    expect(light().ok).toBe(true);
    const original = { ...soldier.pos };
    soldier.pos.x += 100;
    expect(sim.state.campfires[0]!.pos).toEqual(original);
    expect(campfireError(sim.state, soldier)).toContain('already');
    sim.state.campfires[0]!.ticksRemaining = 1;
    sim.step();
    expect(sim.state.campfires).toEqual([]);
    expect(light().ok).toBe(true);
    sim.state.ticks = sec(CONFIG.dayNight.cycleSeconds);
    sim.step();
    expect(sim.state.campfires).toEqual([]);
  });

  it('leaves fires behind when the squad enters a new map', () => {
    const { sim, soldier, light } = fixture();
    expect(light().ok).toBe(true);
    soldier.pos.y = CONFIG.crossing.thresholdY;
    sim.step();
    expect(sim.state.mapNumber).toBe(2);
    expect(sim.state.campfires).toEqual([]);
  });

  it.each(['friendly', 'enemy'] as const)('helps %s soldiers see an enemy illuminated by a fire', (team) => {
    const { sim, soldier, light } = fixture();
    sim.spawnEnemy('rifle', { x: 300, y: 260 });
    const enemy = sim.state.units.at(-1)!;
    enemy.reloadTimer = 100_000; enemy.grenades = 0;
    const observer = team === 'friendly' ? soldier : enemy;
    const target = team === 'friendly' ? enemy : soldier;
    sim.step();
    expect(observer.targetId).toBeNull();
    // Move the fire lighter to the target, then return to the original position.
    const original = { ...soldier.pos };
    soldier.pos = { ...target.pos };
    expect(light().ok).toBe(true);
    soldier.pos = original;
    sim.step();
    expect(observer.targetId).toBe(target.id);
    expect(sim.state.flares).toEqual([]);
  });

  it('preserves burning fires through a validated save and resumes the same expiry', () => {
    const { sim, light } = fixture();
    light(); sim.step();
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.snapshot()).toEqual(sim.snapshot());
    for (let tick = 0; tick < 10; tick++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
    restored.state.campfires[0]!.pos.x++;
    expect(restored.state.campfires[0]!.pos).not.toEqual(saved.snap.campfires![0]!.pos);
  });

  it('loads older saves without fires and rejects corrupt or duplicate fires', () => {
    const { sim, light } = fixture();
    const old = sim.snapshot(); delete old.campfires;
    const loaded = validateSnapshot(JSON.parse(JSON.stringify(old)));
    if ('error' in loaded) throw new Error(loaded.error);
    expect(Simulation.fromSnapshot(loaded.snap).state.campfires).toEqual([]);
    light();
    for (const change of [{ radius: 999 }, { ticksRemaining: 0 }, { unitId: -1 }, { pos: { x: Infinity, y: 0 } }]) {
      const bad = sim.snapshot(); Object.assign(bad.campfires![0]!, change);
      expect('error' in validateSnapshot(bad)).toBe(true);
    }
    const duplicate = sim.snapshot(); duplicate.campfires!.push({ ...duplicate.campfires![0]!, id: 999 });
    expect('error' in validateSnapshot(duplicate)).toBe(true);
  });
});
