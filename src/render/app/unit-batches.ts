import * as THREE from 'three';

interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
  count: number;
}

/** Keep the articulated models for aiming/input; submit repeated parts together. */
export class UnitBatches {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly sources = new Set<THREE.Mesh>();
  private readonly inverse = new THREE.Matrix4();
  private readonly matrix = new THREE.Matrix4();

  sync(units: THREE.Group): void {
    // Poses, weapon recoil, and hidden passenger groups are finalized first.
    units.updateWorldMatrix(true, true);
    this.group.updateWorldMatrix(true, false);
    const inverse = this.inverse.copy(this.group.matrixWorld).invert();
    const matrix = this.matrix;
    for (const batch of this.batches.values()) batch.count = 0;
    units.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
      const material = object.material;
      if (!(material instanceof THREE.MeshStandardMaterial) || material.transparent) {
        if (this.sources.delete(object)) object.layers.enable(0);
        return;
      }
      if (!object.layers.isEnabled(0) && !this.sources.has(object)) return;
      // Layer 0 belongs to the battlefield camera. Keep sources in the graph
      // for world-space aiming, but exclude them from color and shadow passes.
      object.layers.disable(0);
      this.sources.add(object);
      const key = `${object.geometry.id}:${material.uuid}:${object.castShadow}:${object.receiveShadow}`;
      let batch = this.batches.get(key);
      if (!batch || batch.count === batch.capacity) {
        const capacity = batch ? batch.capacity * 2 : 32;
        const mesh = new THREE.InstancedMesh(object.geometry, material, capacity);
        mesh.name = 'unit-part-batch';
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = object.castShadow;
        mesh.receiveShadow = object.receiveShadow;
        // Units move throughout the map; a stale aggregate bound must not cull them.
        mesh.frustumCulled = false;
        if (batch) {
          mesh.instanceMatrix.array.set(batch.mesh.instanceMatrix.array);
          this.group.remove(batch.mesh);
          batch.mesh.dispose();
        }
        batch = { mesh, capacity, count: batch?.count ?? 0 };
        this.batches.set(key, batch);
        this.group.add(mesh);
      }
      matrix.multiplyMatrices(inverse, object.matrixWorld);
      batch.mesh.setMatrixAt(batch.count++, matrix);
    });
    for (const [key, batch] of this.batches) {
      if (batch.count === 0) {
        this.group.remove(batch.mesh);
        batch.mesh.dispose();
        this.batches.delete(key);
      } else {
        batch.mesh.count = batch.count;
        batch.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    // Dead units and replaced stances must not be retained by the batcher.
    for (const source of this.sources) {
      let root: THREE.Object3D | null = source;
      while (root && root !== units) root = root.parent;
      if (!root) { source.layers.enable(0); this.sources.delete(source); }
    }
  }

  clear(): void {
    for (const source of this.sources) source.layers.enable(0);
    this.sources.clear();
    // Geometry and material are owned by the renderer's shared caches.
    for (const batch of this.batches.values()) batch.mesh.dispose();
    this.batches.clear();
    this.group.clear();
  }
}
