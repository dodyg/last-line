import * as THREE from 'three';
import { applyFoliageWind, type FoliageWind } from './foliage-wind';

/** Fade individual instanced crowns near selected troops without splitting batches. */
export function tacticalFoliageMaterial(color: number, points: THREE.Vector3[], active: { value: number }, wind?: FoliageWind): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color, roughness: .95, transparent: true, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    if (wind) applyFoliageWind(shader, wind);
    shader.uniforms.tacticalPoints = { value: points };
    shader.uniforms.tacticalCount = active;
    shader.vertexShader = 'varying vec3 tacticalWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vec4 tacticalPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        tacticalPosition = instanceMatrix * tacticalPosition;
      #endif
      tacticalWorld = (modelMatrix * tacticalPosition).xyz;`);
    shader.fragmentShader = 'varying vec3 tacticalWorld;\nuniform vec3 tacticalPoints[14];\nuniform int tacticalCount;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
      for (int i = 0; i < 14; i++) {
        if (i >= tacticalCount) break;
        float proximity = distance(tacticalWorld.xz, tacticalPoints[i].xz);
        diffuseColor.a *= mix(0.18, 1.0, smoothstep(0.6, 1.5, proximity));
      }
      #include <alphatest_fragment>`);
  };
  material.customProgramCacheKey = () => wind ? 'tactical-foliage-wind-v2' : 'tactical-foliage-v1';
  return material;
}
