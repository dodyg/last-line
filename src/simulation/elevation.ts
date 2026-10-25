import { CONFIG } from '../content/config';
import { deriveRng, rngRange } from './rng';
import type { Terrain, Vec2 } from './types';
import { bridgesBlockSight } from './bridges';

export type TraversalMode = 'infantry' | 'vehicle';
// Rise/run: infantry walk ordinary slopes; hands-and-knees movement starts
// around 33 degrees. Vehicle and unscalable-face limits are independent.
export const ELEVATION = { levelHeight: 20, walkGrade: .65, vehicleGrade: .3, climbGrade: 1.6 } as const;

const smooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function elevationLineOfSight(terrain: Terrain, from: Vec2, to: Vec2, fromEye = 12, toEye = 12): boolean {
  if (bridgesBlockSight(terrain, from, to, fromEye, toEye)) return false;
  if (!terrain.elevation) return true;
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (terrain.elevation.cell / 2)));
  const start = elevationAt(terrain, from.x, from.y) + fromEye, end = elevationAt(terrain, to.x, to.y) + toEye;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (elevationAt(terrain, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t) > start + (end - start) * t) return false;
  }
  return true;
}

/** Three rounded terraces per hill, with a broader approach on one side. */
export function generateElevation(terrain: Terrain, seed: number, flatAt: (x: number, y: number) => boolean, relief = 1, defensiveRidges: readonly Vec2[] = []): void {
  const cell = terrain.cell / 2;
  const cols = terrain.cols * 2 + 1, rows = terrain.rows * 2 + 1;
  const heights = new Float32Array(cols * rows);
  const distance = new Float32Array(cols * rows).fill(10_000);
  const rng = deriveRng(seed, 0x48494c4c);
  const hills = Array.from({ length: 4 }, (_, i) => ({
    x: rngRange(rng, i % 2 ? 480 : 170, i % 2 ? 790 : 450),
    y: rngRange(rng, 150 + i * 65, 245 + i * 65),
    rx: rngRange(rng, 130, 195), ry: rngRange(rng, 95, 140), angle: rngRange(rng, -Math.PI, Math.PI),
  }));
  for (const pos of defensiveRidges) hills.push({ x: pos.x, y: pos.y + 18, rx: 90, ry: 72, angle: Math.PI / 2 });
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x = col * cell, y = row * cell, index = row * cols + col;
    if (x <= 72 || x >= CONFIG.field.width - 72 || y <= 72 || y >= CONFIG.deploymentZone.yMin - 16 || flatAt(x, y)) {
      distance[index] = 0;
      continue;
    }
    let height = 0;
    for (const hill of hills) {
      const dx = (x - hill.x) / hill.rx, dy = (y - hill.y) / hill.ry;
      const radius = Math.hypot(dx, dy);
      const approach = smooth((Math.cos(Math.atan2(dy, dx) - hill.angle) - .7) / .3);
      const feather = .22 + approach * .35;
      let h = 0;
      for (const edge of [1, .7, .4]) h += ELEVATION.levelHeight * smooth((edge - radius) / feather);
      height = Math.max(height, h);
    }
    heights[index] = height * relief;
  }
  // A distance transform blends the land into roads, water, foundations, and
  // protected deployment/exit routes without spending gameplay randomness.
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const i = row * cols + col;
    if (col > 0) distance[i] = Math.min(distance[i]!, distance[i - 1]! + cell);
    if (row > 0) distance[i] = Math.min(distance[i]!, distance[i - cols]! + cell);
  }
  for (let row = rows - 1; row >= 0; row--) for (let col = cols - 1; col >= 0; col--) {
    const i = row * cols + col;
    if (col + 1 < cols) distance[i] = Math.min(distance[i]!, distance[i + 1]! + cell);
    if (row + 1 < rows) distance[i] = Math.min(distance[i]!, distance[i + cols]! + cell);
    heights[i] = heights[i]! * smooth(distance[i]! / 48);
  }
  // Limit the steepest generated face to something infantry can scramble over.
  // These four sweeps preserve low ground while bounding both gradient axes.
  const step = cell * .95;
  for (let row = 0; row < rows; row++) {
    for (let col = 1; col < cols; col++) { const i = row * cols + col; heights[i] = Math.min(heights[i]!, heights[i - 1]! + step); }
    for (let col = cols - 2; col >= 0; col--) { const i = row * cols + col; heights[i] = Math.min(heights[i]!, heights[i + 1]! + step); }
  }
  for (let col = 0; col < cols; col++) {
    for (let row = 1; row < rows; row++) { const i = row * cols + col; heights[i] = Math.min(heights[i]!, heights[i - cols]! + step); }
    for (let row = rows - 2; row >= 0; row--) { const i = row * cols + col; heights[i] = Math.min(heights[i]!, heights[i + cols]! + step); }
  }
  terrain.elevation = { cols, rows, cell, heights };
}

/** Interpolate the same two triangles per cell used by the rendered heightfield. */
export function elevationAt(terrain: Terrain, x: number, y: number): number {
  const grid = terrain.elevation;
  if (!grid) return 0;
  const gx = Math.max(0, Math.min(grid.cols - 1, x / grid.cell)), gy = Math.max(0, Math.min(grid.rows - 1, y / grid.cell));
  const col = Math.min(grid.cols - 2, Math.floor(gx)), row = Math.min(grid.rows - 2, Math.floor(gy));
  const u = gx - col, v = gy - row, i = row * grid.cols + col;
  const a = grid.heights[i]!, b = grid.heights[i + 1]!, c = grid.heights[i + grid.cols]!, d = grid.heights[i + grid.cols + 1]!;
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

export function slopeAt(terrain: Terrain, x: number, y: number): number {
  const grid = terrain.elevation;
  if (!grid) return 0;
  const col = Math.max(0, Math.min(grid.cols - 2, Math.floor(x / grid.cell))), row = Math.max(0, Math.min(grid.rows - 2, Math.floor(y / grid.cell)));
  const i = row * grid.cols + col, u = x / grid.cell - col, v = y / grid.cell - row;
  const a = grid.heights[i]!, b = grid.heights[i + 1]!, c = grid.heights[i + grid.cols]!, d = grid.heights[i + grid.cols + 1]!;
  return u + v <= 1 ? Math.hypot(b - a, c - a) / grid.cell : Math.hypot(d - c, d - b) / grid.cell;
}

export function elevationTraversal(terrain: Terrain, from: Vec2, to: Vec2, mode: TraversalMode = 'infantry') {
  if (!terrain.elevation) return { allowed: true, requiresCrawl: false, cost: 1, speedMult: 1 };
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / (terrain.elevation.cell / 3)));
  let grade = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    grade = Math.max(grade, slopeAt(terrain, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t));
  }
  const requiresCrawl = grade > ELEVATION.walkGrade;
  const rise = elevationAt(terrain, to.x, to.y) - elevationAt(terrain, from.x, from.y);
  const signedGrade = distance > .01 ? rise / distance : 0;
  return {
    allowed: grade <= (mode === 'vehicle' ? ELEVATION.vehicleGrade : ELEVATION.climbGrade),
    requiresCrawl: mode === 'infantry' && requiresCrawl,
    cost: 1 + grade * 1.4 + (requiresCrawl ? 1.6 : 0) + Math.max(0, signedGrade),
    speedMult: signedGrade >= 0 ? 1 / (1 + signedGrade * 1.4) : Math.max(.65, 1 + signedGrade * .35),
  };
}
