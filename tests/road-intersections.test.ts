import { describe, expect, it } from 'vitest';
import { CAMPAIGN_COUNTRIES } from '../src/content/campaigns';
import { roadBasePasses } from '../src/game/road-drawing';
import { distanceToRoad, generateTerrain } from '../src/simulation/terrain';
import type { LandscapeRoad } from '../src/simulation/terrain';
import type { Vec2 } from '../src/simulation/types';

function roadsTouch(a: LandscapeRoad, b: LandscapeRoad): boolean {
  for (let i = 1; i < a.points.length; i++) {
    const start = a.points[i - 1]!;
    const end = a.points[i]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(length / 3));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
      if (distanceToRoad(b, point) <= a.halfWidth + b.halfWidth + 0.5) return true;
    }
  }
  return false;
}

function connectedRoads(roads: readonly LandscapeRoad[]): boolean {
  if (roads.length === 0) return true;
  const connected = new Set([0]);
  for (let pass = 0; pass < roads.length; pass++) {
    for (let index = 0; index < roads.length; index++) {
      if (connected.has(index)) continue;
      if ([...connected].some((other) => roadsTouch(roads[index]!, roads[other]!))) connected.add(index);
    }
  }
  return connected.size === roads.length;
}

function angleBetween(a: Vec2, b: Vec2): number {
  const dot = a.x * b.x + a.y * b.y;
  const magnitude = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
  return Math.acos(Math.max(-1, Math.min(1, dot / magnitude))) * 180 / Math.PI;
}

describe('road intersection geometry and rendering', () => {
  it('paints all shoulders before opaque road surfaces to make intersections a single surface union', () => {
    const crossroads: LandscapeRoad[] = [
      { points: [{ x: 0, y: 32 }, { x: 64, y: 32 }], halfWidth: 10, surface: 'dirt' },
      { points: [{ x: 32, y: 0 }, { x: 32, y: 64 }], halfWidth: 10, surface: 'dirt' },
      { points: [{ x: 4, y: 4 }, { x: 32, y: 32 }, { x: 60, y: 60 }], halfWidth: 8, surface: 'dirt' },
    ];
    const passes = roadBasePasses(crossroads);
    expect(passes).toHaveLength(crossroads.length * 2);
    expect(passes.slice(0, crossroads.length).every((pass) => pass.layer === 'shoulder')).toBe(true);
    expect(passes.slice(crossroads.length).every((pass) => pass.layer === 'surface')).toBe(true);
    expect(passes.every((pass) => pass.alpha === 1)).toBe(true);

    // Model source-over at the shared center: after the surface pass, drawing
    // another intersecting road cannot darken the pixel or expose the shoulder.
    const center = { x: 32, y: 32 };
    let pixel = 0x514a3b;
    for (const pass of passes) {
      if (distanceToRoad(pass.road, center) <= pass.width / 2) pixel = pass.color;
    }
    expect(pixel).toBe(0x89734e);
  });

  it('keeps every road network connected across all campaign countries and many seeds', () => {
    for (const country of CAMPAIGN_COUNTRIES) {
      for (let seed = 1; seed <= 48; seed++) {
        const roads = generateTerrain(seed, false, 2, country).layout!.roads;
        expect(connectedRoads(roads), `${country}, seed ${seed}`).toBe(true);
        expect(new Set(roads.map((road) => road.surface)).size, `${country}, seed ${seed}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps vertical bends smooth and anchored at their connections', () => {
    for (const country of CAMPAIGN_COUNTRIES) {
      for (let seed = 1; seed <= 36; seed++) {
        const roads = generateTerrain(seed, false, 2, country).layout!.roads;
        const vertical = roads.filter((road) => {
          const xs = road.points.map((point) => point.x);
          const ys = road.points.map((point) => point.y);
          return Math.max(...ys) - Math.min(...ys) > (Math.max(...xs) - Math.min(...xs)) * 2;
        });
        expect(vertical.length, `${country}, seed ${seed}`).toBeGreaterThan(0);
        expect(vertical.some((road) => Math.max(...road.points.map((point) => point.x)) - Math.min(...road.points.map((point) => point.x)) >= 6), `${country}, seed ${seed}: no visible vertical bend`).toBe(true);
        for (const road of vertical) {
          for (let i = 2; i < road.points.length; i++) {
            const a = { x: road.points[i - 1]!.x - road.points[i - 2]!.x, y: road.points[i - 1]!.y - road.points[i - 2]!.y };
            const b = { x: road.points[i]!.x - road.points[i - 1]!.x, y: road.points[i]!.y - road.points[i - 1]!.y };
            expect(angleBetween(a, b), `${country}, seed ${seed}: abrupt bend`).toBeLessThan(35);
          }
        }
      }
    }
  });

  it('keeps roundabout islands clear while every approach joins the carriageway', () => {
    let foundRoundabout = false;
    for (const country of CAMPAIGN_COUNTRIES) {
      for (let seed = 1; seed <= 48; seed++) {
        const roads = generateTerrain(seed, false, 2, country).layout!.roads;
        for (const ring of roads.filter((road) => road.roundabout)) {
          foundRoundabout = true;
          expect(ring.points[0]).toEqual(ring.points.at(-1));
          const ringPoints = ring.points.slice(0, -1);
          const center = ringPoints.reduce((sum, point) => ({ x: sum.x + point.x / ringPoints.length, y: sum.y + point.y / ringPoints.length }), { x: 0, y: 0 });
          const islandRadius = Math.hypot(ring.points[0]!.x - center.x, ring.points[0]!.y - center.y) - ring.halfWidth - 1;
          const approaches = roads.filter((road) => road !== ring && roadsTouch(ring, road));
          expect(approaches.length, `${country}, seed ${seed}: four ring approaches`).toBe(4);
          for (const approach of approaches) {
            expect(distanceToRoad(approach, center), `${country}, seed ${seed}: road intrudes on island`).toBeGreaterThan(islandRadius + approach.halfWidth - 1);
            expect(roadsTouch(ring, approach), `${country}, seed ${seed}: approach detached from ring`).toBe(true);
          }
        }
      }
    }
    expect(foundRoundabout).toBe(true);
  }, 30_000);
});
