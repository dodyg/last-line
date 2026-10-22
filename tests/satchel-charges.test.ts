import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation, sec } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture() {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = [];
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.points = 100;
  const engineer = sim.spawnFriendly('engineer', { x: 300, y: 500 });
  engineer.grenades = 0; engineer.reloadTimer = 100_000;
  const pos = { x: 324, y: 500 };
  const plant = () => sim.command({ type: 'satchel', unitId: engineer.id, pos });
  const tick = (n: number) => Array.from({ length: n }, () => sim.step()).flat();
  return { sim, engineer, pos, plant, tick };
}

describe('combat engineer satchel charges', () => {
  it('detonates once, exactly 10 simulation seconds after planting, with no contact trigger', () => {
    const { sim, engineer, pos, plant, tick } = fixture();
    expect(plant()).toEqual({ ok: true });
    expect(sim.state.points).toBe(100 - CONFIG.satchel.cost);
    expect(sim.state.satchelCharges[0]).toMatchObject({ unitId: engineer.id, pos, ticksRemaining: sec(10) });
    engineer.pos = { x: 500, y: 600 };
    expect(tick(sec(10) - 1).filter((event) => event.type === 'satchelDetonated')).toEqual([]);
    expect(sim.state.satchelCharges[0]!.ticksRemaining).toBe(1);
    expect(tick(1)).toContainEqual({ type: 'satchelDetonated', pos, radius: CONFIG.satchel.radius, victims: 0 });
    expect(sim.state.satchelCharges).toEqual([]);
    expect(tick(30).some((event) => event.type === 'satchelDetonated')).toBe(false);
  });

  it('damages both teams and armor in the blast, credits kills, and leaves distant troops untouched', () => {
    const { sim, engineer, pos, plant, tick } = fixture();
    const friendly = sim.spawnFriendly('rifleman', { x: pos.x + 10, y: pos.y });
    const outside = sim.spawnFriendly('rifleman', { x: pos.x + CONFIG.satchel.radius + 1, y: pos.y });
    sim.spawnEnemy('rifle', { x: pos.x + 15, y: pos.y });
    const enemy = sim.state.units.at(-1)!;
    sim.spawnEnemy('vehicle', { x: pos.x, y: pos.y - 15 });
    const armor = sim.state.units.at(-1)!;
    for (const unit of sim.state.units) { unit.grenades = 0; unit.reloadTimer = 100_000; }
    expect(plant().ok).toBe(true);
    engineer.pos = { x: 500, y: 600 };
    const armorHealth = armor.health, outsideHealth = outside.health;
    sim.state.satchelCharges[0]!.ticksRemaining = 1;
    const events = tick(1);
    expect(friendly.health).toBeLessThanOrEqual(0);
    expect(enemy.health).toBeLessThanOrEqual(0);
    expect(armor.health).toBeLessThan(armorHealth);
    expect(outside.health).toBe(outsideHealth);
    expect(engineer.kills).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.type === 'satchelDetonated' && event.victims >= 3)).toBe(true);
  });

  it('damages buildings beside the charge', () => {
    const { sim, engineer, pos } = fixture();
    sim.state.buildings.push({ id: sim.state.nextEntityId++, kind: 'house', name: 'Target house', pos: { x: 336, y: 480 }, cols: 2, rows: 2, health: 200, maxHealth: 200, destroyed: false });
    // Restoration rebuilds the building geometry used by shared blast resolution.
    const restored = Simulation.fromSnapshot(sim.snapshot());
    expect(restored.command({ type: 'satchel', unitId: engineer.id, pos }).ok).toBe(true);
    restored.state.satchelCharges[0]!.ticksRemaining = 1;
    restored.step();
    expect(restored.state.buildings[0]!.destroyed).toBe(true);
  });

  it.each(['rifleman', 'radioEngineer', 'enemy', 'dead', 'crossed', 'pinned', 'busy', 'upgrading', 'indoors', 'climbing', 'poor', 'far', 'blocked', 'bounds', 'nan', 'duplicate', 'paused'] as const)('rejects %s without spending points or creating a charge', (condition) => {
    const { sim, engineer, pos, plant } = fixture();
    if (condition === 'rifleman') engineer.role = 'rifleman';
    if (condition === 'radioEngineer') engineer.role = 'radio_engineer';
    if (condition === 'enemy') engineer.team = 'enemy';
    if (condition === 'dead') engineer.dead = true;
    if (condition === 'crossed') engineer.crossed = true;
    if (condition === 'pinned') engineer.pinned = true;
    if (condition === 'busy') sim.state.constructionSites.push({ id: 999, kind: 'sandbag', pos, builderId: engineer.id, ticksRemaining: 30, totalTicks: 30 });
    if (condition === 'upgrading') engineer.upgradeTimer = 30;
    if (condition === 'indoors') engineer.buildingPosition = { buildingId: 1, level: 0, slot: 0 };
    if (condition === 'climbing') engineer.buildingOrder = { buildingId: 1, level: 0, slot: 0, climbTicks: 0 };
    if (condition === 'poor') sim.state.points = CONFIG.satchel.cost - 1;
    if (condition === 'far') pos.x += 100;
    if (condition === 'blocked') sim.state.terrain.blocked[Math.floor(pos.y / sim.state.terrain.cell) * sim.state.terrain.cols + Math.floor(pos.x / sim.state.terrain.cell)] = 1;
    if (condition === 'bounds') pos.x = -1;
    if (condition === 'nan') pos.x = NaN;
    if (condition === 'duplicate') expect(plant().ok).toBe(true);
    if (condition === 'paused') sim.paused = true;
    const before = sim.snapshot();
    expect(plant().ok).toBe(false);
    expect(sim.snapshot()).toEqual(before);
  });

  it('keeps the fuse burning after the engineer dies and freezes it while paused', () => {
    const { sim, engineer, plant, tick } = fixture();
    plant(); engineer.dead = true; engineer.health = 0;
    tick(1);
    const remaining = sim.state.satchelCharges[0]!.ticksRemaining;
    sim.paused = true; tick(100);
    expect(sim.state.satchelCharges[0]!.ticksRemaining).toBe(remaining);
    sim.paused = false;
    expect(tick(remaining).filter((event) => event.type === 'satchelDetonated')).toHaveLength(1);
  });

  it('preserves the remaining fuse in a validated save and resumes deterministically', () => {
    const { sim, engineer, plant, tick } = fixture();
    plant(); engineer.pos = { x: 500, y: 600 }; tick(120);
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.state.satchelCharges[0]!.ticksRemaining).toBe(180);
    for (let n = 0; n < 180; n++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
    expect(saved.snap.satchelCharges![0]!.ticksRemaining).toBe(180);
  });

  it('leaves charges behind when the squad moves to a new map', () => {
    const { sim, engineer, plant } = fixture();
    plant(); engineer.pos.y = CONFIG.crossing.thresholdY; sim.step();
    expect(sim.state.mapNumber).toBe(2);
    expect(sim.state.satchelCharges).toEqual([]);
  });

  it('migrates old saves and rejects corrupt charges and duplicate ids or owners', () => {
    const { sim, plant } = fixture();
    const old = sim.snapshot(); old.schemaVersion = 26; delete old.satchelCharges;
    const migrated = validateSnapshot(old);
    if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.schemaVersion).toBe(30);
    expect(Simulation.fromSnapshot(migrated.snap).state.satchelCharges).toEqual([]);
    plant();
    for (const change of [{ ticksRemaining: 0 }, { ticksRemaining: 301 }, { ticksRemaining: 1.5 }, { unitId: -1 }, { id: 1.5 }, { pos: { x: Infinity, y: 500 } }]) {
      const bad = sim.snapshot(); Object.assign(bad.satchelCharges![0]!, change);
      expect('error' in validateSnapshot(bad)).toBe(true);
    }
    for (const same of ['id', 'unitId'] as const) {
      const bad = sim.snapshot(), charge = bad.satchelCharges![0]!;
      bad.satchelCharges!.push({ ...charge, id: same === 'id' ? charge.id : 999, unitId: same === 'unitId' ? charge.unitId : 999 });
      expect('error' in validateSnapshot(bad)).toBe(true);
    }
  });
});
