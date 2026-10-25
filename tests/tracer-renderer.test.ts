import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BattleRenderer3D } from '../src/render/BattleRenderer3D';
import { CONFIG } from '../src/content/config';
import { simulationToWorld } from '../src/render/app/coordinates';
import { drapedRingGeometry } from '../src/render/app/heightfield';
import { Simulation } from '../src/simulation/simulation';
import { elevationAt } from '../src/simulation/elevation';
import { buildingSlot } from '../src/simulation/buildings';
import { bridgeKey } from '../src/simulation/bridges';
import { WORLD_UNITS_PER_PIXEL } from '../src/render/app/coordinates';
import { weaponMuzzleWorldPosition } from '../src/render/app/tracer';
import { SEASONS } from '../src/simulation/seasons';
import { generateTerrain, TERRAIN_KIND } from '../src/simulation/terrain';
import { getContent } from '../src/content/validate';
import { seasonGroundColor, seasonPalette } from '../src/render/app/season-palette';

// Keep the real scene, models, transforms, and frame animation. Only the GPU
// boundary is replaced so endpoint regressions can run without a WebGL context.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      shadowMap = {};
      setPixelRatio() {}
      setSize() {}
      setClearColor() {}
      render(scene: THREE.Scene) { scene.updateMatrixWorld(true); }
      dispose() {}
    },
  };
});

function endpoints(line: THREE.Line): [THREE.Vector3, THREE.Vector3] {
  line.updateWorldMatrix(true, false);
  const positions = line.geometry.getAttribute('position');
  const point = (i: number) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(line.matrixWorld);
  return [point(0), point(positions.count - 1)];
}

function transientLines(renderer: BattleRenderer3D): THREE.Line[] {
  const lines: THREE.Line[] = [];
  renderer.scene.traverse((object) => {
    if (object instanceof THREE.Line && object.userData.ttl !== undefined) lines.push(object);
  });
  return lines;
}

describe('tracer frame animation', () => {
  it('keeps the right-click move ring on a slope as it expands', () => {
    const sim = new Simulation(2026);
    const cols = 81, rows = 61, cell = 12;
    sim.state.terrain.elevation = { cols, rows, cell, heights: Float32Array.from({ length: cols * rows }, (_, i) =>
      Math.max(0, Math.min(36, (i % cols * cell - 456) * 1.5))) };
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      renderer.handleEvents(sim.state, [{ type: 'moveOrdered', unitId: sim.state.units[0]!.id, pos: { x: 468, y: 360 } }]);
      const ring = renderer.scene.getObjectByName('terrain-pulse') as THREE.Mesh;
      const disposed = vi.spyOn(ring.geometry, 'dispose');
      for (const dt of [0, .1, .15, .15]) {
        renderer.frame(sim.state, 1, null, [], dt);
        ring.updateWorldMatrix(true, false);
        const positions = ring.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const point = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(ring.matrixWorld);
          const x = point.x / WORLD_UNITS_PER_PIXEL + CONFIG.field.width / 2;
          const y = point.z / WORLD_UNITS_PER_PIXEL + CONFIG.field.height / 2;
          expect(point.y).toBeCloseTo(elevationAt(sim.state.terrain, x, y) * WORLD_UNITS_PER_PIXEL + .055, 5);
        }
      }
      expect(ring.scale.x).toBeGreaterThan(2);
      renderer.frame(sim.state, 1, null, [], .2);
      renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('terrain-pulse')).toBeUndefined();
      expect(disposed).toHaveBeenCalledOnce();
    } finally { renderer.destroy(); }
  });

  it('keeps range outlines above ridges between their endpoints', () => {
    const sim = new Simulation(2026);
    const cols = 81, rows = 61, cell = 12;
    sim.state.terrain.elevation = { cols, rows, cell, heights: Float32Array.from({ length: cols * rows }, (_, i) =>
      Math.max(0, 36 - Math.abs(i % cols * cell - 480) * 1.5)) };
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    let circle: THREE.BufferGeometry | undefined;
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      renderer.frame(sim.state, 1, { kind: 'ambush', pos: { x: 360, y: 360 }, valid: true,
        ambushArcs: [{ origin: { x: 360, y: 360 }, facing: 0, range: 240, arcDegrees: 90 }] }, [], 0);
      const arc = renderer.scene.getObjectByName('ambush-arc-preview') as THREE.Line;
      const checkSegment = (a: THREE.Vector3, b: THREE.Vector3) => {
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(.1);
        for (const t of [0, .25, .5, .75, 1]) {
          const point = a.clone().lerp(b, t);
          const x = point.x / WORLD_UNITS_PER_PIXEL + CONFIG.field.width / 2;
          const y = point.z / WORLD_UNITS_PER_PIXEL + CONFIG.field.height / 2;
          expect(point.y).toBeGreaterThan(elevationAt(sim.state.terrain, x, y) * WORLD_UNITS_PER_PIXEL);
        }
      };
      const positions = arc.geometry.getAttribute('position');
      for (let i = 1; i < positions.count; i++) checkSegment(
        new THREE.Vector3().fromBufferAttribute(positions, i - 1), new THREE.Vector3().fromBufferAttribute(positions, i));
      circle = drapedRingGeometry(sim.state.terrain, { x: 360, y: 360 }, 4.77, 4.8);
      const vertices = circle.getAttribute('position'), indices = circle.getIndex()!;
      for (let i = 0; i < indices.count; i += 3) {
        for (let j = 0; j < 3; j++) checkSegment(
          new THREE.Vector3().fromBufferAttribute(vertices, indices.getX(i + j)),
          new THREE.Vector3().fromBufferAttribute(vertices, indices.getX(i + (j + 1) % 3)));
      }
    } finally { circle?.dispose(); renderer.destroy(); }
  });

  it('drapes blasts over higher and lower ground throughout expansion and disposes them', () => {
    const sim = new Simulation(2026);
    const cols = 81, rows = 61, cell = 12;
    sim.state.terrain.elevation = { cols, rows, cell, heights: Float32Array.from({ length: cols * rows }, (_, i) => {
      const x = i % cols * cell;
      return Math.max(0, Math.min(36, (x - 468) * 1.5, (552 - x) * 1.5));
    }) };
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      renderer.handleEvents(sim.state, [{ type: 'explosion', pos: { x: 456, y: 360 }, radius: 42 }]);
      const ring = renderer.scene.getObjectByName('terrain-blast') as THREE.Mesh;
      const disposed = vi.spyOn(ring.geometry, 'dispose');
      const checkSurface = () => {
        ring.updateWorldMatrix(true, false);
        const positions = ring.geometry.getAttribute('position');
        let highest = 0, lowest = Infinity;
        for (let i = 0; i < positions.count; i++) {
          const world = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(ring.matrixWorld);
          const x = world.x / WORLD_UNITS_PER_PIXEL + CONFIG.field.width / 2;
          const y = world.z / WORLD_UNITS_PER_PIXEL + CONFIG.field.height / 2;
          expect(world.y).toBeCloseTo(elevationAt(sim.state.terrain, x, y) * WORLD_UNITS_PER_PIXEL + .04, 5);
          highest = Math.max(highest, world.y); lowest = Math.min(lowest, world.y);
        }
        expect(highest - lowest).toBeGreaterThan(.5);
      };
      checkSurface();
      for (const dt of [.1, .2, .3]) {
        renderer.frame(sim.state, 1, null, [], dt);
        checkSurface();
      }
      expect(ring.scale.x).toBeGreaterThan(2);
      renderer.frame(sim.state, 1, null, [], .2);
      renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('terrain-blast')).toBeUndefined();
      expect(disposed).toHaveBeenCalledOnce();
    } finally { renderer.destroy(); }
  });

  it('retains unchanged smoke, lighting and command geometry between frames', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    sim.state.weather = 'fog';
    sim.state.smokes.push({ id: 999, pos: { x: 480, y: 300 }, radius: 56, ticksRemaining: 240 });
    sim.state.campfires.push({ id: 1000, unitId: unit.id, pos: { x: 480, y: 600 }, radius: 70, ticksRemaining: 1800 });
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    const preview = { kind: 'barbedWire' as const, pos: { x: 480, y: 580 }, valid: true };
    try {
      renderer.frame(sim.state, 0, preview, [], 0);
      const fog = renderer.scene.fog, background = renderer.scene.background;
      const smoke = renderer.scene.getObjectByName('smoke-cloud')!;
      const wire = renderer.scene.getObjectByName('wire-placement-preview') as THREE.Mesh;
      const dispose = vi.spyOn(wire.geometry, 'dispose');
      let light: THREE.PointLight | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.PointLight) light = object; });
      const intensity = light!.intensity;
      sim.state.ticks++;
      renderer.frame(sim.state, 1, preview, [], .03);
      expect(renderer.scene.fog).toBe(fog); expect(renderer.scene.background).toBe(background);
      expect(renderer.scene.getObjectByName('smoke-cloud')).toBe(smoke);
      expect(renderer.scene.getObjectByName('wire-placement-preview')).toBe(wire);
      expect(dispose).not.toHaveBeenCalled();
      expect(light!.parent).not.toBeNull(); expect(light!.intensity).not.toBe(intensity);
      renderer.frame(sim.state, 1, { ...preview, pos: { x: 500, y: 580 } }, [], 0);
      expect(dispose).toHaveBeenCalledOnce();
      sim.state.smokes = []; sim.state.campfires = []; sim.state.ticks++;
      renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('smoke-cloud')).toBeUndefined();
      expect(light!.parent).toBeNull();
    } finally { renderer.destroy(); }
  });
  it('draws selected ambush cones and previews without mutating orders, and disposes cancelled cones', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    expect(sim.command({ type: 'ambush', unitIds: [unit.id], aim: { x: unit.pos.x, y: unit.pos.y - 120 }, arcDegrees: 90 }).ok).toBe(true);
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      const before = sim.snapshot();
      renderer.frame(sim.state, 1, { kind: 'ambush', pos: { x: unit.pos.x, y: unit.pos.y - 120 }, valid: true,
        ambushArcs: [{ origin: { ...unit.pos }, ...unit.ambush! }] }, [unit.id], 0);
      expect(renderer.scene.getObjectByName('ambush-arc-preview')).toBeDefined();
      const cone = renderer.scene.getObjectByName('ambush-arc') as THREE.Line;
      expect(cone.geometry.getAttribute('position').count).toBeGreaterThan(30);
      expect(sim.snapshot()).toEqual(before);
      const dispose = vi.spyOn(cone.geometry, 'dispose');
      delete unit.ambush;
      renderer.frame(sim.state, 1, null, [unit.id], 0);
      expect(dispose).toHaveBeenCalledOnce();
      expect(renderer.scene.getObjectByName('ambush-arc')).toBeUndefined();
      expect(renderer.scene.getObjectByName('ambush-arc-preview')).toBeUndefined();
    } finally { renderer.destroy(); }
  });

  it('shows satchel blast boundaries and a shrinking fuse, disposes expired markers, and previews blast range', () => {
    const sim = new Simulation(2026), pos = { x: 492, y: 600 };
    sim.state.satchelCharges.push({ id: sim.state.nextEntityId++, unitId: sim.state.units[0]!.id, pos, ticksRemaining: 300 });
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData()); renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('satchel-charge')).toBeDefined();
      expect(renderer.scene.getObjectByName('satchel-blast-radius')).toBeDefined();
      const countdown = renderer.scene.getObjectByName('satchel-fuse-countdown') as THREE.Mesh<THREE.RingGeometry>;
      expect(countdown.geometry.parameters.thetaLength).toBeCloseTo(Math.PI * 2);
      const dispose = vi.spyOn(countdown.geometry, 'dispose');
      sim.state.satchelCharges[0]!.ticksRemaining = 150; sim.state.ticks++;
      renderer.frame(sim.state, 1, { kind: 'satchel', pos, valid: true }, [], 0);
      expect(dispose).toHaveBeenCalledOnce();
      const half = renderer.scene.getObjectByName('satchel-fuse-countdown') as THREE.Mesh<THREE.RingGeometry>;
      expect(half.geometry.parameters.thetaLength).toBeCloseTo(Math.PI);
      expect(renderer.scene.getObjectByName('satchel-blast-preview')).toBeDefined();
      sim.state.satchelCharges = []; sim.state.ticks++;
      renderer.frame(sim.state, 1, null, [], 0);
      for (const name of ['satchel-charge', 'satchel-blast-radius', 'satchel-fuse-countdown', 'satchel-blast-preview']) expect(renderer.scene.getObjectByName(name)).toBeUndefined();
    } finally { renderer.destroy(); }
  });

  it('replaces damaged tree instances, disposes superseded geometry, and restores the same ruin without replaying splinters', () => {
    const sim = new Simulation(2026), data = sim.terrainData(), cell = data.kinds.findIndex((kind) => kind === TERRAIN_KIND.oak || kind === TERRAIN_KIND.pine);
    const tree = { cell, kind: data.kinds[cell]!, health: 90 }; sim.state.treeDamage = [tree];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      const before = sim.snapshot(); renderer.rebuildStatic(sim.state, data);
      const first = renderer.scene.getObjectByName('damaged-tree') as THREE.Mesh;
      expect(first.userData.treeCell).toBe(cell); expect(first.userData.damageStage).toBe(1);
      const instances = (renderer as unknown as { treeInstances: Map<number, Array<{ mesh: THREE.InstancedMesh; index: number }>> }).treeInstances.get(cell)!;
      expect(instances.length).toBeGreaterThan(1);
      for (const instance of instances) { const matrix = new THREE.Matrix4(); instance.mesh.getMatrixAt(instance.index, matrix); expect(matrix.determinant()).toBe(0); }
      renderer.frame(sim.state, 1, null, [], 0); expect(renderer.scene.getObjectByName('damaged-tree')).toBe(first); expect(sim.snapshot()).toEqual(before);
      const disposed = vi.spyOn(first.geometry, 'dispose'); tree.health = 0; renderer.frame(sim.state, 1, null, [], 0);
      expect(disposed).toHaveBeenCalledOnce(); const ruin = renderer.scene.getObjectByName('damaged-tree') as THREE.Mesh;
      expect(ruin.userData.damageStage).toBe(3); const positions = Array.from(ruin.geometry.getAttribute('position').array);
      const pos = { x: (cell % data.terrain.cols + .5) * data.terrain.cell, y: (Math.floor(cell / data.terrain.cols) + .5) * data.terrain.cell };
      renderer.handleEvents(sim.state, [{ type: 'treeHit', cell, pos, health: 0, blast: true }]);
      const chips = renderer.scene.getObjectByName('tree-splinters') as THREE.InstancedMesh, disposeChips = vi.spyOn(chips, 'dispose');
      renderer.frame(sim.state, 1, null, [], 2); renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('tree-splinters')).toBeUndefined(); expect(disposeChips).toHaveBeenCalledOnce();
      renderer.rebuildStatic(sim.state, data);
      expect(Array.from((renderer.scene.getObjectByName('damaged-tree') as THREE.Mesh).geometry.getAttribute('position').array)).toEqual(positions);
      expect(renderer.scene.getObjectByName('tree-splinters')).toBeUndefined();
    } finally { renderer.destroy(); }
  });

  it('retains distinct earth scars after dust settles, reuses existing meshes, and disposes expired history', () => {
    const data = generateTerrain(2026, false, 2); data.kinds.fill(0); data.zones = { river: null, bridges: [], rapids: [], mud: [] };
    const sim = new Simulation(2026, undefined, data, false);
    sim.state.groundImpacts = (['mortar', 'artillery', 'airSupport'] as const).map((kind, i) => ({ id: sim.state.nextEntityId++, kind, pos: { x: 320 + i * 160, y: 440 }, tick: 0 }));
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720), before = sim.snapshot();
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData()); renderer.frame(sim.state, 1, null, [], 0);
      const marks = sim.state.groundImpacts, meshes = marks.map((mark) => renderer.scene.getObjectByName(`ground-impact-${mark.kind}`) as THREE.Mesh);
      const widths = meshes.map((mesh) => new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).x);
      expect(widths[1]).toBeGreaterThan(widths[0]!); expect(widths[2]).toBeGreaterThan(widths[1]!);
      renderer.frame(sim.state, 1, null, [], 0);
      for (let i = 0; i < marks.length; i++) expect(renderer.scene.getObjectByName(meshes[i]!.name)).toBe(meshes[i]);
      const mark = marks[0]!;
      renderer.handleEvents(sim.state, [{ type: 'groundImpact', impact: mark, blastRadius: 42 }, { type: 'explosion', pos: mark.pos, radius: 42 }]);
      const dust = renderer.scene.getObjectByName('earth-dust-mortar') as THREE.InstancedMesh;
      expect(dust).toBeDefined(); const disposeDust = vi.spyOn(dust, 'dispose');
      renderer.frame(sim.state, 1, null, [], .5); renderer.frame(sim.state, 1, null, [], 2); renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('earth-dust-mortar')).toBeUndefined(); expect(disposeDust).toHaveBeenCalledOnce();
      for (const mesh of meshes) expect(renderer.scene.getObjectByName(mesh.name)).toBe(mesh);
      expect(sim.snapshot()).toEqual(before);
      const disposeScar = vi.spyOn(meshes[0]!.geometry, 'dispose'); sim.state.groundImpacts.shift(); renderer.frame(sim.state, 1, null, [], 0);
      expect(disposeScar).toHaveBeenCalledOnce(); expect(renderer.scene.getObjectByName('ground-impact-mortar')).toBeUndefined();
    } finally { renderer.destroy(); }
  });

  it('rebuilds rough field fortifications without consuming gameplay RNG or retaining old meshes', () => {
    const sim = new Simulation(2026);
    sim.state.sandbags = [{ id: sim.state.nextEntityId++, pos: { x: 380, y: 440 } }];
    sim.state.trenches = [{ id: sim.state.nextEntityId++, pos: { x: 560, y: 440 } }];
    sim.state.bunkers = [{ id: sim.state.nextEntityId++, pos: { x: 400, y: 550 } }];
    sim.state.mortarPits = [{ id: sim.state.nextEntityId++, pos: { x: 565, y: 550 } }];
    const before = sim.snapshot(), renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      const meshes = ['sandbag', 'trench', 'bunker', 'mortarPit'].map((kind) => renderer.scene.getObjectByName(`field-${kind}`) as THREE.Mesh);
      const positions = meshes.map((mesh) => Array.from(mesh.geometry.getAttribute('position').array));
      const disposed = meshes.map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));
      for (const mesh of meshes) {
        expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBe(1);
        expect(mesh.geometry.getAttribute('color')).toBeDefined();
      }
      renderer.handleEvents(sim.state, [{ type: 'constructionCompleted', kind: 'sandbag', pos: { x: 380, y: 440 } }]);
      for (let i = 0; i < meshes.length; i++) {
        expect(disposed[i]).toHaveBeenCalledOnce();
        const rebuilt = renderer.scene.getObjectByName(meshes[i]!.name) as THREE.Mesh;
        expect(Array.from(rebuilt.geometry.getAttribute('position').array)).toEqual(positions[i]);
      }
      expect(sim.snapshot()).toEqual(before);
    } finally { renderer.destroy(); }
  });

  it('marks a pending enemy smoke throw, then replaces its warning with a screen at the blocking radius', () => {
    const sim = new Simulation(2026); sim.state.units = [];
    sim.spawnEnemy('assault', { x: 492, y: 372 }); const leader = sim.state.units[0]!;
    sim.state.enemySmokeAssaults = [{ id: sim.state.nextEntityId++, leaderId: leader.id, unitIds: [leader.id], pos: { x: 492, y: 504 },
      deployTick: 45, endTick: 285, deployed: false }];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('enemy-smoke-warning')).toBeDefined();
      expect(renderer.scene.getObjectByName('enemy-smoke-thrower')!.userData.unitId).toBe(leader.id);
      const plan = sim.state.enemySmokeAssaults[0]!; plan.deployed = true; sim.state.ticks = 45;
      sim.state.smokes.push({ id: plan.id, pos: { ...plan.pos }, radius: CONFIG.smoke.radius, ticksRemaining: 240 });
      renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('enemy-smoke-warning')).toBeUndefined();
      expect(renderer.scene.getObjectByName('enemy-smoke-thrower')).toBeUndefined();
      const cloud = renderer.scene.getObjectByName('smoke-cloud')!;
      expect(cloud.userData.smokeId).toBe(plan.id); expect(cloud.children).toHaveLength(5);
      for (const puff of cloud.children) expect(((puff as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity).toBe(.32);
      const bounds = new THREE.Box3().setFromObject(cloud), size = bounds.getSize(new THREE.Vector3());
      const diameter = CONFIG.smoke.radius * WORLD_UNITS_PER_PIXEL * 2;
      expect(size.x).toBeGreaterThan(diameter * .98); expect(size.x).toBeLessThanOrEqual(diameter * 1.01);
    } finally { renderer.destroy(); }
  });

  it.each(['engineer', 'radio_engineer'] as const)('renders a %s STEN with its side magazine and aligned muzzle tracers', (role) => {
    const sim = new Simulation(2026); sim.state.units = [];
    const soldier = sim.spawnFriendly(role, { x: 492, y: 612 }); sim.spawnEnemy('rifle', { x: 492, y: 432 });
    const enemy = sim.state.units.at(-1)!; soldier.targetId = enemy.id;
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      renderer.handleEvents(sim.state, [{ type: 'shot', shooterId: soldier.id, shooterTeam: 'friendly', from: { ...soldier.pos }, to: { ...enemy.pos }, targetId: enemy.id, hit: true, weapon: getContent().weapons.sten!.name }]);
      renderer.frame(sim.state, 1, null, [], 0);
      const magazine = renderer.scene.getObjectByName('sten-side-magazine')!, weapon = magazine.parent!;
      expect(weapon.userData.weaponId).toBe('sten'); expect(magazine.position.x).toBeLessThan(0);
      const [start, end] = endpoints(transientLines(renderer)[0]!);
      expect(start.distanceTo(weaponMuzzleWorldPosition(weapon, weapon.userData.weaponLength))).toBeLessThan(.00001);
      expect(new THREE.Vector3(0, 0, -1).transformDirection(weapon.matrixWorld).dot(end.clone().sub(start).normalize())).toBeGreaterThan(.999999);
    } finally { renderer.destroy(); }
  });

  it.each(['at', 'mortarman'] as const)('switches the %s model to a rifle while empty and restores the primary model after a refill', (role) => {
    const sim = new Simulation(2026); sim.state.units = [];
    const soldier = sim.spawnFriendly(role, { x: 492, y: 612 });
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      if (role === 'at') expect(renderer.scene.getObjectByName('bazooka-muzzle')).toBeDefined();
      soldier.rockets = 0; soldier.mortarBombs = 0;
      renderer.frame(sim.state, 1, null, [], 0);
      const rifle = renderer.scene.getObjectByName('infantry-weapon')!;
      expect(rifle.userData.weaponId).toBe('rifle'); expect(rifle.userData.weaponLength).toBe(.26);
      expect(renderer.scene.getObjectByName('bazooka-muzzle')).toBeUndefined();
      soldier.rockets = role === 'at' ? 4 : 0; soldier.mortarBombs = role === 'mortarman' ? 6 : 0;
      renderer.frame(sim.state, 1, null, [], 0);
      expect(renderer.scene.getObjectByName('infantry-weapon')!.userData.weaponId).not.toBe('rifle');
      if (role === 'at') expect(renderer.scene.getObjectByName('bazooka-muzzle')).toBeDefined();
    } finally { renderer.destroy(); }
  });

  it.each(['standing', 'crouching', 'prone'] as const)('distinguishes a %s tank crewman by uniform, cap and pistol without showing healthy crew as wounded', (stance) => {
    const sim = new Simulation(2026); sim.spawnEnemy('rifle', { x: 492, y: 432 });
    const crew = sim.state.units.at(-1)!; crew.stance = stance; crew.health = CONFIG.armoredVehicle.crew.health;
    crew.tankCrew = { tankId: 1, behavior: 'retreat', exit: { x: 492, y: 12 }, retryTick: 0, bailoutTicks: 0 };
    sim.state.units = [crew];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      const cap = renderer.scene.getObjectByName('tank-crew-cap')!, root = cap.parent!;
      const weapon = root.getObjectByName('infantry-weapon')!;
      expect(weapon.userData.weaponId).toBe('crew_pistol'); expect(weapon.userData.weaponLength).toBeLessThan(.2);
      const torso = root.children.find((child) => child.userData.aimTarget) as THREE.Mesh;
      expect((torso.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x66655a);
      expect(root.children.find((child) => child.userData.healthIndicator)!.visible).toBe(false);
      const head = root.children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry && !child.userData.unitId) as THREE.Mesh;
      expect(Math.abs(cap.position.y - head.position.y)).toBeLessThan(.12);
    } finally { renderer.destroy(); }
  });

  it('shows independent tank damage, locks an immobilized hull, and retains healthy tanks unchanged', () => {
    const sim = new Simulation(2026);
    sim.spawnEnemy('vehicle', { x: 400, y: 350 }); const tank = sim.state.units.at(-1)!;
    sim.spawnEnemy('vehicle', { x: 600, y: 350 }); const other = sim.state.units.at(-1)!;
    const target = sim.state.units[0]!; sim.state.units = [target, tank, other]; tank.targetId = target.id;
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    const roots = new Map<number, THREE.Group>();
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId) roots.set(object.userData.unitId, object); });
      const root = roots.get(tank.id)!, healthyRoot = roots.get(other.id)!, heading = root.rotation.y;
      const healthyTrack = healthyRoot.children.find((child) => child.userData.vehicleTrack) as THREE.Mesh;
      const originalTrackColor = (healthyTrack.material as THREE.MeshStandardMaterial).color.getHex();
      tank.tankDamage = { tracks: true, turret: true, machineGun: false };
      target.pos.x += 250; target.prevPos = { ...target.pos };
      renderer.frame(sim.state, 1, null, [], .1);
      expect(root.rotation.y).toBeCloseTo(heading);
      expect(root.getObjectByName('tank-damage-tracks')!.visible).toBe(true);
      expect(root.getObjectByName('tank-damage-turret')!.visible).toBe(true);
      expect(root.getObjectByName('tank-damage-machineGun')!.visible).toBe(false);
      expect(root.getObjectByName('vehicle-turret')!.rotation.y).toBe(0);
      expect(root.getObjectByName('weapon-aim')!.rotation.x).toBeCloseTo(-.22);
      expect((healthyTrack.material as THREE.MeshStandardMaterial).color.getHex()).toBe(originalTrackColor);
      tank.tankDamage.machineGun = true; renderer.frame(sim.state, 1, null, [], .1);
      expect(root.getObjectByName('tank-damage-machineGun')!.visible).toBe(true);
      expect(root.getObjectByName('machine-gun-aim')!.rotation.x).toBeCloseTo(-.35);
    } finally { renderer.destroy(); }
  });

  it('fires tank machine-gun tracers from the separate working mount while the turret is disabled', () => {
    const sim = new Simulation(2026), target = sim.state.units[0]!;
    sim.spawnEnemy('vehicle', { x: 400, y: 350 }); const tank = sim.state.units.at(-1)!;
    tank.tankDamage = { tracks: true, turret: true, machineGun: false }; sim.state.units = [target, tank];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      renderer.handleEvents(sim.state, [{ type: 'shot', shooterId: tank.id, shooterTeam: 'enemy', from: { ...tank.pos }, to: { ...target.pos }, targetId: target.id, hit: true, weapon: getContent().weapons.tank_mg!.name }]);
      renderer.frame(sim.state, 1, null, [], 0);
      const mg = renderer.scene.getObjectByName('tank-machine-gun')!;
      const [start, end] = endpoints(transientLines(renderer)[0]!);
      expect(start.distanceTo(weaponMuzzleWorldPosition(mg, mg.userData.weaponLength))).toBeLessThan(.00001);
      expect(new THREE.Vector3(0, 0, -1).transformDirection(mg.matrixWorld).dot(end.clone().sub(start).normalize())).toBeGreaterThan(.999999);
      expect(mg.parent!.parent!.getObjectByName('weapon-aim')!.rotation.x).toBeCloseTo(-.22);
    } finally { renderer.destroy(); }
  });

  it.each(['standing', 'crouching', 'prone'] as const)('renders a shoulder launcher with its muzzle aimed at armor while %s', (stance) => {
    const data = generateTerrain(2026, false, 2);
    const sim = new Simulation(2026, undefined, data, false);
    const soldier = sim.spawnFriendly('at', { x: 492, y: 612 }); soldier.stance = stance;
    sim.spawnEnemy('vehicle', { x: 492, y: 432 });
    const tank = sim.state.units.at(-1)!; soldier.targetId = tank.id;
    sim.state.units = [soldier, tank];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      const weapon = renderer.scene.getObjectByName('infantry-weapon') as THREE.Mesh;
      expect(weapon.userData.weaponId).toBe('at');
      expect(weapon.getObjectByName('bazooka-muzzle')).toBeDefined();
      expect(weapon.getObjectByName('bazooka-grip')).toBeDefined();
      const muzzle = weapon.getObjectByName('bazooka-muzzle')!.getWorldPosition(new THREE.Vector3());
      expect(muzzle.distanceTo(weaponMuzzleWorldPosition(weapon, weapon.userData.weaponLength))).toBeLessThan(.00001);
      let targetBody: THREE.Object3D | undefined;
      renderer.scene.traverse((object) => {
        if (object instanceof THREE.Group && object.userData.unitId === tank.id) targetBody = object.children.find((child) => child.userData.aimTarget);
      });
      const forward = new THREE.Vector3(0, 0, -1).transformDirection(weapon.matrixWorld);
      expect(forward.dot(targetBody!.getWorldPosition(new THREE.Vector3()).sub(muzzle).normalize())).toBeGreaterThan(.999999);
    } finally { renderer.destroy(); }
  });

  it.each(SEASONS)('retains %s ground and tree dressing when clear weather updates', (season) => {
    const data = generateTerrain(2026, true, 3, 'france', season);
    data.kinds[400] = TERRAIN_KIND.oak; data.kinds[401] = TERRAIN_KIND.pine;
    const sim = new Simulation(2026, undefined, data); sim.state.weather = 'clear';
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, data); renderer.frame(sim.state, 0, null, [], 0);
      const ground = renderer.scene.getObjectByName('battlefield-ground') as THREE.Mesh;
      const material = ground.material as THREE.MeshStandardMaterial;
      expect(material.color.getHex()).toBe(seasonGroundColor(season));
      const oakColors: number[] = [];
      renderer.scene.traverse((object) => {
        if (object instanceof THREE.InstancedMesh && object.userData.vegetationKind === TERRAIN_KIND.oak) oakColors.push((object.material as THREE.MeshStandardMaterial).color.getHex());
      });
      if (season === 'winter') expect(oakColors).toContain(seasonPalette(season).snow);
      else expect(oakColors).toContain(seasonPalette(season).foliage[0]);
      renderer.frame(sim.state, 1, null, [], 1);
      expect(material.color.getHex()).toBe(seasonGroundColor(season));
    } finally { renderer.destroy(); }
  });

  it('renders a wheeled troop transport with six passengers and removes the passengers after unloading', () => {
    const sim = new Simulation(2026); sim.spawnEnemy('troop_transport', { x: 360, y: 480 });
    const truck = sim.state.units.at(-1)!;
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      let root: THREE.Group | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === truck.id) root = object; });
      expect(root!.getObjectByName('transport-cab')).toBeDefined();
      expect(root!.children.filter((child) => child.name === 'transport-wheel')).toHaveLength(6);
      const passengers = root!.getObjectByName('transport-passengers')!;
      expect(passengers.children).toHaveLength(6); expect(passengers.visible).toBe(true);
      expect(root!.getObjectByName('vehicle-weapon')).toBeUndefined();
      truck.transport!.passengers = 0; renderer.frame(sim.state, 1, null, [], 0);
      expect(passengers.visible).toBe(false);
    } finally { renderer.destroy(); }
  });

  it('renders ground-level campfire flames and a warm light, then removes them when the fire expires', () => {
    const sim = new Simulation(2026);
    const fire = { id: 999, unitId: sim.state.units[0]!.id, pos: { x: 480, y: 600 }, radius: 70, ticksRemaining: 1800 };
    sim.state.campfires = [fire];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    const findFire = () => {
      let found: THREE.Object3D | undefined;
      renderer.scene.traverse((object) => { if (object.userData.campfireId === fire.id) found = object; });
      return found;
    };
    try {
      renderer.frame(sim.state, 0, null, [], 0);
      const view = findFire()!;
      expect(view).toBeDefined();
      expect(view.children.filter((object) => object instanceof THREE.Mesh)).toHaveLength(4);
      const light = view.children.find((object) => object instanceof THREE.PointLight) as THREE.PointLight;
      expect(light.color.getHex()).toBe(0xffa34b);
      expect(light.intensity).toBeGreaterThan(0);
      const ground = new THREE.Vector3(...simulationToWorld(fire.pos.x, fire.pos.y));
      expect(view.position.x).toBeCloseTo(ground.x);
      expect(view.position.z).toBeCloseTo(ground.z);
      expect(view.position.y).toBeCloseTo(elevationAt(sim.state.terrain, fire.pos.x, fire.pos.y) * WORLD_UNITS_PER_PIXEL + .04);
      sim.state.campfires = []; sim.state.ticks++;
      renderer.frame(sim.state, 0, null, [], 0);
      expect(findFire()).toBeUndefined();
    } finally { renderer.destroy(); }
  });

  it('renders pontoons as a low plank deck carried by transverse floats', () => {
    const sim = new Simulation(2026), bridge = sim.state.terrain.bridges![0]!;
    bridge.type = 'pontoon';
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      let crossing: THREE.Group | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.bridgeKey === bridgeKey(bridge)) crossing = object; });
      expect(crossing!.userData.bridgeType).toBe('pontoon');
      const deck = crossing!.children.find((object) => object.userData.bridgeDeck) as THREE.Mesh;
      deck.geometry.computeBoundingBox();
      expect(deck.geometry.boundingBox!.max.y).toBeCloseTo(3 * WORLD_UNITS_PER_PIXEL);
      const floats = crossing!.getObjectByName('pontoon-floats') as THREE.InstancedMesh;
      expect(floats).toBeInstanceOf(THREE.InstancedMesh); expect(floats.count).toBeGreaterThanOrEqual(2);
    } finally { renderer.destroy(); }
  });

  it('shows patrol bounds for the selection and a live area preview without duplicate group outlines', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    sim.state.units = [unit]; unit.pos = { x: 360, y: 600 }; unit.prevPos = { ...unit.pos };
    expect(sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: 330, y: 564 }, to: { x: 552, y: 684 } }).ok).toBe(true);
    const ally = structuredClone(unit); ally.id = sim.state.nextEntityId++; sim.state.units.push(ally);
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    const outlines = () => {
      const found: THREE.Object3D[] = [];
      renderer.scene.traverse((object) => { if (object.userData.patrolUnitId !== undefined || object.userData.patrolPreview) found.push(object); });
      return found;
    };
    try {
      renderer.frame(sim.state, 0, null, [unit.id, ally.id], 0);
      expect(outlines()).toHaveLength(1);
      renderer.frame(sim.state, 0, { kind: 'patrol', pos: { x: 552, y: 684 }, patrolArea: unit.patrol!.area, valid: true }, [unit.id], 0);
      expect(outlines()).toHaveLength(2);
      renderer.frame(sim.state, 0, null, [], 0);
      expect(outlines()).toHaveLength(0);
    } finally { renderer.destroy(); }
  });

  it.each([
    { delivery: 'artillery' as const, warningTicks: 30 },
    { delivery: 'mortar' as const, warningTicks: 18 },
    { delivery: 'airSupport' as const, warningTicks: 120 },
    { delivery: undefined, warningTicks: 30 },
  ])('shows $delivery impact markers only during their warning window', ({ delivery, warningTicks }) => {
    const sim = new Simulation(2026);
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    const strike = { id: sim.state.nextEntityId++, pos: { x: 480, y: 360 }, landTick: 200,
      radius: 85, damage: 130, suppressionAmount: 45, source: 'enemy' as const, delivery };
    sim.state.strikes = [strike];
    const visible = () => {
      let found = false;
      renderer.scene.traverse((object) => { if (object.userData.strikeId === strike.id) found = true; });
      return found;
    };
    const frameAt = (tick: number) => { sim.state.ticks = tick; renderer.frame(sim.state, 0, null, [], 0); };
    try {
      frameAt(200 - warningTicks - 1); expect(visible()).toBe(false);
      frameAt(200 - warningTicks); expect(visible()).toBe(true);
      frameAt(199); expect(visible()).toBe(true);
      frameAt(200); expect(visible()).toBe(false);
    } finally { renderer.destroy(); }
  });

  it('updates damage stages only on the struck building and disposes replaced details', () => {
    const sim = new Simulation(2026), [building, other] = sim.state.buildings;
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    const rootFor = (id: number): THREE.Group => {
      let found: THREE.Group | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.buildingId === id) found = object; });
      return found!;
    };
    const hit = (health: number) => {
      building!.health = health;
      renderer.handleEvents(sim.state, [{ type: 'buildingHit', buildingId: building!.id, pos: building!.pos, damage: 1, healthAfter: health }]);
    };
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      const intactOther = rootFor(other!.id);
      hit(building!.maxHealth * .85);
      const light = rootFor(building!.id); expect(light.userData.damageStage).toBe(1);
      const scar = light.getObjectByName('building-damage')!.children.find((child) => child.userData.damageDetail === 'roof-scar') as THREE.Mesh;
      const disposed = vi.spyOn(scar.geometry, 'dispose');
      for (let i = 0; i < 10; i++) { hit(building!.maxHealth * .85 - i); expect(rootFor(building!.id)).toBe(light); }
      expect(rootFor(other!.id)).toBe(intactOther);
      hit(building!.maxHealth * .3);
      expect(disposed).toHaveBeenCalledOnce(); expect(rootFor(building!.id).userData.damageStage).toBe(3);
      expect(rootFor(other!.id)).toBe(intactOther);
      building!.destroyed = true; building!.health = 0;
      renderer.handleEvents(sim.state, [{ type: 'buildingDestroyed', buildingId: building!.id, name: building!.name, kind: building!.kind, pos: building!.pos }]);
      expect(rootFor(building!.id).userData.damageStage).toBe(5);
      expect(rootFor(building!.id).getObjectByName('building-damage')).toBeUndefined();
    } finally { renderer.destroy(); }
  });

  it('renders soldiers on and under a bridge separately and reveals the lower passage', () => {
    const sim = new Simulation(2026), under = sim.state.units[0]!;
    const bridge = sim.state.terrain.bridges!.find((candidate) => candidate.type !== 'pontoon')!;
    under.pos = { x: bridge.x, y: bridge.y }; under.prevPos = { ...under.pos };
    under.bridgePosition = { key: bridgeKey(bridge), level: 'under' };
    const above = structuredClone(under); above.id = sim.state.nextEntityId++; above.bridgePosition!.level = 'deck';
    sim.state.units = [under, above];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.rebuildStatic(sim.state, sim.terrainData());
      renderer.frame(sim.state, 1, null, [], 0);
      const roots = new Map<number, THREE.Object3D>(); let deck: THREE.Mesh | undefined;
      renderer.scene.traverse((object) => {
        if (object instanceof THREE.Group && object.userData.unitId) roots.set(object.userData.unitId, object);
        if (object instanceof THREE.Mesh && object.userData.bridgeDeck && object.parent?.userData.bridgeKey === bridgeKey(bridge)) deck = object;
      });
      expect(roots.get(above.id)!.position.y - roots.get(under.id)!.position.y).toBeCloseTo(30 * WORLD_UNITS_PER_PIXEL);
      expect((deck!.material as THREE.MeshStandardMaterial).opacity).toBe(.3);
      // Structure updates must preserve natural bridges and avoid doubling decks.
      renderer.handleEvents(sim.state, [{ type: 'constructionCompleted', kind: 'sandbag', pos: { x: 36, y: 600 } }]);
      let decks = 0; renderer.scene.traverse((object) => { if (object.userData.bridgeDeck) decks++; });
      expect(decks).toBe(sim.state.terrain.bridges!.length);
      sim.state.units = [above]; renderer.frame(sim.state, 1, null, [], 0);
      renderer.scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.userData.bridgeDeck && object.parent?.userData.bridgeKey === bridgeKey(bridge)) expect((object.material as THREE.MeshStandardMaterial).opacity).toBe(1);
      });
    } finally { renderer.destroy(); }
  });

  it('shows a longer running stride and settles the legs when movement stops', () => {
    const sim = new Simulation(2026), soldier = sim.state.units[0]!;
    sim.state.units = [soldier];
    soldier.pos = { x: 480, y: 600 }; soldier.prevPos = { x: 479, y: 600 };
    soldier.stance = 'standing'; soldier.terrainCrawling = false;
    soldier.path = [{ x: 600, y: 600 }];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      let root: THREE.Group | undefined;
      renderer.frame(sim.state, 1, null, [], 0);
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === soldier.id) root = object; });
      const leg = root!.children.find((child) => child.userData.strideSide === 1)!;
      const walkingStride = Math.abs(leg.rotation.x);
      soldier.running = true;
      renderer.frame(sim.state, 1, null, [], 0);
      expect(Math.abs(leg.rotation.x)).toBeGreaterThan(walkingStride * 2);
      soldier.running = false; soldier.prevPos = { ...soldier.pos };
      renderer.frame(sim.state, 1, null, [], .1);
      expect(leg.rotation.x).toBe(0);
    } finally { renderer.destroy(); }
  });

  it('holds its pose and facing while neighboring soldiers nudge it aside', () => {
    const sim = new Simulation(2026), soldier = sim.state.units[0]!;
    sim.state.units = [soldier]; soldier.stance = 'standing'; soldier.terrainCrawling = false;
    soldier.pos = { x: 480, y: 600 }; soldier.prevPos = { x: 479, y: 599 };
    soldier.path = [{ x: 540, y: 660 }]; soldier.moveGoal = { x: 480, y: 600 };
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], .05);
      let root: THREE.Group | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === soldier.id) root = object; });
      const facing = root!.rotation.y;
      soldier.path = [];
      for (const offset of [.2, -.2, .1, -.1, 0]) {
        soldier.prevPos = { ...soldier.pos }; soldier.pos = { x: 480 + offset, y: 600 };
        renderer.frame(sim.state, 1, null, [], .05);
        expect(root!.rotation.y).toBeCloseTo(facing);
        for (const child of root!.children.filter((part) => part.userData.strideSide !== undefined)) expect(child.rotation.x).toBe(0);
      }
    } finally { renderer.destroy(); }
  });

  it('does not flip a medic north and south while it leaves a completed order to treat a casualty', () => {
    const sim = new Simulation(2026), medic = sim.state.units[0]!, patient = sim.state.units[1]!;
    delete sim.state.terrain.elevation;
    sim.state.units = [medic, patient]; sim.state.scheduler.prepTicksLeft = 100_000;
    sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
    medic.role = 'medic'; medic.pos = { x: 396, y: 612 }; medic.moveGoal = { ...medic.pos };
    patient.pos = { x: 396, y: 492 }; patient.health = 40; patient.moveGoal = null;
    for (const unit of sim.state.units) { unit.prevPos = { ...unit.pos }; unit.path = []; unit.grenades = 0; unit.reloadTimer = 100_000; }
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      for (let tick = 0; tick < 60; tick++) {
        sim.step(); renderer.frame(sim.state, 1, null, [medic.id], 1 / 30);
        let root: THREE.Group | undefined;
        renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === medic.id) root = object; });
        expect(root!.rotation.y).toBeCloseTo(0); // Always heading north toward the casualty.
      }
    } finally { renderer.destroy(); }
  });

  it.each([true, false])('keeps stationary soldiers still when pinned=%s despite a pending path or crawl flag', (pinned) => {
    const sim = new Simulation(2026), soldier = sim.state.units[0]!;
    sim.state.units = [soldier];
    soldier.pos = { x: 480, y: 600 }; soldier.prevPos = { ...soldier.pos };
    soldier.pinned = pinned; soldier.stance = 'crouching'; soldier.crawling = true;
    soldier.path = [{ x: 600, y: 600 }];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      const heights: number[] = [];
      for (const dt of [0, .05, .1]) {
        renderer.frame(sim.state, 1, null, [], dt);
        renderer.scene.traverse((object) => {
          if (object instanceof THREE.Group && object.userData.unitId === soldier.id) heights.push(object.position.y);
        });
      }
      expect(heights).toHaveLength(3);
      expect(new Set(heights).size).toBe(1);
    } finally { renderer.destroy(); }
  });

  it('aims at a wall impact and replaces the old trail when a new shot changes direction', () => {
    const sim = new Simulation(2026), shooter = sim.state.units[0]!;
    delete sim.state.terrain.elevation;
    sim.spawnEnemy('rifle', { x: 700, y: 450 });
    const target = sim.state.units.at(-1)!;
    sim.state.units = [shooter, target];
    shooter.pos = { x: 480, y: 450 }; shooter.prevPos = { ...shooter.pos }; shooter.targetId = target.id;
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      let previous: THREE.Line | undefined;
      for (const impact of [{ x: 360, y: 250 }, { x: 650, y: 650 }]) {
        renderer.handleEvents(sim.state, [{ type: 'shot', shooterId: shooter.id, shooterTeam: shooter.team, from: { ...shooter.pos }, to: impact, targetId: null, hit: false, weapon: 'rifle' }]);
        renderer.frame(sim.state, 1, null, [], 0);
        const lines = transientLines(renderer);
        expect(lines).toHaveLength(1);
        if (previous) expect(previous.parent).toBeNull();
        const [start, end] = endpoints(lines[0]!);
        let shooterRoot: THREE.Object3D | undefined;
        renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === shooter.id) shooterRoot = object; });
        const weapon = shooterRoot!.getObjectByName('infantry-weapon');
        const forward = new THREE.Vector3(0, 0, -1).transformDirection(weapon!.matrixWorld);
        expect(forward.dot(end.clone().sub(start).normalize())).toBeGreaterThan(.999999);
        expect(end.distanceTo(new THREE.Vector3(...simulationToWorld(impact.x, impact.y, .26)))).toBeLessThan(.00001);
        previous = lines[0];
      }
    } finally { renderer.destroy(); }
  });

  it.each(['rifleman', 'gun_truck', 'vehicle'] as const)('keeps the %s barrel aligned with its shot after retargeting or losing the victim', (role) => {
    const sim = new Simulation(2026);
    delete sim.state.terrain.elevation;
    const friendly = sim.state.units[0]!;
    friendly.role = role === 'vehicle' ? 'rifleman' : role;
    sim.spawnEnemy(role === 'vehicle' ? 'vehicle' : 'rifle', { x: 360, y: 250 });
    const enemy = sim.state.units.at(-1)!;
    const shooter = role === 'vehicle' ? enemy : friendly, victim = role === 'vehicle' ? friendly : enemy;
    shooter.pos = { x: 480, y: 450 }; shooter.prevPos = { ...shooter.pos };
    const building = sim.state.buildings[0]!;
    victim.buildingPosition = { buildingId: building.id, level: 'roof', slot: 4 };
    victim.pos = buildingSlot(building, victim.buildingPosition, sim.state.terrain.cell); victim.prevPos = { ...victim.pos };
    shooter.targetId = victim.id;
    const replacement = structuredClone(victim); replacement.id = sim.state.nextEntityId++;
    replacement.pos = { x: 650, y: 480 }; replacement.prevPos = { ...replacement.pos };
    sim.state.units = [shooter, victim, replacement];
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      let victimRoot: THREE.Group | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === victim.id) victimRoot = object; });
      const victimHeight = victimRoot!.children.find((child) => child.userData.aimTarget)!.getWorldPosition(new THREE.Vector3()).y;
      // A killing shot can be delivered after the simulation removed its victim
      // and already acquired somebody on the opposite side of the battlefield.
      sim.state.units = [shooter, replacement];
      shooter.targetId = replacement.id;
      renderer.handleEvents(sim.state, [{ type: 'shot', shooterId: shooter.id, shooterTeam: shooter.team, from: { ...shooter.pos }, to: { ...victim.pos }, targetId: victim.id, hit: true, weapon: 'rifle' }]);
      renderer.frame(sim.state, 1, null, [], 0);
      const line = transientLines(renderer)[0]!, original = endpoints(line);
      expect(original[1].y).toBeCloseTo(victimHeight, 5);
      let root: THREE.Group | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === shooter.id) root = object; });
      const weapon = root!.getObjectByName('vehicle-weapon') ?? root!.getObjectByName('infantry-weapon');
      for (const dt of [0, .05, .05, .05]) {
        shooter.targetId = null;
        renderer.frame(sim.state, 1, null, [], dt);
        const [start, end] = endpoints(line);
        const forward = new THREE.Vector3(0, 0, -1).transformDirection(weapon!.matrixWorld);
        expect(forward.dot(end.clone().sub(start).normalize())).toBeGreaterThan(.999999);
        expect(start.distanceTo(weaponMuzzleWorldPosition(weapon!, weapon!.userData.weaponLength))).toBeLessThan(.00001);
        expect(start.distanceTo(original[0]!)).toBeLessThan(.00001);
        expect(end.distanceTo(original[1]!)).toBeLessThan(.00001);
      }
      renderer.frame(sim.state, 1, null, [], .1);
      renderer.frame(sim.state, 1, null, [], 0);
      expect(transientLines(renderer)).toHaveLength(0);
    } finally { renderer.destroy(); }
  });

  it.each([
    { role: 'rifleman', stance: 'standing', shooterAbove: true },
    { role: 'rifleman', stance: 'standing', shooterAbove: false },
    { role: 'sniper', stance: 'prone', shooterAbove: true },
    { role: 'sniper', stance: 'prone', shooterAbove: false },
    { role: 'mg', stance: 'crouching', shooterAbove: true },
    { role: 'at', stance: 'standing', shooterAbove: false },
    { role: 'gun_truck', stance: 'standing', shooterAbove: false },
    { role: 'vehicle', stance: 'standing', shooterAbove: false },
  ] as const)('aims the $role gun in yaw and pitch, including slopes and recoil: above=$shooterAbove', ({ role, stance, shooterAbove }) => {
    const sim = new Simulation(2026);
    const friendly = sim.state.units[0]!;
    friendly.role = role === 'vehicle' ? 'rifleman' : role;
    sim.spawnEnemy(role === 'vehicle' ? 'vehicle' : 'rifle', { x: 400, y: 350 });
    const enemy = sim.state.units.at(-1)!;
    const shooter = role === 'vehicle' ? enemy : friendly;
    const target = role === 'vehicle' ? friendly : enemy;
    sim.state.units = [shooter, target]; // Shooter is posed before its target.
    const building = sim.state.buildings[0]!;
    const high = shooterAbove ? shooter : target, low = shooterAbove ? target : shooter;
    high.buildingPosition = { buildingId: building.id, level: 'roof', slot: 4 };
    high.pos = buildingSlot(building, high.buildingPosition, sim.state.terrain.cell);
    high.prevPos = { ...high.pos };
    low.pos = { x: high.pos.x + 80, y: high.pos.y + 65 };
    low.prevPos = { x: low.pos.x - 10, y: low.pos.y + 7 };
    shooter.stance = stance;
    shooter.targetId = target.id; target.targetId = shooter.id;
    shooter.burstRemaining = 2; target.burstRemaining = 2;
    const terrain = sim.state.terrain, cols = terrain.cols + 1, rows = terrain.rows + 1;
    terrain.elevation = { cell: terrain.cell, cols, rows, heights: Float32Array.from({ length: cols * rows }, (_, i) => (i % cols) * terrain.cell * .08) };
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      for (const alpha of [0, .5, 1]) {
        renderer.frame(sim.state, alpha, null, [], .04);
        const roots = new Map<number, THREE.Group>();
        renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId) roots.set(object.userData.unitId, object); });
        for (const [source, victim] of [[shooter, target], [target, shooter]]) {
          const root = roots.get(source!.id)!;
          const weapon = root.getObjectByName('vehicle-weapon') ?? root.getObjectByName('infantry-weapon');
          const body = roots.get(victim!.id)!.children.find((child) => child.userData.aimTarget)!;
          const targetPoint = body.getWorldPosition(new THREE.Vector3());
          const muzzle = weaponMuzzleWorldPosition(weapon!, weapon!.userData.weaponLength);
          const forward = new THREE.Vector3(0, 0, -1).transformDirection(weapon!.matrixWorld);
          expect(forward.dot(targetPoint.sub(muzzle).normalize())).toBeGreaterThan(.999999);
          expect(source === high ? forward.y < 0 : forward.y > 0).toBe(true);
        }
      }
    } finally { renderer.destroy(); }
  });

  it.each([0, 2, 4, 6])('points idle garrison guns out of the selected facade, slot %i', (slot) => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!, building = sim.state.buildings[0]!;
    sim.state.units = [unit]; unit.targetId = null; unit.moveGoal = null; unit.path = [];
    unit.buildingPosition = { buildingId: building.id, level: 1, slot };
    unit.pos = buildingSlot(building, unit.buildingPosition, sim.state.terrain.cell); unit.prevPos = { ...unit.pos };
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      let weapon: THREE.Object3D | undefined;
      renderer.scene.traverse((object) => { if (object.name === 'infantry-weapon') weapon = object; });
      const expected = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)][slot / 2]!;
      expect(new THREE.Vector3(0, 0, -1).transformDirection(weapon!.matrixWorld).dot(expected)).toBeGreaterThan(.999999);
    } finally { renderer.destroy(); }
  });

  it.each([
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 1 },
  ])('keeps tank tracks along movement while the turret aims across it: $dx, $dy', ({ dx, dy }) => {
    const sim = new Simulation(2026);
    delete sim.state.terrain.elevation;
    const target = sim.state.units[0]!;
    sim.spawnEnemy('vehicle', { x: 400, y: 350 });
    const tank = sim.state.units.at(-1)!;
    sim.state.units = [target, tank];
    tank.prevPos = { x: tank.pos.x - dx, y: tank.pos.y - dy };
    tank.path = [{ x: tank.pos.x + dx * 40, y: tank.pos.y + dy * 40 }];
    target.pos = { x: tank.pos.x - dy * 100, y: tank.pos.y + dx * 100 };
    target.prevPos = { ...target.pos };
    tank.targetId = target.id;
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.frame(sim.state, 1, null, [], 0);
      let root: THREE.Group | undefined;
      renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === tank.id) root = object; });
      const track = root!.children.find((child) => child.userData.vehicleTrack) as THREE.Mesh<THREE.BoxGeometry>;
      expect(track.geometry.parameters.depth).toBeGreaterThan(track.geometry.parameters.width * 5);
      const travel = new THREE.Vector3(dx, 0, dy).normalize();
      const forward = new THREE.Vector3(0, 0, -1).transformDirection(track.matrixWorld);
      expect(forward.dot(travel)).toBeGreaterThan(.999);
      const turret = root!.getObjectByName('vehicle-turret')!;
      const aim = new THREE.Vector3(0, 0, -1).transformDirection(turret.matrixWorld);
      expect(aim.dot(new THREE.Vector3(-dy, 0, dx).normalize())).toBeGreaterThan(.999);
    } finally { renderer.destroy(); }
  });

  it.each([
    { from: { x: 140, y: 600 }, to: { x: 350, y: 260 } },
    { from: { x: 760, y: 580 }, to: { x: 580, y: 220 } },
    { from: { x: 120, y: 200 }, to: { x: 270, y: 350 } },
    { from: { x: 780, y: 240 }, to: { x: 600, y: 400 } },
  ])('keeps both teams anchored away from the map center: $from → $to', ({ from, to }) => {
    const sim = new Simulation(2026);
    const friendly = sim.state.units.find((unit) => unit.team === 'friendly')!;
    friendly.pos = { ...from };
    friendly.prevPos = { ...from };
    sim.spawnEnemy('rifle', to);
    const enemy = sim.state.units.find((unit) => unit.team === 'enemy')!;
    friendly.targetId = enemy.id;
    enemy.targetId = friendly.id;
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      renderer.handleEvents(sim.state, [friendly, enemy].map((shooter, i) => ({
        type: 'shot' as const, shooterId: shooter.id, shooterTeam: shooter.team,
        from: { ...shooter.pos }, to: { ...(i === 0 ? enemy : friendly).pos },
        targetId: (i === 0 ? enemy : friendly).id, hit: false, weapon: 'rifle',
      })));
      renderer.frame(sim.state, 1, null, [], 0);
      const lines = transientLines(renderer);
      expect(lines).toHaveLength(2);
      const original = lines.map(endpoints);
      const flashes: THREE.Object3D[] = [];
      renderer.scene.traverse((object) => { if (object.userData.muzzleFlash) flashes.push(object); });
      expect(flashes).toHaveLength(2);
      for (const flash of flashes) {
        let shooterRoot: THREE.Object3D | undefined;
        renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === flash.userData.shooterId) shooterRoot = object; });
        const weapon = shooterRoot!.getObjectByName('infantry-weapon')!;
        expect(flash.getWorldPosition(new THREE.Vector3()).distanceTo(weaponMuzzleWorldPosition(weapon, weapon.userData.weaponLength))).toBeLessThan(.00001);
      }
      [friendly, enemy].forEach((shooter, i) => {
        const target = i === 0 ? enemy : friendly;
        const shooterPosition = new THREE.Vector3(...simulationToWorld(shooter.pos.x, shooter.pos.y, elevationAt(sim.state.terrain, shooter.pos.x, shooter.pos.y) / 24 + .4));
        let targetRoot: THREE.Object3D | undefined;
        renderer.scene.traverse((object) => { if (object instanceof THREE.Group && object.userData.unitId === target.id) targetRoot = object; });
        const targetPosition = targetRoot!.children.find((child) => child.userData.aimTarget)!.getWorldPosition(new THREE.Vector3());
        expect(original[i]![0]!.distanceTo(shooterPosition)).toBeLessThan(.5);
        expect(original[i]![1]!.distanceTo(targetPosition)).toBeLessThan(.00001);
      });
      // The original failure accumulated during fading, after correct creation.
      for (const dt of [1 / 60, .05, .1, .04]) {
        renderer.frame(sim.state, 1, null, [], dt);
        lines.forEach((line, i) => {
          const current = endpoints(line);
          current.forEach((point, j) => expect(point.distanceTo(original[i]![j]!)).toBeLessThan(.00001));
        });
      }
      expect((lines[0]!.material as THREE.LineBasicMaterial).opacity).toBeLessThan(.5);
      renderer.frame(sim.state, 1, null, [], .1);
      renderer.frame(sim.state, 1, null, [], 0);
      expect(transientLines(renderer)).toHaveLength(0);
    } finally {
      renderer.destroy();
    }
  });

  it('keeps grenade arc endpoints fixed while local pulse effects still expand', () => {
    const sim = new Simulation(2026);
    const renderer = new BattleRenderer3D(document.createElement('canvas'), 960, 720);
    try {
      const from = { x: 180, y: 580 }, to = { x: 350, y: 300 };
      renderer.handleEvents(sim.state, [
        { type: 'grenadeThrown', unitId: 1, from, to, team: 'friendly', remaining: 1 },
        { type: 'moveOrdered', unitId: 1, pos: from },
      ]);
      const arc = transientLines(renderer)[0]!;
      const original = endpoints(arc);
      let pulse: THREE.Mesh | undefined;
      renderer.scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.userData.ttl !== undefined) pulse = object;
      });
      renderer.frame(sim.state, 1, null, [], .1);
      endpoints(arc).forEach((point, i) => expect(point.distanceTo(original[i]!)).toBeLessThan(.00001));
      expect(pulse!.scale.x).toBeGreaterThan(1);
    } finally {
      renderer.destroy();
    }
  });
});
