import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../../content/config';
import { deriveRng, rngRange } from '../../simulation/rng';
import { WORLD_UNITS_PER_PIXEL } from './coordinates';

export type FieldFortification = 'sandbag' | 'trench' | 'bunker' | 'mortarPit' | 'barbedWire';
type V3 = [number, number, number];

const SOIL = [0x584632, 0x69533b, 0x766044, 0x4c402f];
const SACK = [0x9f8c64, 0xb09c73, 0x8d7c59, 0xa49370];
const WOOD = [0x65543d, 0x7b694d, 0x504735];

/** Baked fieldwork meshes: cosmetic RNG, one draw call, and no gameplay-state changes. */
export function fieldFortificationGeometry(kind: FieldFortification, seed: number, ground: (x: number, z: number) => number): THREE.BufferGeometry {
  const random = deriveRng(seed, 0x4649454c);
  const rand = (min: number, max: number) => rngRange(random, min, max);
  const pick = (colors: readonly number[]) => colors[Math.floor(rand(0, colors.length))]!;
  const parts: THREE.BufferGeometry[] = [];
  const transform = new THREE.Object3D();
  const noise = (x: number, y: number, z: number, axis: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + (seed % 10007) + axis * 43.3) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
  };
  const add = (source: THREE.BufferGeometry, color: number, pos: V3, scale: V3 = [1, 1, 1], rotation: V3 = [0, 0, 0], rough = .008, drape = true) => {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    geometry.deleteAttribute('uv');
    transform.position.set(...pos); transform.scale.set(...scale); transform.rotation.set(...rotation); transform.updateMatrix();
    geometry.applyMatrix4(transform.matrix);
    const positions = geometry.getAttribute('position'), colors = new Float32Array(positions.count * 3), tint = new THREE.Color(color);
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      const dx = x + noise(x, y, z, 0) * rough, dz = z + noise(x, y, z, 2) * rough;
      positions.setXYZ(i, dx, y + noise(x, y, z, 1) * rough + (drape ? ground(dx, dz) : 0), dz);
      const shade = .94 + noise(x, y, z, 3) * .07;
      colors.set([tint.r * shade, tint.g * shade, tint.b * shade], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.computeVertexNormals(); parts.push(geometry);
  };
  const box = (color: number, pos: V3, size: V3, angle = 0, rough = .012, drape = true) =>
    add(new THREE.BoxGeometry(1, 1, 1), color, pos, size, [0, angle, 0], rough, drape);
  const lump = (color: number, pos: V3, size: V3, angle = 0) =>
    add(new THREE.IcosahedronGeometry(1, 0), color, pos, size, [rand(-.15, .15), angle, rand(-.15, .15)], .025);
  const plank = (pos: V3, size: V3, angle = 0) => {
    box(pick(WOOD), pos, size, angle, .015);
    // Split, weather-darkened grain along the exposed face.
    box(0x423b2c, [pos[0], pos[1] + size[1] / 2 + .005, pos[2]], [size[0] * .72, .006, .009], angle, .002);
  };
  const bag = (x: number, y: number, z: number, angle = 0, drape = true) => {
    const length = rand(.25, .30), height = rand(.105, .135), depth = rand(.18, .22);
    add(new THREE.SphereGeometry(1, 8, 5), pick(SACK), [x, y, z], [length / 2, height / 2, depth / 2],
      [rand(-.12, .12), angle + rand(-.09, .09), rand(-.08, .08)], .009, drape);
    // A pinched stitched edge gives each sack a soft fabric silhouette.
    const seamX = x - Math.sin(angle) * depth * .39, seamZ = z - Math.cos(angle) * depth * .39;
    box(0x6b5c42, [seamX, y + height * .16, seamZ], [length * .78, .009, .011], angle, .003, drape);
  };
  const spoil = (x: number, z: number, width: number, depth: number, count: number) => {
    for (let i = 0; i < count; i++) lump(pick(SOIL), [x + rand(-width, width), rand(.015, .055), z + rand(-depth, depth)],
      [rand(.09, .21), rand(.025, .065), rand(.07, .16)], rand(0, Math.PI));
  };

  if (kind === 'barbedWire') {
    const half = CONFIG.barbedWire.halfLength * WORLD_UNITS_PER_PIXEL;
    // Ground-draped steel coils with crossed stakes and individual barbs.
    for (const x of [-half, 0, half]) {
      add(new THREE.BoxGeometry(.055, .52, .055), 0x71634a, [x, .24, 0], [1, 1, 1], [0, 0, .2], .003);
      add(new THREE.BoxGeometry(.055, .52, .055), 0x71634a, [x, .24, 0], [1, 1, 1], [0, 0, -.2], .003);
    }
    const turns = 12, points: THREE.Vector3[] = [];
    for (let i = 0; i <= turns * 12; i++) {
      const t = i / (turns * 12), angle = t * turns * Math.PI * 2;
      points.push(new THREE.Vector3(-half + t * half * 2, .23 + Math.sin(angle) * .20, Math.cos(angle) * .20));
    }
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), turns * 12, .013, 4, false),
      0x9b9c8c, [0, 0, 0], [1, 1, 1], [0, 0, 0], 0);
    for (let i = 0; i <= 20; i++) {
      const x = -half + i / 20 * half * 2;
      box(0x969888, [x, .26, -.18], [.10, .018, .018], .65, .001);
      box(0x969888, [x, .26, -.18], [.10, .018, .018], -.65, .001);
    }
    box(0x74796c, [0, .26, -.18], [half * 2, .017, .017], 0, .001);
  } else if (kind === 'sandbag') {
    lump(0x69563c, [0, .025, 0], [.95, .045, .30]);
    for (let row = 0; row < 3; row++) {
      const count = row === 2 ? 4 : 6;
      for (let i = 0; i < count; i++) bag((i - (count - 1) / 2) * .265 + (row === 1 ? .04 : 0), .075 + row * .108,
        rand(-.025, .025) + row * .025);
    }
    bag(.88, .065, .13, -.45); // A collapsed end sack, rather than a perfect wall.
    spoil(0, 0, 1, .32, 12);
  } else if (kind === 'trench') {
    const length = CONFIG.trench.halfLength * 2 * WORLD_UNITS_PER_PIXEL;
    box(0x352e23, [0, .018, 0], [length, .025, .90], 0, .055);
    for (let x = -length / 2 + .14, i = 0; x < length / 2; x += .24, i++) {
      if (i % 8 !== 3) plank([x, .049, rand(-.025, .025)], [rand(.15, .19), .035, rand(.58, .70)], rand(-.07, .07));
      for (const side of [-1, 1]) {
        lump(pick(SOIL), [x + rand(-.06, .06), .13, side * rand(.52, .61)], [rand(.20, .31), rand(.12, .20), rand(.18, .26)]);
      }
    }
    for (const side of [-1, 1]) {
      for (let x = -length / 2 + .48; x < length / 2; x += .92)
        plank([x, .15, side * .43], [.87, .20, .055], rand(-.025, .025));
      for (let x = -length / 2 + .17; x < length / 2; x += .62)
        box(pick(WOOD), [x, .18, side * .39], [.06, .32, .065], rand(-.1, .1));
    }
    for (let i = 0; i < 9; i++) bag((i - 4) * .28, .29, -.59 + rand(-.04, .04));
    spoil(0, 0, length / 2 + .2, .85, 34);
  } else if (kind === 'bunker') {
    // The openings are real gaps between wall sections, with a dark interior.
    box(0x35352c, [0, .035, 0], [1.60, .06, 1.30], 0, .02);
    for (const side of [-1, 1]) {
      box(0x747261, [side * .80, .30, 0], [.25, .58, 1.48], rand(-.015, .015), .035, false);
      box(0x7d7967, [side * .55, .27, -.65], [.63, .52, .23], 0, .027, false);
      box(0x666454, [side * .57, .27, .65], [.57, .53, .23], 0, .03, false);
    }
    box(0x777462, [0, .13, -.65], [1.55, .22, .24], 0, .018, false);
    box(0x8c8774, [0, .51, -.65], [1.70, .14, .27], 0, .024, false);
    box(0x282a23, [0, .33, -.54], [.64, .15, .04], 0, .004, false);
    box(0x292a22, [0, .23, .54], [.43, .42, .04], 0, .006, false);
    const roof = new THREE.Shape();
    const edge = [[-.97, -.71], [-.81, -.82], [-.35, -.82], [-.28, -.76], [.77, -.82], [.96, -.63],
      [.92, -.50], [.97, .58], [.80, .82], [.55, .79], [-.72, .82], [-.97, .62]];
    roof.moveTo(edge[0]![0]!, edge[0]![1]!);
    for (const point of edge.slice(1)) roof.lineTo(point[0]!, point[1]!);
    roof.closePath();
    add(new THREE.ExtrudeGeometry(roof, { depth: .16, bevelEnabled: false }).rotateX(-Math.PI / 2),
      0x817c68, [0, .56, 0], [1, 1, 1], [0, .015, 0], .018, false);
    for (let i = 0; i < 7; i++) {
      add(new THREE.CircleGeometry(1, 6).rotateX(-Math.PI / 2), i % 2 ? 0x6f6b56 : 0x918b74,
        [rand(-.75, .75), .745, rand(-.56, .56)], [rand(.09, .24), 1, rand(.07, .17)], [0, rand(0, Math.PI), 0], .004, false);
    }
    // Jagged cracks, chipped corners, and mud accumulated along the roof edges.
    for (let i = 0; i < 6; i++) box(0x454438, [-.43 + i * .11, .755, -.20 + (i % 2) * .07], [.19, .008, .018], i % 2 ? -.5 : .5, .004, false);
    for (let i = 0; i < 10; i++) {
      const angle = rand(0, Math.PI * 2);
      add(new THREE.IcosahedronGeometry(1, 0), i % 3 === 0 ? 0xa49b81 : pick(SOIL),
        [Math.cos(angle) * .82, .73, Math.sin(angle) * .63], [rand(.07, .17), rand(.025, .06), rand(.06, .13)], [0, angle, 0], .012, false);
    }
    for (let i = 0; i < 4; i++) bag(-.40 + i * .27, .80, -.65, rand(-.12, .12), false);
    spoil(0, 0, 1.13, .98, 23);
    plank([.43, .045, .90], [.20, .05, .38], -.25);
  } else {
    // Dark floor, ragged spoil, staggered sacks, and a partial timber shelter.
    add(new THREE.CircleGeometry(.68, 15).rotateX(-Math.PI / 2), 0x3d3427, [0, .022, 0], [1, 1, 1], [0, 0, 0], .035);
    for (let i = 0; i < 16; i++) {
      const angle = i / 16 * Math.PI * 2;
      lump(pick(SOIL), [Math.cos(angle) * .77, .10, Math.sin(angle) * .77], [rand(.19, .27), rand(.09, .15), rand(.17, .23)], angle);
      if (i >= 3 && i <= 5) continue; // Southern entrance.
      bag(Math.cos(angle) * .64, .18, Math.sin(angle) * .64, -angle + Math.PI / 2);
      if (i % 2 === 0) bag(Math.cos(angle + .10) * .67, .29, Math.sin(angle + .10) * .67, -angle + Math.PI / 2);
    }
    for (const side of [-1, 1]) box(pick(WOOD), [side * .49, .28, -.40], [.07, .55, .075], side * .08);
    for (let i = 0; i < 6; i++) plank([-.48 + i * .19, .57 + rand(-.018, .018), -.42], [.18, .055, .47], rand(-.06, .06));
    box(0x645334, [.91, .13, .25], [.24, .23, .33], -.19);
    box(0x8a7651, [.91, .25, .25], [.27, .035, .36], -.19);
    spoil(0, 0, .99, .98, 20);
  }

  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  merged.computeBoundingSphere(); merged.computeBoundingBox();
  return merged;
}
