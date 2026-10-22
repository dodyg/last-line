import * as THREE from 'three';

/** Get the gun barrel's actual world-space muzzle after the unit root is posed. */
export function weaponMuzzleWorldPosition(weapon: THREE.Object3D, barrelLength: number): THREE.Vector3 {
  weapon.updateWorldMatrix(true, false);
  return weapon.localToWorld(new THREE.Vector3(0, 0, -barrelLength / 2));
}

/** Return detached endpoint vectors for a tracer so later scene changes cannot move it. */
export function tracerWorldEndpoints(muzzle: THREE.Vector3, target: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  return [muzzle.clone(), target.clone()];
}
