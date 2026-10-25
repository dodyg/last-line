import * as THREE from 'three';
import type { VehicleTrack } from '../../simulation/battle-wear';
import type { Vec2 } from '../../simulation/types';
import { deriveRng, rngRange } from '../../simulation/rng';
import { WORLD_UNITS_PER_PIXEL } from './coordinates';

/** Twin ribbons drape over the heightfield; gaps retain the ground's own texture. */
export function vehicleTrackGeometry(tracks: readonly VehicleTrack[], ground: (x: number, y: number) => [number, number, number]): THREE.BufferGeometry {
  const vertices: number[] = [];
  for (const track of tracks) {
    const dx = track.to.x - track.from.x, dy = track.to.y - track.from.y, length = Math.hypot(dx, dy);
    if (length < .01) continue;
    const nx = -dy / length, ny = dx / length;
    const steps = Math.max(1, Math.ceil(length / 4));
    for (let step = 0; step < steps; step++) for (const side of [-1, 1]) {
      const corners: number[][] = [];
      for (const [t, edge] of [[step / steps, -1], [(step + .9) / steps, -1], [(step + .9) / steps, 1], [step / steps, 1]]) {
        const offset = side * 5 + edge! * 1.1;
        const point = ground(track.from.x + dx * t! + nx * offset, track.from.y + dy * t! + ny * offset);
        corners.push([point[0], point[1] + .012, point[2]]);
      }
      for (const i of [0, 2, 1, 0, 3, 2]) vertices.push(...corners[i]!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.computeVertexNormals(); return geometry;
}

/** Vertex alpha fades the scorch halo into the existing ground without a hard decal edge. */
export function scorchGeometry(radius: number, seed: number, ground: (x: number, z: number) => number, land: (x: number, z: number) => boolean): THREE.BufferGeometry {
  const rng = deriveRng(seed, 0x53434f52), vertices: number[] = [], colors: number[] = [];
  const points: Vec2[] = Array.from({ length: 32 }, (_, i) => {
    const angle = i / 32 * Math.PI * 2, r = radius * WORLD_UNITS_PER_PIXEL * rngRange(rng, 1.45, 2.15);
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const triangle = [{ x: 0, y: 0 }, b, a];
    if (!triangle.every((p) => land(p.x, p.y))) continue;
    triangle.forEach((p, corner) => {
      vertices.push(p.x, ground(p.x, p.y) + .009, p.y);
      colors.push(.12, .10, .075, corner === 0 ? .42 : 0);
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4)); return geometry;
}
