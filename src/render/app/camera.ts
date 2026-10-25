import * as THREE from 'three';
import { CONFIG } from '../../content/config';
import { WORLD_UNITS_PER_PIXEL } from './coordinates';

export function createBattleCamera(width: number, height: number): THREE.OrthographicCamera {
  const aspect = Math.max(1, width) / Math.max(1, height);
  const fieldWidth = CONFIG.field.width * WORLD_UNITS_PER_PIXEL;
  const fieldDepth = CONFIG.field.height * WORLD_UNITS_PER_PIXEL;
  const camera = new THREE.OrthographicCamera();
  camera.position.set(0, 38, 10.8);
  camera.lookAt(0, 0, 0);
  // Measure depth along the camera's actual screen-up axis. The view is
  // nearly top-down, so most of the map's north/south extent is visible.
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const projectedDepth = fieldDepth * Math.abs(up.z) + 3.2;
  const frustumHeight = Math.max(projectedDepth, (fieldWidth + 3) / aspect);
  camera.left = -frustumHeight * aspect / 2;
  camera.right = frustumHeight * aspect / 2;
  camera.top = frustumHeight / 2;
  camera.bottom = -frustumHeight / 2;
  camera.near = 0.1;
  camera.far = 100;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}
