import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { deriveRng, rngRange } from '../../simulation/rng';
import type { GroundImpactKind } from '../../simulation/types';
import { WORLD_UNITS_PER_PIXEL } from './coordinates';

export const GROUND_IMPACT_LOOK = {
  mortar: { radius: 12, rim: .08, aspect: 1, rays: 4, clods: 8, dust: 10, seconds: .95, color: 0x897452 },
  artillery: { radius: 24, rim: .16, aspect: 1.08, rays: 10, clods: 18, dust: 22, seconds: 1.5, color: 0x9c815b },
  airSupport: { radius: 32, rim: .24, aspect: 1.20, rays: 14, clods: 28, dust: 34, seconds: 2, color: 0xa18a68 },
} as const;

/** Raised, torn rims and dark basins drape over the existing terrain surface. */
export function groundImpactGeometry(kind: GroundImpactKind, seed: number, ground: (x: number, z: number) => number,
  land: (x: number, z: number) => boolean): THREE.BufferGeometry {
  const look = GROUND_IMPACT_LOOK[kind], r = look.radius * WORLD_UNITS_PER_PIXEL;
  const rng = deriveRng(seed, 0x43524154), rand = (lo: number, hi: number) => rngRange(rng, lo, hi);
  const rotation = rand(0, Math.PI * 2), segments = kind === 'mortar' ? 18 : 28;
  const jagged = Array.from({ length: segments }, () => rand(.82, 1.15));
  const parts: THREE.BufferGeometry[] = [], vertices: number[] = [], colors: number[] = [];
  const point = (radius: number, angle: number, height: number): THREE.Vector3 => {
    const x = Math.cos(angle) * radius * look.aspect, z = Math.sin(angle) * radius / look.aspect;
    const dx = Math.cos(rotation) * x - Math.sin(rotation) * z, dz = Math.sin(rotation) * x + Math.cos(rotation) * z;
    return new THREE.Vector3(dx, ground(dx, dz) + height, dz);
  };
  const triangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: number, variation = 1) => {
    if (![a, b, c].every((p) => land(p.x, p.z))) return;
    const tint = new THREE.Color(color).multiplyScalar(variation);
    for (const p of [a, c, b]) { vertices.push(p.x, p.y, p.z); colors.push(tint.r, tint.g, tint.b); }
  };
  const rings = [0, .33, .69, 1, 1.23, 1.44];
  const height = [.025, .029, look.rim * .42, look.rim, look.rim * .40, .026];
  const palette = [0x342c23, 0x46392a, 0x665039, 0x856b48, 0x6d593f];
  for (let ring = 0; ring < rings.length - 1; ring++) for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments, a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2;
    const p = (row: number, index: number, angle: number) => point(r * rings[row]! * jagged[index]!, angle, height[row]!);
    const innerA = p(ring, i, a), innerB = p(ring, next, b), outerA = p(ring + 1, i, a), outerB = p(ring + 1, next, b);
    const shade = rand(.88, 1.12);
    triangle(innerA, outerA, innerB, palette[ring]!, shade); triangle(innerB, outerA, outerB, palette[ring]!, shade);
  }
  // Ejecta rays break up the footprint; bomb scars throw longer, wider fans.
  for (let i = 0; i < look.rays; i++) {
    const angle = i / look.rays * Math.PI * 2 + rand(-.18, .18), spread = rand(.035, .10);
    const near = r * rand(.9, 1.2), far = r * rand(1.45, kind === 'airSupport' ? 2.15 : 1.95);
    triangle(point(near, angle - spread, .030), point(far, angle + rand(-.06, .06), .030), point(near, angle + spread, .030),
      i % 2 ? 0x665239 : 0x7b6547, rand(.9, 1.1));
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  surface.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); surface.computeVertexNormals(); parts.push(surface);
  for (let i = 0; i < look.clods; i++) {
    const angle = rand(0, Math.PI * 2), p = point(r * rand(.95, 1.85), angle, .02);
    if (!land(p.x, p.z)) continue;
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    geometry.scale(r * rand(.05, .12), r * rand(.035, .09), r * rand(.05, .14)); geometry.rotateY(angle); geometry.translate(p.x, p.y + r * .035, p.z);
    geometry.deleteAttribute('uv');
    const color = new THREE.Color(i % 4 === 0 ? 0x918065 : 0x645039).multiplyScalar(rand(.88, 1.08));
    const tint = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let j = 0; j < tint.length; j += 3) tint.set([color.r, color.g, color.b], j);
    geometry.setAttribute('color', new THREE.BufferAttribute(tint, 3)); parts.push(geometry);
  }
  const merged = mergeGeometries(parts, false)!; for (const part of parts) part.dispose();
  merged.computeBoundingSphere(); return merged;
}
