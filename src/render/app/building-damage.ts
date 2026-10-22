import * as THREE from 'three';
import type { Building } from '../../simulation/types';
import { deriveRng, rngRange } from '../../simulation/rng';

/** Appearance stages use HP only, so saves reproduce the same damage. */
export function buildingDamageStage(building: Building): number {
  if (building.destroyed || building.health <= 0) return 5;
  const ratio = building.health / Math.max(1, building.maxHealth);
  return ratio <= .15 ? 4 : ratio <= .4 ? 3 : ratio <= .7 ? 2 : ratio < 1 ? 1 : 0;
}

export function damagedBuildingColor(color: number, stage: number): number {
  return new THREE.Color(color).lerp(new THREE.Color(0x49443e), Math.max(0, stage - 1) * .12).getHex();
}

/** Cosmetic geometry is owned by this group and disposed when its stage changes. */
export function buildingDamage(building: Building, width: number, depth: number, height: number, pitched: boolean,
  material: (color: number) => THREE.Material): THREE.Group {
  const group = new THREE.Group(), stage = buildingDamageStage(building);
  group.name = 'building-damage'; group.userData.damageStage = stage;
  if (stage === 0 || stage === 5) return group;
  const span = Math.min(width, depth) * 1.04, peak = Math.min(.75, span * .35);
  const roofHeight = (x: number, z: number) => height + (pitched ? peak * Math.max(0, 1 - Math.abs(width > depth ? z : x) / (span / 2)) : .055);
  const patches = new Map<string, { color: number; kind: string; vertices: number[] }>();
  const cracks = new Map<string, number[]>();
  const chunks = new Map<string, { color: number; kind: string; shape: 'box' | 'stone'; matrices: THREE.Matrix4[] }>();
  const chunk = (kind: string, color: number, shape: 'box' | 'stone', position: THREE.Vector3, scale: THREE.Vector3, rotation = new THREE.Euler()): void => {
    const key = `${kind}:${color}`, batch = chunks.get(key) ?? { color, kind, shape, matrices: [] };
    const pose = new THREE.Object3D(); pose.position.copy(position); pose.scale.copy(scale); pose.rotation.copy(rotation); pose.updateMatrix();
    batch.matrices.push(pose.matrix.clone()); chunks.set(key, batch);
  };
  const patch = (points: THREE.Vector3[], center: THREE.Vector3, color: number, kind: string): void => {
    const key = `${kind}:${color}`, batch = patches.get(key) ?? { color, kind, vertices: [] };
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      batch.vertices.push(...center.toArray(), ...a.toArray(), ...b.toArray(), ...center.toArray(), ...b.toArray(), ...a.toArray());
    }
    patches.set(key, batch);
  };
  const crack = (points: THREE.Vector3[], kind: string): void => {
    const vertices = cracks.get(kind) ?? [];
    for (let i = 1; i < points.length; i++) vertices.push(...points[i - 1]!.toArray(), ...points[i]!.toArray());
    cracks.set(kind, vertices);
  };

  // Deterministic sites retain their positions and grow as the damage worsens.
  for (let site = 0; site < stage; site++) {
    const rng = deriveRng(building.id, 0x524f4f46 + site);
    const x = rngRange(rng, -width * .28, width * .28), z = rngRange(rng, -depth * .27, depth * .27);
    const radius = Math.min(width, depth) * (.075 + stage * .035);
    const center = new THREE.Vector3(x, roofHeight(x, z) + .025, z);
    const rim: THREE.Vector3[] = [];
    for (let i = 0; i < 11; i++) {
      const angle = i / 11 * Math.PI * 2, r = radius * rngRange(rng, .65, 1.15);
      const px = THREE.MathUtils.clamp(x + Math.cos(angle) * r, -width * .46, width * .46);
      const pz = THREE.MathUtils.clamp(z + Math.sin(angle) * r, -depth * .46, depth * .46);
      rim.push(new THREE.Vector3(px, roofHeight(px, pz) + .028, pz));
    }
    patch(rim, center, stage >= 3 ? 0x242823 : 0x47463d, 'roof-scar');
    for (let branch = 0; branch < 3; branch++) {
      const end = rim[(branch * 3 + site) % rim.length]!;
      const px = THREE.MathUtils.clamp(end.x + (end.x - x) * .6, -width * .48, width * .48);
      const pz = THREE.MathUtils.clamp(end.z + (end.z - z) * .6, -depth * .48, depth * .48);
      crack([center, end.clone().add(new THREE.Vector3(0, .008, 0)), new THREE.Vector3(px, roofHeight(px, pz) + .035, pz)], 'roof-crack');
    }
    if (stage >= 2) for (let chip = 0; chip < stage * 2; chip++) {
      const edge = rim[chip % rim.length]!;
      const radius = rngRange(rng, .035, .075);
      chunk('roof-debris', chip % 2 ? 0x9f9178 : 0x665b4a, 'stone', edge.clone().add(new THREE.Vector3(0, .035, 0)), new THREE.Vector3(radius, radius * .45, radius));
    }
  }

  // Mark every side, including upper floors, so damage reads from any camera view.
  for (let face = 0; face < 4; face++) {
    const faceWidth = face % 2 === 0 ? width : depth;
    const world = (u: number, y: number): THREE.Vector3 => face === 0 ? new THREE.Vector3(u, y, depth * .476 + .008)
      : face === 1 ? new THREE.Vector3(width * .476 + .008, y, -u)
        : face === 2 ? new THREE.Vector3(-u, y, -depth * .476 - .008) : new THREE.Vector3(-width * .476 - .008, y, u);
    for (let site = 0; site < stage; site++) {
      const rng = deriveRng(building.id, 0x57414c4c + face * 31 + site);
      const u = rngRange(rng, -faceWidth * .32, faceWidth * .32), y = rngRange(rng, height * .2, height * .8);
      const r = Math.min(faceWidth, height) * (.04 + stage * .035);
      const rim: THREE.Vector3[] = [];
      for (let i = 0; i < 9; i++) {
        const a = i / 9 * Math.PI * 2;
        rim.push(world(u + Math.cos(a) * r * rngRange(rng, .65, 1.1), THREE.MathUtils.clamp(y + Math.sin(a) * r, .08, height - .03)));
      }
      patch(rim, world(u, y), stage >= 3 ? 0x35342e : 0x625b4e, 'wall-impact');
      const length = height * (.15 + stage * .12);
      const points = Array.from({ length: 6 }, (_, i) => world(THREE.MathUtils.clamp(u + (i % 2 ? .05 : -.05), -faceWidth * .44, faceWidth * .44), THREE.MathUtils.clamp(y + length * (i / 5 - .5), .05, height - .02)));
      crack(points, 'wall-crack');
    }
    if (stage >= 2) {
      chunk('broken-window-frame', 0x81715b, 'box', world(faceWidth * .22, .35), new THREE.Vector3(.035, .27, .035), new THREE.Euler(.5, face * Math.PI / 2, .5));
    }
  }

  for (let i = 0; i < stage * 5; i++) {
    const rng = deriveRng(building.id, 0x52554242 + i), side = i % 4;
    const x = side % 2 ? (side === 1 ? 1 : -1) * (width * .5 + rngRange(rng, .02, stage * .09)) : rngRange(rng, -width * .5, width * .5);
    const z = side % 2 ? rngRange(rng, -depth * .5, depth * .5) : (side === 0 ? 1 : -1) * (depth * .5 + rngRange(rng, .02, stage * .09));
    chunk('fallen-masonry', i % 2 ? 0x96866c : 0x645a48, 'box', new THREE.Vector3(x, .045, z),
      new THREE.Vector3(rngRange(rng, .05, .13), rngRange(rng, .04, .1), rngRange(rng, .05, .12)), new THREE.Euler(.15, rngRange(rng, 0, Math.PI), .15));
  }
  for (const { vertices, color, kind } of patches.values()) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material(color)); mesh.userData.damageDetail = kind; group.add(mesh);
  }
  for (const [kind, vertices] of cracks) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x302c26 })); line.userData.damageDetail = kind; group.add(line);
  }
  for (const { kind, color, shape, matrices } of chunks.values()) {
    const geometry = shape === 'stone' ? new THREE.DodecahedronGeometry(1, 0) : new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geometry, material(color), matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix)); mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true; mesh.userData.damageDetail = kind; group.add(mesh);
  }
  return group;
}
