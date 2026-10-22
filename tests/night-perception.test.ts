import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, TERRAIN_KIND } from '../src/simulation/terrain';
import { contactBearing, nightContactFor, recordNightGunfire } from '../src/simulation/perception';

function fixture(distance = 240) {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  const friendly = sim.state.units[0]!;
  friendly.pos = { x: 300, y: 500 }; friendly.prevPos = { ...friendly.pos };
  sim.state.units = [friendly];
  sim.spawnEnemy('rifle', { x: 300, y: 500 - distance });
  const enemy = sim.state.units.at(-1)!;
  for (const unit of sim.state.units) { unit.reloadTimer = 100_000; unit.grenades = 0; unit.health = 1000; }
  sim.state.ticks = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate / 2;
  sim.state.dayNightStartTick = 0; sim.state.wavesCompleted = 3;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  sim.state.scheduler.prepTicksLeft = 100_000;
  return { sim, friendly, enemy, data, hear: () => recordNightGunfire(sim.state, enemy, data.kinds, sim.weaponOf(enemy)!) };
}

describe('night gunfire perception', () => {
  it('keeps contacts personal to soldiers close enough to perceive the shot', () => {
    const { sim, friendly, hear } = fixture();
    const far = structuredClone(friendly); far.id = sim.state.nextEntityId++;
    far.pos = { x: 900, y: 650 }; far.prevPos = { ...far.pos };
    sim.state.units.push(far);
    hear(); expect(friendly.nightContacts).toHaveLength(1); expect(far.nightContacts).toBeUndefined();
  });

  it('resumes the same detection and expiry after a save without changing random outcomes', () => {
    const sim = new Simulation(2026);
    const friendly = sim.state.units[0]!;
    sim.state.units = [friendly]; friendly.pos = { x: 36, y: 600 }; friendly.prevPos = { ...friendly.pos };
    sim.spawnEnemy('rifle', { x: 36, y: 360 });
    const enemy = sim.state.units.at(-1)!;
    for (const unit of sim.state.units) { unit.reloadTimer = 100_000; unit.grenades = 0; }
    sim.state.ticks = 4500; sim.state.dayNightStartTick = 0; sim.state.wavesCompleted = 3;
    sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000; sim.state.scheduler.prepTicksLeft = 100_000;
    sim.fireShot(enemy, friendly, sim.weaponOf(enemy)!);
    sim.step(); // Drain the shot event before comparing resumed tick events.
    const valid = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in valid) throw new Error(valid.error);
    const resumed = Simulation.fromSnapshot(valid.snap);
    for (let tick = 0; tick < 100; tick++) expect(resumed.step()).toEqual(sim.step());
    expect(resumed.snapshot()).toEqual(sim.snapshot());
  });

  it('investigates the last heard position instead of following a hidden moving soldier', () => {
    const { sim, friendly, enemy, data } = fixture();
    for (let col = 11; col <= 13; col++) {
      const index = 15 * sim.state.terrain.cols + col;
      sim.state.terrain.blocked[index] = 1; data.kinds[index] = TERRAIN_KIND.obstacle;
    }
    recordNightGunfire(sim.state, friendly, data.kinds, sim.weaponOf(friendly)!);
    expect(enemy.nightContacts?.[0]?.kind).toBe('sound');
    const heard = { ...friendly.pos };
    friendly.pos.x += 150; friendly.prevPos = { ...friendly.pos };
    sim.step();
    expect(enemy.targetId).toBeNull();
    expect(enemy.moveGoal!.x).toBeCloseTo(heard.x);
    expect(Math.abs(enemy.moveGoal!.y - heard.y)).toBeLessThan(sim.state.terrain.cell);
    sim.state.ticks = enemy.nightContacts![0]!.expiresTick - 1;
    sim.step();
    expect(enemy.nightContacts).toBeUndefined();
    expect(enemy.moveGoal!.y).toBeGreaterThan(CONFIG.breakthroughY);
  });

  it.each(['friendly', 'enemy'] as const)('lets %s infantry locate a firing enemy beyond ordinary night sight', (team) => {
    const { sim, friendly, enemy } = fixture();
    const observer = team === 'friendly' ? friendly : enemy, source = team === 'friendly' ? enemy : friendly;
    sim.step(); expect(observer.targetId).toBeNull();
    sim.fireShot(source, observer, sim.weaponOf(source)!);
    expect(observer.nightContacts?.[0]).toMatchObject({ sourceId: source.id, kind: 'muzzleFlash', pos: source.pos });
    sim.step(); expect(observer.targetId).toBe(source.id);
  });

  it('lets a distant tracer reveal a shooter to a sniper without extending weapon range', () => {
    const { sim, friendly, enemy, hear } = fixture(350);
    friendly.role = 'sniper';
    sim.step(); expect(friendly.targetId).toBeNull();
    hear(); expect(friendly.nightContacts?.[0]?.kind).toBe('tracer');
    sim.step(); expect(friendly.targetId).toBe(enemy.id);
    friendly.role = 'rifleman'; friendly.targetId = null;
    sim.step(); expect(friendly.targetId).toBeNull();
  });

  it('uses sound in thick fog when no flash or tracer is visible', () => {
    const { sim, friendly, enemy, hear } = fixture();
    sim.state.weather = 'heavyFog';
    sim.step(); expect(friendly.targetId).toBeNull();
    hear(); expect(friendly.nightContacts?.[0]?.kind).toBe('sound');
    expect(contactBearing(friendly.pos, friendly.nightContacts![0]!.pos)).toBe('North');
    sim.step(); expect(friendly.targetId).toBe(enemy.id);
  });

  it.each(['wall', 'smoke', 'ridge'] as const)('hears fire through %s without acquiring a rifle target through it', (obstacle) => {
    const { sim, friendly, enemy, data, hear } = fixture();
    if (obstacle === 'wall') {
      for (let col = 0; col < sim.state.terrain.cols; col++) {
        const index = 15 * sim.state.terrain.cols + col;
        sim.state.terrain.blocked[index] = 1; data.kinds[index] = TERRAIN_KIND.obstacle;
      }
    } else if (obstacle === 'smoke') {
      sim.state.smokes.push({ id: sim.state.nextEntityId++, pos: { x: 300, y: 380 }, radius: 40, ticksRemaining: 1000 });
    } else {
      const terrain = sim.state.terrain, cols = terrain.cols + 1, rows = terrain.rows + 1;
      terrain.elevation = { cell: terrain.cell, cols, rows, heights: Float32Array.from({ length: cols * rows }, (_, i) => Math.abs(Math.floor(i / cols) * terrain.cell - 380) < 40 ? 80 : 0) };
    }
    hear(); expect(friendly.nightContacts?.[0]).toMatchObject({ sourceId: enemy.id, kind: 'sound' });
    sim.step(); expect(friendly.targetId).toBeNull();
  });

  it('masks distant gunfire with heavy rain', () => {
    const { sim, friendly, hear } = fixture(300);
    sim.state.weather = 'heavyRain';
    hear(); expect(friendly.nightContacts).toBeUndefined();
  });

  it('loses precise contact when the shooter moves away from its last-known position', () => {
    const { sim, friendly, enemy, hear } = fixture();
    hear(); const position = { ...friendly.nightContacts![0]!.pos };
    expect(nightContactFor(sim.state, friendly, enemy)).toBeDefined();
    enemy.pos.x += CONFIG.dayNight.gunfire.trackRadius + 1;
    expect(nightContactFor(sim.state, friendly, enemy)).toBeUndefined();
    sim.step(); expect(friendly.targetId).toBeNull();
    expect(friendly.nightContacts![0]!.pos).toEqual(position);
  });

  it('drops contact after silence and removes it at daylight', () => {
    const { sim, friendly, hear } = fixture();
    hear(); sim.step(); expect(friendly.targetId).not.toBeNull();
    sim.state.ticks = friendly.nightContacts![0]!.expiresTick - 1;
    sim.step(); expect(friendly.nightContacts).toBeUndefined(); expect(friendly.targetId).toBeNull();
    hear(); sim.state.ticks = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate;
    sim.step(); expect(friendly.nightContacts).toBeUndefined();
    hear(); expect(friendly.nightContacts).toBeUndefined();
  });

  it('firing reveals camouflaged soldiers to listeners', () => {
    const { sim, friendly, enemy, data } = fixture();
    friendly.specialization = 'camouflage';
    sim.step(); expect(enemy.targetId).toBeNull();
    recordNightGunfire(sim.state, friendly, data.kinds, sim.weaponOf(friendly)!);
    sim.step(); expect(enemy.targetId).toBe(friendly.id);
  });

  it('saves personal contacts without sharing mutable positions and rejects corrupt memories', () => {
    const { sim, friendly, hear } = fixture();
    hear(); const snapshot = sim.snapshot();
    friendly.nightContacts![0]!.pos.x++;
    expect(snapshot.units[0]!.nightContacts![0]!.pos.x).not.toBe(friendly.nightContacts![0]!.pos.x);
    const valid = validateSnapshot(JSON.parse(JSON.stringify(snapshot)));
    if ('error' in valid) throw new Error(valid.error);
    expect(Simulation.fromSnapshot(valid.snap).state.units[0]!.nightContacts).toEqual(snapshot.units[0]!.nightContacts);
    const bad = structuredClone(snapshot); bad.units[0]!.nightContacts![0]!.expiresTick = Infinity;
    expect(validateSnapshot(bad)).toHaveProperty('error');
    const old = structuredClone(snapshot); for (const unit of old.units) delete unit.nightContacts;
    expect(validateSnapshot(old)).toHaveProperty('snap');
  });
});
