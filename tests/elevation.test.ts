import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { ELEVATION, elevationAt, elevationTraversal, slopeAt } from '../src/simulation/elevation';
import { generateTerrain, hasLineOfSight } from '../src/simulation/terrain';
import { findPath } from '../src/simulation/navigation';
import { Simulation } from '../src/simulation/simulation';
import { validateSnapshot } from '../src/persistence';
import { heightfieldGeometry } from '../src/render/app/heightfield';
import { simulationToWorld, WORLD_UNITS_PER_PIXEL } from '../src/render/app/coordinates';
import type { Terrain } from '../src/simulation/types';

function ramp(height: (x: number, y: number) => number): Terrain {
  const cell = 12, cols = 81, rows = 61;
  return { cell: 24, cols: 40, rows: 30, blocked: new Uint8Array(1200), elevation: {
    cell, cols, rows, heights: Float32Array.from({ length: cols * rows }, (_, i) => height((i % cols) * cell, Math.floor(i / cols) * cell)),
  } };
}

function movementFixture(withCover = false) {
  const data = generateTerrain(2026, false, 2);
  data.terrain = ramp((x) => Math.max(0, Math.min(36, (x - 120) * .75)));
  data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  if (withCover) {
    data.buildings = [{ kind: 'barn', name: 'Hill barn', col: 8, row: 11, cols: 2, rows: 2 }];
    for (let row = 11; row < 13; row++) for (let col = 8; col < 10; col++) data.terrain.blocked[row * 40 + col] = 1;
  }
  const sim = new Simulation(2026, undefined, data, false);
  const unit = sim.state.units[0]!;
  sim.state.units = [unit];
  sim.state.weather = 'clear';
  sim.state.scheduler.prepTicksLeft = 100_000;
  unit.pos = { x: 108, y: 360 }; unit.prevPos = { ...unit.pos };
  unit.stance = 'crouching'; unit.crawling = false;
  return { sim, unit };
}

describe('elevated terrain', () => {
  it('generates reproducible multiple levels and steep faces, with safe deployment lanes', () => {
    let maximum = 0, steep = 0;
    for (const seed of [5, 6, 7, 2026]) {
      const data = generateTerrain(seed, true, 3);
      expect(generateTerrain(seed, true, 3).terrain.elevation).toEqual(data.terrain.elevation);
      maximum = Math.max(maximum, ...data.terrain.elevation!.heights);
      for (let y = 96; y < 540; y += 12) for (let x = 96; x < 864; x += 12) {
        const slope = slopeAt(data.terrain, x, y);
        if (slope > ELEVATION.walkGrade) steep++;
        expect(slope).toBeLessThanOrEqual(ELEVATION.climbGrade);
      }
      for (const x of [36, 480, 924]) {
        expect(elevationAt(data.terrain, x, 24)).toBe(0);
        expect(elevationAt(data.terrain, x, 600)).toBe(0);
      }
    }
    expect(maximum).toBeGreaterThan(40);
    expect(steep).toBeGreaterThan(20);
  });

  it('keeps old landscapes flat and saves/restores the new heightfield exactly', () => {
    expect(generateTerrain(2026, true, 2).terrain.elevation).toBeUndefined();
    expect(generateTerrain(2026, true, 1).terrain.elevation).toBeUndefined();
    const sim = new Simulation(2026);
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.state.terrain.elevation).toEqual(sim.state.terrain.elevation);
    const old = { ...sim.snapshot(), terrainLayoutVersion: 2 as const };
    expect(Simulation.fromSnapshot(old).state.terrain.elevation).toBeUndefined();
  });

  it('requires a crawl on a steep face and blocks vehicles from that route', () => {
    const terrain = ramp((x) => Math.max(0, Math.min(36, (x - 120) * .75)));
    const from = { x: 108, y: 360 }, to = { x: 204, y: 360 };
    const infantry = findPath(terrain, from, to);
    expect(infantry.reachable).toBe(true);
    expect(elevationTraversal(terrain, from, to).requiresCrawl).toBe(true);
    expect(findPath(terrain, from, to, undefined, 'vehicle').reachable).toBe(false);
    expect(elevationTraversal(terrain, from, to, 'vehicle').allowed).toBe(false);
  });

  it('routes a vehicle around the steep face using a gentler approach', () => {
    const terrain = ramp((x, y) => Math.max(0, Math.min(36, (x - 120) * (y < 200 ? .15 : .75))));
    const from = { x: 108, y: 360 }, to = { x: 228, y: 360 };
    const path = findPath(terrain, from, to, undefined, 'vehicle');
    expect(path.reachable).toBe(true);
    expect(path.waypoints.some((point) => point.y < 200)).toBe(true);
    let previous = from;
    for (const waypoint of path.waypoints) {
      expect(elevationTraversal(terrain, previous, waypoint, 'vehicle').allowed).toBe(true);
      previous = waypoint;
    }
  });

  it('actually crawls uphill and downhill, then restores the manual posture', () => {
    const { sim, unit } = movementFixture();
    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 204, y: 360 } }).ok).toBe(true);
    let crawlingUp = false, highest = 0;
    for (let i = 0; i < 1600 && unit.path.length; i++) {
      sim.step(); crawlingUp ||= unit.terrainCrawling === true;
      highest = Math.max(highest, elevationAt(sim.state.terrain, unit.pos.x, unit.pos.y));
    }
    sim.step();
    expect(crawlingUp).toBe(true);
    expect(highest).toBe(36);
    expect(unit.path).toHaveLength(0);
    expect(unit.terrainCrawling).toBe(false);
    expect(unit.stance).toBe('crouching');
    expect(unit.crawling).toBe(false);
    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 108, y: 360 } }).ok).toBe(true);
    let crawlingDown = false;
    for (let i = 0; i < 1600 && unit.path.length; i++) { sim.step(); crawlingDown ||= unit.terrainCrawling === true; }
    sim.step();
    expect(crawlingDown).toBe(true);
    expect(elevationAt(sim.state.terrain, unit.pos.x, unit.pos.y)).toBe(0);
    expect(unit.stance).toBe('crouching');
  });

  it('walks over moderate slopes without forcing the player into a crawl', () => {
    const { sim, unit } = movementFixture();
    sim.state.terrain.elevation = ramp((x) => x * .5).elevation;
    unit.stance = 'standing';
    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 204, y: 360 } }).ok).toBe(true);
    // Allow for the slower walking pace and the uphill movement penalty.
    for (let tick = 0; tick < CONFIG.tickRate * 12 && unit.path.length; tick++) {
      const before = { ...unit.pos };
      const remaining = unit.path.length;
      sim.step();
      expect(unit.terrainCrawling).toBe(false);
      if (unit.path.length === remaining) expect(unit.pos).not.toEqual(before);
    }
    expect(unit.path).toHaveLength(0);
    expect(unit.stance).toBe('standing');
  });

  it('stays upright on flat ground before a steep bank and after stepping off it', () => {
    const { sim, unit } = movementFixture();
    unit.stance = 'standing';
    // One waypoint beyond the bank used to make the whole flat approach a crawl.
    unit.path = [{ x: 204, y: 360 }]; unit.moveGoal = { x: 204, y: 360 };
    sim.step();
    expect(unit.pos.x).toBeLessThan(120);
    expect(unit.terrainCrawling).toBe(false);
    let climbed = false;
    for (let tick = 0; tick < 600 && unit.path.length; tick++) {
      sim.step();
      if (unit.pos.x > 126 && unit.pos.x < 156) {
        expect(unit.terrainCrawling).toBe(true); climbed = true;
      }
      if (unit.pos.x > 174) expect(unit.terrainCrawling).toBe(false);
    }
    expect(climbed).toBe(true);
    expect(unit.path).toHaveLength(0);
    expect(unit.stance).toBe('standing');
    expect(unit.crawling).toBe(false);
  });

  it('does not apply the slope below a building to its level rooftop or floor', () => {
    const { sim, unit } = movementFixture(true);
    const building = sim.state.buildings[0]!;
    unit.pos = { x: 144, y: 360 }; unit.prevPos = { ...unit.pos };
    unit.buildingPosition = { buildingId: building.id, level: 'roof', slot: 0 };
    unit.terrainCrawling = true;
    sim.step();
    expect(unit.terrainCrawling).toBe(false);
  });

  it('keeps a manually requested crawl after leaving a slope', () => {
    const { sim, unit } = movementFixture();
    sim.command({ type: 'posture', unitIds: [unit.id], stance: 'prone', crawling: true });
    sim.command({ type: 'move', unitId: unit.id, pos: { x: 204, y: 360 } });
    for (let i = 0; i < 1600 && unit.path.length; i++) sim.step();
    sim.step();
    expect(unit.terrainCrawling).toBe(false);
    expect(unit.crawling).toBe(true);
    expect(unit.stance).toBe('prone');
  });

  it('slows uphill traversal more than descent and refuses an unscalable drop', () => {
    const terrain = ramp((x) => x * .2);
    const low = { x: 108, y: 360 }, high = { x: 204, y: 360 };
    expect(elevationTraversal(terrain, low, high).speedMult).toBeLessThan(elevationTraversal(terrain, high, low).speedMult);
    const cliff = ramp((x) => x < 144 ? 0 : 80);
    expect(findPath(cliff, low, high).reachable).toBe(false);
  });

  it('blocks sight through a hill crest while allowing a view from the crest', () => {
    const terrain = ramp((x) => Math.max(0, 40 - Math.abs(x - 240) * .5));
    expect(hasLineOfSight(terrain, { x: 120, y: 360 }, { x: 360, y: 360 })).toBe(false);
    expect(hasLineOfSight(terrain, { x: 240, y: 360 }, { x: 360, y: 360 })).toBe(true);
  });

  it('answers first contact before taking a slow route into nearby cover', () => {
    const { sim, unit } = movementFixture(true);
    unit.role = 'medic'; unit.health = 1_000_000;
    unit.pos = { x: 180, y: 400 }; unit.prevPos = { ...unit.pos };
    // The barn is off the current firing line, with a reachable protected position.
    sim.spawnEnemy('rifle', { x: 180, y: 240 });
    const enemy = sim.state.units.find((candidate) => candidate.team === 'enemy')!;
    enemy.grenades = 0; enemy.reloadTimer = 0; enemy.shotTimer = 0;
    const events = sim.step();
    expect(events.some((event) => event.type === 'shot' && event.shooterId === enemy.id)).toBe(true);
    expect(enemy.pos).toEqual({ x: 180, y: 240 });
    // Once contact is answered, the same soldier can move into that cover.
    sim.step();
    expect(enemy.path.length).toBeGreaterThan(0);
  });

  it('renders the same height that movement and picking sample', () => {
    const terrain = generateTerrain(5, true, 3).terrain;
    const geometry = heightfieldGeometry(terrain);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    for (const point of [{ x: 210.3, y: 180.7 }, { x: 682.5, y: 419.5 }, { x: 405, y: 310 }]) {
      const [x, , z] = simulationToWorld(point.x, point.y);
      const ray = new THREE.Raycaster(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(mesh)[0]!;
      expect(hit).toBeDefined();
      expect(hit.point.y).toBeCloseTo(elevationAt(terrain, point.x, point.y) * WORLD_UNITS_PER_PIXEL, 5);
    }
    geometry.dispose(); (mesh.material as THREE.Material).dispose();
    expect(CONFIG.field.width).toBe(terrain.cols * terrain.cell);
  });
});
