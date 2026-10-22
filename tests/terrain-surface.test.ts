import { describe, expect, it } from 'vitest';
import { riverOutline, mudOutline } from '../src/render/app/terrain-surface';
import { generateTerrain, isRiverAt, mudPatchDistance, riverPathPoints } from '../src/simulation/terrain';
import type { Vec2 } from '../src/simulation/types';

function contains(polygon: readonly Vec2[], point: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

describe('continuous terrain rendering', () => {
  it('keeps horizontal, vertical, and diagonal channels aligned with actual water', () => {
    const orientations = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const data = generateTerrain(seed, false, 2);
      const river = data.zones.river;
      if (!river) { expect(riverOutline(data)).toEqual([]); continue; }
      orientations.add(river.orientation ?? 'horizontal');
      const outline = riverOutline(data);
      for (const center of riverPathPoints(river, seed, 24).slice(2, -2)) {
        expect(contains(outline, center), `centerline seed ${seed}`).toBe(true);
        expect(isRiverAt(data.zones, seed, center.x, center.y)).toBe(true);
      }
      // Water has a continuous contour, not cell-sized right-angle stairs.
      for (let i = 1; i < outline.length / 2; i++) expect(Math.hypot(outline[i]!.x - outline[i - 1]!.x, outline[i]!.y - outline[i - 1]!.y)).toBeLessThan(8);
    }
    expect(orientations).toEqual(new Set(['horizontal', 'vertical', 'diagonal']));
  });

  it('matches irregular mud boundaries and stays deterministic', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const data = generateTerrain(seed, false, 2);
      for (const patch of data.zones.mud) {
        const outline = mudOutline(patch);
        expect(mudOutline(patch)).toEqual(outline);
        for (const point of outline) expect(mudPatchDistance(patch, point.x, point.y)).toBeCloseTo(1, 3);
        expect(contains(outline, { x: patch.cx, y: patch.cy })).toBe(true);
      }
    }
  });

  it('does not change terrain kinds, passability, roads, or random state when calculating contours', () => {
    const data = generateTerrain(2026, true, 2);
    const before = JSON.stringify(data);
    riverOutline(data);
    data.zones.mud.forEach(mudOutline);
    expect(JSON.stringify(data)).toBe(before);
  });
});
