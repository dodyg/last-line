import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { battlefieldDetails, MAX_BATTLEFIELD_DETAILS } from '../src/render/app/environment-dressing';
import { MovementEffects, MOVEMENT_PARTICLE_CAP } from '../src/render/app/movement-effects';
import { generateTerrain, TERRAIN_KIND } from '../src/simulation/terrain';
import { Simulation } from '../src/simulation/simulation';

describe('bounded environment rendering', () => {
  it('keeps seeded dressing deterministic and within three shadow-free batches', () => {
    const data = generateTerrain(2026, true, 4, 'france');
    const ground = (x: number, y: number): [number, number, number] => [x, 0, y];
    const a = battlefieldDetails(data, ground), b = battlefieldDetails(data, ground);
    expect(a.children.length).toBeGreaterThan(0);
    expect(a.children.length).toBeLessThanOrEqual(3);
    let count = 0;
    a.children.forEach((object, i) => {
      const mesh = object as THREE.InstancedMesh;
      count += mesh.count;
      expect(mesh.castShadow).toBe(false);
      expect(Array.from(mesh.instanceMatrix.array)).toEqual(Array.from((b.children[i] as THREE.InstancedMesh).instanceMatrix.array));
    });
    expect(count).toBeLessThanOrEqual(MAX_BATTLEFIELD_DETAILS);
    for (const group of [a, b]) for (const child of group.children) {
      const mesh = child as THREE.InstancedMesh;
      mesh.dispose(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
    }
  });

  it('pools movement particles and skips hidden, offscreen, stationary and disabled emitters', () => {
    const sim = new Simulation(2026), state = sim.state, unit = state.units[0]!;
    state.weather = 'clear'; state.season = 'summer';
    unit.running = true; unit.pos = { x: 100, y: 100 }; unit.prevPos = { x: 99, y: 100 }; unit.buildingPosition = undefined; unit.bridgePosition = undefined;
    state.terrain.kinds?.fill(0);
    const root = new THREE.Group(), views = new Map([[unit.id, root]]);
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10);
    camera.position.set(0, 2, 2); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const effects = new MovementEffects(), geometry = effects.mesh.geometry;
    const rng = state.rng.s, nextId = state.nextEntityId;
    const update = () => { state.ticks++; effects.update(state, views, camera, .1, true, 1); };
    root.visible = false; update(); expect(effects.mesh.count).toBe(0);
    root.visible = true; root.position.x = 100; update(); expect(effects.mesh.count).toBe(0);
    root.position.x = 0; unit.prevPos = { ...unit.pos }; update(); expect(effects.mesh.count).toBe(0);
    unit.prevPos.x--; update(); expect(effects.mesh.visible).toBe(true);
    for (let i = 0; i < 150; i++) update();
    expect(effects.mesh.count).toBeLessThanOrEqual(MOVEMENT_PARTICLE_CAP);
    expect(effects.mesh.geometry).toBe(geometry);
    effects.update(state, views, camera, .1, false, 1);
    expect(effects.mesh.count).toBe(0); expect(effects.mesh.visible).toBe(false);
    unit.running = false; state.weather = 'rain'; state.terrain.kinds?.fill(TERRAIN_KIND.mud);
    update(); expect(effects.mesh.visible).toBe(true);
    effects.reset(); unit.bridgePosition = { key: 'test', level: 'deck' };
    update(); expect(effects.mesh.count).toBe(0);
    expect(state.rng.s).toBe(rng); expect(state.nextEntityId).toBe(nextId);
    effects.dispose();
  });
});
