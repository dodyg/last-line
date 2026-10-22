import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildingDamage, buildingDamageStage } from '../src/render/app/building-damage';
import { Simulation } from '../src/simulation/simulation';

describe('building damage appearance', () => {
  it('progresses from first damage through critical damage and collapse', () => {
    const building = new Simulation(2026).state.buildings[0]!;
    for (const [ratio, stage] of [[1, 0], [.99, 1], [.71, 1], [.7, 2], [.4, 3], [.15, 4], [0, 5]]) {
      building.health = building.maxHealth * ratio!;
      expect(buildingDamageStage(building)).toBe(stage);
    }
  });

  it.each([false, true])('adds growing roof/wall damage and rubble with bounded draw calls, pitched=%s', (pitched) => {
    const sim = new Simulation(2026), building = sim.state.buildings[0]!;
    const material = new THREE.MeshBasicMaterial();
    let previousVertices = 0;
    for (const ratio of [.9, .6, .3, .1]) {
      building.health = building.maxHealth * ratio;
      const group = buildingDamage(building, 4, 3, 2.5, pitched, () => material);
      const roof = group.children.find((child) => child.userData.damageDetail === 'roof-scar') as THREE.Mesh;
      const vertices = roof.geometry.getAttribute('position').count;
      expect(vertices).toBeGreaterThan(previousVertices); previousVertices = vertices;
      expect(group.children.some((child) => child.userData.damageDetail === 'wall-crack')).toBe(true);
      expect(group.children.some((child) => child.userData.damageDetail === 'fallen-masonry')).toBe(true);
      expect(group.children.length).toBeLessThanOrEqual(9);
      for (const child of group.children) {
        const geometry = (child as THREE.Mesh).geometry;
        expect([...geometry.getAttribute('position').array].every(Number.isFinite)).toBe(true);
        if (child instanceof THREE.InstancedMesh) child.dispose(); geometry.dispose();
        if (child instanceof THREE.LineSegments) (child.material as THREE.Material).dispose();
      }
    }
    material.dispose();
  });

  it('reproduces the same marks after restoring HP without consuming gameplay randomness', () => {
    const sim = new Simulation(2026), building = sim.state.buildings[0]!;
    building.health = building.maxHealth * .25;
    const restored = Simulation.fromSnapshot(sim.snapshot()), material = new THREE.MeshBasicMaterial();
    const before = { ...sim.state.rng };
    const groups = [building, restored.state.buildings[0]!].map((b) => buildingDamage(b, 4, 3, 2.5, false, () => material));
    expect(sim.state.rng).toEqual(before);
    const geometry = (group: THREE.Group) => group.children.map((child) => ({
      detail: child.userData.damageDetail,
      positions: [...(child as THREE.Mesh).geometry.getAttribute('position').array],
      instances: child instanceof THREE.InstancedMesh ? [...child.instanceMatrix.array] : [],
    }));
    expect(geometry(groups[0]!)).toEqual(geometry(groups[1]!));
    for (const group of groups) for (const child of group.children) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
      (child as THREE.Mesh).geometry.dispose();
      if (child instanceof THREE.LineSegments) (child.material as THREE.Material).dispose();
    }
    material.dispose();
  });
});
