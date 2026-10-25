import { bridgeTraversal } from '../src/simulation/bridges';
import type { BridgePosition } from '../src/simulation/types';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { CAMPAIGN_COUNTRIES } from '../src/content/campaigns';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { distanceToRoad, generateTerrain, isBridgeAt, isRiverAt, TERRAIN_KIND } from '../src/simulation/terrain';
import { nearestRoadPoint } from '../src/simulation/landscape-details';
import { MAX_VEHICLE_TRACKS, recordVehicleTracks } from '../src/simulation/battle-wear';
import { vehicleTrackGeometry, scorchGeometry } from '../src/render/app/battle-wear';
import { hippedRoofGeometry } from '../src/render/app/environment-dressing';

describe('inhabited battlefields', () => {
  it('retains the original version 2 and 3 map fingerprints for existing saves', () => {
    const legacyPlans = [
      { version: 2, country: 'france', seed: 1, sha256: '1737b092f5b4b973bd1f512df22108b5fa8e408f0d0507f62b16f56fd0d56304' },
      { version: 2, country: 'italy', seed: 6, sha256: '817ddb2ed79a51856509b023d61929225969e20de5b4156a7aa18cf58ca9ac1a' },
      { version: 2, country: 'netherlands', seed: 2026, sha256: 'ada04d2595b5c324520f1c8cfbebd32c56a74a6a3aecd0b7d2f5696c61ce45be' },
      { version: 3, country: 'france', seed: 1, sha256: 'e6b41a36aabaf5d93d027e92dc9b399dc006136667d51f5be5a40cec09c85a18' },
      { version: 3, country: 'italy', seed: 6, sha256: '7774c0d08c589ec5e1b17c08b02835a08acbe6a1c1d337ae17b1716718740eb5' },
      { version: 3, country: 'netherlands', seed: 2026, sha256: '49cbca198d5a83edfd2eb09125077efa5078c4471ea9a2088bae087b844e2ba9' },
    ] as const;
    for (const plan of legacyPlans) {
      const data = generateTerrain(plan.seed, true, plan.version, plan.country);
      expect(createHash('sha256').update(JSON.stringify(data)).digest('hex')).toBe(plan.sha256);
    }
  });

  it('connects doors to the nearest road segment rather than a distant vertex', () => {
    expect(nearestRoadPoint({ label: '', archetype: 'village', fields: [], roads: [{ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], halfWidth: 10, surface: 'dirt' }] }, { x: 42, y: 30 })).toEqual({ x: 42, y: 0 });
  });

  it('creates accessible lots and real cover without obstructing roads, deployment or edge lanes across countries', () => {
    let lots = 0, defenses = 0;
    for (const country of CAMPAIGN_COUNTRIES) for (const seed of [...Array.from({ length: 24 }, (_, i) => i + 1), 26, 2026, 31337]) {
      const data = generateTerrain(seed, true, 4, country);
      const { terrain, layout } = data, { cell, cols } = terrain;
      expect(data.layoutVersion).toBe(4);
      for (const lot of layout!.lots ?? []) {
        lots++;
        for (let row = lot.row; row < lot.row + lot.rows; row++) for (let col = lot.col; col < lot.col + lot.cols; col++) {
          const point = { x: (col + .5) * cell, y: (row + .5) * cell };
          expect(isRiverAt(data.zones, seed, point.x, point.y)).toBe(false);
          expect(layout!.roads.every((road) => distanceToRoad(road, point) > road.halfWidth)).toBe(true);
          expect(row * cell).toBeLessThan(CONFIG.deploymentZone.yMin);
        }
        const gate = (lot.row + Math.floor(lot.rows / 2)) * cols + lot.col;
        expect(terrain.blocked[gate]).toBe(0);
      }
      for (const defense of layout!.defensivePositions ?? []) {
        defenses++;
        expect(defense.cover).toHaveLength(4);
        for (const index of defense.cover) { expect(terrain.blocked[index]).toBe(1); expect(data.kinds[index]).toBe(TERRAIN_KIND.stoneFence); }
        for (const point of [defense.pos, defense.approach]) expect(terrain.blocked[Math.floor(point.y / cell) * cols + Math.floor(point.x / cell)]).toBe(0);
      }
      for (const lane of data.lanes) for (let row = 0; row < terrain.rows; row++) expect(terrain.blocked[row * cols + lane]).toBe(0);
      for (const road of layout!.roads) {
        let bridgePosition: BridgePosition | undefined;
        let previous = road.points[0]!;
        for (let i = 1; i < road.points.length; i++) {
          const a = road.points[i - 1]!, b = road.points[i]!, steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8);
          for (let step = 0; step <= steps; step++) {
            const point = { x: a.x + (b.x - a.x) * step / steps, y: a.y + (b.y - a.y) * step / steps };
            if (point.x < 0 || point.y < 0 || point.x >= CONFIG.field.width || point.y >= CONFIG.field.height) continue;
            const passage = bridgeTraversal(terrain, previous, point, bridgePosition, 'vehicle');
            expect(passage.allowed, `${country} ${seed}: impassable bridge at ${point.x},${point.y}`).toBe(true);
            bridgePosition = passage.position; previous = point;
            expect(terrain.blocked[Math.floor(point.y / cell) * cols + Math.floor(point.x / cell)], `${country} ${seed}: road blocked`).toBe(0);
            if (isRiverAt(data.zones, seed, point.x, point.y)) expect(isBridgeAt(data.zones, seed, point.x, point.y), `${country} ${seed}: unbridged road at ${point.x},${point.y}`).toBe(true);
          }
        }
      }
    }
    expect(lots).toBeGreaterThan(40); expect(defenses).toBeGreaterThan(36);
  }, 60000);

  it.each(CAMPAIGN_COUNTRIES)('preserves the new %s map and scenery through save validation', (country) => {
    const sim = new Simulation(2026, undefined, generateTerrain(2026, true, 4, country));
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.snapshot()).toEqual(sim.snapshot());
    expect(restored.terrainData()).toEqual(sim.terrainData());
  });

  it('gives Dutch terrain substantially less relief than Italian terrain', () => {
    const peak = (country: 'netherlands' | 'italy') => Math.max(...generateTerrain(2026, true, 4, country).terrain.elevation!.heights);
    expect(peak('netherlands')).toBeLessThan(peak('italy') * .4);
  });

  it('builds roofs with upward-facing surfaces', () => {
    for (const [width, depth] of [[3, 2], [2, 3], [2, 2]]) {
      const geometry = hippedRoofGeometry(width!, depth!, .6);
      const normals = geometry.getAttribute('normal');
      for (let i = 0; i < normals.count; i++) expect(normals.getY(i)).toBeGreaterThan(0);
      geometry.dispose();
    }
  });
});

describe('battle wear', () => {
  const fixture = () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    unit.role = 'vehicle'; unit.team = 'enemy'; unit.pos = { x: 400, y: 600 }; unit.prevPos = { x: 399, y: 600 };
    return { sim, unit };
  };
  const dry = { river: null, bridges: [], rapids: [], mud: [] };

  it('records actual vehicle movement without changing random state or IDs, coalesces straight tracks, and ignores teleports', () => {
    const { sim, unit } = fixture(), rng = sim.state.rng.s, nextId = sim.state.nextEntityId;
    for (let i = 0; i < 10; i++) { unit.prevPos = { ...unit.pos }; unit.pos.x++; recordVehicleTracks(sim.state, dry); }
    expect(sim.state.vehicleTracks).toHaveLength(1);
    expect(sim.state.vehicleTracks![0]!.to.x).toBe(410);
    expect(sim.state.rng.s).toBe(rng); expect(sim.state.nextEntityId).toBe(nextId);
    unit.prevPos = { x: 100, y: 100 }; recordVehicleTracks(sim.state, dry);
    expect(sim.state.vehicleTracks).toHaveLength(1);
  });

  it('bounds track history, preserves it through saves, and rejects invalid track coordinates', () => {
    const { sim, unit } = fixture();
    for (let i = 0; i < MAX_VEHICLE_TRACKS + 5; i++) {
      unit.prevPos = { x: 200 + i % 2 * 20, y: 600 }; unit.pos = { x: unit.prevPos.x + 1, y: 600 }; recordVehicleTracks(sim.state, dry);
    }
    expect(sim.state.vehicleTracks).toHaveLength(MAX_VEHICLE_TRACKS);
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    expect(Simulation.fromSnapshot(saved.snap).state.vehicleTracks).toEqual(sim.state.vehicleTracks);
    const corrupt = sim.snapshot(); corrupt.vehicleTracks![0]!.to.x = Infinity;
    expect(validateSnapshot(corrupt)).toHaveProperty('error');
    const old = sim.snapshot(); delete old.vehicleTracks;
    const legacy = validateSnapshot(old); if ('error' in legacy) throw new Error(legacy.error);
    expect(legacy.snap.vehicleTracks).toEqual([]);
  });

  it('does not draw tracks on water or bridge decks', () => {
    const { sim, unit } = fixture();
    const data = generateTerrain(2026);
    const bridge = data.zones.bridges[0]!;
    unit.pos = { x: bridge.x, y: bridge.y }; unit.prevPos = { x: bridge.x - 1, y: bridge.y };
    recordVehicleTracks(sim.state, data.zones); expect(sim.state.vehicleTracks).toEqual([]);
  });

  it('drapes tracks over terrain and fades scorch edges without painting excluded ground', () => {
    const ground = (x: number, y: number): [number, number, number] => [x, x * .01 + y * .02, y];
    const geometry = vehicleTrackGeometry([{ unitId: 1, tick: 1, from: { x: 10, y: 10 }, to: { x: 20, y: 10 } }], ground);
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) expect(positions.getY(i)).toBeCloseTo(positions.getX(i) * .01 + positions.getZ(i) * .02 + .012, 5);
    expect(positions.count).toBeGreaterThan(0); geometry.dispose();
    const scorch = scorchGeometry(24, 2026, () => 0, (x) => x >= 0);
    const colors = scorch.getAttribute('color'), points = scorch.getAttribute('position');
    expect(colors.itemSize).toBe(4);
    for (let i = 0; i < points.count; i++) expect(points.getX(i)).toBeGreaterThanOrEqual(0);
    expect(colors.getW(0)).toBeGreaterThan(0); expect(colors.getW(1)).toBe(0); scorch.dispose();
  });
});
