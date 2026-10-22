import * as THREE from 'three';
import { CONFIG } from '../../content/config';
import { elevationAt, slopeAt } from '../../simulation/elevation';
import type { Terrain } from '../../simulation/types';
import { simulationToWorld, WORLD_UNITS_PER_PIXEL } from './coordinates';

/** Height, triangles, and UVs share the simulation's exact sampling convention. */
export function heightfieldGeometry(terrain?: Terrain, bounds?: { x: number; y: number; width: number; height: number }): THREE.BufferGeometry {
  const grid = terrain?.elevation;
  const width = bounds?.width ?? CONFIG.field.width, height = bounds?.height ?? CONFIG.field.height;
  const cols = bounds ? Math.max(2, Math.ceil(width / 12) + 1) : grid?.cols ?? 2;
  const rows = bounds ? Math.max(2, Math.ceil(height / 12) + 1) : grid?.rows ?? 2;
  const positions: number[] = [], uv: number[] = [], colors: number[] = [], indices: number[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x = (bounds?.x ?? 0) + col / (cols - 1) * width, y = (bounds?.y ?? 0) + row / (rows - 1) * height;
    const elevation = terrain ? elevationAt(terrain, x, y) : 0;
    positions.push(...simulationToWorld(x, y, elevation * WORLD_UNITS_PER_PIXEL));
    uv.push(col / (cols - 1), 1 - row / (rows - 1));
    const slope = terrain ? slopeAt(terrain, x, y) : 0;
    // Exposed steep faces are slightly earthy; height itself is lit in 3D.
    const rocky = Math.min(1, slope / .9);
    colors.push(1 - rocky * .05, 1 - rocky * .15, 1 - rocky * .23);
    if (col + 1 < cols && row + 1 < rows) {
      const a = row * cols + col, b = a + 1, c = a + cols, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Large range/strike markers follow slopes rather than disappearing into hills. */
export function drapedRingGeometry(terrain: Terrain | null, center: { x: number; y: number }, inner: number, outer: number, offset = .045): THREE.BufferGeometry {
  const geometry = new THREE.RingGeometry(inner, outer, 64);
  geometry.rotateX(-Math.PI / 2);
  const [x, , z] = simulationToWorld(center.x, center.y);
  geometry.translate(x, 0, z);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const sx = positions.getX(i) / WORLD_UNITS_PER_PIXEL + CONFIG.field.width / 2;
    const sy = positions.getZ(i) / WORLD_UNITS_PER_PIXEL + CONFIG.field.height / 2;
    positions.setY(i, (terrain ? elevationAt(terrain, sx, sy) * WORLD_UNITS_PER_PIXEL : 0) + offset);
  }
  geometry.computeVertexNormals();
  return geometry;
}
