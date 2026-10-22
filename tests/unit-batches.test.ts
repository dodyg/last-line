import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { UnitBatches } from '../src/render/app/unit-batches';

describe('unit part instancing', () => {
  it('batches repeated parts, follows articulated world transforms, and preserves shadows', () => {
    const units = new THREE.Group(), batcher = new UnitBatches();
    const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
    const parts: THREE.Mesh[] = [];
    for (let i = 0; i < 70; i++) {
      const root = new THREE.Group(), pivot = new THREE.Group();
      root.position.set(i, .2, -i); pivot.rotation.y = i * .01;
      const part = new THREE.Mesh(geometry, material);
      part.position.z = -.3; part.castShadow = true;
      root.add(pivot); pivot.add(part); units.add(root); parts.push(part);
    }
    batcher.sync(units);
    expect(batcher.group.children).toHaveLength(1);
    const batch = batcher.group.children[0] as THREE.InstancedMesh;
    expect(batch.count).toBe(70); expect(batch.castShadow).toBe(true);
    expect(parts[0]!.layers.isEnabled(0)).toBe(false);
    parts[40]!.parent!.rotation.x = .5;
    batcher.sync(units);
    const matrix = new THREE.Matrix4(); batch.getMatrixAt(40, matrix);
    matrix.elements.forEach((value, i) => expect(value).toBeCloseTo(parts[40]!.matrixWorld.elements[i]!, 5));
    const disposeGeometry = vi.spyOn(geometry, 'dispose'), disposeMaterial = vi.spyOn(material, 'dispose');
    batcher.clear();
    expect(parts[0]!.layers.isEnabled(0)).toBe(true);
    expect(batcher.group.children).toHaveLength(0);
    expect(disposeGeometry).not.toHaveBeenCalled(); expect(disposeMaterial).not.toHaveBeenCalled();
    geometry.dispose(); material.dispose();
  });

  it('removes hidden passengers and casualties, and follows damage material changes', () => {
    const units = new THREE.Group(), passengers = new THREE.Group(), batcher = new UnitBatches();
    const geometry = new THREE.BoxGeometry(), intact = new THREE.MeshStandardMaterial(), damaged = new THREE.MeshStandardMaterial();
    const body = new THREE.Mesh(geometry, intact), passenger = new THREE.Mesh(geometry, intact);
    units.add(body, passengers); passengers.add(passenger);
    batcher.sync(units);
    expect((batcher.group.children[0] as THREE.InstancedMesh).count).toBe(2);
    passengers.visible = false; body.material = damaged;
    const dispose = vi.spyOn(batcher.group.children[0] as THREE.InstancedMesh, 'dispose');
    batcher.sync(units);
    expect(dispose).toHaveBeenCalledOnce();
    expect(batcher.group.children).toHaveLength(1);
    const batch = batcher.group.children[0] as THREE.InstancedMesh;
    expect(batch.count).toBe(1); expect(batch.material).toBe(damaged);
    damaged.transparent = true; batcher.sync(units);
    expect(batcher.group.children).toHaveLength(0);
    expect(body.layers.isEnabled(0)).toBe(true);
    damaged.transparent = false; batcher.sync(units);
    units.remove(body); batcher.sync(units);
    expect(batcher.group.children).toHaveLength(0);
    expect(body.layers.isEnabled(0)).toBe(true);
    batcher.clear(); geometry.dispose(); intact.dispose(); damaged.dispose();
  });
});
