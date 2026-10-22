import * as THREE from 'three';

export const HEADLIGHT_BEAM = { width: 1.9, length: 3.6 } as const;

/** Ground light: narrow at the lamp, widening and fading into the distance. */
export function headlightMaterial(): THREE.MeshBasicMaterial {
  const width = 64, height = 128;
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    // DataTexture's bottom row maps to the near end of the ground plane.
    const distance = row / (height - 1);
    const halfWidth = .07 + distance * .8;
    const reach = Math.min(1, distance / .06) * (1 - distance) ** 1.5;
    for (let col = 0; col < width; col++) {
      const across = (col / (width - 1) - .5) * HEADLIGHT_BEAM.width;
      const edge = Math.max(0, 1 - (across / halfWidth) ** 2) ** 2;
      const index = (row * width + col) * 4;
      pixels[index] = 255; pixels[index + 1] = 255; pixels[index + 2] = 255;
      pixels[index + 3] = Math.round(255 * reach * edge);
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return new THREE.MeshBasicMaterial({
    color: 0xffe5b0, map: texture, transparent: true, opacity: .36,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
}
