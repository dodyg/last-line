import * as THREE from 'three';

export interface FoliageWind { time: { value: number }; strength: { value: number } }

/** One pair of uniforms drives every crown, including its shadow silhouette. */
export function applyFoliageWind(shader: Parameters<THREE.Material['onBeforeCompile']>[0], wind: FoliageWind): void {
  shader.uniforms.foliageTime = wind.time;
  shader.uniforms.foliageStrength = wind.strength;
  shader.vertexShader = 'uniform float foliageTime;\nuniform float foliageStrength;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    vec3 windOrigin = vec3(0.0);
    #ifdef USE_INSTANCING
      windOrigin = instanceMatrix[3].xyz;
    #endif
    float windPhase = foliageTime * 1.4 + dot(windOrigin.xz, vec2(0.73, 0.49));
    float windWeight = clamp(position.y, 0.0, 1.6);
    transformed.xz += vec2(sin(windPhase), cos(windPhase * 0.83) * 0.45)
      * windWeight * foliageStrength;`);
}

export function foliageDepthMaterial(wind: FoliageWind): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.onBeforeCompile = (shader) => applyFoliageWind(shader, wind);
  material.customProgramCacheKey = () => 'foliage-wind-depth-v1';
  return material;
}
