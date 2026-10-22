import { TERRAIN_KIND } from '../../simulation/terrain';
import type { Terrain, Vec2 } from '../../simulation/types';

export interface FenceSegment {
  from: Vec2;
  to: Vec2;
}

/** Join neighboring boundary cells, including changes of fence material. */
export function fenceSegments(terrain: Terrain, kinds: Uint8Array, col: number, row: number): FenceSegment[] {
  const boundaryAt = (x: number, y: number): boolean => {
    if (x < 0 || x >= terrain.cols || y < 0 || y >= terrain.rows) return false;
    const kind = kinds[y * terrain.cols + x];
    return kind === TERRAIN_KIND.woodFence || kind === TERRAIN_KIND.stoneFence || kind === TERRAIN_KIND.trees;
  };
  const center = { x: (col + .5) * terrain.cell, y: (row + .5) * terrain.cell };
  const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
  const connected = neighbors.filter(([dx, dy]) => boundaryAt(col + dx, row + dy));
  const horizontal = connected.some(([dx]) => dx !== 0);
  const vertical = connected.some(([, dy]) => dy !== 0);
  if (horizontal && vertical) {
    // Corners and junctions meet at the center instead of choosing one axis.
    return connected.map(([dx, dy]) => ({ from: { ...center }, to: { x: center.x + dx * terrain.cell / 2, y: center.y + dy * terrain.cell / 2 } }));
  }
  let alongY = vertical;
  if (!horizontal && !vertical) {
    // A single surviving section beside a gate can still inherit its run's
    // direction. Look across the gap for orientation only; never fill the gap.
    for (let distance = 2; distance <= 4; distance++) {
      const across = boundaryAt(col - distance, row) || boundaryAt(col + distance, row);
      const down = boundaryAt(col, row - distance) || boundaryAt(col, row + distance);
      if (across || down) { alongY = down && !across; break; }
    }
  }
  const dx = alongY ? 0 : terrain.cell / 2, dy = alongY ? terrain.cell / 2 : 0;
  return [{ from: { x: center.x - dx, y: center.y - dy }, to: { x: center.x + dx, y: center.y + dy } }];
}
