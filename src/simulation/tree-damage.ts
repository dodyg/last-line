import { TERRAIN_KIND } from './terrain';
import { elevationAt } from './elevation';
import type { Terrain, Vec2 } from './types';

export const TREE_HEALTH = 100;
export const isTreeKind = (kind: number): boolean => kind === TERRAIN_KIND.trees || kind === TERRAIN_KIND.oak
  || kind === TERRAIN_KIND.beech || kind === TERRAIN_KIND.birch || kind === TERRAIN_KIND.pine || kind === TERRAIN_KIND.fruitTree;

export function treeCellPosition(terrain: Pick<Terrain, 'cell' | 'cols'>, cell: number): Vec2 {
  return { x: (cell % terrain.cols + .5) * terrain.cell, y: (Math.floor(cell / terrain.cols) + .5) * terrain.cell };
}

/** Closest crown struck by a missed round. Adjacent cells catch branches overhanging their cell. */
export function treeOnShot(terrain: Terrain, kinds: Uint8Array, from: Vec2, to: Vec2, fromHeight = 0, toHeight = 0): number | null {
  const dx = to.x - from.x, dy = to.y - from.y, squared = dx * dx + dy * dy;
  if (squared < 1) return null;
  const steps = Math.ceil(Math.sqrt(squared) / (terrain.cell * .35)), seen = new Set<number>();
  let result: number | null = null, best = Infinity;
  for (let step = 0; step <= steps; step++) {
    const col = Math.floor((from.x + dx * step / steps) / terrain.cell), row = Math.floor((from.y + dy * step / steps) / terrain.cell);
    for (let r = row - 1; r <= row + 1; r++) for (let c = col - 1; c <= col + 1; c++) {
      if (r < 0 || c < 0 || r >= terrain.rows || c >= terrain.cols) continue;
      const cell = r * terrain.cols + c; if (seen.has(cell)) continue; seen.add(cell);
      if (!isTreeKind(kinds[cell]!)) continue;
      const center = treeCellPosition(terrain, cell), t = ((center.x - from.x) * dx + (center.y - from.y) * dy) / squared;
      if (t <= 0 || t > 1 || t >= best || Math.hypot(center.x - from.x, center.y - from.y) < terrain.cell * .65) continue;
      if (Math.hypot(center.x - from.x - dx * t, center.y - from.y - dy * t) > terrain.cell * .38) continue;
      const height = kinds[cell] === TERRAIN_KIND.trees ? 19 : kinds[cell] === TERRAIN_KIND.fruitTree ? 29 : 45;
      if (fromHeight + (toHeight - fromHeight) * t > elevationAt(terrain, center.x, center.y) + height) continue;
      best = t; result = cell;
    }
  }
  return result;
}
