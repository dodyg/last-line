import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingArchitecture } from '../../simulation/buildings';
import { deriveRng, rngRange } from '../../simulation/rng';
import type { Building } from '../../simulation/types';

type V3 = [number, number, number];
const MASONRY = [
  [0x8a6550, 0xa17a5e, 0x735342], // Broken red brick and pale mortar.
  [0x9b927c, 0xb0a38b, 0x777361], // Plastered stone houses.
  [0x75746b, 0x908b7b, 0x5e6059], // Grey stone and concrete.
] as const;

/** One baked mesh per ruin; cosmetic randomness never consumes simulation RNG. */
export function buildingRubbleGeometry(building: Building, seed: number, width: number, depth: number,
  ground: (x: number, z: number) => number): THREE.BufferGeometry {
  const rng = deriveRng(seed ^ Math.imul(building.id, 159), 0x5255494e);
  const rand = (lo: number, hi: number) => rngRange(rng, lo, hi);
  const variant = Math.floor(rand(0, 5));
  const palette = MASONRY[Math.floor(rand(0, MASONRY.length))]!;
  const pick = (colors: readonly number[]) => colors[Math.floor(rand(0, colors.length))]!;
  const architecture = buildingArchitecture(building), span = Math.min(width, depth);
  const woodHeavy = variant === 3 || building.kind === 'barn';
  const roofColor = building.kind === 'church' ? 0x62666b : pick([0x7b5140, 0x8c654b, 0x696963]);
  const parts: THREE.BufferGeometry[] = [], pose = new THREE.Object3D();
  const add = (source: THREE.BufferGeometry, color: number, position: V3, size: V3, rotation: V3 = [0, 0, 0]) => {
    const geo = source.index ? source.toNonIndexed() : source;
    if (geo !== source) source.dispose();
    geo.deleteAttribute('uv');
    pose.position.set(...position); pose.scale.set(...size); pose.rotation.set(...rotation); pose.updateMatrix(); geo.applyMatrix4(pose.matrix);
    const vertices = geo.getAttribute('position'), colors = new Float32Array(vertices.count * 3), tint = new THREE.Color(color);
    for (let i = 0; i < vertices.count; i++) {
      const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
      // Matching vertices get matching chips, keeping all faces joined.
      const noise = Math.sin(x * 71.7 + y * 113.1 + z * 37.3 + building.id) * 43758.5453;
      const chip = (noise - Math.floor(noise) - .5) * .022;
      vertices.setXYZ(i, x + chip, y + ground(x, z) + chip, z - chip);
      const shade = .9 + (noise - Math.floor(noise)) * .18;
      colors.set([tint.r * shade, tint.g * shade, tint.b * shade], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geo.computeVertexNormals(); parts.push(geo);
  };
  const box = (color: number, pos: V3, size: V3, rotation: V3 = [0, 0, 0]) => add(new THREE.BoxGeometry(1, 1, 1), color, pos, size, rotation);
  const lump = (color: number, pos: V3, size: V3) => add(new THREE.IcosahedronGeometry(1, 0), color, pos, size, [rand(-.3, .3), rand(0, Math.PI), rand(-.2, .2)]);

  // A broken floor outline and ash show the original footprint between debris.
  box(variant === 3 ? 0x39372e : 0x625b4c, [0, .022, 0], [width * .91, .045, depth * .91]);
  for (let i = 0; i < 5; i++) lump(pick([0x3d3b31, 0x4e4839, 0x655944]),
    [rand(-width * .35, width * .35), .045, rand(-depth * .35, depth * .35)], [span * rand(.12, .28), .04, span * rand(.12, .28)]);
  // Off-centre piles leave different open channels through each footprint.
  const pileCount = variant === 4 ? 7 : variant === 2 ? 3 : 5;
  for (let i = 0; i < pileCount; i++) {
    const angle = rand(0, Math.PI * 2), spread = variant === 4 ? .43 : .31;
    const x = Math.cos(angle) * width * spread * rand(.3, 1), z = Math.sin(angle) * depth * spread * rand(.3, 1);
    lump(pick(palette), [x, rand(.06, .13), z], [span * rand(.14, .27), span * rand(.07, variant === 4 ? .13 : .23), span * rand(.13, .25)]);
  }
  // Jagged wall stubs survive in a corner, along one side, or only at floor level.
  const corner = Math.floor(rand(0, 4));
  for (let side = 0; side < 4; side++) {
    const length = side % 2 ? depth : width, pieces = Math.max(3, Math.ceil(length / .25));
    for (let i = 0; i < pieces; i++) {
      if (rand(0, 1) < (variant === 4 ? .65 : .27)) continue;
      const u = (i + .5) / pieces - .5;
      const survivingSide = side === corner || (variant === 0 && side === (corner + 1) % 4);
      const h = survivingSide && variant !== 4 ? rand(.22, .66) * (1 - Math.abs(u) * .7) : rand(.055, .18);
      const px = side % 2 ? (side === 1 ? 1 : -1) * width * .45 : u * length * .92;
      const pz = side % 2 ? u * length * .92 : (side === 0 ? 1 : -1) * depth * .45;
      box(pick(palette), [px, h / 2 + .045, pz], side % 2 ? [.13, h, length / pieces * .86] : [length / pieces * .86, h, .13]);
      if (h > .3) box(0x514c40, [px, h * .56, pz], side % 2 ? [.137, .015, length / pieces * .84] : [length / pieces * .84, .015, .137]);
    }
  }
  // Roof fragments retain their material, but slump at unrelated angles.
  for (let i = 0; i < (variant === 2 ? 7 : 3); i++) {
    const x = rand(-width * .32, width * .32), z = rand(-depth * .32, depth * .32);
    const w = span * rand(.15, .33), d = span * rand(.15, .32);
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, -d / 2); shape.lineTo(w * .35, -d * .43); shape.lineTo(w / 2, d * .15);
    shape.lineTo(w * .1, d / 2); shape.lineTo(-w * .43, d * .28); shape.closePath();
    const roof = new THREE.ExtrudeGeometry(shape, { depth: .035, bevelEnabled: false }); roof.rotateX(-Math.PI / 2);
    add(roof, architecture.roofStyle === 'flat' ? pick(palette) : roofColor, [x, rand(.13, .32), z], [1, 1, 1], [rand(-.4, .4), rand(0, Math.PI), rand(-.32, .32)]);
  }
  for (let i = 0; i < (woodHeavy ? 15 : 7); i++) {
    box(pick(woodHeavy ? [0x302e27, 0x514333, 0x69533c] : [0x514333, 0x756048]),
      [rand(-width * .48, width * .48), rand(.13, .3), rand(-depth * .48, depth * .48)],
      [span * rand(.25, .7), .045, rand(.04, .07)], [rand(-.25, .25), rand(0, Math.PI), rand(-.18, .18)]);
  }
  if (variant === 1 || building.kind === 'church') {
    const x = width * rand(-.3, .3), z = depth * rand(-.3, .3), h = rand(.5, .85);
    for (let course = 0; course < 5; course++) box(pick(palette), [x, .06 + (course + .5) * h / 5, z], [.22 - course * .008, h / 5 * .94, .24]);
    box(0x292c27, [x, h + .065, z], [.13, .018, .13]);
  }
  // Loose bricks, plaster chips and larger fallen slabs spread beyond the walls.
  const count = Math.min(80, Math.round(width * depth * 10) + architecture.floors * 5);
  for (let i = 0; i < count; i++) {
    const x = rand(-width * .66, width * .66), z = rand(-depth * .66, depth * .66), large = i % 9 === 0;
    box(pick(i % 4 === 0 ? [0xbbb09a, 0x99917c] : palette), [x, large ? .07 : .035, z],
      large ? [rand(.19, .32), rand(.06, .11), rand(.15, .26)] : [rand(.07, .14), rand(.035, .07), rand(.055, .11)],
      [rand(-.3, .3), rand(0, Math.PI), rand(-.25, .25)]);
  }
  const merged = mergeGeometries(parts, false)!; for (const part of parts) part.dispose();
  merged.computeBoundingSphere(); return merged;
}
