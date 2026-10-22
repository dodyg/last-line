import * as THREE from 'three';
import { UnitBatches } from './app/unit-batches';
import { AdaptiveResolution } from './app/adaptive-resolution';
import { CONFIG } from '../content/config';
import { getContent, unitDef } from '../content/validate';
import { usesBackupRifle } from '../simulation/loadout';
import { isFoliageKind, isRiverAt, riverHalfWidthAtPoint, riverPathPoints, TERRAIN_KIND, type TerrainData } from '../simulation/terrain';
import { deriveRng, rngRange } from '../simulation/rng';
import type { AmbushOrder, Building, GroundImpact, PatrolArea, Season, SimEvent, SimState, Terrain, Unit, Vec2, WeatherKind } from '../simulation/types';
import { elevationAt } from '../simulation/elevation';
import { buildingArchitecture, FLOOR_HEIGHT, positionFacing, unitBuildingHeight } from '../simulation/buildings';
import { buildingDamage, buildingDamageStage, damagedBuildingColor } from './app/building-damage';
import { buildingRubbleGeometry } from './app/building-rubble';
import { BRIDGE, bridgeContains, bridgeDeckHeight, bridgeKey, bridgeRampLength } from '../simulation/bridges';
import type { BridgeSurface } from '../simulation/types';
import type { RendererPort, PreviewInfo, DragRect } from '../game/render-contract';
import { createBattleCamera } from './app/camera';
import { insideField, simulationToWorld, WORLD_UNITS_PER_PIXEL } from './app/coordinates';
import { tracerWorldEndpoints, weaponMuzzleWorldPosition } from './app/tracer';
import { vegetationParts } from './app/vegetation';
import { damagedTreeGeometry, treeDamageStage } from './app/damaged-trees';
import { treeCellPosition } from '../simulation/tree-damage';
import { seasonGroundColor, seasonPalette } from './app/season-palette';
import { terrainSurfaceCanvas } from './app/terrain-surface';
import { BattleLighting, celestialAtTick, type CelestialState } from './app/lighting';
import { fenceSegments } from './app/fences';
import { fieldFortificationGeometry, type FieldFortification } from './app/field-fortifications';
import { groundImpactGeometry, GROUND_IMPACT_LOOK } from './app/ground-impacts';
import { drapedRingGeometry, heightfieldGeometry } from './app/heightfield';
import { HEADLIGHT_BEAM, headlightMaterial } from './app/headlights';
import { aimGunAtWorld } from './app/aiming';
import { latestNightContact } from '../simulation/perception';
import { strikeIsImminent } from '../simulation/incoming-fire';
import { dayNightAtTick } from '../simulation/daynight';
import { TANK_COMPONENTS } from '../simulation/tank-damage';

const COLORS = {
  ground: 0x566044, dirt: 0x746345, road: 0x827657, water: 0x355665, mud: 0x514638,
  friendly: 0x547ca1, enemy: 0x963f32, uniform: 0x68664d, metal: 0x353b35,
  sandbag: 0x9c8862, marker: 0xe4d59d, danger: 0xc64d36,
};
const TRACER_LIFETIME = .22;
type RenderShot = Extract<SimEvent, { type: 'shot' }> & { lastTargetHeight?: number };

/** Three.js view adapter. Simulation data is read-only; all motion here is cosmetic. */
export class BattleRenderer3D implements RendererPort {
  readonly scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly resolution = new AdaptiveResolution();
  private pixelRatio = 1;
  private readonly field = new THREE.Group();
  private readonly terrainGroup = new THREE.Group();
  private readonly buildingsGroup = new THREE.Group();
  private readonly propsGroup = new THREE.Group();
  private readonly structureGroup = new THREE.Group();
  private readonly groundImpactGroup = new THREE.Group();
  private readonly damagedTreeGroup = new THREE.Group();
  private readonly treeInstances = new Map<number, Array<{ mesh: THREE.InstancedMesh; index: number }>>();
  private readonly damagedTreeViews = new Map<number, { stage: number; mesh: THREE.Mesh }>();
  private readonly groundImpactViews = new Map<number, THREE.Mesh>();
  private readonly unitGroup = new THREE.Group();
  private readonly unitBatches = new UnitBatches();
  private readonly weatherGroup = new THREE.Group();
  private readonly stateFxGroup = new THREE.Group();
  private readonly retainedFxGroup = new THREE.Group();
  private readonly retainedFxViews = new Map<string, { signature: string; group: THREE.Group }>();
  private readonly retainedFxLive = new Set<string>();
  private readonly zoneGroup = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();
  private readonly effectGroup = new THREE.Group();
  private readonly pendingTracers: RenderShot[] = [];
  private readonly firingAims = new Map<number, { direction: THREE.Vector3; bodyFacing: number; expiresAt: number; secondary: boolean }>();
  private readonly unitViews = new Map<number, THREE.Group>();
  private readonly buildingViews = new Map<number, THREE.Group>();
  private readonly unitHitTargets: THREE.Object3D[] = [];
  private readonly sharedGeometries: THREE.BufferGeometry[] = [];
  private readonly geometryCache = new Map<string, THREE.BufferGeometry>();
  private readonly sharedMaterials: THREE.Material[] = [];
  private readonly materialCache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly basicMaterialCache = new Map<string, THREE.MeshBasicMaterial>();
  private readonly hitRaycaster = new THREE.Raycaster();
  private shakeTime = 0;
  private shakeMag = 0;
  private cameraPanX = 0;
  private cameraPanZ = 0;
  private effectTime = 0;
  private fieldMaterial: THREE.MeshStandardMaterial;
  private readonly fortificationMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  private season: Season = 'summer';
  private zoneKey = '';
  private overlayKey = '';
  private readonly particleTransform = new THREE.Object3D();
  private stateFxTick = -1;
  private rainLines: THREE.LineSegments | null = null;
  private snowPoints: THREE.Points | null = null;
  private rainBase = new Float32Array(0);
  private snowBase = new Float32Array(0);
  private riverFlowLines: THREE.LineSegments | null = null;
  private riverFlowBase = new Float32Array(0);
  private readonly lighting: BattleLighting;
  private readonly weatherColor = new THREE.Color();
  private readonly weatherFog = new THREE.FogExp2(0x242932);
  private terrain: Terrain | null = null;
  private groundMesh: THREE.Mesh | null = null;
  private headlightBeamMaterial: THREE.MeshBasicMaterial | null = null;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0x20251b, 1);
    this.camera = createBattleCamera(width, height);
    this.scene.background = new THREE.Color(0x20251b);
    this.lighting = new BattleLighting(this.scene);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(this.field);
    this.field.add(this.terrainGroup, this.groundImpactGroup, this.buildingsGroup, this.propsGroup, this.damagedTreeGroup, this.structureGroup, this.unitGroup, this.unitBatches.group, this.weatherGroup, this.stateFxGroup, this.retainedFxGroup, this.effectGroup, this.zoneGroup, this.overlayGroup);
    this.fieldMaterial = this.material(COLORS.ground, 0.98);
    this.sharedMaterials.push(this.fortificationMaterial);
    this.buildGround();
  }

  private material(color: number, roughness = 0.9, transparent = false): THREE.MeshStandardMaterial {
    const key = `${color}:${roughness}:${transparent}`;
    const cached = this.materialCache.get(key);
    if (cached) return cached;
    const material = new THREE.MeshStandardMaterial({ color, roughness, transparent, depthWrite: !transparent });
    this.sharedMaterials.push(material);
    this.materialCache.set(key, material);
    return material;
  }

  private geometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.sharedGeometries.push(geometry);
    return geometry;
  }

  private cachedGeometry<T extends THREE.BufferGeometry>(key: string, create: () => T): T {
    const cached = this.geometryCache.get(key);
    if (cached) return cached as T;
    const geometry = this.geometry(create());
    this.geometryCache.set(key, geometry);
    return geometry;
  }

  /** Automatic crawling switches models often; share their primitive shapes. */
  private modelGeometry<T extends THREE.BufferGeometry & { parameters: unknown }>(geometry: T): T {
    const key = `unit:${geometry.type}:${JSON.stringify(geometry.parameters)}`;
    const cached = this.geometryCache.get(key);
    if (cached) { geometry.dispose(); return cached as T; }
    this.geometryCache.set(key, geometry);
    return this.geometry(geometry);
  }

  private basicMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
    const key = `${color}:${opacity}`;
    const cached = this.basicMaterialCache.get(key);
    if (cached) return cached;
    const material = new THREE.MeshBasicMaterial({ color, opacity, transparent: opacity < 1, side: THREE.DoubleSide, depthWrite: opacity >= 1 });
    this.sharedMaterials.push(material);
    this.basicMaterialCache.set(key, material);
    return material;
  }

  private buildGround(data?: TerrainData): void {
    if (data) {
      const canvas = terrainSurfaceCanvas(data);
      if (canvas) {
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        this.fieldMaterial.map = texture;
        this.fieldMaterial.color.set(0xffffff);
        this.fieldMaterial.needsUpdate = true;
      }
    }
    const mesh = new THREE.Mesh(this.geometry(heightfieldGeometry(data?.terrain)), this.fieldMaterial);
    mesh.name = 'battlefield-ground';
    this.fieldMaterial.vertexColors = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.groundMesh = mesh;
    this.terrainGroup.add(mesh);
    const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[0, 0], [CONFIG.field.width, 0], [CONFIG.field.width, CONFIG.field.height], [0, CONFIG.field.height]].map(([x, y]) => new THREE.Vector3(...this.groundWorld(x!, y!, .008)))), new THREE.LineBasicMaterial({ color: 0xb4a57a }));
    this.terrainGroup.add(border);
  }

  private groundHeight(x: number, y: number): number {
    return this.terrain ? elevationAt(this.terrain, x, y) * WORLD_UNITS_PER_PIXEL : 0;
  }

  private groundWorld(x: number, y: number, offset = 0): [number, number, number] {
    return simulationToWorld(x, y, this.groundHeight(x, y) + offset);
  }

  private placeOnGround(object: THREE.Object3D, x: number, offset: number, z: number): void {
    object.position.set(x, this.groundHeight(x / WORLD_UNITS_PER_PIXEL + CONFIG.field.width / 2, z / WORLD_UNITS_PER_PIXEL + CONFIG.field.height / 2) + offset, z);
  }

  get canvas(): HTMLCanvasElement { return this.renderer.domElement; }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const zoom = this.camera.zoom;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * this.resolution.scale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera = createBattleCamera(width, height);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  updateFrameTime(deltaMs: number): void {
    if (this.resolution.sample(deltaMs) === null) return;
    this.lighting.setResolutionScale(this.resolution.scale);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * this.resolution.scale;
    this.renderer.setPixelRatio(this.pixelRatio);
  }

  /** Set a bounded orthographic zoom; 1 is the default full-field view. */
  setZoom(zoom: number): number {
    this.camera.zoom = THREE.MathUtils.clamp(zoom, 1, 3.5);
    this.clampCameraPan();
    this.camera.updateProjectionMatrix();
    return this.camera.zoom;
  }

  getZoom(): number { return this.camera.zoom; }

  /** Pan the view by a screen-space drag, clamped so it stays over the field. */
  panByScreenPixels(deltaX: number, deltaY: number, viewportWidth: number, viewportHeight: number): void {
    if (this.camera.zoom <= 1 || viewportWidth <= 0 || viewportHeight <= 0) return;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const moveRight = -deltaX * (this.camera.right - this.camera.left) / (this.camera.zoom * viewportWidth);
    const moveUp = deltaY * (this.camera.top - this.camera.bottom) / (this.camera.zoom * viewportHeight);
    this.cameraPanX += right.x * moveRight + up.x * moveUp;
    this.cameraPanZ += right.z * moveRight + up.z * moveUp;
    this.clampCameraPan();
  }

  private clampCameraPan(): void {
    const zoom = Math.max(1, this.camera.zoom);
    const maxX = CONFIG.field.width * WORLD_UNITS_PER_PIXEL * (1 - 1 / zoom) / 2;
    const maxZ = CONFIG.field.height * WORLD_UNITS_PER_PIXEL * (1 - 1 / zoom) / 2;
    this.cameraPanX = THREE.MathUtils.clamp(this.cameraPanX, -maxX, maxX);
    this.cameraPanZ = THREE.MathUtils.clamp(this.cameraPanZ, -maxZ, maxZ);
  }

  /** Simulation pixels to viewport CSS pixels, including the camera's visible shake. */
  simulationToClient(pos: Vec2, height = 0): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !insideField(pos.x, pos.y)) return null;
    const [x, y, z] = this.groundWorld(pos.x, pos.y, height);
    const point = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }

  clientToSimulation(clientX: number, clientY: number, clampToField = false): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ndc = new THREE.Vector2((clientX - rect.left) * 2 / rect.width - 1, 1 - (clientY - rect.top) * 2 / rect.height);
    this.hitRaycaster.setFromCamera(ndc, this.camera);
    this.groundMesh?.updateWorldMatrix(true, false);
    const surfaceHit = this.groundMesh ? this.hitRaycaster.intersectObject(this.groundMesh, false)[0]?.point : undefined;
    const hit = surfaceHit ?? this.hitRaycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (hit === null) return null;
    const sim = { x: hit.x / WORLD_UNITS_PER_PIXEL + CONFIG.field.width / 2, y: hit.z / WORLD_UNITS_PER_PIXEL + CONFIG.field.height / 2 };
    if (insideField(sim.x, sim.y)) return sim;
    return clampToField ? { x: Math.max(0, Math.min(CONFIG.field.width - .001, sim.x)), y: Math.max(0, Math.min(CONFIG.field.height - .001, sim.y)) } : null;
  }

  /** Returns a renderer-only friendly-unit proxy hit; it never changes eligibility. */
  friendlyUnitAt(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((clientX - rect.left) * 2 / rect.width - 1, 1 - (clientY - rect.top) * 2 / rect.height);
    this.hitRaycaster.setFromCamera(ndc, this.camera);
    const hits = this.hitRaycaster.intersectObjects(this.unitHitTargets, false);
    for (const hit of hits) {
      let parent: THREE.Object3D | null = hit.object;
      while (parent !== null && !parent.userData.unitId) parent = parent.parent;
      const id = parent?.userData.unitId as number | undefined;
      if (id !== undefined && parent?.userData.team === 'friendly') return id;
    }
    return null;
  }

  buildingAt(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    this.hitRaycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) * 2 / rect.width - 1, 1 - (clientY - rect.top) * 2 / rect.height), this.camera);
    this.buildingsGroup.updateWorldMatrix(true, true);
    for (const hit of this.hitRaycaster.intersectObject(this.buildingsGroup, true)) {
      let object: THREE.Object3D | null = hit.object;
      while (object && !object.userData.buildingCenter) object = object.parent;
      if (object?.userData.buildingCenter) return object.userData.buildingCenter as Vec2;
    }
    return null;
  }

  rendererDiagnostics(): { geometries: number; textures: number; calls: number; triangles: number; pixelRatio: number } {
    return { geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, pixelRatio: this.pixelRatio };
  }

  rebuildStatic(state: SimState, data: TerrainData): void {
    this.unitBatches.clear();
    this.overlayKey = '';
    this.season = state.season ?? data.season ?? 'summer';
    this.firingAims.clear();
    this.pendingTracers.length = 0;
    this.terrain = state.terrain;
    this.terrain.bridges ??= data.zones.bridges;
    this.clearGroup(this.terrainGroup, true);
    this.clearGroup(this.buildingsGroup, true);
    this.clearGroup(this.propsGroup, true);
    this.clearGroup(this.structureGroup, true);
    this.clearGroup(this.groundImpactGroup, true); this.groundImpactViews.clear();
    this.clearGroup(this.damagedTreeGroup, true); this.damagedTreeViews.clear(); this.treeInstances.clear();
    this.clearGroup(this.unitGroup, true);
    this.clearGroup(this.effectGroup, true);
    this.clearGroup(this.weatherGroup, true);
    this.clearGroup(this.stateFxGroup, true);
    this.clearGroup(this.retainedFxGroup, true, false);
    this.retainedFxViews.clear();
    this.clearGroup(this.zoneGroup, true);
    this.clearGroup(this.overlayGroup, true);
    for (const geometry of this.sharedGeometries) geometry.dispose();
    for (const material of this.sharedMaterials) { (material as THREE.MeshStandardMaterial).map?.dispose(); material.dispose(); }
    this.sharedGeometries.length = 0;
    this.geometryCache.clear();
    this.sharedMaterials.length = 0;
    this.materialCache.clear();
    this.basicMaterialCache.clear();
    this.unitViews.clear();
    this.buildingViews.clear();
    this.unitHitTargets.length = 0;
    this.riverFlowLines = null;
    this.riverFlowBase = new Float32Array(0);
    this.rainLines = null;
    this.snowPoints = null;
    // Recreate only the ground and terrain-owned geometry. Shared primitives/materials remain cached.
    this.fieldMaterial = this.material(seasonGroundColor(this.season), .98);
    this.sharedMaterials.push(this.fortificationMaterial);
    this.buildGround(data);
    this.drawTerrain(data);
    this.buildWeather(data.weather, data.seed);
    for (const building of state.buildings) this.building(building, state.seed);
    this.structures(state);
    this.updateGroundImpacts(state);
    this.updateDamagedTrees(state);
    this.zoneKey = '';
    this.drawZones(state);
    this.effectTime = 0;
    this.stateFxTick = -1;
  }

  private clearGroup(group: THREE.Group, dispose: boolean, pruneShared = true): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (!dispose) continue;
      child.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) object.dispose();
        const mesh = object as THREE.Mesh;
        if (mesh.geometry && !this.sharedGeometries.includes(mesh.geometry)) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        mats.forEach((mat) => { if (!this.sharedMaterials.includes(mat)) { (mat as THREE.MeshStandardMaterial).map?.dispose(); mat.dispose(); } });
      });
    }
    if (dispose && pruneShared) {
      const active = new Set<THREE.BufferGeometry>();
      const cached = new Set(this.geometryCache.values());
      this.field.traverse((object) => { const geometry = (object as THREE.Mesh).geometry; if (geometry) active.add(geometry); });
      for (let i = this.sharedGeometries.length - 1; i >= 0; i--) {
        const geometry = this.sharedGeometries[i]!;
        if (!active.has(geometry) && !cached.has(geometry)) { geometry.dispose(); this.sharedGeometries.splice(i, 1); }
      }
    }
  }

  private drawTerrain(data: TerrainData): void {
    const { terrain, kinds } = data;
    const cell = terrain.cell;
    const rockGeo = this.geometry(new THREE.DodecahedronGeometry(0.2, 0));
    const flowerGeo = this.geometry(new THREE.SphereGeometry(0.035, 5, 4));
    const kindsToProps: number[] = [TERRAIN_KIND.trees, TERRAIN_KIND.oak, TERRAIN_KIND.beech, TERRAIN_KIND.birch, TERRAIN_KIND.pine, TERRAIN_KIND.fruitTree, TERRAIN_KIND.shrub, TERRAIN_KIND.tallGrass, TERRAIN_KIND.rocks, TERRAIN_KIND.obstacle, TERRAIN_KIND.stoneFence, TERRAIN_KIND.woodFence, TERRAIN_KIND.wildflower, TERRAIN_KIND.ruins];
    const groups = new Map<number, Array<{ x: number; y: number }>>();
    for (const kind of kindsToProps) groups.set(kind, []);
    for (let i = 0; i < kinds.length; i++) groups.get(kinds[i]!)?.push({ x: i % terrain.cols, y: Math.floor(i / terrain.cols) });
    for (const [kind, positions] of groups) {
      if (!positions.length) continue;
      if (isFoliageKind(kind)) {
        const helper = new THREE.Object3D();
        for (const part of vegetationParts(kind, this.season)) {
          const mesh = new THREE.InstancedMesh(this.geometry(part.geometry), this.material(part.color), positions.length);
          positions.forEach((p, i) => {
            const [x, , z] = this.groundWorld((p.x + .5) * cell, (p.y + .5) * cell);
            // Stable visual variation never consumes gameplay randomness.
            const variation = ((p.x * 73856093) ^ (p.y * 19349663) ^ data.seed) >>> 0;
            this.placeOnGround(helper, x, .025, z);
            helper.rotation.y = (variation % 360) * Math.PI / 180;
            helper.scale.setScalar(.86 + (variation % 23) * .01);
            helper.updateMatrix();
            mesh.setMatrixAt(i, helper.matrix);
            const cellIndex = p.y * terrain.cols + p.x, instances = this.treeInstances.get(cellIndex) ?? [];
            instances.push({ mesh, index: i }); this.treeInstances.set(cellIndex, instances);
          });
          mesh.instanceMatrix.needsUpdate = true;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.userData.vegetationKind = kind;
          this.propsGroup.add(mesh);
        }
      } else if (kind === TERRAIN_KIND.rocks || kind === TERRAIN_KIND.obstacle || kind === TERRAIN_KIND.ruins) {
        const mesh = new THREE.InstancedMesh(kind === TERRAIN_KIND.rocks ? rockGeo : new THREE.BoxGeometry(0.5, 0.45, 0.32), this.material(this.season === 'winter' ? 0xb7c0ba : kind === TERRAIN_KIND.rocks ? 0x625f53 : kind === TERRAIN_KIND.obstacle ? 0x555148 : 0x514a3c), positions.length);
        mesh.castShadow = true; mesh.receiveShadow = true;
        const helper = new THREE.Object3D();
        positions.forEach((p, i) => { const [x, , z] = this.groundWorld((p.x + 0.5) * cell, (p.y + 0.5) * cell); this.placeOnGround(helper, x, 0.13, z); helper.rotation.set(i * .12, i, i * .05); helper.updateMatrix(); mesh.setMatrixAt(i, helper.matrix); });
        this.propsGroup.add(mesh);
      } else if (kind === TERRAIN_KIND.stoneFence || kind === TERRAIN_KIND.woodFence) {
        const segments = positions.flatMap((p) => fenceSegments(terrain, kinds, p.x, p.y));
        const wood = kind === TERRAIN_KIND.woodFence;
        const cube = this.cachedGeometry('fence-cube', () => new THREE.BoxGeometry(1, 1, 1));
        const rails = new THREE.InstancedMesh(cube, this.material(wood ? 0x684d34 : 0x777367), segments.length * (wood ? 2 : 1));
        const transform = new THREE.Object3D();
        segments.forEach((segment, i) => {
          const from = new THREE.Vector3(...this.groundWorld(segment.from.x, segment.from.y));
          const to = new THREE.Vector3(...this.groundWorld(segment.to.x, segment.to.y));
          const direction = to.clone().sub(from);
          const center = from.clone().add(to).multiplyScalar(.5);
          transform.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.clone().normalize());
          transform.scale.set(direction.length(), wood ? .045 : .22, wood ? .045 : .11);
          for (let level = 0; level < (wood ? 2 : 1); level++) {
            transform.position.copy(center); transform.position.y += wood ? .11 + level * .12 : .11;
            transform.updateMatrix(); rails.setMatrixAt(i * (wood ? 2 : 1) + level, transform.matrix);
          }
        });
        rails.instanceMatrix.needsUpdate = true;
        rails.castShadow = true; rails.receiveShadow = true;
        rails.userData.fenceKind = kind;
        this.propsGroup.add(rails);
        if (wood) {
          const endpoints = new Map(segments.flatMap((segment) => [segment.from, segment.to]).map((p) => [`${p.x}:${p.y}`, p]));
          const posts = new THREE.InstancedMesh(cube, this.material(0x59432e), endpoints.size);
          transform.rotation.set(0, 0, 0); transform.scale.set(.065, .32, .065);
          [...endpoints.values()].forEach((p, i) => {
            const [x, , z] = this.groundWorld(p.x, p.y);
            this.placeOnGround(transform, x, .16, z); transform.updateMatrix(); posts.setMatrixAt(i, transform.matrix);
          });
          posts.instanceMatrix.needsUpdate = true;
          posts.castShadow = true; posts.receiveShadow = true;
          this.propsGroup.add(posts);
        }
      } else if (kind === TERRAIN_KIND.wildflower) {
        if (this.season === 'winter') continue;
        const mesh = new THREE.InstancedMesh(flowerGeo, this.material(this.season === 'spring' ? 0xe3c3bb : this.season === 'autumn' ? 0xb48c49 : 0xc6a969), positions.length * 3);
        const helper = new THREE.Object3D();
        positions.forEach((p, i) => {
          const [x, , z] = this.groundWorld((p.x + .5) * cell, (p.y + .5) * cell);
          for (let dot = 0; dot < 3; dot++) {
            const j = i * 3 + dot;
            this.placeOnGround(helper, x + (dot - 1) * .1, .035, z + ((i + dot) % 2 ? .06 : -.06));
            helper.updateMatrix(); mesh.setMatrixAt(j, helper.matrix);
          }
        });
        this.propsGroup.add(mesh);
      }
    }
    const river = data.zones.river;
    if (river !== null) {
      const points = riverPathPoints(river, data.seed, 5).filter((point) => insideField(point.x, point.y));
      const rng = deriveRng(data.seed, 0x57415452);
      const count = Math.min(88, points.length);
      this.riverFlowBase = new Float32Array(count * 5);
      const positions = new Float32Array(count * 6);
      for (let i = 0; i < count; i++) {
        const index = Math.floor(rngRange(rng, 0, Math.max(1, points.length - 1)));
        const point = points[index]!;
        const next = points[Math.min(points.length - 1, index + 1)]!;
        const tangent = new THREE.Vector2(next.x - point.x, next.y - point.y).normalize();
        const offset = rngRange(rng, -.45, .45) * riverHalfWidthAtPoint(river, data.seed, point.x, point.y);
        let px = point.x - tangent.y * offset, py = point.y + tangent.x * offset;
        if (!isRiverAt(data.zones, data.seed, px, py)) { px = point.x; py = point.y; }
        const [x, , z] = this.groundWorld(px, py);
        const dirX = tangent.x, dirZ = tangent.y;
        this.riverFlowBase.set([x, z, dirX, dirZ, rngRange(rng, 0, 3)], i * 5);
      }
      const flowGeo = new THREE.BufferGeometry();
      flowGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      this.riverFlowLines = new THREE.LineSegments(flowGeo, new THREE.LineBasicMaterial({ color: 0xb5d5d2, transparent: true, opacity: .42 }));
      this.terrainGroup.add(this.riverFlowLines);
    }
  }

  private building(building: Building, seed: number): void {
    const width = building.cols * CONFIG.terrain.cell * WORLD_UNITS_PER_PIXEL;
    const depth = building.rows * CONFIG.terrain.cell * WORLD_UNITS_PER_PIXEL;
    const center = { x: building.pos.x + building.cols * CONFIG.terrain.cell / 2, y: building.pos.y + building.rows * CONFIG.terrain.cell / 2 };
    const [x, , z] = this.groundWorld(center.x, center.y);
    const root = new THREE.Group(); this.placeOnGround(root, x, 0, z); this.buildingsGroup.add(root);
    root.userData.buildingId = building.id;
    const damageStage = buildingDamageStage(building);
    root.userData.damageStage = damageStage; this.buildingViews.set(building.id, root);
    const architecture = buildingArchitecture(building);
    const floorHeight = FLOOR_HEIGHT * WORLD_UNITS_PER_PIXEL;
    const height = architecture.floors * floorHeight;
    const box = (w: number, h: number, d: number, px: number, py: number, pz: number, color: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(w, h, d)), this.material(color));
      mesh.position.set(px, py, pz); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh;
    };
    if (building.destroyed) {
      const groundY = this.groundHeight(center.x, center.y);
      const geometry = buildingRubbleGeometry(building, seed, width, depth,
        (dx, dz) => this.groundHeight(center.x + dx / WORLD_UNITS_PER_PIXEL, center.y + dz / WORLD_UNITS_PER_PIXEL) - groundY);
      const rubble = new THREE.Mesh(geometry, this.fortificationMaterial);
      rubble.name = 'building-rubble'; rubble.castShadow = true; rubble.receiveShadow = true; root.add(rubble); return;
    }
    root.userData.buildingCenter = center;
    const masonry = damagedBuildingColor(building.kind === 'hospital' ? 0xb5ac91 : building.kind === 'barn' ? 0x947b5e : 0xa49b7d, damageStage);
    box(width * .94, height, depth * .94, 0, height / 2, 0, masonry);
    for (let floor = 0; floor < architecture.floors; floor++) {
      const base = floor * floorHeight;
      if (floor > 0) box(width * .98, .055, depth * .98, 0, base, 0, 0x827b66);
      // Windows on every facade align with the simulation's firing slots.
      for (const fraction of [-.22, .22]) for (const side of [-1, 1]) {
        box(.31, .38, .035, width * fraction, base + .35, side * depth * .476, damageStage >= 2 ? 0x222722 : 0x35413e);
        box(.38, .05, .065, width * fraction, base + .14, side * depth * .48, 0xbeb49a);
        box(.035, .38, .31, side * width * .476, base + .35, depth * fraction, damageStage >= 2 ? 0x222722 : 0x35413e);
        box(.065, .05, .38, side * width * .48, base + .14, depth * fraction, 0xbeb49a);
      }
    }
    for (const side of [-1, 1]) {
      box(.23, .4, .035, 0, .2, side * depth * .48, 0x494232);
      box(.035, .4, .23, side * width * .48, .2, 0, 0x494232);
    }
    const snowRoof = (color: number): number => new THREE.Color(color).lerp(new THREE.Color(seasonPalette(this.season).snow), seasonPalette(this.season).snowCover).getHex();
    const roofColor = snowRoof(damagedBuildingColor(building.kind === 'church' ? 0x62666c : 0x795b43, damageStage));
    if (architecture.roofStyle === 'pitched') {
      const span = Math.min(width, depth) * 1.04, length = Math.max(width, depth) * 1.04;
      const profile = new THREE.Shape();
      profile.moveTo(-span / 2, 0); profile.lineTo(0, Math.min(.75, span * .35)); profile.lineTo(span / 2, 0); profile.closePath();
      const roof = new THREE.Mesh(this.geometry(new THREE.ExtrudeGeometry(profile, { depth: length, bevelEnabled: false }).translate(0, 0, -length / 2)), this.material(roofColor));
      roof.rotation.y = width > depth ? Math.PI / 2 : 0;
      roof.position.y = height; roof.castShadow = true; root.add(roof);
    } else {
      box(width, .1, depth, 0, height, 0, snowRoof(damagedBuildingColor(0x8d8878, damageStage)));
      for (const side of [-1, 1]) {
        box(width, .17, .07, 0, height + .13, side * depth * .47, masonry);
        box(.07, .17, depth, side * width * .47, height + .13, 0, masonry);
      }
      if (architecture.rooftopAccess) {
        box(.35, .38, .4, 0, height + .24, 0, masonry);
        box(.2, .27, .025, 0, height + .18, .21, 0x494232);
        box(.42, .06, .47, 0, height + .46, 0, 0x696653);
      }
    }
    if (architecture.balcony) {
      const balconyZ = depth / 2 + .22, balconyWidth = width * .76;
      box(balconyWidth, .08, .6, 0, floorHeight, balconyZ, 0x8e8872);
      box(balconyWidth, .045, .045, 0, floorHeight + .25, balconyZ + .26, 0x4d544c);
      for (let i = 0; i < 7; i++) box(.025, .25, .025, balconyWidth * (i / 6 - .5), floorHeight + .13, balconyZ + .26, 0x4d544c);
      for (const side of [-1, 1]) box(.035, .25, .55, side * balconyWidth / 2, floorHeight + .13, balconyZ, 0x4d544c);
    }
    if (building.kind === 'church' || building.kind === 'castle') {
      const tower = new THREE.Mesh(this.geometry(new THREE.CylinderGeometry(.22, .3, .65, 6)), this.material(0x777467));
      tower.position.set(width * .28, height + .4, depth * .28); tower.castShadow = true; root.add(tower);
    }
    if (damageStage > 0) root.add(buildingDamage(building, width, depth, height, architecture.roofStyle === 'pitched', (color) => this.material(color)));
  }

  private deck(bridge: BridgeSurface): void {
    const scale = WORLD_UNITS_PER_PIXEL, key = bridgeKey(bridge);
    const group = new THREE.Group(); group.userData.bridgeKey = key; group.userData.bridgeType = bridge.type;
    const [x, , z] = this.groundWorld(bridge.x, bridge.y); this.placeOnGround(group, x, 0, z);
    if (bridge.axis === 'vertical') group.rotation.y = -Math.PI / 2;
    const half = bridge.halfLength, flat = half - bridgeRampLength(bridge);
    const height = bridge.type === 'pontoon' ? BRIDGE.lowHeight : BRIDGE.raisedHeight;
    const points = bridge.type === 'pontoon' ? [[-half, height], [half, height]] : [[-half, 0], [-flat, height], [flat, height], [half, 0]];
    const profile = new THREE.Shape();
    points.forEach(([along, top], i) => i ? profile.lineTo(along! * scale, top! * scale) : profile.moveTo(along! * scale, top! * scale));
    for (const [along, top] of [...points].reverse()) profile.lineTo(along! * scale, (top! - BRIDGE.thickness) * scale);
    profile.closePath();
    const color = bridge.type === 'stone' ? 0x777366 : bridge.type === 'pontoon' ? 0x827558 : 0x73654f;
    const matKey = `bridge:${key}:${color}`;
    let mat = this.materialCache.get(matKey);
    if (!mat) { mat = new THREE.MeshStandardMaterial({ color, roughness: .95, transparent: true }); this.materialCache.set(matKey, mat); this.sharedMaterials.push(mat); }
    const geometry = this.cachedGeometry(`bridge-profile:${half}:${bridge.halfWidth}:${height}`, () => new THREE.ExtrudeGeometry(profile, { depth: bridge.halfWidth * 2 * scale, bevelEnabled: false, steps: 1 }));
    const deck = new THREE.Mesh(geometry, mat); deck.position.z = -bridge.halfWidth * scale;
    deck.userData.bridgeDeck = true; deck.castShadow = true; deck.receiveShadow = true; group.add(deck);
    if (bridge.type === 'pontoon') {
      const count = Math.max(2, Math.ceil(half * 2 / 24));
      const floats = new THREE.InstancedMesh(this.cachedGeometry(`pontoon-float:${bridge.halfWidth}`,
        () => new THREE.CapsuleGeometry(.1, (bridge.halfWidth * 2 + 12) * scale - .2, 2, 6)), this.material(0x485348), count);
      floats.name = 'pontoon-floats';
      const transform = new THREE.Object3D(); transform.rotation.x = Math.PI / 2;
      for (let i = 0; i < count; i++) {
        transform.position.set((-half + (i + .5) * half * 2 / count) * scale, .025, 0);
        transform.updateMatrix(); floats.setMatrixAt(i, transform.matrix);
      }
      floats.instanceMatrix.needsUpdate = true; floats.castShadow = true; group.add(floats);
      const seams: THREE.Vector3[] = [];
      for (let along = -half + 5; along < half; along += 5) {
        for (const side of [-1, 1]) seams.push(new THREE.Vector3(along * scale, height * scale + .008, side * bridge.halfWidth * scale));
      }
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seams),
        new THREE.LineBasicMaterial({ color: 0x504935, transparent: true, opacity: .65 })));
    }
    if (bridge.type !== 'pontoon') for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(this.cachedGeometry(`bridge-rail:${flat}`, () => new THREE.BoxGeometry(flat * 2 * scale, .08, .06)), this.material(0x59584c));
      rail.position.set(0, height * scale + .18, side * bridge.halfWidth * scale); group.add(rail);
      for (const end of [-1, 1]) {
        const pier = new THREE.Mesh(this.cachedGeometry('bridge-pier', () => new THREE.BoxGeometry(.22, BRIDGE.raisedHeight * scale, .2)), this.material(0x69675a));
        pier.position.set(end * flat * scale, height * scale / 2, side * (bridge.halfWidth + 3) * scale); group.add(pier);
      }
    }
    this.structureGroup.add(group);
  }

  private structures(state: SimState): void {
    const build = (kind: FieldFortification, id: number, pos: Vec2) => {
      const [x, y, z] = this.groundWorld(pos.x, pos.y);
      const geometry = fieldFortificationGeometry(kind, (state.seed ^ Math.imul(id, 159)) >>> 0,
        (dx, dz) => this.groundHeight(pos.x + dx / WORLD_UNITS_PER_PIXEL, pos.y + dz / WORLD_UNITS_PER_PIXEL) - y);
      const mesh = new THREE.Mesh(geometry, this.fortificationMaterial);
      mesh.name = `field-${kind}`; mesh.userData.fortificationId = id; mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true; this.structureGroup.add(mesh);
    };
    for (const b of state.sandbags) build('sandbag', b.id, b.pos);
    for (const t of state.trenches) build('trench', t.id, t.pos);
    for (const b of state.bunkers) build('bunker', b.id, b.pos);
    for (const pit of state.mortarPits) build('mortarPit', pit.id, pit.pos);
    for (const wire of state.barbedWire) build('barbedWire', wire.id, wire.pos);
    for (const bridge of state.terrain.bridges ?? []) this.deck(bridge);
    for (const mine of state.mines) { const [x, , z] = this.groundWorld(mine.pos.x, mine.pos.y); const m = new THREE.Mesh(this.geometry(new THREE.CylinderGeometry(.09, .1, .035, 8)), this.material(mine.kind === 'at' ? 0x726f5a : 0x77704d)); this.placeOnGround(m, x, .025, z); this.structureGroup.add(m); }
    for (const site of state.constructionSites) {
      const [x, , z] = this.groundWorld(site.pos.x, site.pos.y); const ghost: THREE.Mesh<THREE.BufferGeometry> = new THREE.Mesh(this.geometry(new THREE.CylinderGeometry(.3, .3, .035, 18)), this.material(0xd5b865, .8, true)); this.placeOnGround(ghost, x, .025, z); ghost.userData.siteId = site.id; this.structureGroup.add(ghost);
      if (site.kind === 'barbedWire') {
        ghost.geometry = this.geometry(new THREE.BoxGeometry(CONFIG.barbedWire.halfLength * 2 * WORLD_UNITS_PER_PIXEL, .045, CONFIG.barbedWire.halfDepth * 2 * WORLD_UNITS_PER_PIXEL));
        ghost.name = 'wire-construction';
      }
    }
  }

  private makeUnit(unit: Unit): THREE.Group {
    const root = new THREE.Group(); root.userData.unitId = unit.id; root.userData.team = unit.team;
    root.userData.stance = unit.terrainCrawling ? 'prone' : unit.stance ?? 'standing'; root.userData.pinned = unit.pinned; root.userData.headlightsOn = unit.headlightsOn !== false;
    root.userData.backupRifle = usesBackupRifle(unit, getContent());
    const isVehicle = unit.role === 'vehicle' || unit.role === 'gun_truck' || unit.role === 'troop_transport';
    const color = unit.tankCrew ? 0x66655a : unit.team === 'friendly' ? COLORS.friendly : COLORS.enemy;
    const bodyMat = this.material(isVehicle ? 0x626953 : color);
    if (isVehicle) {
      // Models face local -Z, the same axis used by infantry and path headings.
      const hull = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.55, .36, unit.role === 'vehicle' ? .9 : unit.role === 'troop_transport' ? 1.45 : 1.05)), bodyMat); hull.position.y = .23; hull.castShadow = true; hull.userData.aimTarget = true; root.add(hull);
      if (unit.role === 'vehicle') {
        const turretRoot = new THREE.Group(); turretRoot.name = 'vehicle-turret'; turretRoot.position.y = .48; root.add(turretRoot);
        const turret = new THREE.Mesh(this.modelGeometry(new THREE.CylinderGeometry(.2, .27, .18, 8)), this.material(0x4b5144)); turret.name = 'tank-turret'; turretRoot.add(turret);
        const barrelPivot = new THREE.Group(); barrelPivot.name = 'weapon-aim'; barrelPivot.position.set(0, .01, -.11); turretRoot.add(barrelPivot);
        const barrel = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.07, .07, .42)), this.material(0x30332c)); barrel.position.z = -.21; barrel.name = 'vehicle-weapon'; barrel.userData.weapon = true; barrel.userData.weaponLength = .42; barrelPivot.add(barrel);
        const mgPivot = new THREE.Group(); mgPivot.name = 'machine-gun-aim'; mgPivot.position.set(.18, .34, -.39); root.add(mgPivot);
        const mg = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.035, .035, .24)), this.material(0x292c28));
        mg.name = 'tank-machine-gun'; mg.position.z = -.12; mg.userData.weapon = true; mg.userData.weaponLength = .24; mgPivot.add(mg);
        TANK_COMPONENTS.forEach((component, index) => {
          const marker = new THREE.Mesh(this.modelGeometry(new THREE.RingGeometry(.63, .69, 8, 1, index * Math.PI * 2 / 3, Math.PI * .5)), this.basicMaterial(0xe4a052, .85));
          marker.name = `tank-damage-${component}`; marker.rotation.x = -Math.PI / 2; marker.position.y = .035; marker.visible = false; root.add(marker);
        });
      } else if (unit.role === 'troop_transport') {
        const cab = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.54, .28, .4)), this.material(0x777c68));
        cab.name = 'transport-cab'; cab.position.set(0, .5, -.45); root.add(cab);
        const windshield = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.42, .12, .025)), this.material(0x879d9d));
        windshield.position.set(0, .54, -.66); root.add(windshield);
        for (const side of [-1, 1]) {
          const board = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.04, .2, .9)), this.material(0x6b6651));
          board.position.set(side * .28, .48, .22); root.add(board);
        }
        const tailgate = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.6, .2, .045)), this.material(0x6b6651));
        tailgate.position.set(0, .48, .68); root.add(tailgate);
        const passengers = new THREE.Group(); passengers.name = 'transport-passengers';
        for (let i = 0; i < 6; i++) {
          const soldier = new THREE.Group(); soldier.name = `transport-passenger-${i + 1}`;
          const body = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.12, .17, .12)), this.material(0x696c58));
          body.position.y = .47; soldier.add(body);
          const helmet = new THREE.Mesh(this.modelGeometry(new THREE.SphereGeometry(.075, 6, 4)), this.material(0x414c3c));
          helmet.position.y = .6; soldier.add(helmet);
          soldier.position.set(i % 2 === 0 ? -.14 : .14, 0, -.02 + Math.floor(i / 2) * .24); passengers.add(soldier);
        }
        passengers.visible = (unit.transport?.passengers ?? 0) > 0; root.add(passengers);
      } else {
        const cab = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.52, .25, .3)), this.material(0x777c68)); cab.position.set(0, .49, -.25); root.add(cab);
        const turretRoot = new THREE.Group(); turretRoot.name = 'vehicle-turret'; turretRoot.position.set(0, .48, .22); root.add(turretRoot);
        const gunPivot = new THREE.Group(); gunPivot.name = 'weapon-aim'; turretRoot.add(gunPivot);
        const gun = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.07, .07, .4)), this.material(0x292c28)); gun.position.z = -.2; gun.name = 'vehicle-weapon'; gun.userData.weapon = true; gun.userData.weaponLength = .4; gunPivot.add(gun);
      }
      for (const side of [-1, 1]) {
        if (unit.role === 'troop_transport') {
          for (const axle of [-.48, .12, .52]) {
            const wheel = new THREE.Mesh(this.modelGeometry(new THREE.CylinderGeometry(.13, .13, .1, 8)), this.material(0x252a24));
            wheel.name = 'transport-wheel'; wheel.rotation.z = Math.PI / 2; wheel.position.set(side * .32, .13, axle); root.add(wheel);
          }
        } else {
          const track = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.12, .23, 1.04)), this.material(0x30352f)); track.position.set(side * .31, .12, 0); track.userData.vehicleTrack = true; root.add(track);
        }
      }
      const lampZ = unit.role === 'vehicle' ? -.47 : unit.role === 'troop_transport' ? -.75 : -.55;
      for (const side of [-1, 1]) {
        const light = new THREE.Mesh(this.modelGeometry(new THREE.SphereGeometry(.045, 6, 4)), new THREE.MeshStandardMaterial({ color: 0xffe1a1, emissive: unit.headlightsOn === false ? 0x000000 : 0xffc962, emissiveIntensity: unit.headlightsOn === false ? 0 : 1.6 }));
        light.position.set(side * .26, .29, lampZ); root.add(light);
      }
      if (!this.headlightBeamMaterial) {
        this.headlightBeamMaterial = headlightMaterial();
        this.sharedMaterials.push(this.headlightBeamMaterial);
      }
      const beams = new THREE.Group(); beams.userData.headlightBeam = true; beams.visible = false;
      const beamGeometry = this.cachedGeometry('headlight-ground', () => new THREE.PlaneGeometry(HEADLIGHT_BEAM.width, HEADLIGHT_BEAM.length));
      for (const side of [-1, 1]) {
        const beam = new THREE.Mesh(beamGeometry, this.headlightBeamMaterial);
        beam.rotation.x = -Math.PI / 2;
        beam.position.set(side * .26, .025, lampZ - HEADLIGHT_BEAM.length / 2);
        beams.add(beam);
      }
      root.add(beams);
      root.userData.selected = false;
      return root;
    }
    const stance = unit.terrainCrawling ? 'prone' : unit.stance ?? 'standing';
    const prone = stance === 'prone';
    const crouch = stance === 'crouching' ? .75 : stance === 'prone' ? .42 : 1;
    const torso = new THREE.Mesh(this.modelGeometry(new THREE.CapsuleGeometry(.105, .24 * crouch, 3, 5)), bodyMat); torso.position.y = .39 * crouch; torso.castShadow = true; torso.userData.aimTarget = true; root.add(torso);
    const head = new THREE.Mesh(this.modelGeometry(new THREE.SphereGeometry(.095, 7, 5)), this.material(unit.team === 'friendly' ? 0xb79c73 : 0xb28f70)); head.position.set(0, .63 * crouch, -.025); root.add(head);
    if (prone) { torso.rotation.x = Math.PI / 2; torso.scale.y = 1.5; torso.position.set(0, .13, .02); head.position.set(0, .14, -.22); }
    const limb = this.modelGeometry(new THREE.CapsuleGeometry(.035, .16 * crouch, 2, 4));
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(limb, this.material(0x3d4338)); leg.position.set(side * .065, .16 * crouch, .02); leg.userData.strideSide = side; root.add(leg);
      const arm = new THREE.Mesh(limb, this.material(0x5a5b49)); arm.position.set(side * .125, .42 * crouch, -.13); arm.rotation.x = .65; root.add(arm);
      if (prone) { leg.rotation.x = Math.PI / 2; leg.position.set(side * .065, .07, .29); arm.rotation.x = Math.PI / 2; arm.position.set(side * .125, .12, -.2); }
    }
    const bazooka = unit.team === 'friendly' && unit.role === 'at' && !root.userData.backupRifle;
    const sten = unit.team === 'friendly' && unitDef(getContent(), unit.role, unit.team).weapon === 'sten';
    const weaponLength = bazooka ? .68 : sten ? .23 : unit.tankCrew ? .13 : unit.role === 'mg' ? .35 : .26;
    const weaponPivot = new THREE.Group(); weaponPivot.name = 'weapon-aim';
    weaponPivot.position.set(bazooka ? .12 : .02, prone ? .14 : (bazooka ? .52 : .4) * crouch, bazooka ? .12 : (prone ? -.4 : -.25) + weaponLength / 2); root.add(weaponPivot);
    // Rotate the geometry so the launch tube keeps the same local -Z aiming
    // and muzzle axis as other weapons, including while posed or recoiling.
    const weaponGeometry = bazooka ? new THREE.CylinderGeometry(.047, .047, weaponLength, 10, 1, true).rotateX(Math.PI / 2)
      : sten ? new THREE.CylinderGeometry(.022, .022, weaponLength, 8).rotateX(Math.PI / 2)
      : new THREE.BoxGeometry(.045, .045, weaponLength);
    const weapon = new THREE.Mesh(this.modelGeometry(weaponGeometry), this.material(bazooka ? 0x62684b : unit.role === 'medic' ? 0x7c7b68 : 0x252823)); weapon.position.z = -weaponLength / 2; weapon.name = 'infantry-weapon'; weapon.userData.weapon = true; weapon.userData.weaponLength = weaponLength; weaponPivot.add(weapon);
    if (root.userData.backupRifle) weapon.userData.weaponId = 'rifle';
    if (sten) {
      weapon.userData.weaponId = 'sten';
      const magazine = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.13, .025, .04)), this.material(0x343a34));
      magazine.name = 'sten-side-magazine'; magazine.position.set(-.08, 0, .025); weapon.add(magazine);
      const stock = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.055, .055, .015)), this.material(0x343a34));
      stock.name = 'sten-stock'; stock.position.z = weaponLength / 2; weapon.add(stock);
    }
    if (unit.tankCrew) {
      weapon.userData.weaponId = 'crew_pistol';
      const cap = new THREE.Mesh(this.modelGeometry(new THREE.CylinderGeometry(.105, .115, .045, 7)), this.material(0x242c29));
      cap.name = 'tank-crew-cap'; cap.position.set(0, prone ? .22 : .72 * crouch, prone ? -.22 : 0); root.add(cap);
    }
    if (bazooka) {
      weapon.userData.weaponId = 'at';
      for (const end of [-1, 1]) {
        const rim = new THREE.Mesh(this.modelGeometry(new THREE.TorusGeometry(.044, .009, 4, 10)), this.material(0x454c38));
        rim.name = end < 0 ? 'bazooka-muzzle' : 'bazooka-breech'; rim.position.z = end * weaponLength / 2; weapon.add(rim);
        const opening = new THREE.Mesh(this.modelGeometry(new THREE.CircleGeometry(.036, 10)), this.material(0x191e17));
        opening.position.z = end * (weaponLength / 2 - .02); if (end < 0) opening.rotation.y = Math.PI; weapon.add(opening);
      }
      const grip = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.04, .12, .055)), this.material(0x493e2d));
      grip.name = 'bazooka-grip'; grip.position.set(0, -.09, .07); weapon.add(grip);
      const sight = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.018, .07, .04)), this.material(0x454c38));
      sight.position.set(-.05, .06, -.17); weapon.add(sight);
    }
    if (unit.role === 'medic' || unit.role === 'engineer' || unit.role === 'radio_engineer' || unit.role === 'observer' || unit.role === 'sapper' || unit.role === 'sniper') { const pack = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.15, .18, .1)), this.material(unit.role === 'medic' ? 0xa5a493 : 0x4f503e)); pack.position.set(0, .37, .13); root.add(pack); }
    if (unit.role === 'sapper') {
      const chargePack = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.23, .22, .14)), this.material(0x9b7750));
      chargePack.name = 'sapper-demolition-pack'; chargePack.position.set(0, .37, .19); root.add(chargePack);
      for (const side of [-1, 1]) {
        const tool = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.035, .29, .035)), this.material(0xb5af91));
        tool.name = 'wire-cutters'; tool.position.set(.13, .37, .17); tool.rotation.z = side * .32; root.add(tool);
      }
    }
    if (unit.role === 'officer' || unit.role === 'supply_officer') { const cap = new THREE.Mesh(this.modelGeometry(new THREE.CylinderGeometry(.11, .12, .045, 7)), this.material(0x514a37)); cap.position.y = .72 * crouch; root.add(cap); }
    if (unit.role === 'supply_officer') {
      const crate = new THREE.Mesh(this.modelGeometry(new THREE.BoxGeometry(.2, .24, .14)), this.material(0x8a794d));
      crate.name = 'grenade-supply-pack'; crate.position.set(0, prone ? .18 : .4 * crouch, prone ? .08 : .15); root.add(crate);
    }
    if (unit.role === 'sniper') { const optic = new THREE.Mesh(this.modelGeometry(new THREE.CylinderGeometry(.018, .018, .18, 6)), this.material(0x252823)); optic.rotation.x = Math.PI / 2; optic.position.set(0, .04, -weaponLength / 2 + .01); weaponPivot.add(optic); }
    if (unit.role === 'radio_engineer' || unit.role === 'observer') { const aerial = new THREE.Mesh(this.modelGeometry(new THREE.CylinderGeometry(.012, .012, .42, 4)), this.material(0x8d8a72)); aerial.position.set(.08, .69, .12); root.add(aerial); }
    if (unit.pinned) { const marker = new THREE.Mesh(this.modelGeometry(new THREE.ConeGeometry(.08, .13, 4)), this.material(0xe5c852)); marker.position.set(0, .88 * crouch, 0); root.add(marker); }
    const proxy = new THREE.Mesh(this.modelGeometry(new THREE.SphereGeometry(.33, 6, 5)), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
    proxy.visible = false; // Raycaster still intersects hidden input proxies.
    proxy.position.y = isVehicle ? .26 : .38; proxy.userData.unitId = unit.id; proxy.userData.team = unit.team; root.add(proxy);
    return root;
  }

  private unitMarker(unit: Unit, root: THREE.Group): void {
    // A quiet ground crescent marks wounds without hovering over the soldier.
    // Its size stays fixed; healthy units have no health marker at all.
    const radius = unit.role === 'troop_transport' ? .7 : unit.role === 'vehicle' || unit.role === 'gun_truck' ? .6 : .26;
    const health = new THREE.Mesh(this.modelGeometry(new THREE.RingGeometry(radius, radius + .035, 20, 1, Math.PI, Math.PI * .8)), this.basicMaterial(0xb99864, .5));
    health.rotation.x = -Math.PI / 2;
    health.position.y = .035;
    health.visible = false;
    health.userData.healthIndicator = true;
    root.add(health);
    if (unit.suppression > 20 || unit.morale < 40) {
      const warn = new THREE.Mesh(this.modelGeometry(new THREE.SphereGeometry(.055, 6, 4)), this.material(unit.pinned ? 0xe4c343 : 0xd58e45)); warn.position.set(.18, .99, 0); root.add(warn);
    }
  }

  private updateUnits(state: SimState, alpha: number, selection: readonly number[], _dt: number): void {
    const unitsById = new Map(state.units.map((unit) => [unit.id, unit]));
    const night = dayNightAtTick(state.ticks, state.dayNightStartTick).night;
    const infantry = state.bunkers.length > 0 || state.mortarPits.length > 0
      ? state.units.filter((unit) => unit.team === 'friendly' && unit.health > 0 && unit.role !== 'vehicle' && unit.role !== 'gun_truck').sort((a, b) => a.id - b.id)
      : [];
    const below = new Set(state.units.filter((unit) => unit.health > 0 && !unit.dead && unit.bridgePosition?.level === 'under').map((unit) => unit.bridgePosition!.key));
    for (const group of this.structureGroup.children) if (group.userData.bridgeKey) {
      const deck = group.children.find((child) => child.userData.bridgeDeck) as THREE.Mesh | undefined;
      if (deck) {
        const material = deck.material as THREE.MeshStandardMaterial;
        material.opacity = below.has(group.userData.bridgeKey) ? .3 : 1;
        material.depthWrite = material.opacity === 1;
      }
    }
    const live = new Set<number>();
    const selected = new Set(selection);
    for (const [id, aim] of this.firingAims) if (aim.expiresAt <= this.effectTime) this.firingAims.delete(id);
    const latestShots = new Map(this.pendingTracers.map((event) => [event.shooterId, event]));
    this.unitHitTargets.length = 0;
    for (const unit of state.units) {
      if (unit.dead || unit.health <= 0 || unit.crossed) continue;
      live.add(unit.id);
      let root = this.unitViews.get(unit.id);
      if (!root) { root = this.makeUnit(unit); this.unitViews.set(unit.id, root); this.unitMarker(unit, root); this.unitGroup.add(root); }
      if (root.userData.stance !== (unit.terrainCrawling ? 'prone' : unit.stance ?? 'standing') || root.userData.pinned !== unit.pinned || root.userData.headlightsOn !== (unit.headlightsOn !== false) || root.userData.backupRifle !== usesBackupRifle(unit, getContent())) {
        const facing = root.userData.facing;
        this.unitGroup.remove(root); this.clearGroup(root, true, false);
        root = this.makeUnit(unit); this.unitViews.set(unit.id, root); this.unitMarker(unit, root); this.unitGroup.add(root);
        root.userData.facing = facing;
      }
      const visual = this.visualPosition(unit, state, alpha, infantry);
      const interpX = unit.prevPos.x + (unit.pos.x - unit.prevPos.x) * alpha;
      const interpY = unit.prevPos.y + (unit.pos.y - unit.prevPos.y) * alpha;
      const [x, , z] = this.groundWorld(visual.x, visual.y);
      this.placeOnGround(root, x, unitBuildingHeight(state.terrain, { ...unit, pos: visual }) * WORLD_UNITS_PER_PIXEL, z);
      let facing: number = root.userData.facing ?? (unit.team === 'friendly' ? -Math.PI / 2 : Math.PI / 2);
      if (unit.buildingPosition) facing = { north: -Math.PI / 2, east: 0, south: Math.PI / 2, west: Math.PI }[positionFacing(unit.buildingPosition)];
      const target = unit.targetId !== null ? unitsById.get(unit.targetId) : undefined;
      const contact = night && unit.path.length === 0 ? latestNightContact(unit, state.ticks) : undefined;
      const vehicle = unit.role === 'vehicle' || unit.role === 'gun_truck' || unit.role === 'troop_transport';
      const passengers = root.getObjectByName('transport-passengers');
      if (passengers) passengers.visible = (unit.transport?.passengers ?? 0) > 0;
      if (unit.role === 'vehicle') this.updateTankDamage(root, unit);
      const shot = latestShots.get(unit.id), firingAim = this.firingAims.get(unit.id);
      const movedX = unit.pos.x - unit.prevPos.x, movedY = unit.pos.y - unit.prevPos.y;
      if (unit.tankDamage?.tracks) { /* Immobilized hulls retain their heading while working weapons aim. */ }
      else if (vehicle && Math.hypot(movedX, movedY) > .001) facing = Math.atan2(movedY, movedX);
      else if (vehicle && unit.path.length > 0) facing = Math.atan2(unit.path[0]!.y - unit.pos.y, unit.path[0]!.x - unit.pos.x);
      else if (shot) facing = Math.atan2(shot.to.y - unit.pos.y, shot.to.x - unit.pos.x);
      else if (firingAim) facing = firingAim.bodyFacing;
      else if (target) facing = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
      else if (contact) facing = Math.atan2(contact.pos.y - unit.pos.y, contact.pos.x - unit.pos.x);
      else if (unit.path.length > 0) facing = Math.atan2(unit.path[0]!.y - interpY, unit.path[0]!.x - interpX);
      // Resting soldiers retain their facing. A separation nudge around the old
      // destination must not spin them toward that point every other tick.
      root.userData.facing = facing;
      root.rotation.y = -facing - Math.PI / 2;
      const aheadX = visual.x + Math.cos(facing) * 4, aheadY = visual.y + Math.sin(facing) * 4;
      const bridge = unit.bridgePosition?.level === 'deck' ? state.terrain.bridges?.find((candidate) => bridgeKey(candidate) === unit.bridgePosition!.key) : undefined;
      const surfaceHeight = (sx: number, sy: number) => bridge
        ? (elevationAt(state.terrain, bridge.x, bridge.y) + bridgeDeckHeight(bridge, { x: sx, y: sy })) * WORLD_UNITS_PER_PIXEL : this.groundHeight(sx, sy);
      const pitch = Math.atan2(surfaceHeight(aheadX, aheadY) - surfaceHeight(visual.x, visual.y), 4 * WORLD_UNITS_PER_PIXEL);
      const rightX = visual.x - Math.sin(facing) * 4, rightY = visual.y + Math.cos(facing) * 4;
      const roll = Math.atan2(surfaceHeight(rightX, rightY) - surfaceHeight(visual.x, visual.y), 4 * WORLD_UNITS_PER_PIXEL);
      root.rotation.set(THREE.MathUtils.clamp(pitch, -.7, .7), root.rotation.y, THREE.MathUtils.clamp(roll, -.7, .7), 'YXZ');
      if (unit.buildingPosition) root.rotation.set(0, root.rotation.y, 0);
      // Keep garrisons locatable when a roof hides the far-side window.
      let garrisonMarker = root.children.find((child) => child.userData.garrisonMarker);
      if (!garrisonMarker && unit.buildingPosition) {
        const marker = new THREE.Mesh(this.modelGeometry(new THREE.RingGeometry(.12, .18, 4)), new THREE.MeshBasicMaterial({ color: unit.team === 'friendly' ? COLORS.friendly : COLORS.enemy, depthTest: false, depthWrite: false, transparent: true, opacity: .85 }));
        marker.rotation.x = -Math.PI / 2; marker.position.y = .85; marker.renderOrder = 8; marker.userData.garrisonMarker = true; root.add(marker); garrisonMarker = marker;
      }
      if (garrisonMarker) garrisonMarker.visible = unit.buildingPosition !== undefined;
      root.userData.team = unit.team;
      // Ground proxy uses the stable root anchor; selection fallback remains simulation-side.
      const proxy = root.children.find((child) => child.userData.unitId === unit.id);
      if (proxy) this.unitHitTargets.push(proxy);
      const striding = !vehicle && !unit.pinned && unit.path.length > 0 && Math.hypot(movedX, movedY) > .001 && unit.stance !== 'prone' && !unit.terrainCrawling;
      const stridePhase = this.effectTime * (unit.running ? 14 : 8) + unit.id;
      if (striding) root.position.y += Math.sin(stridePhase * 2) * (unit.running ? .03 : .012);
      if (unit.stance !== 'prone' && !unit.terrainCrawling) for (const child of root.children) {
        if (child.userData.strideSide !== undefined) child.rotation.x = striding ? Math.sin(stridePhase) * child.userData.strideSide * (unit.running ? .85 : .35) : 0;
      }
      const weapon = root.getObjectByName('vehicle-weapon') ?? root.getObjectByName('infantry-weapon');
      // Slide recoil along the barrel so it never replaces the aiming pitch.
      if (weapon) weapon.position.z = -(weapon.userData.weaponLength as number) / 2 + (unit.burstRemaining > 0 ? (1 + Math.sin(this.effectTime * 60)) * .008 : 0);
      const beam = root.children.find((child) => child.userData.headlightBeam);
      if (beam) beam.visible = this.isNight && unit.headlightsOn !== false;
      const health = root.children.find((child) => child.userData.healthIndicator) as THREE.Mesh | undefined;
      const maxHealth = unit.tankCrew ? CONFIG.armoredVehicle.crew.health : unitDef(getContent(), unit.role, unit.team).health;
      if (health) {
        const critical = unit.health / maxHealth < .3;
        health.visible = unit.health < maxHealth;
        health.material = this.basicMaterial(critical ? 0xb86a52 : 0xb99864, critical ? .7 : .5);
      }
    }
    for (const [id, root] of this.unitViews) if (!live.has(id)) { this.unitGroup.remove(root); this.clearGroup(root, true, false); this.unitViews.delete(id); }
    for (const id of this.firingAims.keys()) if (!live.has(id)) this.firingAims.delete(id);
    // Pose every unit first; aim at this frame's interpolated body positions.
    for (const unit of state.units) {
      const root = this.unitViews.get(unit.id);
      if (!root) continue;
      const shot = latestShots.get(unit.id), firingAim = this.firingAims.get(unit.id);
      if (shot) { this.aimWeaponAt(root, this.shotTargetWorld(shot), this.isTankMachineGunShot(root, shot)); continue; }
      if (firingAim) { this.aimWeaponAlong(root, firingAim.direction, firingAim.secondary); continue; }
      const turret = root.getObjectByName('vehicle-turret');
      const weaponPivot = root.getObjectByName('weapon-aim');
      const targetRoot = unit.targetId === null ? undefined : this.unitViews.get(unit.targetId);
      const targetBody = targetRoot?.children.find((child) => child.userData.aimTarget);
      if (targetBody) {
        const targetPoint = targetBody.getWorldPosition(new THREE.Vector3());
        this.aimWeaponAt(root, targetPoint);
        this.aimWeaponAt(root, targetPoint, true);
      } else {
        const contact = night && unit.path.length === 0 ? latestNightContact(unit, state.ticks) : undefined;
        if (contact) this.aimWeaponAt(root, new THREE.Vector3(...simulationToWorld(contact.pos.x, contact.pos.y, contact.height * WORLD_UNITS_PER_PIXEL)));
        else {
          if (!root.userData.turretDisabled) { turret?.rotation.set(0, 0, 0); weaponPivot?.rotation.set(0, 0, 0); }
          if (!root.userData.machineGunDisabled) root.getObjectByName('machine-gun-aim')?.rotation.set(0, 0, 0);
        }
      }
    }
    // Selection rings are rebuilt only when selection changes.
    for (const [id, root] of this.unitViews) {
      if (root.userData.selected === selected.has(id)) continue;
      root.userData.selected = selected.has(id);
      const old = root.children.find((o) => o.userData.selectionRing === true);
      if (old) { root.remove(old); const mesh = old as THREE.Mesh; mesh.geometry.dispose(); }
      if (selected.has(id)) { const ring = new THREE.Mesh(new THREE.RingGeometry(.4, .445, 24), this.material(0xffe29a, .8, true)); ring.rotation.x = -Math.PI / 2; ring.position.y = .03; ring.userData.selectionRing = true; root.add(ring); }
    }
  }

  private isNight = false;

  private updateTankDamage(root: THREE.Group, unit: Unit): void {
    root.userData.turretDisabled = unit.tankDamage?.turret === true;
    root.userData.machineGunDisabled = unit.tankDamage?.machineGun === true;
    for (const component of TANK_COMPONENTS) {
      const marker = root.getObjectByName(`tank-damage-${component}`);
      if (marker) marker.visible = unit.tankDamage?.[component] === true;
    }
    for (const track of root.children.filter((child) => child.userData.vehicleTrack)) {
      (track as THREE.Mesh).material = this.material(unit.tankDamage?.tracks ? 0x302a24 : 0x30352f);
    }
    const turret = root.getObjectByName('tank-turret') as THREE.Mesh | undefined;
    if (turret) turret.material = this.material(unit.tankDamage?.turret ? 0x302a24 : 0x4b5144);
    if (unit.tankDamage?.turret) {
      root.getObjectByName('vehicle-turret')?.rotation.set(0, 0, 0);
      root.getObjectByName('weapon-aim')?.rotation.set(-.22, 0, 0);
    }
    const machineGun = root.getObjectByName('tank-machine-gun') as THREE.Mesh | undefined;
    if (machineGun) machineGun.material = this.material(unit.tankDamage?.machineGun ? 0x302a24 : 0x292c28);
    if (unit.tankDamage?.machineGun) root.getObjectByName('machine-gun-aim')?.rotation.set(-.35, 0, 0);
  }

  private isTankMachineGunShot(root: THREE.Group, shot: RenderShot): boolean {
    return root.getObjectByName('tank-machine-gun') !== undefined && shot.weapon === getContent().weapons.tank_mg?.name;
  }

  private aimWeaponAt(root: THREE.Group, target: THREE.Vector3, secondary = false): void {
    if (secondary ? root.userData.machineGunDisabled : root.userData.turretDisabled) return;
    const turret = secondary ? undefined : root.getObjectByName('vehicle-turret');
    const pivot = root.getObjectByName(secondary ? 'machine-gun-aim' : 'weapon-aim');
    if (turret) aimGunAtWorld(turret, target, true);
    if (pivot) aimGunAtWorld(pivot, target);
  }

  private aimWeaponAlong(root: THREE.Group, direction: THREE.Vector3, secondary = false): void {
    if (secondary ? root.userData.machineGunDisabled : root.userData.turretDisabled) return;
    const turret = secondary ? undefined : root.getObjectByName('vehicle-turret');
    const pivot = root.getObjectByName(secondary ? 'machine-gun-aim' : 'weapon-aim');
    if (turret) aimGunAtWorld(turret, turret.getWorldPosition(new THREE.Vector3()).add(direction), true);
    if (pivot) aimGunAtWorld(pivot, pivot.getWorldPosition(new THREE.Vector3()).add(direction));
  }

  private shotTargetWorld(event: RenderShot): THREE.Vector3 {
    const targetRoot = event.targetId === null ? undefined : this.unitViews.get(event.targetId);
    const body = targetRoot?.children.find((child) => child.userData.aimTarget);
    if (body) return body.getWorldPosition(new THREE.Vector3());
    const point = new THREE.Vector3(...this.groundWorld(event.to.x, event.to.y, .26));
    if (event.lastTargetHeight !== undefined) point.y = event.lastTargetHeight;
    return point;
  }

  private visualPosition(unit: Unit, state: SimState, alpha: number, infantry: readonly Unit[]): Vec2 {
    const pos = { x: unit.prevPos.x + (unit.pos.x - unit.prevPos.x) * alpha, y: unit.prevPos.y + (unit.pos.y - unit.prevPos.y) * alpha };
    if (unit.buildingPosition) return pos;
    if (unit.team !== 'friendly' || unit.role === 'vehicle' || unit.role === 'gun_truck' || unit.role === 'troop_transport') return pos;
    const bunkerSlots: readonly Vec2[] = [{ x: 0, y: 0 }, { x: -5, y: -3 }, { x: 5, y: -3 }, { x: -5, y: 4 }, { x: 5, y: 4 }, { x: 0, y: 7 }];
    for (const bunker of state.bunkers) {
      const occupants = infantry.filter((candidate) => Math.hypot(candidate.pos.x - bunker.pos.x, candidate.pos.y - bunker.pos.y) <= CONFIG.bunker.occupyRadius);
      const index = occupants.findIndex((candidate) => candidate.id === unit.id);
      if (index >= 0) { const slot = bunkerSlots[index % bunkerSlots.length]!; return { x: bunker.pos.x + slot.x, y: bunker.pos.y + slot.y }; }
    }
    const mortarSlots: readonly Vec2[] = [{ x: 0, y: 0 }, { x: -5, y: 0 }, { x: 5, y: 0 }, { x: 0, y: -5 }];
    if (unit.role === 'mortarman') for (const pit of state.mortarPits) {
      const occupants = infantry.filter((candidate) => candidate.role === 'mortarman' && Math.hypot(candidate.pos.x - pit.pos.x, candidate.pos.y - pit.pos.y) <= CONFIG.mortarPit.occupyRadius);
      const index = occupants.findIndex((candidate) => candidate.id === unit.id);
      if (index >= 0) { const slot = mortarSlots[index % mortarSlots.length]!; return { x: pit.pos.x + slot.x, y: pit.pos.y + slot.y }; }
    }
    return pos;
  }

  private drawZones(state: SimState): void {
    const zones: Array<{ x: number; y: number; w: number; h: number; c: number }> = [
      { x: CONFIG.field.width / 2, y: CONFIG.deploymentZone.yMax, w: CONFIG.field.width, h: CONFIG.deploymentZone.yMax - CONFIG.deploymentZone.yMin, c: 0x566948 },
    ];
    for (const zone of zones) {
      const [x, , z] = this.groundWorld(zone.x, zone.y);
      const geom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(zone.w * WORLD_UNITS_PER_PIXEL, zone.h * WORLD_UNITS_PER_PIXEL));
      const line = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: zone.c, transparent: true, opacity: .65 }));
      line.position.y = .024;
      line.rotation.x = -Math.PI / 2;
      line.position.x += x; line.position.z += z;
      this.zoneGroup.add(line);
    }
    const lineY = this.groundWorld(CONFIG.lineY, 0, .022);
    const band = new THREE.Mesh(new THREE.PlaneGeometry(CONFIG.field.width * WORLD_UNITS_PER_PIXEL, .03), this.material(0xd0a75b, .8, true)); band.rotation.x = -Math.PI / 2; band.position.set(0, .022, lineY[2]); this.zoneGroup.add(band);
    if (state.scheduler.phase === 'crossing' || state.scheduler.phase === 'advance') {
      const north = new THREE.Mesh(new THREE.PlaneGeometry(40, .08), this.material(0xd9d4ab, .7, true)); north.rotation.x = -Math.PI / 2; north.position.set(0, .024, -14.1); this.zoneGroup.add(north);
    }
    this.zoneKey = `${state.scheduler.phase}:${state.sectorCaptured}`;
  }

  private buildWeather(weather: WeatherKind, seed: number): void {
    const def = CONFIG.weather[weather];
    const rng = deriveRng(seed, 0x54485244);
    this.rainBase = new Float32Array(160 * 6);
    const rainPositions = new Float32Array(160 * 6);
    for (let i = 0; i < 160; i++) {
      this.rainBase.set([rngRange(rng, -20, 20), rngRange(rng, .1, 6.8), rngRange(rng, -16, 16), rngRange(rng, 1, 3), rngRange(rng, .12, .35), rngRange(rng, .2, 1)], i * 6);
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xb6cbd1, transparent: true, opacity: .3 }));
    this.rainLines.visible = def.rainIntensity > 0;
    rainGeo.setDrawRange(0, Math.ceil(160 * def.rainIntensity) * 2);
    this.weatherGroup.add(this.rainLines);

    this.snowBase = new Float32Array(240 * 4);
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(240 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    for (let i = 0; i < 240; i++) this.snowBase.set([rngRange(rng, -20, 20), rngRange(rng, -15, 15), rngRange(rng, 0, 1), rngRange(rng, 0, Math.PI * 2)], i * 4);
    this.snowPoints = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xe5e9e7, size: .07, transparent: true, opacity: .68, depthWrite: false }));
    this.snowPoints.visible = (def.snowIntensity ?? 0) > 0;
    snowGeo.setDrawRange(0, Math.ceil(240 * (def.snowIntensity ?? 0) * 2));
    this.weatherGroup.add(this.snowPoints);
  }

  private updateWeather(weather: WeatherKind, time: CelestialState, dt: number): void {
    const { darkness, night } = time;
    this.isNight = night;
    this.lighting.update(time, weather);
    const palette = seasonPalette(this.season);
    (this.scene.background as THREE.Color).set(0x151b24).lerp(this.weatherColor.set(palette.sky), time.daylight);
    // Continuous tint avoids a visible color jump as either body crosses the horizon.
    this.fieldMaterial.color.set(this.fieldMaterial.map ? 0xffffff : seasonGroundColor(this.season));
    this.fieldMaterial.color.lerp(this.weatherColor.set(this.fieldMaterial.map ? 0xd2ddeb : 0x404b47), darkness);
    const weatherDef = CONFIG.weather[weather];
    this.weatherFog.color.set(0x242932).lerp(this.weatherColor.set(0x899086), time.daylight);
    this.weatherFog.density = weatherDef.fogIntensity * .024;
    this.scene.fog = weatherDef.fogIntensity > 0 ? this.weatherFog : null;
    if (this.rainLines) {
      const attribute = this.rainLines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const positions = attribute.array as Float32Array;
      const visible = Math.ceil(160 * weatherDef.rainIntensity);
      this.rainLines.visible = visible > 0;
      this.rainLines.geometry.setDrawRange(0, visible * 2);
      for (let i = 0; i < visible; i++) {
        const j = i * 6;
        const x = this.rainBase[j]! - this.effectTime * .14 * (0.8 + weatherDef.rainIntensity);
        const y = ((this.rainBase[j + 1]! - this.effectTime * this.rainBase[j + 3]!) % 8 + 8) % 8;
        const z = this.rainBase[j + 2]!;
        positions.set([x, y, z, x - this.rainBase[j + 4]!, Math.max(.02, y - this.rainBase[j + 5]!), z], j);
      }
      attribute.needsUpdate = true;
    }
    if (this.snowPoints) {
      const intensity = weatherDef.snowIntensity ?? 0;
      const attribute = this.snowPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      const positions = attribute.array as Float32Array;
      const visible = Math.ceil(240 * intensity * 2);
      this.snowPoints.visible = visible > 0;
      this.snowPoints.geometry.setDrawRange(0, visible);
      for (let i = 0; i < visible; i++) {
        const j = (i % 240) * 4;
        positions[i * 3] = this.snowBase[j]! + Math.sin(this.effectTime + this.snowBase[j + 3]!) * .34 - this.effectTime * (.16 + intensity * .28);
        positions[i * 3 + 1] = ((this.snowBase[j + 2]! * 8 - this.effectTime * (.14 + intensity * .1)) % 8 + 8) % 8;
        positions[i * 3 + 2] = this.snowBase[j + 1]!;
      }
      attribute.needsUpdate = true;
    }
    if (this.riverFlowLines) {
      const attribute = this.riverFlowLines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const positions = attribute.array as Float32Array;
      const count = this.riverFlowBase.length / 5;
      for (let i = 0; i < count; i++) {
        const j = i * 5;
        const distance = ((this.effectTime * weatherDef.riverFlowMult * .18 + this.riverFlowBase[j + 4]!) % .9) - .45;
        const x = this.riverFlowBase[j]! + this.riverFlowBase[j + 2]! * distance;
        const z = this.riverFlowBase[j + 1]! + this.riverFlowBase[j + 3]! * distance;
        positions.set([x, .044, z, x + this.riverFlowBase[j + 2]! * .15, .044, z + this.riverFlowBase[j + 3]! * .15], i * 6);
      }
      attribute.needsUpdate = true;
    }
    this.effectTime += dt;
  }

  handleEvents(state: SimState, events: readonly SimEvent[]): void {
    this.terrain = state.terrain;
    let structuresChanged = false;
    const buildingsChanged = new Set<number>();
    const earthBlasts = new Set(events.filter((event) => event.type === 'groundImpact').map((event) => `${Math.round(event.impact.pos.x)}:${Math.round(event.impact.pos.y)}`));
    const durableBlasts = new Set([...earthBlasts, ...events.filter((event) => event.type === 'artilleryImpact' || event.type === 'mineTriggered' || event.type === 'buildingDestroyed').map((event) => `${Math.round(event.pos.x)}:${Math.round(event.pos.y)}`)]);
    for (const event of events) {
      if (event.type === 'treeHit') {
        this.treeSplinters(event, state.seed);
      } else if (event.type === 'groundImpact') {
        this.blast(event.impact.pos, event.blastRadius, event.impact.kind === 'mortar' ? 0xc1a06a : 0xe2a04c);
        this.earthDust(event.impact, state.seed);
      } else if (event.type === 'shot') {
        const targetRoot = event.targetId === null ? undefined : this.unitViews.get(event.targetId);
        const body = targetRoot?.children.find((child) => child.userData.aimTarget);
        this.pendingTracers.push({ ...event, lastTargetHeight: body?.getWorldPosition(new THREE.Vector3()).y });
      } else if (event.type === 'grenadeThrown') {
        this.grenadeArc(event.from, event.to);
      } else if (event.type === 'enemySmokeAssaultDeployed') {
        const thrower = state.units.find((unit) => unit.id === event.unitId);
        if (thrower) this.grenadeArc(thrower.pos, event.pos);
      } else if (event.type === 'tankCrewBailedOut') {
        this.pulse(event.pos, 0xd9aa62, .6);
      } else if (event.type === 'artilleryOrdered' || event.type === 'airSupportOrdered' || event.type === 'mortarFired' || event.type === 'flareOrdered') {
        this.pulse(event.pos, 0xc68a49, .32);
      } else if (event.type === 'explosion') {
        const key = `${Math.round(event.pos.x)}:${Math.round(event.pos.y)}`;
        if (!durableBlasts.has(key)) this.blast(event.pos, event.radius, 0xd98242);
      } else if (event.type === 'artilleryImpact' || event.type === 'mineTriggered' || event.type === 'satchelDetonated' || event.type === 'enemyChargeDetonated' || event.type === 'buildingDestroyed') {
        const radius = 'radius' in event ? event.radius : 44;
        if (!earthBlasts.has(`${Math.round(event.pos.x)}:${Math.round(event.pos.y)}`)) this.blast(event.pos, radius, 0xe2a04c);
      } else if (event.type === 'healed') this.pulse(event.pos, 0x8fc57b, .7);
      else if (event.type === 'moveOrdered') this.pulse(event.pos, COLORS.marker, .48);
      else if (event.type === 'breakthrough') this.pulse(event.pos, COLORS.danger, .85);
      else if (event.type === 'unitDied') this.pulse(event.pos, event.team === 'friendly' ? 0x7292a9 : 0xa75a45, .8);
      if (event.type === 'structureDemolished' || event.type === 'wireConstructionStarted' || event.type === 'wireBreached' || event.type === 'sandbagPlaced' || event.type === 'trenchBuilt' || event.type === 'mineLaid' || event.type === 'constructionCompleted' || event.type === 'constructionAbandoned' || event.type === 'mineTriggered') structuresChanged = true;
      if (event.type === 'buildingHit' || event.type === 'buildingDestroyed') buildingsChanged.add(event.buildingId);
    }
    if (structuresChanged) { this.clearGroup(this.structureGroup, true); this.structures(state); }
    for (const id of buildingsChanged) {
      const building = state.buildings.find((candidate) => candidate.id === id);
      if (!building) continue;
      const previous = this.buildingViews.get(id);
      if (previous?.userData.damageStage === buildingDamageStage(building)) continue;
      if (previous) { this.buildingsGroup.remove(previous); this.clearGroup(previous, true); }
      this.building(building, state.seed);
    }
  }

  private pulse(pos: Vec2, color: number, lifetime: number): void {
    const [x, , z] = this.groundWorld(pos.x, pos.y);
    const ring = new THREE.Mesh(new THREE.RingGeometry(.08, .13, 18), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; this.placeOnGround(ring, x, .055, z); ring.userData.ttl = lifetime; ring.userData.max = lifetime; this.effectGroup.add(ring);
  }

  private tracer(muzzle: THREE.Vector3, target: THREE.Vector3, team: 'friendly' | 'enemy', shooterId: number): void {
    // A newly aimed shot replaces this gun's previous trail, so two different
    // firing directions cannot linger beside a single visible barrel.
    for (const previous of [...this.effectGroup.children]) {
      if (previous.userData.tracerShooterId !== shooterId) continue;
      this.effectGroup.remove(previous);
      const line = previous as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
      line.geometry.dispose(); line.material.dispose();
    }
    const [a, b] = tracerWorldEndpoints(muzzle, target);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: team === 'friendly' ? 0xffdf8e : 0xff8557, transparent: true, opacity: .86 }));
    line.userData.ttl = TRACER_LIFETIME; line.userData.max = TRACER_LIFETIME; this.effectGroup.add(line);
    line.userData.tracerShooterId = shooterId;
  }

  private flushTracers(): void {
    if (this.pendingTracers.length === 0) return;
    const pending = this.pendingTracers.splice(0);
    for (const event of pending) {
      const shooterRoot = this.unitViews.get(event.shooterId);
      const target = this.shotTargetWorld(event);
      const secondary = shooterRoot !== undefined && this.isTankMachineGunShot(shooterRoot, event);
      // The event's shot, rather than a newly acquired target, owns this muzzle.
      if (shooterRoot) this.aimWeaponAt(shooterRoot, target, secondary);
      const weapon = (secondary ? shooterRoot?.getObjectByName('tank-machine-gun') : shooterRoot?.getObjectByName('vehicle-weapon') ?? shooterRoot?.getObjectByName('infantry-weapon')) as THREE.Mesh | undefined;
      let muzzle: THREE.Vector3;
      if (weapon !== undefined) {
        muzzle = weaponMuzzleWorldPosition(weapon, weapon.userData.weaponLength as number);
      } else {
        const [x, y, z] = this.groundWorld(event.from.x, event.from.y, .4);
        muzzle = new THREE.Vector3(x, y, z);
      }

      if (weapon && shooterRoot) {
        this.firingAims.set(event.shooterId, {
          direction: target.clone().sub(muzzle).normalize(),
          bodyFacing: -shooterRoot.rotation.y - Math.PI / 2,
          expiresAt: this.effectTime + TRACER_LIFETIME,
          secondary,
        });
      }
      this.tracer(muzzle, target, event.shooterTeam, event.shooterId);
      const flash = new THREE.Mesh(this.cachedGeometry('muzzle-flash', () => new THREE.OctahedronGeometry(.085)), new THREE.MeshBasicMaterial({ color: 0xffecad, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      flash.position.copy(muzzle); flash.userData.muzzleFlash = true; flash.userData.shooterId = event.shooterId; flash.userData.ttl = .07; flash.userData.max = .07;
      this.effectGroup.add(flash);
    }
  }

  private grenadeArc(from: Vec2, to: Vec2): void {
    const points: THREE.Vector3[] = [];
    const [ax, ay, az] = this.groundWorld(from.x, from.y);
    const [bx, by, bz] = this.groundWorld(to.x, to.y);
    for (let i = 0; i <= 12; i++) { const t = i / 12; points.push(new THREE.Vector3(THREE.MathUtils.lerp(ax, bx, t), Math.max(THREE.MathUtils.lerp(ay, by, t), this.groundHeight(THREE.MathUtils.lerp(from.x, to.x, t), THREE.MathUtils.lerp(from.y, to.y, t))) + .12 + Math.sin(t * Math.PI) * .7, THREE.MathUtils.lerp(az, bz, t))); }
    const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xe2c27e, transparent: true, opacity: .72 }));
    arc.userData.ttl = .65; arc.userData.max = .65; this.effectGroup.add(arc);
  }

  private blast(pos: Vec2, radius: number, color: number): void {
    const [x, , z] = this.groundWorld(pos.x, pos.y);
    const ring = new THREE.Mesh(new THREE.RingGeometry(.15, Math.max(.2, radius * WORLD_UNITS_PER_PIXEL), 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .75, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; this.placeOnGround(ring, x, .04, z); ring.userData.ttl = .75; ring.userData.max = .75; this.effectGroup.add(ring);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffc469, transparent: true, opacity: .9, depthWrite: false })); this.placeOnGround(flash, x, .25, z); flash.userData.ttl = .3; flash.userData.max = .3; this.effectGroup.add(flash);
  }

  private updateGroundImpacts(state: SimState): void {
    const marks = state.groundImpacts ?? [], live = new Set(marks.map((mark) => mark.id));
    for (const [id, view] of this.groundImpactViews) if (!live.has(id)) {
      this.groundImpactGroup.remove(view); view.geometry.dispose(); this.groundImpactViews.delete(id);
    }
    for (const mark of marks) {
      if (this.groundImpactViews.has(mark.id)) continue;
      const [x, y, z] = this.groundWorld(mark.pos.x, mark.pos.y);
      const land = (dx: number, dz: number) => {
        const px = mark.pos.x + dx / WORLD_UNITS_PER_PIXEL, py = mark.pos.y + dz / WORLD_UNITS_PER_PIXEL;
        if (!insideField(px, py)) return false;
        const terrain = state.terrain, index = Math.floor(py / terrain.cell) * terrain.cols + Math.floor(px / terrain.cell);
        return terrain.kinds?.[index] !== TERRAIN_KIND.river && !terrain.bridges?.some((bridge) => bridgeContains(bridge, { x: px, y: py }));
      };
      const geometry = groundImpactGeometry(mark.kind, state.seed ^ mark.id,
        (dx, dz) => this.groundHeight(mark.pos.x + dx / WORLD_UNITS_PER_PIXEL, mark.pos.y + dz / WORLD_UNITS_PER_PIXEL) - y, land);
      const mesh = new THREE.Mesh(geometry, this.fortificationMaterial);
      mesh.name = `ground-impact-${mark.kind}`; mesh.userData.impactId = mark.id;
      mesh.position.set(x, y + (mark.id % 1024) * .00001, z); mesh.castShadow = true; mesh.receiveShadow = true;
      this.groundImpactGroup.add(mesh); this.groundImpactViews.set(mark.id, mesh);
    }
  }

  private updateDamagedTrees(state: SimState): void {
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const tree of state.treeDamage ?? []) {
      const stage = treeDamageStage(tree.health), old = this.damagedTreeViews.get(tree.cell);
      if (old?.stage === stage) continue;
      if (old) { this.damagedTreeGroup.remove(old.mesh); old.mesh.geometry.dispose(); }
      for (const { mesh, index } of this.treeInstances.get(tree.cell) ?? []) {
        mesh.setMatrixAt(index, hidden); mesh.instanceMatrix.needsUpdate = true;
      }
      const pos = treeCellPosition(state.terrain, tree.cell), col = tree.cell % state.terrain.cols, row = Math.floor(tree.cell / state.terrain.cols);
      const variation = ((col * 73856093) ^ (row * 19349663) ^ state.seed) >>> 0;
      const mesh = new THREE.Mesh(damagedTreeGeometry(tree, this.season, state.seed), this.fortificationMaterial);
      const [x, , z] = this.groundWorld(pos.x, pos.y); this.placeOnGround(mesh, x, .025, z);
      mesh.rotation.y = (variation % 360) * Math.PI / 180; mesh.scale.setScalar(.86 + (variation % 23) * .01);
      mesh.name = 'damaged-tree'; mesh.userData.treeCell = tree.cell; mesh.userData.damageStage = stage;
      mesh.castShadow = true; mesh.receiveShadow = true; this.damagedTreeGroup.add(mesh); this.damagedTreeViews.set(tree.cell, { stage, mesh });
    }
  }

  private treeSplinters(event: Extract<SimEvent, { type: 'treeHit' }>, seed: number): void {
    const count = event.blast ? 14 : 6, rng = deriveRng(seed ^ event.cell, Math.round(event.health * 100)), lifetime = event.blast ? .95 : .55;
    const chips = new THREE.InstancedMesh(this.cachedGeometry('wood-splinter', () => new THREE.IcosahedronGeometry(1, 0)),
      new THREE.MeshBasicMaterial({ color: 0xc7a374, transparent: true, opacity: 1, depthWrite: false }), count);
    const velocities = new Float32Array(count * 3), sizes = new Float32Array(count), matrix = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const angle = rngRange(rng, 0, Math.PI * 2), speed = rngRange(rng, .4, event.blast ? 2.2 : 1.1);
      velocities.set([Math.cos(angle) * speed, rngRange(rng, .5, 1.8), Math.sin(angle) * speed], i * 3);
      sizes[i] = rngRange(rng, .035, event.blast ? .085 : .055); matrix.scale.set(sizes[i]! * .3, sizes[i]! * 1.6, sizes[i]! * .3); matrix.updateMatrix(); chips.setMatrixAt(i, matrix.matrix);
    }
    chips.name = 'tree-splinters'; chips.userData.woodSplinters = true; chips.userData.velocities = velocities; chips.userData.sizes = sizes;
    chips.userData.ttl = lifetime; chips.userData.max = lifetime;
    const [x, , z] = this.groundWorld(event.pos.x, event.pos.y); this.placeOnGround(chips, x, .4, z); this.effectGroup.add(chips);
  }

  private earthDust(mark: GroundImpact, seed: number): void {
    const look = GROUND_IMPACT_LOOK[mark.kind], rng = deriveRng(seed, mark.id), radius = look.radius * WORLD_UNITS_PER_PIXEL;
    const dust = new THREE.InstancedMesh(this.cachedGeometry('earth-dust-clod', () => new THREE.IcosahedronGeometry(1, 0)),
      new THREE.MeshBasicMaterial({ color: look.color, transparent: true, opacity: .6, depthWrite: false }), look.dust);
    dust.name = `earth-dust-${mark.kind}`;
    const velocities = new Float32Array(look.dust * 3), sizes = new Float32Array(look.dust);
    const matrix = new THREE.Object3D();
    for (let i = 0; i < look.dust; i++) {
      const angle = rngRange(rng, 0, Math.PI * 2), speed = rngRange(rng, .7, 1.6) * radius;
      velocities.set([Math.cos(angle) * speed, rngRange(rng, 1.1, 2) * radius + .3, Math.sin(angle) * speed], i * 3);
      sizes[i] = radius * rngRange(rng, .09, .20); matrix.scale.setScalar(sizes[i]!); matrix.updateMatrix(); dust.setMatrixAt(i, matrix.matrix);
    }
    dust.userData.earthDust = true; dust.userData.velocities = velocities; dust.userData.sizes = sizes;
    dust.userData.ttl = look.seconds; dust.userData.max = look.seconds;
    const [x, , z] = this.groundWorld(mark.pos.x, mark.pos.y); this.placeOnGround(dust, x, .04, z); this.effectGroup.add(dust);
  }

  private retainedFx(key: string, signature: string, create: (group: THREE.Group) => void): THREE.Group {
    this.retainedFxLive.add(key);
    const previous = this.retainedFxViews.get(key);
    if (previous?.signature === signature) return previous.group;
    if (previous) {
      this.retainedFxGroup.remove(previous.group);
      this.clearGroup(previous.group, true, false);
    }
    const group = new THREE.Group();
    create(group);
    this.retainedFxGroup.add(group);
    this.retainedFxViews.set(key, { signature, group });
    return group;
  }

  private updateStateFx(state: SimState): void {
    if (state.ticks === this.stateFxTick) return;
    this.stateFxTick = state.ticks;
    this.retainedFxLive.clear();
    // State markers are rebuilt as simulation time advances. Their shapes are
    // shared and cached below, so keep cached geometry alive between updates.
    this.clearGroup(this.stateFxGroup, true, false);
    for (const charge of [...state.satchelCharges.map((charge) => ({ ...charge, enemy: false })),
      ...state.enemyDemolitionCharges.map((charge) => ({ ...charge, enemy: true }))]) {
      const def = charge.enemy ? CONFIG.enemySappers : CONFIG.satchel;
      const name = charge.enemy ? 'enemy-demolition' : 'satchel';
      const [x, , z] = this.groundWorld(charge.pos.x, charge.pos.y);
      const bag = new THREE.Group(); bag.name = `${name}-charge`; bag.userData.chargeId = charge.id;
      const body = new THREE.Mesh(this.cachedGeometry('satchel-bag', () => new THREE.BoxGeometry(.38, .17, .27)), this.material(charge.enemy ? 0x985849 : 0x777052));
      bag.add(body);
      for (const offset of [-.11, .11]) {
        const strap = new THREE.Mesh(this.cachedGeometry('satchel-strap', () => new THREE.BoxGeometry(.035, .19, .29)), this.material(0x423d31));
        strap.position.x = offset; bag.add(strap);
      }
      const fuse = new THREE.Mesh(this.cachedGeometry('satchel-fuse', () => new THREE.SphereGeometry(.045, 6, 4)), this.basicMaterial(0xff6947));
      fuse.position.y = .14; bag.add(fuse);
      this.placeOnGround(bag, x, .12, z); this.stateFxGroup.add(bag);
      const radius = def.radius * WORLD_UNITS_PER_PIXEL;
      const danger = new THREE.Mesh(drapedRingGeometry(state.terrain, charge.pos, radius - .025, radius), this.material(0xd65c43, .65, true));
      danger.name = `${name}-blast-radius`; danger.userData.chargeId = charge.id; this.stateFxGroup.add(danger);
      const fraction = charge.ticksRemaining / (def.fuseSeconds * CONFIG.tickRate);
      const countdown = new THREE.Mesh(new THREE.RingGeometry(.26, .31, 40, 1, 0, Math.PI * 2 * fraction), this.material(0xffbc65, .95, true));
      countdown.name = `${name}-fuse-countdown`; countdown.userData.ticksRemaining = charge.ticksRemaining;
      countdown.rotation.x = -Math.PI / 2; this.placeOnGround(countdown, x, .04, z); this.stateFxGroup.add(countdown);
    }
    for (const plan of state.enemySmokeAssaults ?? []) if (!plan.deployed) {
      const radius = CONFIG.smoke.radius * WORLD_UNITS_PER_PIXEL;
      const ring = new THREE.Mesh(this.cachedGeometry('enemy-smoke-warning', () => new THREE.RingGeometry(radius - .035, radius, 36)),
        this.material(0xd9b36a, .8, true));
      ring.name = 'enemy-smoke-warning'; ring.userData.assaultId = plan.id;
      ring.rotation.x = -Math.PI / 2;
      const [x, , z] = this.groundWorld(plan.pos.x, plan.pos.y); this.placeOnGround(ring, x, .055, z); this.stateFxGroup.add(ring);
      const thrower = state.units.find((unit) => unit.id === plan.leaderId && !unit.dead && unit.health > 0);
      if (thrower) {
        const marker = new THREE.Mesh(this.cachedGeometry('enemy-smoke-thrower', () => new THREE.ConeGeometry(.09, .18, 4)), this.material(0xe5bf72));
        marker.name = 'enemy-smoke-thrower'; marker.userData.unitId = thrower.id; marker.rotation.z = Math.PI;
        const [tx, , tz] = this.groundWorld(thrower.pos.x, thrower.pos.y); this.placeOnGround(marker, tx, .95, tz); this.stateFxGroup.add(marker);
      }
    }
    for (const cloud of state.smokes) {
      this.retainedFx(`smoke:${cloud.id}`, `${cloud.pos.x}:${cloud.pos.y}:${cloud.radius}`, (container) => {
        const [x, , z] = this.groundWorld(cloud.pos.x, cloud.pos.y);
        const radius = Math.max(.35, cloud.radius * WORLD_UNITS_PER_PIXEL);
        const group = new THREE.Group(); group.name = 'smoke-cloud'; group.userData.smokeId = cloud.id;
        this.placeOnGround(group, x, .25, z);
        for (let i = 0; i < 5; i++) {
          const puffRadius = radius * (i === 0 ? .65 : .55);
          const haze = new THREE.Mesh(this.cachedGeometry(`smoke:${puffRadius}`, () => new THREE.SphereGeometry(puffRadius, 10, 7)), this.material(0x8a8c82, .92, true));
          haze.material.opacity = .32;
          if (i > 0) { const angle = (i - 1) * Math.PI / 2; haze.position.set(Math.cos(angle) * radius * .45, .06 * i, Math.sin(angle) * radius * .45); }
          haze.scale.y = .55; group.add(haze);
        }
        container.add(group);
      });
    }
    for (const fire of state.campfires) {
      const group = this.retainedFx(`fire:${fire.id}`, `${fire.pos.x}:${fire.pos.y}:${fire.radius}`, (group) => {
        const [x, , z] = this.groundWorld(fire.pos.x, fire.pos.y);
        group.userData.campfireId = fire.id;
        this.placeOnGround(group, x, .04, z);
        for (const angle of [-.55, .55]) {
          const log = new THREE.Mesh(this.cachedGeometry('campfire-log', () => new THREE.CylinderGeometry(.045, .055, .55, 6)), this.material(0x483024));
          log.rotation.z = Math.PI / 2; log.rotation.y = angle; log.position.y = .06;
          group.add(log);
        }
        const flame = new THREE.Mesh(this.cachedGeometry('campfire-flame', () => new THREE.ConeGeometry(.19, .55, 7)), this.basicMaterial(0xf87820, .85));
        flame.position.y = .3; group.add(flame);
        const core = new THREE.Mesh(this.cachedGeometry('campfire-core', () => new THREE.ConeGeometry(.1, .34, 6)), this.basicMaterial(0xffdf7b));
        core.position.y = .23; group.add(core);
        const light = new THREE.PointLight(0xffa34b, 4, fire.radius * WORLD_UNITS_PER_PIXEL * 2, 2);
        light.position.y = .55; group.add(light);
      });
      const flicker = .9 + .1 * Math.sin(state.ticks * .8 + fire.id);
      group.children[2]!.scale.y = flicker;
      group.children[3]!.scale.y = flicker;
      (group.children[4] as THREE.PointLight).intensity = 4 * flicker;
    }
    for (const flare of state.flares) {
      const pending = (flare.pendingTicksRemaining ?? 0) > 0;
      this.retainedFx(`flare:${flare.id}`, `${flare.pos.x}:${flare.pos.y}:${flare.radius}:${pending}`, (group) => {
        const [x, , z] = this.groundWorld(flare.pos.x, flare.pos.y);
        const glowRadius = pending ? .11 : .19;
        const glow = new THREE.Mesh(this.cachedGeometry(`flare:${glowRadius}`, () => new THREE.SphereGeometry(glowRadius, 9, 6)), this.material(pending ? 0xd9b77c : 0xffdb83, .4));
        this.placeOnGround(glow, x, pending ? 1.4 : 4.2, z); group.add(glow);
        if (!pending) { const light = new THREE.PointLight(0xffcf79, 9, flare.radius * WORLD_UNITS_PER_PIXEL * 2.5, 2); light.position.copy(glow.position); group.add(light); }
      });
    }
    for (const strike of state.strikes) {
      if (!strikeIsImminent(strike, state.ticks)) continue;
      this.retainedFx(`strike:${strike.id}`, `${strike.pos.x}:${strike.pos.y}:${strike.radius}:${strike.source}`, (group) => {
        const [x, , z] = this.groundWorld(strike.pos.x, strike.pos.y);
        const color = strike.source === 'enemy' ? 0xd1503f : 0xe2bd65;
        const outerRadius = strike.radius * WORLD_UNITS_PER_PIXEL;
        const innerRadius = Math.max(.2, outerRadius - .06);
        const ring = new THREE.Mesh(drapedRingGeometry(this.terrain, strike.pos, innerRadius, outerRadius), this.basicMaterial(color, .62));
        ring.userData.strikeId = strike.id;
        group.add(ring);
        const dot = new THREE.Mesh(this.cachedGeometry('strike-dot', () => new THREE.SphereGeometry(.08, 6, 4)), this.basicMaterial(color)); this.placeOnGround(dot, x, .11, z); group.add(dot);
      });
    }
    for (const projectile of state.projectiles) {
      const [x, , z] = this.groundWorld(projectile.pos.x, projectile.pos.y);
      const group = this.retainedFx(`projectile:${projectile.id}`, `${projectile.arc}:${projectile.team}`, (group) => {
        const radius = projectile.arc ? .09 : .045;
        const shell = new THREE.Mesh(this.cachedGeometry(`projectile:${radius}`, () => new THREE.SphereGeometry(radius, 6, 4)), this.material(projectile.team === 'friendly' ? 0xffdfa0 : 0xe28b5c, .5));
        group.add(shell);
      });
      this.placeOnGround(group, x, projectile.arc ? .75 : .25, z);
    }
    for (const site of state.constructionSites) {
      const marker = this.structureGroup.children.find((child) => child.userData.siteId === site.id);
      if (marker) marker.scale.setScalar(.6 + .4 * Math.max(0, Math.min(1, 1 - site.ticksRemaining / Math.max(1, site.totalTicks))));
    }
    for (const team of state.enemySapperTeams) {
      if (!team.plantPos || team.chargeId !== null) continue;
      const radius = CONFIG.enemySappers.radius * WORLD_UNITS_PER_PIXEL;
      const danger = new THREE.Mesh(drapedRingGeometry(state.terrain, team.plantPos, radius - .025, radius),
        this.basicMaterial(0xe4a052, .75));
      danger.name = 'sapper-target-warning'; danger.userData.teamId = team.id; this.stateFxGroup.add(danger);
      const sapper = state.units.find((unit) => unit.id === team.sapperId && unit.health > 0 && !unit.dead);
      if (!sapper) continue;
      const [x, y, z] = this.groundWorld(sapper.pos.x, sapper.pos.y);
      const marker = new THREE.Mesh(this.cachedGeometry('sapper-warning', () => new THREE.OctahedronGeometry(.10, 0)), this.basicMaterial(0xe4a052));
      marker.name = 'sapper-specialist-marker'; marker.userData.unitId = sapper.id; marker.position.set(x, y + 1, z); this.stateFxGroup.add(marker);
      if (team.plantTicks <= 0) continue;
      const fraction = team.plantTicks / (CONFIG.enemySappers.plantSeconds * CONFIG.tickRate);
      const back = new THREE.Mesh(this.cachedGeometry('sapper-planting-bar', () => new THREE.BoxGeometry(.8, .025, .07)), this.basicMaterial(0x302b25, .9));
      back.position.set(x, y + .85, z); this.stateFxGroup.add(back);
      const fill = new THREE.Mesh(back.geometry, this.basicMaterial(0xe4a052)); fill.name = 'sapper-planting-progress';
      fill.scale.x = fraction; fill.position.set(x - .4 * (1 - fraction), y + .87, z); this.stateFxGroup.add(fill);
    }
    for (const wire of state.barbedWire) {
      if (wire.cutTicks <= 0) continue;
      const fraction = Math.min(1, wire.cutTicks / (CONFIG.barbedWire.cutSeconds * CONFIG.tickRate));
      const width = CONFIG.barbedWire.halfLength * 2 * WORLD_UNITS_PER_PIXEL;
      const [x, y, z] = this.groundWorld(wire.pos.x, wire.pos.y);
      const back = new THREE.Mesh(this.cachedGeometry('wire-progress-back', () => new THREE.BoxGeometry(width, .025, .07)), this.basicMaterial(0x302b25, .9));
      back.position.set(x, y + .6, z); this.stateFxGroup.add(back);
      const fill = new THREE.Mesh(back.geometry, this.basicMaterial(0xe4a052));
      fill.name = 'wire-breach-progress'; fill.scale.x = fraction;
      fill.position.set(x - width * (1 - fraction) / 2, y + .62, z); this.stateFxGroup.add(fill);
    }
    for (const [key, view] of this.retainedFxViews) if (!this.retainedFxLive.has(key)) {
      this.retainedFxGroup.remove(view.group);
      this.clearGroup(view.group, true, false);
      this.retainedFxViews.delete(key);
    }
  }

  private drawAmbushArc(origin: Vec2, order: Pick<AmbushOrder, 'facing' | 'range' | 'arcDegrees'>, color: number, preview = false): void {
    const points = [new THREE.Vector3(...this.groundWorld(origin.x, origin.y, .07))];
    const half = order.arcDegrees * Math.PI / 360;
    for (let i = 0; i <= 32; i++) {
      const angle = order.facing - half + half * 2 * i / 32;
      points.push(new THREE.Vector3(...this.groundWorld(origin.x + Math.cos(angle) * order.range, origin.y + Math.sin(angle) * order.range, .07)));
    }
    points.push(points[0]!.clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({ color, transparent: true, opacity: .8, dashSize: .16, gapSize: .08, depthWrite: false }));
    line.name = preview ? 'ambush-arc-preview' : 'ambush-arc'; line.computeLineDistances();
    this.overlayGroup.add(line);
  }

  private drawPatrolArea(area: PatrolArea, color: number, unitId?: number): void {
    const corners = [area.min, { x: area.max.x, y: area.min.y }, area.max, { x: area.min.x, y: area.max.y }];
    const points: THREE.Vector3[] = [];
    corners.forEach((from, i) => {
      const to = corners[(i + 1) % corners.length]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 6));
      for (let step = 0; step < steps; step++) points.push(new THREE.Vector3(...this.groundWorld(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps, .07)));
    });
    points.push(points[0]!.clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({
      color, transparent: true, opacity: .85, dashSize: 1.5 * WORLD_UNITS_PER_PIXEL, gapSize: 4 * WORLD_UNITS_PER_PIXEL,
    }));
    line.computeLineDistances();
    line.userData.patrolUnitId = unitId;
    line.userData.patrolPreview = unitId === undefined;
    this.overlayGroup.add(line);
  }

  frame(state: SimState, alpha: number, preview: PreviewInfo | null, selection: readonly number[], dt: number, drag: DragRect | null = null): void {
    this.terrain = state.terrain;
    this.updateGroundImpacts(state);
    this.updateUnits(state, alpha, selection, dt);
    this.updateDamagedTrees(state);
    this.flushTracers();
    this.updateStateFx(state);
    this.updateWeather(state.weather, celestialAtTick(state.ticks + alpha, state.dayNightStartTick), dt);
    const n = this.effectGroup.children.length;
    for (let i = n - 1; i >= 0; i--) {
      const object = this.effectGroup.children[i]!;
      const ttl = object.userData.ttl as number | undefined;
      if (ttl !== undefined) {
        object.userData.ttl = ttl - dt;
        if (ttl <= 0) {
          this.effectGroup.remove(object);
          if (object instanceof THREE.InstancedMesh) object.dispose();
          const effect = object as THREE.Mesh;
          if (effect.geometry && !this.sharedGeometries.includes(effect.geometry)) effect.geometry.dispose();
          if (effect.material && !this.sharedMaterials.includes(effect.material as THREE.Material)) (effect.material as THREE.Material).dispose();
        } else {
          // Pulses and blasts have local geometry centered on their position.
          // Tracers and arcs contain world coordinates: scaling them moves both
          // endpoints away from the map origin, detaching fire from its units.
          if (object instanceof THREE.InstancedMesh && (object.userData.earthDust || object.userData.woodSplinters)) {
            const elapsed = (object.userData.max as number) - ttl + dt, matrix = this.particleTransform;
            const velocity = object.userData.velocities as Float32Array, sizes = object.userData.sizes as Float32Array;
            for (let j = 0; j < object.count; j++) {
              matrix.position.set(velocity[j * 3]! * elapsed, Math.max(.025, velocity[j * 3 + 1]! * elapsed - 1.5 * elapsed * elapsed), velocity[j * 3 + 2]! * elapsed);
              if (object.userData.woodSplinters) {
                matrix.scale.set(sizes[j]! * .3, sizes[j]! * 1.6, sizes[j]! * .3); matrix.rotation.set(elapsed * 6 + j, j, elapsed * 4);
              } else { matrix.rotation.set(0, 0, 0); matrix.scale.setScalar(sizes[j]! * (1 + elapsed * .8)); }
              matrix.updateMatrix(); object.setMatrixAt(j, matrix.matrix);
            }
            object.instanceMatrix.needsUpdate = true;
          } else if (object instanceof THREE.Mesh) {
            const f = 1 - (ttl - dt) / (object.userData.max as number);
            object.scale.setScalar(1 + Math.max(0, f) * 1.8);
          }
          const mat = (object as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
          if (mat?.transparent) mat.opacity = Math.max(0, ttl / (object.userData.max as number)) * (object.userData.earthDust ? .6 : 1);
        }
      }
    }
    // Static zones change only when a run enters/leaves the crossing phase.
    const zoneKey = `${state.scheduler.phase}:${state.sectorCaptured}`;
    if (zoneKey !== this.zoneKey) { this.clearGroup(this.zoneGroup, true); this.zoneKey = ''; this.drawZones(state); }
    // Geometry depends on commands and cursor positions, not on render frequency.
    const overlayKey = JSON.stringify([preview, drag, state.units
      .filter((unit) => selection.includes(unit.id) && !unit.dead && unit.health > 0)
      .map((unit) => [unit.id, unit.patrol?.area, unit.ambush && !unit.ambush.triggered && !unit.crossed
        ? [unit.pos, unit.ambush.facing, unit.ambush.range, unit.ambush.arcDegrees, unit.ambush.prepTicks > 0] : null])]);
    if (overlayKey !== this.overlayKey) {
      this.overlayKey = overlayKey;
      this.clearGroup(this.overlayGroup, true, false);
      for (const unit of state.units) {
        if (unit.ambush && !unit.ambush.triggered && selection.includes(unit.id) && unit.health > 0 && !unit.dead && !unit.crossed) {
          this.drawAmbushArc(unit.pos, unit.ambush, unit.ambush.prepTicks > 0 ? 0xa5ad98 : 0xe2c177);
        }
      }
      const patrolAreas = new Set<string>();
      for (const unit of state.units) {
        if (!unit.patrol || !selection.includes(unit.id) || unit.dead || unit.health <= 0) continue;
        const key = JSON.stringify(unit.patrol.area);
        if (patrolAreas.has(key)) continue;
        patrolAreas.add(key);
        this.drawPatrolArea(unit.patrol.area, 0x9bbf8a, unit.id);
      }
      if (preview) {
        const [x, , z] = this.groundWorld(preview.pos.x, preview.pos.y);
        const color = preview.valid ? 0x8dbb7a : 0xc95642;
        for (const arc of preview.ambushArcs ?? []) this.drawAmbushArc(arc.origin, arc, color, true);
        if (preview.patrolArea) this.drawPatrolArea(preview.patrolArea, color);
        const ghost: THREE.Mesh<THREE.BufferGeometry> = new THREE.Mesh(new THREE.CylinderGeometry(.31, .31, .035, 20), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .55, depthWrite: false })); this.placeOnGround(ghost, x, .05, z); this.overlayGroup.add(ghost);
        if (preview.kind === 'barbedWire') {
          ghost.geometry.dispose();
          ghost.geometry = new THREE.BoxGeometry(CONFIG.barbedWire.halfLength * 2 * WORLD_UNITS_PER_PIXEL, .05, CONFIG.barbedWire.halfDepth * 2 * WORLD_UNITS_PER_PIXEL);
          ghost.name = 'wire-placement-preview';
        }
        if (preview.engineerRange && preview.engineerPos) { const range = new THREE.Mesh(drapedRingGeometry(this.terrain, preview.engineerPos, preview.engineerRange * WORLD_UNITS_PER_PIXEL - .035, preview.engineerRange * WORLD_UNITS_PER_PIXEL), new THREE.MeshBasicMaterial({ color: 0xb9bb83, transparent: true, opacity: .72, side: THREE.DoubleSide, depthWrite: false })); this.overlayGroup.add(range); }
        if (preview.kind === 'satchel') {
          const radius = CONFIG.satchel.radius * WORLD_UNITS_PER_PIXEL;
          const danger = new THREE.Mesh(drapedRingGeometry(state.terrain, preview.pos, radius - .025, radius), new THREE.MeshBasicMaterial({ color: 0xd65c43, transparent: true, opacity: .8, side: THREE.DoubleSide, depthWrite: false }));
          danger.name = 'satchel-blast-preview'; this.overlayGroup.add(danger);
        }
      }
      if (drag) {
        const centerX = (drag.x0 + drag.x1) / 2, centerY = (drag.y0 + drag.y1) / 2;
        const width = Math.abs(drag.x1 - drag.x0), height = Math.abs(drag.y1 - drag.y0);
        const box = new THREE.Mesh(heightfieldGeometry(state.terrain, { x: centerX - width / 2, y: centerY - height / 2, width, height }).translate(0, .04, 0), new THREE.MeshBasicMaterial({ color: 0xc4d4b1, transparent: true, opacity: .16, side: THREE.DoubleSide, depthWrite: false }));
        this.overlayGroup.add(box);
        const corners = [{ x: drag.x0, y: drag.y0 }, { x: drag.x1, y: drag.y0 }, { x: drag.x1, y: drag.y1 }, { x: drag.x0, y: drag.y1 }];
        const points: THREE.Vector3[] = [];
        corners.forEach((from, i) => {
          const to = corners[(i + 1) % corners.length]!;
          const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 6));
          for (let step = 0; step < steps; step++) points.push(new THREE.Vector3(...this.groundWorld(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps, .05)));
        });
        this.overlayGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xd8e6c6 })));
      }
    }
    if (this.shakeTime > 0) { this.shakeTime = Math.max(0, this.shakeTime - dt); const amount = this.shakeTime * this.shakeMag * WORLD_UNITS_PER_PIXEL; this.camera.position.x = this.cameraPanX + Math.sin(this.effectTime * 83) * amount; this.camera.position.z = this.cameraPanZ + 10.8 + Math.cos(this.effectTime * 71) * amount; this.camera.lookAt(this.cameraPanX, 0, this.cameraPanZ); }
    else { this.camera.position.set(this.cameraPanX, 38, this.cameraPanZ + 10.8); this.camera.lookAt(this.cameraPanX, 0, this.cameraPanZ); this.shakeMag = 0; }
    this.unitBatches.sync(this.unitGroup);
    this.renderer.render(this.scene, this.camera);
  }

  shake(magnitude: number, duration: number): void { this.shakeMag = Math.max(this.shakeMag, magnitude); this.shakeTime = Math.max(this.shakeTime, duration); }
  getShakeMagnitude(): number { return this.shakeMag; }
  destroy(): void {
    this.unitBatches.clear();
    this.retainedFxViews.clear();
    this.retainedFxLive.clear();
    this.lighting.dispose();
    this.clearGroup(this.field, true);
    for (const geometry of this.sharedGeometries) geometry.dispose();
    for (const material of this.sharedMaterials) { const map = (material as THREE.MeshStandardMaterial).map; map?.dispose(); material.dispose(); }
    this.sharedGeometries.length = 0; this.sharedMaterials.length = 0;
    this.geometryCache.clear();
    this.basicMaterialCache.clear();
    this.materialCache.clear();
    this.renderer.dispose();
  }
}
