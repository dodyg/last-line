import * as THREE from 'three';
import { isDeciduousKind, TERRAIN_KIND } from '../../simulation/terrain';
import type { Season } from '../../simulation/types';
import { seasonPalette } from './season-palette';

interface VegetationPart {
  geometry: THREE.BufferGeometry;
  color: number;
  woody?: boolean;
}

/** Parts use ground-relative geometry so every species can be instanced by cell. */
export function vegetationParts(kind: number, season: Season = 'summer'): VegetationPart[] {
  const parts: VegetationPart[] = [];
  const palette = seasonPalette(season);
  let crownIndex = 0;
  const add = (geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void => {
    geometry.scale(sx, sy, sz).translate(x, y, z);
    parts.push({ geometry, color });
  };
  const crown = (color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    const leaf = season === 'summer' ? color : palette.foliage[(crownIndex++ + (kind === TERRAIN_KIND.birch ? 1 : 0)) % palette.foliage.length]!;
    add(new THREE.IcosahedronGeometry(1, 1), leaf, x, y, z, sx, sy, sz);
    if (season === 'winter') add(new THREE.IcosahedronGeometry(1, 0), palette.snow, x, y + sy * .7, z, sx * .8, sy * .25, sz * .8);
  };
  const trunk = (color: number, height: number, radius: number): void => {
    add(new THREE.CylinderGeometry(radius * .7, radius, height, 6), color, 0, height / 2, 0);
    parts[parts.length - 1]!.woody = true;
  };

  if (season === 'winter' && isDeciduousKind(kind)) {
    const height = kind === TERRAIN_KIND.birch ? 1.45 : kind === TERRAIN_KIND.fruitTree ? .8 : 1.2;
    const bark = kind === TERRAIN_KIND.birch ? 0xc8c5ab : kind === TERRAIN_KIND.beech ? 0x8b8977 : 0x65503a;
    trunk(bark, height, kind === TERRAIN_KIND.birch ? .047 : .07);
    for (let branch = 0; branch < 5; branch++) {
      const angle = branch * Math.PI * .78, length = height * .48;
      const geometry = new THREE.CylinderGeometry(.012, .025, length, 4);
      geometry.rotateZ((branch % 2 ? 1 : -1) * .85).rotateY(angle);
      add(geometry, bark, Math.cos(angle) * .13, height * (.5 + branch * .07), Math.sin(angle) * .13);
      parts[parts.length - 1]!.woody = true;
      add(new THREE.IcosahedronGeometry(.06, 0), palette.snow, Math.cos(angle) * .21, height * (.65 + branch * .06), Math.sin(angle) * .21, 1.4, .35, .7);
    }
    return parts;
  }

  if (kind === TERRAIN_KIND.oak) {
    trunk(0x65503a, .95, .095);
    crown(0x435c32, -.2, .97, .02, .39, .38, .4);
    crown(0x526b39, .2, 1.04, .09, .4, .4, .38);
    crown(0x61763f, 0, 1.24, -.13, .39, .35, .4);
  } else if (kind === TERRAIN_KIND.beech) {
    trunk(0x8b8977, .9, .075);
    crown(0x536637, 0, 1.02, 0, .43, .5, .4);
    crown(0x778247, .06, 1.4, -.04, .32, .37, .31);
  } else if (kind === TERRAIN_KIND.birch) {
    trunk(0xc8c5ab, 1.3, .047);
    for (const y of [.28, .55, .82]) add(new THREE.CylinderGeometry(.043, .047, .045, 6), 0x575d4d, 0, y, 0);
    crown(0x829052, -.12, 1.12, .02, .27, .38, .3);
    crown(0x9aa362, .1, 1.42, -.02, .29, .35, .27);
  } else if (kind === TERRAIN_KIND.pine) {
    trunk(0x63513c, .82, .065);
    add(new THREE.ConeGeometry(.46, .88, 7), 0x304c39, 0, .88, 0);
    add(new THREE.ConeGeometry(.35, .78, 7), 0x3e5d40, 0, 1.23, 0);
    add(new THREE.ConeGeometry(.23, .66, 7), 0x506e46, 0, 1.55, 0);
    if (season === 'winter') {
      add(new THREE.ConeGeometry(.4, .52, 7), palette.snow, 0, 1.07, 0);
      add(new THREE.ConeGeometry(.3, .46, 7), palette.snow, 0, 1.42, 0);
      add(new THREE.ConeGeometry(.2, .42, 7), palette.snow, 0, 1.7, 0);
    }
  } else if (kind === TERRAIN_KIND.fruitTree) {
    trunk(0x715338, .6, .065);
    crown(0x5d713b, -.14, .78, 0, .32, .29, .34);
    crown(0x718344, .14, .85, .04, .31, .3, .3);
    for (const [x, y, z] of [[-.24, .88, .2], [.22, .99, .15], [.04, .71, -.25]] as const) {
      add(new THREE.SphereGeometry(season === 'spring' ? .065 : .045, 5, 4), season === 'spring' ? 0xe3c5c2 : season === 'autumn' ? 0xb96135 : 0xa97443, x, y, z);
    }
  } else if (kind === TERRAIN_KIND.tallGrass) {
    for (const [x, z, height] of [[-.16, 0, .3], [.13, .07, .39], [0, -.12, .46]] as const) {
      const stemHeight = season === 'winter' ? height * .45 : height;
      add(new THREE.ConeGeometry(.075, stemHeight, 4), season === 'summer' ? 0x89905a : palette.foliage[1]!, x, stemHeight / 2, z);
    }
  } else {
    // Hedgerows and shrubs keep their low, dense profile instead of posing as pines.
    const hedge = kind === TERRAIN_KIND.trees;
    crown(hedge ? 0x4b6137 : 0x637744, -.17, hedge ? .39 : .24, 0, .3, hedge ? .37 : .22, .34);
    crown(hedge ? 0x5c7040 : 0x7a874c, .18, hedge ? .43 : .27, .04, .29, hedge ? .38 : .25, .3);
  }
  return parts;
}
