import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { distanceToRoad, isRiverAt, TERRAIN_KIND, type TerrainData } from '../../simulation/terrain';
import { CONFIG } from '../../content/config';
import { deriveRng, rngRange } from '../../simulation/rng';
import { riverOutline } from './terrain-surface';
import { insideField } from './coordinates';

export const MAX_BATTLEFIELD_DETAILS = 120;

/** Small cosmetic fragments cluster around existing cover, never in travel lanes. */
export function battlefieldDetails(data: TerrainData, ground: (x: number, y: number) => [number, number, number]): THREE.Group {
  const group = new THREE.Group(); group.name = 'battlefield-details';
  const rng = deriveRng(data.seed, 0x44454252), { cell, cols } = data.terrain;
  const points: Array<{ x: number; y: number; kind: number }> = [];
  const anchors: number[] = [TERRAIN_KIND.ruins, TERRAIN_KIND.stoneFence, TERRAIN_KIND.woodFence, TERRAIN_KIND.farmyard, TERRAIN_KIND.obstacle];
  // Reservoir sampling distributes a fixed budget over the whole map.
  let seen = 0;
  for (let i = 0; i < data.kinds.length; i++) {
    if (!anchors.includes(data.kinds[i]!)) continue;
    const x = (i % cols + .5) * cell + rngRange(rng, -18, 18), y = (Math.floor(i / cols) + .5) * cell + rngRange(rng, -18, 18);
    if (!insideField(x, y) || y >= CONFIG.deploymentZone.yMin || isRiverAt(data.zones, data.seed, x, y)) continue;
    if ((data.layout?.roads ?? data.zones.roads ?? []).some((road) => distanceToRoad(road, { x, y }) < road.halfWidth + 5)) continue;
    if (data.zones.bridges.some((bridge) => Math.hypot(x - bridge.x, y - bridge.y) < bridge.halfLength + 16)) continue;
    if (data.buildings.some((b) => x >= b.col * cell - 5 && x <= (b.col + b.cols) * cell + 5 && y >= b.row * cell - 5 && y <= (b.row + b.rows) * cell + 5)) continue;
    const point = { x, y, kind: data.kinds[i] === TERRAIN_KIND.woodFence ? 0 : data.kinds[i] === TERRAIN_KIND.farmyard ? 2 : 1 };
    seen++;
    if (points.length < MAX_BATTLEFIELD_DETAILS) points.push(point);
    else { const slot = Math.floor(rngRange(rng, 0, seen)); if (slot < points.length) points[slot] = point; }
  }
  const transform = new THREE.Object3D();
  for (let kind = 0; kind < 3; kind++) {
    const selected = points.filter((point) => point.kind === kind);
    if (!selected.length) continue;
    const geometry = kind === 0 ? new THREE.BoxGeometry(.22, .018, .035) : kind === 1 ? new THREE.DodecahedronGeometry(.055, 0) : new THREE.BoxGeometry(.12, .09, .12);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: [0x78644b, 0x927e65, 0x716248][kind], roughness: 1, flatShading: true }), selected.length);
    mesh.name = ['broken-boards', 'brick-fragments', 'abandoned-crates'][kind]!; mesh.receiveShadow = true;
    selected.forEach((point, i) => {
      const [x, y, z] = ground(point.x, point.y);
      const size = rngRange(rng, .7, 1.4);
      transform.position.set(x, y + (kind === 0 ? .012 : .045) * size, z);
      transform.rotation.set(0, rngRange(rng, 0, Math.PI * 2), 0); transform.scale.setScalar(size); transform.updateMatrix();
      mesh.setMatrixAt(i, transform.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true; group.add(mesh);
  }
  return group;
}

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
