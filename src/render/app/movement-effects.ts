import * as THREE from 'three';
import { CONFIG } from '../../content/config';
import { TERRAIN_KIND } from '../../simulation/terrain';
import type { SimState } from '../../simulation/types';

export const MOVEMENT_PARTICLE_CAP = 96;
const EMITTER_CAP = 12;

/** A single reusable batch for dust and splashes; no per-emission GPU allocations. */
export class MovementEffects {
  readonly mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ vertexColors: false }), MOVEMENT_PARTICLE_CAP);
  private readonly life = new Float32Array(MOVEMENT_PARTICLE_CAP);
  private readonly positions = new Float32Array(MOVEMENT_PARTICLE_CAP * 3);
  private readonly wet = new Uint8Array(MOVEMENT_PARTICLE_CAP);
  private readonly transform = new THREE.Object3D();
  private readonly projected = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private cursor = 0;
  private scan = 0;
  private lastTick = -1;
  private elapsed = 0;

  constructor() {
    this.mesh.name = 'movement-dust-and-splashes'; this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.reset();
  }

  reset(): void { this.life.fill(0); this.mesh.count = 0; this.mesh.visible = false; this.lastTick = -1; this.elapsed = 0; }

  update(state: SimState, views: ReadonlyMap<number, THREE.Group>, camera: THREE.Camera, dt: number, enabled: boolean, budgetScale: number): void {
    if (!enabled) { this.reset(); return; }
    const delta = Math.min(Math.max(dt, 0), .1);
    this.elapsed += delta;
    let spawned = false;
    if (delta > 0 && this.elapsed >= .1 && state.ticks !== this.lastTick) {
      this.elapsed = 0; this.lastTick = state.ticks;
      let emitted = 0;
      const limit = Math.max(3, Math.floor(EMITTER_CAP * budgetScale));
      for (let n = 0; n < state.units.length && emitted < limit; n++) {
        const unit = state.units[(this.scan + n) % state.units.length]!;
        const root = views.get(unit.id);
        const distance = Math.hypot(unit.pos.x - unit.prevPos.x, unit.pos.y - unit.prevPos.y);
        if (!root?.visible || unit.dead || unit.crossed || unit.health <= 0 || unit.buildingPosition || unit.bridgePosition || distance < .15 || distance > 12) continue;
        this.projected.copy(root.position).project(camera);
        if (Math.abs(this.projected.x) > 1.05 || Math.abs(this.projected.y) > 1.05 || Math.abs(this.projected.z) > 1) continue;
        const { cell, cols, kinds } = state.terrain;
        const kind = kinds?.[Math.floor(unit.pos.y / cell) * cols + Math.floor(unit.pos.x / cell)];
        const wet = kind === TERRAIN_KIND.river || kind === TERRAIN_KIND.rapids || kind === TERRAIN_KIND.mud;
        const vehicle = unit.role === 'vehicle' || unit.role === 'gun_truck' || unit.role === 'troop_transport';
        if (!wet && ((!vehicle && !unit.running) || CONFIG.weather[state.weather].rainIntensity > .1 || state.season === 'winter')) continue;
        const i = this.cursor++ % MOVEMENT_PARTICLE_CAP;
        this.life[i] = .55; this.wet[i] = wet ? 1 : 0;
        spawned = true;
        this.positions.set([root.position.x, root.position.y + .025, root.position.z], i * 3);
        this.color.setHex(wet ? 0x9badad : 0xa59576); this.mesh.setColorAt(i, this.color);
        emitted++;
      }
      this.scan = (this.scan + limit) % Math.max(1, state.units.length);
    }
    if (!spawned && this.mesh.count === 0) return;
    let count = 0;
    for (let i = 0; i < MOVEMENT_PARTICLE_CAP; i++) {
      this.life[i] = Math.max(0, this.life[i]! - delta);
      const age = .55 - this.life[i]!, wet = this.wet[i]!;
      this.transform.position.set(this.positions[i * 3]! + (wet ? Math.sin(i * 7) : .08) * age * .15,
        this.positions[i * 3 + 1]! + (wet ? Math.max(0, age * .7 - age * age * 1.6) : age * .15), this.positions[i * 3 + 2]!);
      const size = this.life[i]! > 0 ? (wet ? .023 : .055) * Math.sin(Math.PI * this.life[i]! / .55) : 0;
      this.transform.scale.set(size, size * (wet ? 1.8 : .6), size); this.transform.updateMatrix(); this.mesh.setMatrixAt(i, this.transform.matrix);
      if (this.life[i]! > 0) count = i + 1;
    }
    this.mesh.count = count; this.mesh.visible = count > 0; this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void { this.mesh.dispose(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}
