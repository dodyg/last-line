import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { deriveRng, rngRange } from '../../simulation/rng';
import { TERRAIN_KIND } from '../../simulation/terrain';
import type { Season, TreeDamage } from '../../simulation/types';
import { vegetationParts } from './vegetation';

export const treeDamageStage = (health: number): number => health <= 0 ? 3 : health <= 65 ? 2 : 1;

/** Stripped crowns, pale fractures and fallen timber replace the original instance. */
export function damagedTreeGeometry(tree: TreeDamage, season: Season, seed: number): THREE.BufferGeometry {
  const rng = deriveRng(seed, tree.cell), rand = (lo: number, hi: number) => rngRange(rng, lo, hi);
  const stage = treeDamageStage(tree.health), parts: THREE.BufferGeometry[] = [];
  const low = tree.kind === TERRAIN_KIND.trees, bark = tree.kind === TERRAIN_KIND.birch ? 0xb4b29c : 0x5c4935;
  const height = low ? .42 : tree.kind === TERRAIN_KIND.fruitTree ? .7 : tree.kind === TERRAIN_KIND.birch || tree.kind === TERRAIN_KIND.pine ? 1.35 : 1;
  const add = (geometry: THREE.BufferGeometry, color: number) => {
    const geo = geometry.index ? geometry.toNonIndexed() : geometry; if (geo !== geometry) geometry.dispose();
    geo.deleteAttribute('uv');
    const colors = new Float32Array(geo.getAttribute('position').count * 3), tint = new THREE.Color(color);
    for (let i = 0; i < colors.length; i += 3) colors.set([tint.r, tint.g, tint.b], i);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); parts.push(geo);
  };
  const stick = (from: THREE.Vector3, to: THREE.Vector3, radius: number, color = bark) => {
    const direction = to.clone().sub(from), geo = new THREE.CylinderGeometry(radius * .6, radius, direction.length(), 5);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()));
    geo.translate(...from.clone().add(to).multiplyScalar(.5).toArray()); add(geo, color);
  };
  if (stage < 3) {
    let crown = 0;
    for (const part of vegetationParts(tree.kind, season)) {
      if (part.woody) {
        if (stage === 2) part.geometry.scale(1, .7, 1);
        add(part.geometry, part.color);
      } else if (stage === 1 ? crown++ % 3 !== tree.cell % 3 : crown++ % 4 === 0) {
        part.geometry.scale(stage === 1 ? .78 : .38, stage === 1 ? .91 : .55, stage === 1 ? .78 : .38);
        add(part.geometry, stage === 2 ? 0x6b6646 : part.color);
      } else part.geometry.dispose();
    }
  } else {
    const stump = new THREE.CylinderGeometry(.065, .10, height * .27, 7, 1, true);
    stump.translate(0, height * .135, 0); add(stump, bark);
    // Unequal splinter tips read as a torn trunk rather than a clean saw cut.
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2, tip = new THREE.ConeGeometry(.025, rand(.09, .24), 3);
      tip.translate(Math.cos(a) * .047, height * .27, Math.sin(a) * .047); add(tip, i % 2 ? bark : 0xc6a476);
    }
    const a = rand(0, Math.PI * 2), direction = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    stick(direction.clone().multiplyScalar(.18).setY(.12), direction.clone().multiplyScalar(height * 1.1).setY(.09), low ? .05 : .095);
    add(new THREE.CylinderGeometry(.064, .064, .02, 7).rotateZ(Math.PI / 2).rotateY(-a).translate(direction.x * .18, .12, direction.z * .18), 0xc9a676);
  }
  const branchCount = stage === 1 ? 3 : stage === 2 ? 5 : 8;
  for (let i = 0; i < branchCount; i++) {
    const a = rand(0, Math.PI * 2), broken = stage === 3 || i % 2 === 0;
    const from = broken ? new THREE.Vector3(Math.cos(a) * rand(.12, .44), .045, Math.sin(a) * rand(.12, .44)) : new THREE.Vector3(0, height * rand(.35, .65), 0);
    const to = from.clone().add(new THREE.Vector3(Math.cos(a) * rand(.17, .4), broken ? .025 : rand(.06, .18), Math.sin(a) * rand(.17, .4)));
    stick(from, to, rand(.016, .028));
    add(new THREE.IcosahedronGeometry(.03, 0).scale(1, .35, 1).translate(to.x, to.y, to.z), 0xc9a676);
  }
  // Exposed pale wood chips on the trunk and scattered around its base.
  for (let i = 0; i < stage * 4; i++) {
    const a = rand(0, Math.PI * 2), r = i < 3 && stage < 3 ? .078 : rand(.12, .5);
    const y = i < 3 && stage < 3 ? height * rand(.2, .6) : .03;
    add(new THREE.IcosahedronGeometry(1, 0).scale(.025, i < 3 && stage < 3 ? .075 : .018, .04).rotateY(a).translate(Math.cos(a) * r, y, Math.sin(a) * r), 0xc8a270);
  }
  const merged = mergeGeometries(parts, false)!; for (const part of parts) part.dispose(); merged.computeBoundingSphere(); return merged;
}
