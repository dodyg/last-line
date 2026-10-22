import * as THREE from 'three';
import { CONFIG } from '../../content/config';
import { WORLD_UNITS_PER_PIXEL } from './coordinates';

export function createBattleCamera(width: number, height: number): THREE.OrthographicCamera {
  const aspect = Math.max(1, width) / Math.max(1, height);
  const fieldWidth = CONFIG.field.width * WORLD_UNITS_PER_PIXEL;
  const fieldDepth = CONFIG.field.height * WORLD_UNITS_PER_PIXEL;
  const pitch = THREE.MathUtils.degToRad(70);
  // The whole field remains inside view, including the foreshortened north/south axis.
  const projectedDepth = fieldDepth * Math.cos(pitch) + 3.2;
  const frustumHeight = Math.max(projectedDepth, (fieldWidth + 3) / aspect);
  const camera = new THREE.OrthographicCamera(-frustumHeight * aspect / 2, frustumHeight * aspect / 2, frustumHeight / 2, -frustumHeight / 2, 0.1, 100);
  camera.position.set(0, 38, 10.8);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  return camera;
}
