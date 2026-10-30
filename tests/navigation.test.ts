import { describe, expect, it } from 'vitest';
import { findPath } from '../src/simulation/navigation';
import { cellCenter, isBlockedAt } from '../src/simulation/terrain';
import type { Terrain } from '../src/simulation/types';

function grid(cols = 24, rows = 24): Terrain {
  return { cell: 24, cols, rows, blocked: new Uint8Array(cols * rows) };
}

describe('navigation', () => {
  it('matches independent shortest-path costs on seeded weighted maps', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const terrain = grid(8, 8);
      let random = seed;
      const costs = Array.from({ length: 64 }, (_, index) => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        terrain.blocked[index] = random / 2 ** 32 < .2 ? 1 : 0;
        return 1 + (random % 5) * .3;
      });
      terrain.blocked[0] = 0; terrain.blocked[63] = 0;
      // Dijkstra reference: no heuristic or priority queue, full precision.
      const distances = Array<number>(64).fill(Infinity);
      const visited = new Set<number>();
      distances[0] = 0;
      for (;;) {
        let current = -1;
        for (let i = 0; i < 64; i++) {
          if (!visited.has(i) && distances[i]! < (current === -1 ? Infinity : distances[current]!)) current = i;
        }
        if (current === -1 || current === 63) break;
        visited.add(current);
        const col = current % 8, row = Math.floor(current / 8);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const x = col + dx, y = row + dy;
          if (x < 0 || x >= 8 || y < 0 || y >= 8 || terrain.blocked[y * 8 + x]) continue;
          if (dx && dy && (terrain.blocked[row * 8 + x] || terrain.blocked[y * 8 + col])) continue;
          const next = y * 8 + x;
          distances[next] = Math.min(distances[next]!, distances[current]! + Math.hypot(dx, dy) * costs[next]!);
        }
      }
      const weight = (point: { x: number; y: number }) => costs[Math.floor(point.y / 24) * 8 + Math.floor(point.x / 24)]!;
      const start = cellCenter(terrain, 0, 0);
      const route = findPath(terrain, start, cellCenter(terrain, 7, 7), weight);
      expect(route.reachable, `seed ${seed}`).toBe(Number.isFinite(distances[63]));
      if (!route.reachable) continue;
      let previous = start, actual = 0;
      for (const point of route.waypoints) {
        expect(isBlockedAt(terrain, point.x, point.y)).toBe(false);
        actual += Math.hypot(point.x - previous.x, point.y - previous.y) / 24 * weight(point);
        previous = point;
      }
      expect(actual, `seed ${seed}`).toBeCloseTo(distances[63]!, 10);
    }
  });

  it('stops in the open cell when a blocked destination is nudged back to the start', () => {
    const terrain = grid(3, 3);
    terrain.blocked[4] = 1;
    const start = cellCenter(terrain, 0, 0);
    const route = findPath(terrain, start, cellCenter(terrain, 1, 1));
    expect(route).toEqual({ reachable: true, waypoints: [start] });
    expect(route.waypoints.every((point) => !isBlockedAt(terrain, point.x, point.y))).toBe(true);
  });

  it('returns unreachable when a wall separates the goal from the starting component', () => {
    const terrain = grid();
    // Separate the goal so the entire reachable component must be searched.
    for (let row = 0; row < terrain.rows; row++) terrain.blocked[row * terrain.cols + 20] = 1;
    const route = findPath(terrain, cellCenter(terrain, 0, 0), cellCenter(terrain, 23, 23), (point) => {
      return 1 + ((point.x / 24 + point.y / 24) % 3);
    });
    expect(route.reachable).toBe(false);
    expect(route.waypoints).toEqual([]);
  });

  it('keeps equal-cost routes deterministic and avoids diagonal corner cutting', () => {
    const terrain = grid(3, 3);
    terrain.blocked[1] = 1;
    terrain.blocked[3] = 1;
    expect(findPath(terrain, cellCenter(terrain, 0, 0), cellCenter(terrain, 2, 2)).reachable).toBe(false);
    terrain.blocked[3] = 0;
    const route = findPath(terrain, cellCenter(terrain, 0, 0), cellCenter(terrain, 2, 2), () => 1);
    expect(route.reachable).toBe(true);
    expect(route.waypoints[0]).toEqual(cellCenter(terrain, 0, 1));
    expect(findPath(terrain, cellCenter(terrain, 0, 0), cellCenter(terrain, 2, 2), () => 1)).toEqual(route);
  });
});
