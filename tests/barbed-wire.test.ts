import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation, sec } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import { wireContains } from '../src/simulation/barbed-wire';
import { buildSpawnQueue } from '../src/simulation/waves';
import { getContent } from '../src/content/validate';
import { deriveRng } from '../src/simulation/rng';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.kinds.fill(0); data.terrain.elevation?.heights.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  data.terrain.bridges = [];
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = []; sim.state.points = 100;
  sim.state.scheduler.prepTicksLeft = 100_000;
  const engineer = sim.spawnFriendly('engineer', { x: 492, y: 612 });
  engineer.reloadTimer = 100_000; engineer.grenades = 0;
  const pos = { x: 492, y: 564 };
  const build = () => sim.command({ type: 'barbedWire', pos });
  const tick = (n: number) => Array.from({ length: n }, () => sim.step()).flat();
  const wire = () => {
    sim.state.barbedWire.push({ id: sim.state.nextEntityId++, pos: { ...pos }, cutTicks: 0 });
    return sim.state.barbedWire.at(-1)!;
  };
  return { sim, engineer, pos, build, tick, wire };
}

describe('barbed wire and breach lanes', () => {
  it('builds after four seconds, charges once, and gives engineering service credit', () => {
    const { sim, engineer, pos, build, tick } = fixture();
    expect(sim.validatePlacement('barbedWire', pos).ok).toBe(true);
    expect(build()).toEqual({ ok: true });
    expect(sim.state.points).toBe(96);
    expect(sim.state.barbedWire).toEqual([]);
    expect(tick(sec(4) - 1).some((e) => e.type === 'constructionCompleted')).toBe(false);
    expect(tick(1)).toContainEqual({ type: 'constructionCompleted', kind: 'barbedWire', pos });
    expect(sim.state.barbedWire).toHaveLength(1);
    expect(engineer.service.fortificationsBuilt).toBe(1);
    expect(engineer.xp).toBe(1);
    expect(build().ok).toBe(false);
    expect(sim.state.points).toBe(96);
  });

  it.each(['no engineer', 'poor', 'far', 'pinned', 'busy', 'bounds', 'nan', 'blocked end', 'overlap', 'paused'] as const)('rejects %s without spending points', (condition) => {
    const { sim, engineer, pos, build, wire } = fixture();
    if (condition === 'no engineer') engineer.role = 'rifleman';
    if (condition === 'poor') sim.state.points = 3;
    if (condition === 'far') engineer.pos.y = 700;
    if (condition === 'pinned') engineer.pinned = true;
    if (condition === 'busy') sim.state.constructionSites.push({ id: 900, kind: 'sandbag', pos, builderId: engineer.id, ticksRemaining: 30, totalTicks: 30 });
    if (condition === 'bounds') pos.x = 12;
    if (condition === 'nan') pos.x = NaN;
    if (condition === 'blocked end') sim.state.terrain.blocked[Math.floor(pos.y / 24) * sim.state.terrain.cols + Math.floor((pos.x + 36) / 24)] = 1;
    if (condition === 'overlap') wire();
    if (condition === 'paused') sim.paused = true;
    const before = sim.snapshot();
    expect(build().ok).toBe(false);
    expect(sim.snapshot()).toEqual(before);
  });

  it('pauses unfinished work, survives Continue, and refunds when all engineers die', () => {
    const { sim, engineer, build, tick } = fixture();
    build(); tick(30); engineer.pos.y = 710; tick(30);
    expect(sim.state.constructionSites[0]!.ticksRemaining).toBe(90);
    const restored = Simulation.fromSnapshot(sim.snapshot());
    expect(restored.state.constructionSites[0]!.ticksRemaining).toBe(90);
    sim.paused = true; tick(30);
    expect(sim.state.constructionSites[0]!.ticksRemaining).toBe(90);
    sim.paused = false; engineer.health = 0; engineer.dead = true; tick(1);
    expect(sim.state.constructionSites).toEqual([]);
    expect(sim.state.points).toBe(100);
  });

  it('slows both armies and every infantry role while vehicles and gaps remain unaffected', () => {
    const { sim, wire, pos } = fixture(); wire();
    for (const role of Object.keys(getContent().friendly)) {
      const unit = sim.spawnFriendly(role as Parameters<Simulation['spawnFriendly']>[0], { ...pos });
      const baseline = sim.terrainEffectsFor({ ...unit, pos: { x: pos.x, y: pos.y - 24 } });
      expect(sim.terrainEffectsFor(unit).speedMult / baseline.speedMult).toBeCloseTo(role === 'gun_truck' ? 1 : .3);
    }
    for (const role of Object.keys(getContent().enemy)) {
      sim.spawnEnemy(role as Parameters<Simulation['spawnEnemy']>[0], { ...pos });
      const unit = sim.state.units.at(-1)!;
      const baseline = sim.terrainEffectsFor({ ...unit, pos: { x: pos.x, y: pos.y - 24 } });
      expect(sim.terrainEffectsFor(unit).speedMult / baseline.speedMult).toBeCloseTo(['vehicle', 'gun_truck', 'troop_transport'].includes(role) ? 1 : .3);
    }
    const friendly = sim.state.units[0]!;
    friendly.pos = { x: pos.x + 60, y: pos.y };
    expect(sim.terrainEffectsFor(friendly).speedMult).toBe(1);
  });

  it('routes infantry through a nearby gap while tanks keep their direct route', () => {
    const { sim, engineer, wire, pos } = fixture(); wire();
    engineer.pos = { x: pos.x, y: pos.y + 100 };
    expect(sim.command({ type: 'move', unitId: engineer.id, pos: { x: pos.x, y: pos.y - 100 } }).ok).toBe(true);
    expect(engineer.path.some((point) => Math.abs(point.y - pos.y) <= 12 && Math.abs(point.x - pos.x) > 48), JSON.stringify(engineer.path)).toBe(true);
    sim.spawnEnemy('vehicle', { x: pos.x, y: pos.y - 100 });
    const tank = sim.state.units.at(-1)!;
    expect(tank.path.some((point) => Math.abs(point.y - pos.y) <= 12 && Math.abs(point.x - pos.x) > 48)).toBe(false);
  });

  it('actually crosses continuous wire slowly without making it an impassable wall', () => {
    const { engineer, wire, pos, tick } = fixture(); wire();
    engineer.pos = { x: pos.x, y: pos.y - 4 }; engineer.prevPos = { ...engineer.pos };
    engineer.path = [{ x: pos.x, y: pos.y + 4 }]; engineer.moveGoal = { x: pos.x, y: pos.y + 4 };
    const startY = engineer.pos.y;
    tick(1);
    const baseline = fixture(); baseline.engineer.pos = { x: pos.x, y: startY }; baseline.engineer.prevPos = { ...baseline.engineer.pos };
    baseline.engineer.path = [{ x: pos.x, y: pos.y + 4 }]; baseline.engineer.moveGoal = { x: pos.x, y: pos.y + 4 };
    baseline.tick(1);
    expect((engineer.pos.y - startY) / (baseline.engineer.pos.y - startY)).toBeCloseTo(.3);
    tick(60);
    expect(engineer.pos.y).toBeGreaterThanOrEqual(pos.y + 4);
  });

  it('approaches and cuts a segment exactly once, opening a lane without shooting', () => {
    const { sim, wire, pos, tick, engineer } = fixture(); const segment = wire();
    engineer.pos = { x: 900, y: 700 };
    sim.spawnEnemy('sapper', { x: pos.x, y: pos.y - 70 });
    const sapper = sim.state.units.at(-1)!;
    const events = tick(sec(14));
    expect(sim.state.barbedWire).toEqual([]);
    expect(events.filter((event) => event.type === 'wireCutStarted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'wireBreached')).toEqual([{ type: 'wireBreached', unitId: sapper.id, wireId: segment.id, pos }]);
    expect(events.some((event) => event.type === 'shot' && event.shooterId === sapper.id)).toBe(false);
    expect(sapper.pos.y).toBeGreaterThan(pos.y - 20);
  });

  it('pinning, pausing, or killing cutters preserves progress and allows another engineer to finish', () => {
    const { sim, wire, pos, tick } = fixture(); const segment = wire();
    sim.spawnEnemy('sapper', { x: pos.x, y: pos.y - 18 });
    const sapper = sim.state.units.at(-1)!; sapper.reloadTimer = 100_000;
    tick(30); expect(segment.cutTicks).toBe(30);
    sapper.pinned = true; sapper.suppression = 100; tick(10);
    expect(segment.cutTicks).toBe(30);
    sim.paused = true; tick(30); expect(segment.cutTicks).toBe(30); sim.paused = false;
    sapper.health = 0; sapper.dead = true; tick(10); expect(segment.cutTicks).toBe(30);
    sim.spawnEnemy('sapper', { x: pos.x, y: pos.y - 18 });
    tick(sec(6) - 31); expect(sim.state.barbedWire).toHaveLength(1);
    expect(tick(1).filter((e) => e.type === 'wireBreached')).toHaveLength(1);
  });

  it('counts a breakthrough even when an engineer is heading for wire beyond the line', () => {
    const { sim, wire, pos, tick, engineer } = fixture();
    pos.y = 700; wire(); engineer.pos = { x: 900, y: 600 };
    sim.spawnEnemy('sapper', { x: pos.x, y: CONFIG.breakthroughY - 1 });
    const id = sim.state.units.at(-1)!.id;
    expect(tick(30).filter((e) => e.type === 'breakthrough' && e.unitId === id)).toHaveLength(1);
    expect(sim.state.integrity).toBe(CONFIG.start.integrity - 1);
    expect(sim.state.units.some((unit) => unit.id === id)).toBe(false);
  });

  it('saves partial cutting progress, resumes in lockstep, and migrates old saves', () => {
    const { sim, wire, pos, tick } = fixture(); wire();
    sim.spawnEnemy('sapper', { x: pos.x, y: pos.y - 18 }); tick(60);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.barbedWire[0]!.cutTicks).toBe(60);
    for (let i = 0; i < 120; i++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
    const old = sim.snapshot(); old.schemaVersion = 27; delete old.barbedWire;
    const migrated = validateSnapshot(old);
    if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.schemaVersion).toBe(30);
    expect(migrated.snap.barbedWire).toEqual([]);
  });

  it('rejects corrupt wire geometry, ids, lists, and cutting progress', () => {
    const { sim, wire } = fixture(); wire();
    for (const change of [{ cutTicks: -1 }, { cutTicks: 180 }, { cutTicks: .5 }, { cutTicks: NaN }, { id: .5 }, { pos: { x: 0, y: 500 } }]) {
      const snap = sim.snapshot(); Object.assign(snap.barbedWire![0]!, change);
      expect('error' in validateSnapshot(snap)).toBe(true);
    }
    const duplicate = sim.snapshot(); duplicate.barbedWire!.push({ ...duplicate.barbedWire![0]! });
    expect('error' in validateSnapshot(duplicate)).toBe(true);
  });

  it('leaves wire and construction behind when marching to a new map', () => {
    const { sim, engineer, wire, tick, build, pos } = fixture(); wire();
    expect(wireContains(sim.state.barbedWire[0]!, engineer.pos)).toBe(false);
    pos.x += 120; engineer.pos.x += 60;
    expect(build().ok).toBe(true);
    engineer.pos.y = CONFIG.crossing.thresholdY; tick(1);
    expect(sim.state.mapNumber).toBe(2); expect(sim.state.barbedWire).toEqual([]);
    expect(sim.state.constructionSites).toEqual([]);
  });

  it('introduces enemy engineers in wave five and keeps them in endless waves', () => {
    const { sim } = fixture();
    sim.state.scheduler.waveIndex = 4;
    const fifth = buildSpawnQueue(deriveRng(1, 2), sim.state.scheduler, false);
    expect(fifth.queue).toContain('sapper'); expect(fifth.queue).toHaveLength(10);
    sim.state.scheduler.waveIndex = 15;
    expect(buildSpawnQueue(deriveRng(1, 2), sim.state.scheduler, true).queue).toContain('sapper');
  });
});
