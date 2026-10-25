import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createBattleCamera } from '../src/render/app/camera';
import { simulationToWorld } from '../src/render/app/coordinates';
import { CONFIG } from '../src/content/config';

describe('full-map camera framing', () => {
  it.each([[1280, 720], [1920, 600], [390, 700], [800, 800]])('fits every corner at %i × %i', (width, height) => {
    const camera = createBattleCamera(width, height);
    for (const x of [0, CONFIG.field.width]) {
      for (const y of [0, CONFIG.field.height]) {
        const point = new Vector3(...simulationToWorld(x, y)).project(camera);
        expect(Math.abs(point.x)).toBeLessThan(1);
        expect(Math.abs(point.y)).toBeLessThan(1);
        expect(Math.abs(point.z)).toBeLessThan(1);
      }
    }
  });
});
