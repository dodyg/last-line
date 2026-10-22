import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, TERRAIN_KIND } from '../src/simulation/terrain';
import { isTreeKind, treeCellPosition, treeOnShot } from '../src/simulation/tree-damage';

function fixture(real = false) {
  const data = generateTerrain(2026, false, 2);
  if (!real) {
    data.kinds.fill(0); data.terrain.blocked.fill(0); data.terrain.baseBlocked?.fill(0);
    data.terrain.elevation?.heights.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  }
  const sim = new Simulation(2026, undefined, data, false); sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const cell = real ? data.kinds.findIndex((kind) => isTreeKind(kind)) : 18 * data.terrain.cols + 20;
  if (!real) data.kinds[cell] = TERRAIN_KIND.oak;
  const pos = treeCellPosition(data.terrain, cell);
  const blast = (damage: number, offset = 0, delivery: 'mortar' | 'artillery' | 'airSupport' = 'artillery') => {
    sim.state.strikes.push({ id: sim.state.nextEntityId++, pos: { x: pos.x + offset, y: pos.y }, landTick: sim.state.ticks + 1,
      radius: 60, damage, suppressionAmount: 0, source: 'friendly', delivery });
    return sim.step();
  };
  return { sim, data, cell, pos, blast };
}

describe('trees damaged by gunfire and explosions', () => {
  it.each(['mortar', 'artillery', 'airSupport'] as const)('%s strips or snaps trees and removes foliage concealment once felled', (delivery) => {
    const { sim, data, cell, pos, blast } = fixture();
    const unit = sim.state.units[0]!; unit.pos = { ...pos }; unit.prevPos = { ...pos }; sim.state.units = [unit];
    const coveredSpeed = sim.terrainEffectsFor(unit).speedMult;
    const first = blast(30, 0, delivery);
    expect(sim.state.treeDamage).toEqual([{ cell, kind: TERRAIN_KIND.oak, health: 58 }]);
    expect(first).toContainEqual({ type: 'treeHit', cell, pos, health: 58, blast: true });
    expect(data.kinds[cell]).toBe(TERRAIN_KIND.oak); expect(sim.terrainEffectsFor(unit).speedMult).toBe(coveredSpeed);
    blast(100, 0, delivery); expect(sim.state.treeDamage![0]!.health).toBe(0); expect(data.kinds[cell]).toBe(TERRAIN_KIND.open);
    expect(sim.terrainEffectsFor(unit).speedMult).toBeGreaterThan(coveredSpeed);
    expect(blast(100, 0, delivery).some((event) => event.type === 'treeHit')).toBe(false);
  });

  it('applies blast falloff, leaves trees beyond the radius alone, and ignores zero damage', () => {
    const { sim, data, cell, blast } = fixture();
    blast(0); expect(sim.state.treeDamage).toEqual([]);
    blast(30, 80); expect(sim.state.treeDamage).toEqual([]);
    const untouched = cell - 4; data.kinds[untouched] = TERRAIN_KIND.birch;
    blast(30, 45); expect(sim.state.treeDamage![0]!.health).toBeCloseTo(83.2);
    expect(sim.state.treeDamage!.some((tree) => tree.cell === untouched)).toBe(false);
  });

  it('missed small-arms fire chips the first tree, redirects its tracer, and can eventually fell it', () => {
    const { sim, data, cell, pos } = fixture();
    const shooter = sim.state.units[0]!; shooter.pos = { x: pos.x - 96, y: pos.y }; sim.state.units = [shooter];
    sim.spawnEnemy('rifle', { x: pos.x + 96, y: pos.y }); const target = sim.state.units.at(-1)!;
    target.health = 10_000;
    for (const unit of sim.state.units) { unit.reloadTimer = 100_000; unit.pinned = true; unit.suppression = 10_000; unit.path = []; unit.moveGoal = null; }
    const weapon = { ...sim.weaponOf(shooter)!, damage: 20, accuracy: 0 };
    const second = cell + 2; data.kinds[second] = TERRAIN_KIND.birch;
    for (let i = 0; i < 40 && data.kinds[cell] !== TERRAIN_KIND.open; i++) {
      expect(sim.fireShot(shooter, target, weapon)).toBe(true);
      const events = sim.step();
      if (events.some((event) => event.type === 'treeHit')) {
        expect(events).toContainEqual(expect.objectContaining({ type: 'treeHit', cell, blast: false }));
        expect(events).toContainEqual(expect.objectContaining({ type: 'shot', to: pos, targetId: null }));
      }
    }
    expect(sim.state.treeDamage!.find((tree) => tree.cell === cell)!.health).toBe(0);
    expect(sim.state.treeDamage!.some((tree) => tree.cell === second)).toBe(false);
  });

  it('does not damage trees outside the shot path, next to the muzzle, or below elevated fire', () => {
    const { data, cell, pos } = fixture();
    expect(treeOnShot(data.terrain, data.kinds, { x: pos.x - 80, y: pos.y }, { x: pos.x + 80, y: pos.y })).toBe(cell);
    expect(treeOnShot(data.terrain, data.kinds, { x: pos.x - 80, y: pos.y + 20 }, { x: pos.x + 80, y: pos.y + 20 })).toBeNull();
    expect(treeOnShot(data.terrain, data.kinds, pos, { x: pos.x + 80, y: pos.y })).toBeNull();
    expect(treeOnShot(data.terrain, data.kinds, { x: pos.x - 80, y: pos.y }, { x: pos.x + 80, y: pos.y }, 100, 100)).toBeNull();
  });

  it('also damages trees with travelling explosive projectiles', () => {
    const { sim, cell, pos } = fixture();
    sim.state.projectiles.push({ id: sim.state.nextEntityId++, team: 'friendly', sourceId: null, pos: { ...pos }, target: { ...pos },
      speed: 10, damage: 100, splashRadius: 35, armorMult: 1, suppressionAmount: 0, suppressionRadius: 35, arc: false });
    sim.step(); expect(sim.state.treeDamage!.find((tree) => tree.cell === cell)!.health).toBe(0);
  });

  it('preserves damage and lost foliage through Continue without replaying splinter events', () => {
    const { sim, cell, blast } = fixture(true); sim.state.units = []; blast(100);
    const saved = sim.snapshot(), checked = validateSnapshot(JSON.parse(JSON.stringify(saved))); if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.snapshot()).toEqual(saved); expect(restored.state.terrain.kinds![cell]).toBe(TERRAIN_KIND.open);
    const events = restored.step(); expect(events).toEqual(sim.step()); expect(events.some((event) => event.type === 'treeHit')).toBe(false);
    for (let i = 0; i < 30; i++) expect(restored.step()).toEqual(sim.step());
    expect(restored.snapshot()).toEqual(sim.snapshot());
    const legacy = { ...saved }; delete legacy.treeDamage; const migrated = validateSnapshot(legacy);
    if ('error' in migrated) throw new Error(migrated.error); expect(migrated.snap.treeDamage).toEqual([]);
  });

  it('starts the next map with undamaged trees', () => {
    const { sim, blast } = fixture(); blast(100); expect(sim.state.treeDamage!.length).toBeGreaterThan(0);
    for (const unit of sim.state.units) unit.pos.y = CONFIG.crossing.thresholdY - 1;
    sim.step(); expect(sim.state.mapNumber).toBe(2); expect(sim.state.treeDamage).toEqual([]);
  });

  it.each(['cell', 'duplicate', 'kind', 'health', 'nan', 'intact'] as const)('rejects corrupt tree records: %s', (field) => {
    const { sim, blast } = fixture(); blast(20); const saved = sim.snapshot(), tree = saved.treeDamage![0]!;
    if (field === 'cell') tree.cell = -1;
    if (field === 'duplicate') saved.treeDamage!.push({ ...tree });
    if (field === 'kind') tree.kind = TERRAIN_KIND.road;
    if (field === 'health') tree.health = -1;
    if (field === 'nan') tree.health = NaN;
    if (field === 'intact') tree.health = 100;
    expect(validateSnapshot(saved)).toHaveProperty('error');
  });
});
