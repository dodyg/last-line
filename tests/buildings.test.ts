import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { validateSnapshot } from '../src/persistence';
import { BUILDING_FACINGS, buildingArchitecture, buildingSlot, positionFacing, unitBuildingHeight } from '../src/simulation/buildings';
import { targetIsValid } from '../src/simulation/combat';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, hasLineOfSight, rebuildBlocked } from '../src/simulation/terrain';

function fixture(withLowBuilding = false) {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  data.buildings = [{ kind: 'hospital', name: 'Field hospital', col: 10, row: 10, cols: 4, rows: 2 }];
  if (withLowBuilding) data.buildings.push({ kind: 'barn', name: 'Low barn', col: 10, row: 13, cols: 2, rows: 2 });
  const sim = new Simulation(2026, undefined, data);
  const unit = sim.state.units[0]!;
  sim.state.units = [unit]; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  unit.pos = { x: 300, y: 360 }; unit.prevPos = { ...unit.pos }; unit.grenades = 0;
  const building = sim.state.buildings[0]!;
  function tick(count = 250) { return Array.from({ length: count }, () => sim.step()).flat(); }
  return { sim, unit, building, tick };
}

describe('multi-floor building combat', () => {
  it('moves to the requested facade and preserves its direction through save and restore', () => {
    const { sim, unit, building, tick } = fixture();
    for (const facing of BUILDING_FACINGS) {
      expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 1, facing }).ok).toBe(true);
      tick();
      expect(positionFacing(unit.buildingPosition!)).toBe(facing);
      if (facing === 'north') expect(unit.pos.y).toBeLessThan(building.pos.y);
      if (facing === 'east') expect(unit.pos.x).toBeGreaterThan(building.pos.x + building.cols * 24);
      if (facing === 'south') expect(unit.pos.y).toBeGreaterThan(building.pos.y + building.rows * 24);
      if (facing === 'west') expect(unit.pos.x).toBeLessThan(building.pos.x);
      const restored = Simulation.fromSnapshot(sim.snapshot());
      expect(positionFacing(restored.state.units[0]!.buildingPosition!)).toBe(facing);
    }
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 'balcony', facing: 'north' }).ok).toBe(false);
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 'balcony', facing: 'south' }).ok).toBe(true);
    tick(); expect(positionFacing(unit.buildingPosition!)).toBe('south');
  });

  it('lets rooftops fire over a lower building while a lower window remains obstructed', () => {
    const { sim, unit, building } = fixture(true);
    sim.spawnEnemy('rifle', { x: 267, y: 408 });
    const enemy = sim.state.units.at(-1)!;
    unit.buildingPosition = { buildingId: building.id, level: 0, slot: 4 };
    unit.pos = buildingSlot(building, unit.buildingPosition, 24); unit.prevPos = { ...unit.pos };
    const valid = () => targetIsValid(getContent(), sim.state.terrain, [], unit, enemy, sim.weaponOf(unit)!, CONFIG);
    expect(valid()).toBe(false);
    unit.buildingPosition.level = 'roof';
    unit.pos = buildingSlot(building, unit.buildingPosition, 24); unit.prevPos = { ...unit.pos };
    expect(valid()).toBe(true);
    const barn = sim.state.buildings[1]!, health = barn.health;
    sim.fireShot(unit, enemy, sim.weaponOf(unit)!);
    expect(barn.health).toBe(health);
  });

  it('caps a floor at eight reserved windows and rejects a ninth without changing its orders', () => {
    const { sim, unit, building } = fixture();
    for (let i = 0; i < 8; i++) { const clone = structuredClone(unit); clone.id = sim.state.nextEntityId++; sim.state.units.push(clone); }
    const units = sim.state.units;
    expect(sim.command({ type: 'garrison', unitIds: units.slice(0, 8).map((u) => u.id), buildingId: building.id, level: 1 }).ok).toBe(true);
    expect(new Set(units.slice(0, 8).map((u) => u.buildingOrder?.slot)).size).toBe(8);
    const before = structuredClone(units[8]!);
    expect(sim.command({ type: 'garrison', unitIds: [units[8]!.id], buildingId: building.id, level: 1 }).ok).toBe(false);
    expect(units[8]).toEqual(before);
  });

  it('walks to an entrance, enters, and takes time to climb between firing positions', () => {
    const { sim, unit, building, tick } = fixture();
    expect(buildingArchitecture(building)).toMatchObject({ floors: 3, roofStyle: 'flat', rooftopAccess: true, balcony: true });
    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 280, y: 260 } }).ok).toBe(true);
    expect(unit.buildingPosition).toBeUndefined();
    expect(unit.path.length).toBeGreaterThan(0);
    tick();
    expect(unit.buildingPosition?.level).toBe(0);
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 'roof' }).ok).toBe(true);
    tick(1); expect(unit.buildingPosition?.level).toBe(0);
    tick(110); expect(unit.buildingPosition?.level).toBe('roof');
    expect(unitBuildingHeight(sim.state.terrain, unit)).toBe(62);
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 'balcony' }).ok).toBe(true);
    tick(); expect(unit.buildingPosition?.level).toBe('balcony');
    expect(unit.pos.y).toBeGreaterThan(building.pos.y + building.rows * 24);
  });

  it('allows floor and rooftop occupants to shoot out and be shot at without damaging their own wall', () => {
    const { sim, unit, building, tick } = fixture();
    sim.spawnEnemy('rifle', { x: 300, y: 390 });
    const enemy = sim.state.units.at(-1)!;
    enemy.health = 10_000; enemy.reloadTimer = 100_000; enemy.grenades = 0;
    const content = getContent(), weapon = sim.weaponOf(unit)!;
    for (const level of [0, 1, 2, 'roof', 'balcony'] as const) {
      expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level }).ok).toBe(true);
      tick();
      expect(targetIsValid(content, sim.state.terrain, [], unit, enemy, weapon, CONFIG)).toBe(true);
      expect(targetIsValid(content, sim.state.terrain, [], enemy, unit, sim.weaponOf(enemy)!, CONFIG)).toBe(true);
      const hp = building.health;
      sim.fireShot(unit, enemy, weapon);
      expect(building.health).toBe(hp);
      expect(sim.step().some((e) => e.type === 'shot' && e.shooterId === unit.id && e.targetId === enemy.id)).toBe(true);
    }
  });

  it('keeps walls solid for ground troops and unrelated lines of fire', () => {
    const { sim, building } = fixture();
    expect(hasLineOfSight(sim.state.terrain, { x: 288, y: 200 }, { x: 288, y: 350 })).toBe(false);
    expect(sim.state.terrain.blocked[10 * sim.state.terrain.cols + 10]).toBe(1);
    building.destroyed = true; building.health = 0; rebuildBlocked(sim.state.terrain, sim.state.buildings);
    expect(hasLineOfSight(sim.state.terrain, { x: 288, y: 200 }, { x: 288, y: 350 })).toBe(true);
  });

  it('rejects vehicles, pinned infantry, invalid floors, unavailable roofs, and occupied enemy buildings', () => {
    const { sim, unit, building } = fixture();
    const command = () => sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 1 });
    unit.pinned = true; expect(command().ok).toBe(false); unit.pinned = false;
    unit.role = 'gun_truck'; expect(command().ok).toBe(false); unit.role = 'rifleman';
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 99 }).ok).toBe(false);
    building.rooftopAccess = false;
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 'roof' }).ok).toBe(false);
    sim.spawnEnemy('rifle', { x: 300, y: 260 });
    const enemy = sim.state.units.at(-1)!;
    enemy.buildingPosition = { buildingId: building.id, level: 0, slot: 0 };
    expect(command().ok).toBe(false);
  });

  it('reserves distinct slots for group orders and lets soldiers walk out again', () => {
    const { sim, unit, tick } = fixture();
    const second = structuredClone(unit); second.id = sim.state.nextEntityId++; second.pos.x += 24;
    sim.state.units.push(second);
    expect(sim.command({ type: 'moveGroup', unitIds: [unit.id, second.id], pos: { x: 280, y: 260 } }).ok).toBe(true);
    expect(unit.buildingOrder?.slot).not.toBe(second.buildingOrder?.slot);
    tick();
    expect(unit.buildingPosition).toBeDefined(); expect(second.buildingPosition).toBeDefined();
    expect(sim.command({ type: 'moveGroup', unitIds: [unit.id, second.id], pos: { x: 440, y: 400 } }).ok).toBe(true);
    expect(unit.buildingPosition).toBeUndefined(); expect(second.buildingPosition).toBeUndefined();
    tick(); expect(unit.pos.x).toBeGreaterThan(400);
  });

  it('lets enemy infantry find a building and fire from it', () => {
    const { sim, unit, building, tick } = fixture();
    unit.reloadTimer = 100_000; unit.health = 10_000;
    sim.state.nextEntityId += (3 - sim.state.nextEntityId % 3) % 3;
    sim.spawnEnemy('rifle', { x: 290, y: 214 });
    const enemy = sim.state.units.at(-1)!;
    enemy.grenades = 0; enemy.reloadTimer = 100_000;
    tick(300);
    expect(enemy.buildingPosition?.buildingId).toBe(building.id);
    expect(['roof', 2]).toContain(enemy.buildingPosition?.level);
    enemy.reloadTimer = 0;
    const events = tick(10);
    expect(events.some((e) => e.type === 'shot' && e.shooterId === enemy.id && e.targetId === unit.id)).toBe(true);
  });

  it('evacuates occupants and applies collapse damage when a building is destroyed', () => {
    const { sim, unit, building, tick } = fixture();
    sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 'roof' }); tick();
    const health = unit.health;
    sim.damageBuilding(building, building.maxHealth);
    expect(unit.health).toBeLessThan(health);
    expect(unit.buildingPosition).toBeUndefined(); expect(unit.buildingOrder).toBeUndefined();
    expect(sim.state.terrain.blocked[Math.floor(unit.pos.y / 24) * sim.state.terrain.cols + Math.floor(unit.pos.x / 24)]).toBe(0);
    expect(sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 0 }).ok).toBe(false);
  });

  it('preserves a stair order and firing position through validated saves, detached from live state', () => {
    const { sim, unit, building, tick } = fixture();
    sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 'roof' }); tick();
    sim.command({ type: 'garrison', unitIds: [unit.id], buildingId: building.id, level: 1 });
    const snap = sim.snapshot();
    unit.buildingOrder!.climbTicks--;
    expect(snap.units[0]!.buildingOrder!.climbTicks).not.toBe(unit.buildingOrder!.climbTicks);
    const valid = validateSnapshot(JSON.parse(JSON.stringify(snap)));
    if ('error' in valid) throw new Error(valid.error);
    const restored = Simulation.fromSnapshot(valid.snap);
    expect(restored.state.units[0]!.buildingPosition?.level).toBe('roof');
    expect(restored.state.units[0]!.buildingOrder?.level).toBe(1);
    expect(restored.state.terrain.buildings).toBe(restored.state.buildings);
    const bad = structuredClone(snap); bad.units[0]!.buildingOrder!.level = 99;
    expect(validateSnapshot(bad)).toHaveProperty('error');
    const old = structuredClone(snap); delete old.units[0]!.buildingOrder; delete old.units[0]!.buildingPosition;
    for (const b of old.buildings) { delete b.floors; delete b.roofStyle; delete b.rooftopAccess; delete b.balcony; }
    expect(validateSnapshot(old)).toHaveProperty('snap');
    expect(buildingSlot(building, { buildingId: building.id, level: 0, slot: 0 }, 24).y).toBeLessThan(building.pos.y);
  });
});
