import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { isRiverAt, type TerrainData } from '../../simulation/terrain';
import { deriveRng, rngRange } from '../../simulation/rng';
import { riverOutline } from './terrain-surface';
import { insideField } from './coordinates';

/** Tiny bank growth is cosmetic; all soldier-height cover comes from terrain cells. */
export function riverDressing(data: TerrainData, ground: (x: number, y: number) => [number, number, number]): THREE.Group {
  const group = new THREE.Group(); group.name = 'river-bank-dressing';
  if (!data.zones.river) return group;
  const rng = deriveRng(data.seed, 0x52454544);
  const points = riverOutline(data, 1, 4).filter((point, i) => i % 7 === 0 && insideField(point.x, point.y)
    && !isRiverAt(data.zones, data.seed, point.x, point.y)
    && !data.zones.bridges.some((bridge) => Math.hypot(bridge.x - point.x, bridge.y - point.y) < bridge.halfLength + 18));
  if (!points.length) return group;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(new THREE.ConeGeometry(.018, .16 + i * .018, 3).translate((i % 2) * .06, .08, Math.floor(i / 2) * .05));
  }
  const geometry = mergeGeometries(parts)!; parts.forEach((part) => part.dispose());
  const reeds = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: data.season === 'winter' ? 0x99927a : 0x687546, roughness: 1 }), points.length);
  reeds.name = 'bank-reeds'; reeds.receiveShadow = true;
  const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(.05, 0), new THREE.MeshStandardMaterial({ color: 0x8a8977, roughness: 1 }), points.length);
  stones.name = 'bank-stones'; stones.receiveShadow = true;
  const transform = new THREE.Object3D();
  points.forEach((point, i) => {
    const [x, y, z] = ground(point.x, point.y);
    transform.position.set(x, y + .015, z); transform.rotation.set(0, rngRange(rng, 0, Math.PI * 2), 0);
    transform.scale.setScalar(rngRange(rng, .6, 1.2)); transform.updateMatrix(); reeds.setMatrixAt(i, transform.matrix);
    transform.position.x += .08; transform.scale.set(rngRange(rng, .7, 1.6), .5, 1); transform.updateMatrix(); stones.setMatrixAt(i, transform.matrix);
  });
  reeds.instanceMatrix.needsUpdate = true; stones.instanceMatrix.needsUpdate = true;
  group.add(reeds, stones); return group;
}

/** A hipped roof stays within the authoritative rectangular building footprint. */
export function hippedRoofGeometry(width: number, depth: number, rise: number): THREE.BufferGeometry {
  const x = width / 2, z = depth / 2;
  const alongX = width >= depth;
  const a = alongX ? [-Math.max(0, x - z * .7), rise, 0] : [0, rise, -Math.max(0, z - x * .7)];
  const b = alongX ? [Math.max(0, x - z * .7), rise, 0] : [0, rise, Math.max(0, z - x * .7)];
  const corners = [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]];
  const faces = alongX ? [[corners[0]!, a, b], [corners[0]!, b, corners[1]!], [corners[1]!, b, corners[2]!], [corners[2]!, b, a], [corners[2]!, a, corners[3]!], [corners[3]!, a, corners[0]!]]
    : [[corners[0]!, a, corners[1]!], [corners[1]!, a, b], [corners[1]!, b, corners[2]!], [corners[2]!, b, corners[3]!], [corners[3]!, b, a], [corners[3]!, a, corners[0]!]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces.flat(2), 3));
  geometry.computeVertexNormals(); return geometry;
}
