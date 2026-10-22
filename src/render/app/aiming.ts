import * as THREE from 'three';

/** Aim local -Z at a world point, compensating for the parent's slope and yaw. */
export function aimGunAtWorld(pivot: THREE.Object3D, target: THREE.Vector3, yawOnly = false): void {
  pivot.parent?.updateWorldMatrix(true, false);
  const localTarget = target.clone();
  pivot.parent?.worldToLocal(localTarget);
  const direction = localTarget.sub(pivot.position);
  if (direction.lengthSq() < 1e-10) return;
  const yaw = Math.atan2(-direction.x, -direction.z);
  const pitch = yawOnly ? 0 : Math.atan2(direction.y, Math.hypot(direction.x, direction.z));
  pivot.rotation.set(pitch, yaw, 0, 'YXZ');
}
