import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { bridgeDeckHeight, bridgeFootHeight, bridgeKey, bridgeTraversal, bridgesBlockSight } from '../src/simulation/bridges';
import { unitEyeHeight } from '../src/simulation/buildings';
import { findPath } from '../src/simulation/navigation';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, isBridgeAt, riverPathPoints, terrainEffectsAt } from '../src/simulation/terrain';
import { validateSnapshot } from '../src/persistence';
import type { BridgeSurface, BridgePosition, Vec2 } from '../src/simulation/types';

function fixture(axis: BridgeSurface['axis'] = 'horizontal', type: BridgeSurface['type'] = 'stone') {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length); data.kinds.fill(0);
  data.buildings = [];
  const bridge: BridgeSurface = { x: 348, y: 348, axis, type, halfWidth: 18, halfLength: 72 };
  data.zones = { river: { cx: 348, cy: 348, halfLength: 500, halfWidth: 30, orientation: axis === 'horizontal' ? 'vertical' : 'horizontal' }, bridges: [bridge], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false), unit = sim.state.units[0]!;
  sim.state.units = [unit]; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const pos = (along: number, across: number): Vec2 => axis === 'horizontal' ? { x: bridge.x + along, y: bridge.y + across } : { x: bridge.x + across, y: bridge.y + along };
  const move = (from: Vec2, to: Vec2) => {
    unit.pos = { ...from }; unit.prevPos = { ...from }; unit.path = []; unit.moveGoal = null; delete unit.bridgePosition;
    return sim.command({ type: 'move', unitId: unit.id, pos: to });
  };
  return { sim, unit, bridge, pos, move, data };
}

describe('independent bridge routes', () => {
  it.each(['horizontal', 'vertical'] as const)('prefers a nearby %s bridge over wading between dry banks', (axis) => {
    const { sim, unit, bridge, pos, move } = fixture(axis);
    expect(move(pos(-144, 72), pos(144, 72)).ok).toBe(true);
    expect(unit.path.some((point) => Math.abs(point.x - bridge.x) <= 12 && Math.abs(point.y - bridge.y) <= 12)).toBe(true);
    let usedDeck = false;
    for (let tick = 0; tick < 1400 && unit.path.length; tick++) {
      sim.step();
      if (unit.bridgePosition?.level === 'deck') usedDeck = true;
    }
    expect(usedDeck).toBe(true);
    expect(unit.path).toHaveLength(0);
  });

  it('uses an engineer-built pontoon for a nearby river crossing', () => {
    const { unit, bridge, pos, move } = fixture('horizontal', 'pontoon');
    expect(move(pos(-144, 72), pos(144, 72)).ok).toBe(true);
    expect(unit.path.some((point) => Math.abs(point.x - bridge.x) <= 12 && Math.abs(point.y - bridge.y) <= 12)).toBe(true);
  });

  it('still wades when the bridge would require a long detour', () => {
    const { unit, bridge, pos, move } = fixture();
    expect(move(pos(-144, 300), pos(144, 300)).ok).toBe(true);
    expect(unit.path.every((point) => Math.abs(point.y - bridge.y) > bridge.halfWidth)).toBe(true);
  });

  it('still finds a crossing when no bridge exists', () => {
    const { sim, unit, pos, move, data } = fixture();
    data.zones.bridges = [];
    sim.state.terrain.bridges = [];
    expect(move(pos(-144, 72), pos(144, 72)).ok).toBe(true);
    expect(unit.path.length).toBeGreaterThan(0);
  });

  it('wades around an inaccessible nearby bridge', () => {
    const { sim, unit, bridge, pos, move } = fixture();
    const terrain = sim.state.terrain;
    for (let row = 0; row < terrain.rows; row++) for (let col = 0; col < terrain.cols; col++) {
      if (Math.abs((col + .5) * terrain.cell - bridge.x) <= bridge.halfLength
        && Math.abs((row + .5) * terrain.cell - bridge.y) <= bridge.halfWidth) terrain.blocked[row * terrain.cols + col] = 1;
    }
    expect(move(pos(-144, 72), pos(144, 72)).ok).toBe(true);
    expect(unit.path.every((point) => Math.abs(point.y - bridge.y) > bridge.halfWidth)).toBe(true);
  });

  it.each(['horizontal', 'vertical'] as const)('walks underneath a raised %s bridge and leaves at ground level', (axis) => {
    const { sim, unit, bridge, pos, move } = fixture(axis);
    expect(move(pos(0, -72), pos(0, 72)).ok).toBe(true);
    let underneath = false;
    for (let tick = 0; tick < 1000 && unit.path.length; tick++) {
      sim.step();
      if (unit.bridgePosition) {
        expect(unit.bridgePosition).toEqual({ key: bridgeKey(bridge), level: 'under' });
        expect(bridgeFootHeight(sim.state.terrain, unit)).toBe(0); underneath = true;
      }
    }
    expect(underneath).toBe(true); expect(unit.path).toHaveLength(0);
    expect(unit.bridgePosition).toBeUndefined();
    expect(Math.hypot(unit.pos.x - pos(0, 72).x, unit.pos.y - pos(0, 72).y)).toBeLessThan(1);
  });

  it.each(['horizontal', 'vertical'] as const)('uses the deck from the road ends of a %s bridge', (axis) => {
    const { sim, unit, bridge, pos, move } = fixture(axis);
    expect(move(pos(-96, 0), pos(96, 0)).ok).toBe(true);
    let highest = 0;
    for (let tick = 0; tick < 1000 && unit.path.length; tick++) {
      sim.step(); highest = Math.max(highest, bridgeFootHeight(sim.state.terrain, unit));
      if (unit.bridgePosition) expect(unit.bridgePosition.level).toBe('deck');
    }
    expect(highest).toBe(bridgeDeckHeight(bridge, pos(0, 0)));
    expect(unit.path).toHaveLength(0); expect(unit.bridgePosition).toBeUndefined();
  });

  it('routes a soldier already below the bridge out to the side without jumping to the deck', () => {
    const { sim, unit, bridge, pos } = fixture();
    unit.pos = pos(0, 0); unit.prevPos = { ...unit.pos };
    unit.bridgePosition = { key: bridgeKey(bridge), level: 'under' };
    expect(sim.command({ type: 'move', unitId: unit.id, pos: pos(0, 72) }).ok).toBe(true);
    for (let tick = 0; tick < 500 && unit.path.length; tick++) { sim.step(); if (unit.bridgePosition) expect(unit.bridgePosition.level).toBe('under'); }
    expect(unit.path).toHaveLength(0);
  });

  it('keeps deck rails, low ramps and pontoons from becoming impossible shortcuts', () => {
    const { sim, bridge, pos } = fixture();
    const deck: BridgePosition = { key: bridgeKey(bridge), level: 'deck' }, under: BridgePosition = { ...deck, level: 'under' };
    expect(bridgeTraversal(sim.state.terrain, pos(0, 0), pos(0, 60), deck).allowed).toBe(false);
    expect(bridgeTraversal(sim.state.terrain, pos(0, 0), pos(70, 0), under).allowed).toBe(false);
    expect(bridgeTraversal(sim.state.terrain, pos(0, -60), pos(0, 60), undefined, 'vehicle').allowed).toBe(false);
    bridge.type = 'pontoon';
    expect(bridgeTraversal(sim.state.terrain, pos(0, -60), pos(0, 60)).allowed).toBe(false);
    const route = findPath(sim.state.terrain, pos(0, -72), pos(0, 72));
    expect(route.reachable).toBe(true);
    expect(route.waypoints.some((point) => Math.abs(point.x - bridge.x) >= bridge.halfLength)).toBe(true);
  });

  it('keeps overlapping soldiers on separate levels and blocks fire through the deck', () => {
    const { sim, unit, bridge, pos } = fixture();
    unit.pos = pos(0, 0); unit.prevPos = { ...unit.pos }; unit.bridgePosition = { key: bridgeKey(bridge), level: 'under' };
    const above = structuredClone(unit); above.id = sim.state.nextEntityId++; above.pos.x += 2; above.prevPos = { ...above.pos }; above.bridgePosition!.level = 'deck';
    sim.state.units.push(above);
    const before = sim.state.units.map((soldier) => ({ ...soldier.pos }));
    sim.step(); expect(sim.state.units.map((soldier) => soldier.pos)).toEqual(before);
    expect(bridgesBlockSight(sim.state.terrain, unit.pos, above.pos, unitEyeHeight(sim.state.terrain, unit), unitEyeHeight(sim.state.terrain, above))).toBe(true);
    expect(bridgesBlockSight(sim.state.terrain, pos(0, -60), pos(0, 60), 12, 12)).toBe(false);
    expect(bridgeFootHeight(sim.state.terrain, above) - bridgeFootHeight(sim.state.terrain, unit)).toBe(30);
  });

  it('applies river penalties below a bridge rather than the firm deck bonus', () => {
    const { sim, unit, bridge, data } = fixture();
    unit.pos = { x: bridge.x, y: bridge.y };
    unit.bridgePosition = { key: bridgeKey(bridge), level: 'under' };
    const zones = { ...data.zones, bridges: [] };
    expect(sim.terrainEffectsFor(unit)).toEqual(terrainEffectsAt(zones, sim.state.seed, unit.pos));
    unit.bridgePosition.level = 'deck';
    expect(sim.terrainEffectsFor(unit)).toEqual(CONFIG.terrain.effects.bridge);
  });

  it('lets enemy infantry use the same lower route', () => {
    const { sim, unit, pos } = fixture();
    unit.team = 'enemy'; unit.role = 'rifle'; unit.grenades = 0;
    unit.pos = pos(0, -72); unit.prevPos = { ...unit.pos };
    unit.path = findPath(sim.state.terrain, unit.pos, pos(0, 72)).waypoints;
    unit.moveGoal = pos(0, 72);
    let passedUnder = false;
    for (let tick = 0; tick < 1000 && unit.path.length; tick++) { sim.step(); passedUnder ||= unit.bridgePosition?.level === 'under'; }
    expect(passedUnder).toBe(true);
  });

  it('preserves an occupied lower route and its remaining path through Continue', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    const bridge = sim.state.terrain.bridges!.find((candidate) => candidate.type !== 'pontoon')!;
    sim.state.units = [unit]; sim.state.scheduler.prepTicksLeft = 100_000;
    unit.pos = { x: bridge.x, y: bridge.y }; unit.prevPos = { ...unit.pos };
    unit.bridgePosition = { key: bridgeKey(bridge), level: 'under' };
    const destination = bridge.axis === 'horizontal' ? { x: bridge.x, y: bridge.y + 72 } : { x: bridge.x + 72, y: bridge.y };
    expect(sim.command({ type: 'move', unitId: unit.id, pos: destination }).ok).toBe(true);
    sim.step(); // Drain spawn/order events before comparing continuation ticks.
    const valid = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in valid) throw new Error(valid.error);
    const resumed = Simulation.fromSnapshot(valid.snap);
    expect(resumed.state.units[0]!.bridgePosition).toEqual(unit.bridgePosition);
    for (let tick = 0; tick < 150; tick++) expect(resumed.step()).toEqual(sim.step());
    expect(resumed.snapshot()).toEqual(sim.snapshot());
  });

  it('builds a low pontoon crossing and restores it with its occupants on the deck', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    const data = sim.terrainData();
    const point = riverPathPoints(data.zones.river!, sim.state.seed, 24).find((candidate) =>
      candidate.x > 40 && candidate.x < 920 && candidate.y > 40 && candidate.y < 680
      && !isBridgeAt(data.zones, sim.state.seed, candidate.x, candidate.y)
      && data.zones.bridges.every((bridge) => Math.hypot(bridge.x - candidate.x, bridge.y - candidate.y) > 150))!;
    expect(point).toBeDefined();
    sim.state.units = [unit]; sim.state.scheduler.prepTicksLeft = 100_000; sim.state.points = 1000;
    unit.role = 'engineer'; unit.pos = { ...point }; unit.prevPos = { ...point };
    expect(sim.command({ type: 'bridge', pos: point }).ok).toBe(true);
    sim.state.constructionSites[0]!.ticksRemaining = 1;
    sim.step();
    expect(sim.state.builtBridges).toHaveLength(1);
    expect(unit.bridgePosition?.level).toBe('deck');
    expect(unit.pos).toEqual(point);
    const bridge = sim.state.terrain.bridges!.find((candidate) => bridgeKey(candidate) === unit.bridgePosition!.key)!;
    expect(bridge.type).toBe('pontoon'); expect(bridgeDeckHeight(bridge, point)).toBe(3);
    const side = bridge.axis === 'horizontal' ? { x: point.x, y: point.y + bridge.halfWidth + 24 } : { x: point.x + bridge.halfWidth + 24, y: point.y };
    expect(bridgeTraversal(sim.state.terrain, point, side, unit.bridgePosition).allowed).toBe(false);
    const resumed = Simulation.fromSnapshot(sim.snapshot());
    expect(resumed.state.units[0]!.bridgePosition).toEqual(unit.bridgePosition);
    expect(resumed.state.terrain.bridges!.find((bridge) => bridgeKey(bridge) === unit.bridgePosition!.key)?.type).toBe('pontoon');
    // A pre-pontoon save may still put an occupant below this engineer crossing.
    const legacy = sim.snapshot(); legacy.units[0]!.bridgePosition!.level = 'under';
    legacy.units[0]!.moveGoal = side; legacy.units[0]!.path = [side];
    const migrated = Simulation.fromSnapshot(legacy), soldier = migrated.state.units[0]!;
    expect(soldier.bridgePosition?.level).toBe('deck');
    expect(soldier.path.length).toBeGreaterThan(0);
    let start = soldier.pos, passage = soldier.bridgePosition;
    for (const waypoint of soldier.path) {
      const crossing = bridgeTraversal(migrated.state.terrain, start, waypoint, passage);
      expect(crossing.allowed).toBe(true); start = waypoint; passage = crossing.position;
    }
  });
});
