import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { distanceToRoad, generateTerrain, isBridgeAt, isRiverAt, isMudAt, TERRAIN_KIND, terrainEffectsAt } from '../src/simulation/terrain';

describe('European landscape generation', () => {
  it('uses uneven mud boundaries and applies penalties only inside the shared outline', () => {
    const patch = { cx: 300, cy: 300, halfLength: 76, halfWidth: 45, shapeSeed: 2026 };
    const zones = { river: null, bridges: [], rapids: [], mud: [patch] };
    const radii: number[] = [];
    for (let ray = 0; ray < 24; ray++) {
      const angle = ray * Math.PI / 12;
      const at = (radius: number) => ({ x: patch.cx + Math.cos(angle) * patch.halfLength * radius, y: patch.cy + Math.sin(angle) * patch.halfWidth * radius });
      let inside = 0;
      let outside = 1;
      for (let search = 0; search < 16; search++) {
        const radius = (inside + outside) / 2;
        const point = at(radius);
        if (isMudAt(zones, point.x, point.y)) inside = radius;
        else outside = radius;
      }
      radii.push(inside);
      expect(terrainEffectsAt(zones, 99, at(inside * 0.97)).speedMult).toBe(CONFIG.terrain.effects.mud.speedMult);
      expect(terrainEffectsAt(zones, 99, at(outside * 1.04)).speedMult).toBe(1);
    }
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.15);
    expect(generateTerrain(32).zones.mud.every((mud) => mud.shapeSeed !== undefined)).toBe(true);
    expect(generateTerrain(32, true, 1).zones.mud.every((mud) => mud.shapeSeed === undefined)).toBe(true);
  });

  it('keeps roads connected, clear of structures and trees, and bridged over rivers across 120 seeds', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const data = generateTerrain(seed);
      const { terrain, layout, zones } = data;
      expect(layout).toBeDefined();
      // Every secondary street intersects a through road, directly or through
      // another cross street; the rendered network is one connected component.
      const connected = new Set([0]);
      for (let pass = 0; pass < layout!.roads.length; pass++) {
        layout!.roads.forEach((road, index) => {
          if ([...connected].some((other) => {
            const target = layout!.roads[other]!;
            return road.points.slice(1).some((end, segment) => {
              const start = road.points[segment]!;
              const length = Math.hypot(end.x - start.x, end.y - start.y);
              const steps = Math.max(1, Math.ceil(length / 8));
              for (let step = 0; step <= steps; step++) {
                const point = { x: start.x + (end.x - start.x) * step / steps, y: start.y + (end.y - start.y) * step / steps };
                if (distanceToRoad(target, point) <= 6) return true;
              }
              return false;
            });
          })) connected.add(index);
        });
      }
      expect(connected.size, `seed ${seed}; connected ${[...connected]}; roads ${layout!.roads.map((road) => `${road.roundabout ? 'ring' : ''}${JSON.stringify(road.points.slice(0, 2))}..${JSON.stringify(road.points.at(-1))}`).join('; ')}`).toBe(layout!.roads.length);
      expect(layout!.roads.some((road) => road.points.some((point) => point.y === 0)), `north road seed ${seed}`).toBe(true);
      expect(layout!.roads.some((road) => road.points.some((point) => point.y === CONFIG.field.height)), `south road seed ${seed}`).toBe(true);
      for (const road of layout!.roads) {
        for (let i = 1; i < road.points.length; i++) {
          const a = road.points[i - 1]!;
          const b = road.points[i]!;
          const length = Math.hypot(b.x - a.x, b.y - a.y);
          for (let offset = 0; offset <= length; offset += 6) {
            const point = { x: a.x + (b.x - a.x) * offset / length, y: a.y + (b.y - a.y) * offset / length };
            if (point.x >= CONFIG.field.width || point.y >= CONFIG.field.height) continue;
            const index = Math.floor(point.y / terrain.cell) * terrain.cols + Math.floor(point.x / terrain.cell);
            expect(terrain.blocked[index], `road obstructed on seed ${seed}`).toBe(0);
            if (isRiverAt(zones, seed, point.x, point.y)) expect(isBridgeAt(zones, seed, point.x, point.y), `missing bridge on seed ${seed}`).toBe(true);
            else expect(terrainEffectsAt(zones, seed, point).speedMult).toBe(1);
          }
        }
      }
    }
  });

  it('adds smooth bends and connected roundabouts to village plans', () => {
    let curvedRoutes = 0;
    let roundabouts = 0;
    for (let seed = 1; seed <= 240; seed++) {
      // Road layout is shared by versions 2 and 3; skip unrelated heightfields.
      const layout = generateTerrain(seed, true, 2).layout!;
      for (const road of layout.roads) {
        if (road.roundabout) {
          roundabouts++;
          expect(road.points[0]).toEqual(road.points[road.points.length - 1]);
          expect(road.points.length).toBeGreaterThan(24);
          const ringPoints = road.points.slice(0, -1);
          const center = ringPoints.reduce((sum, point) => ({ x: sum.x + point.x / ringPoints.length, y: sum.y + point.y / ringPoints.length }), { x: 0, y: 0 });
          const islandRadius = Math.hypot(road.points[0]!.x - center.x, road.points[0]!.y - center.y) - road.halfWidth - 1;
          for (const approach of layout.roads.filter((candidate) => candidate !== road)) {
            expect(distanceToRoad(approach, center), `road crosses roundabout island on seed ${seed}`).toBeGreaterThan(islandRadius + approach.halfWidth - 1);
          }
        }
        for (let i = 2; i < road.points.length; i++) {
          const prior = road.points[i - 2]!;
          const before = road.points[i - 1]!;
          const point = road.points[i]!;
          const cross = (before.x - prior.x) * (point.y - before.y) - (before.y - prior.y) * (point.x - before.x);
          if (Math.abs(cross) > 0.01) curvedRoutes++;
        }
      }
    }
    expect(roundabouts).toBeGreaterThan(0);
    expect(curvedRoutes).toBeGreaterThan(0);
  });

  it('puts buildings on frontage and keeps farm and woodland building rosters appropriate', () => {
    const families = new Set<string>();
    for (let seed = 1; seed <= 120; seed++) {
      const data = generateTerrain(seed);
      const layout = data.layout!;
      families.add(layout.archetype);
      for (const building of data.buildings) {
        const cell = data.terrain.cell;
        const left = building.col * cell;
        const top = building.row * cell;
        const right = left + building.cols * cell;
        const bottom = top + building.rows * cell;
        const perimeter = [{ x: left, y: (top + bottom) / 2 }, { x: right, y: (top + bottom) / 2 }, { x: (left + right) / 2, y: top }, { x: (left + right) / 2, y: bottom }];
        expect(Math.min(...layout.roads.flatMap((road) => perimeter.map((point) => distanceToRoad(road, point)))), `frontage seed ${seed}`).toBeLessThanOrEqual(cell * 1.5);
        expect(bottom).toBeLessThan(CONFIG.deploymentZone.yMin);
      }
      if (layout.archetype === 'village') expect(data.buildings.filter((building) => building.kind === 'house').length, `village seed ${seed}`).toBeGreaterThanOrEqual(4);
      if (['farm', 'bocage', 'fields'].includes(layout.archetype)) {
        expect(data.buildings.some((building) => building.kind === 'barn'), `farm seed ${seed}`).toBe(true);
        expect(data.buildings.every((building) => building.kind === 'barn' || building.kind === 'house')).toBe(true);
        expect(layout.fields.length).toBeGreaterThan(0);
      }
      if (layout.archetype === 'forest') expect(data.buildings.every((building) => building.kind === 'house')).toBe(true);
      if (layout.archetype === 'fields') {
        const treeCounts = [7, 15, 22].map((row) => [...data.kinds.slice(row * data.terrain.cols, (row + 1) * data.terrain.cols)].filter((kind) => [TERRAIN_KIND.oak, TERRAIN_KIND.beech, TERRAIN_KIND.birch].includes(kind as 11 | 12 | 13)).length);
        expect(Math.max(...treeCounts), `tree line seed ${seed}`).toBeGreaterThan(15);
      }
      if (data.settingId === 1) expect([...data.kinds].filter((kind) => kind === TERRAIN_KIND.fruitTree).length, `orchard seed ${seed}`).toBeGreaterThan(0);
    }
    expect([...families].sort()).toEqual(['bocage', 'farm', 'fields', 'forest', 'village']);
  });

  it('preserves seeded plans through save validation and restoration, including barns and ruins', () => {
    for (const seed of [7, 11, 2026, 31337]) {
      const sim = new Simulation(seed);
      const first = sim.state.buildings[0]!;
      sim.damageBuilding(first, first.maxHealth);
      const result = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
      expect(result).toHaveProperty('snap');
      if (!('snap' in result)) throw new Error(result.error);
      const restored = Simulation.fromSnapshot(result.snap);
      expect(restored.terrainData()).toEqual(sim.terrainData());
      expect(restored.state.terrain.blocked).toEqual(sim.state.terrain.blocked);
      expect(restored.state.buildings).toEqual(sim.state.buildings);
    }
  });

  it('retains the old terrain for snapshots made before the landscape generator', () => {
    const legacy = new Simulation(7, undefined, generateTerrain(7, true, 1));
    const snap = legacy.snapshot();
    delete snap.terrainLayoutVersion;
    const result = validateSnapshot(JSON.parse(JSON.stringify(snap)));
    if (!('snap' in result)) throw new Error(result.error);
    const restored = Simulation.fromSnapshot(result.snap);
    expect(restored.terrainData().layoutVersion).toBe(1);
    expect(restored.terrainData().layout).toBeUndefined();
    expect(restored.state.terrain.blocked).toEqual(legacy.state.terrain.blocked);
    expect(restored.state.buildings).toEqual(legacy.state.buildings);
  });

  it('keeps legacy maps without buildings empty across repeated validated saves', () => {
    let sim = new Simulation(7, undefined, generateTerrain(7, false, 1), false);
    const original = sim.state.terrain.blocked.slice();
    for (let reload = 0; reload < 2; reload++) {
      const result = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
      if (!('snap' in result)) throw new Error(result.error);
      sim = Simulation.fromSnapshot(result.snap);
      expect(sim.state.buildings).toEqual([]);
      expect(sim.state.terrain.blocked).toEqual(original);
      expect(sim.terrainData().layoutVersion).toBe(1);
    }
  });
});
