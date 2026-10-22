import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/content/config';
import { BattleLighting, celestialAtTick } from '../src/render/app/lighting';
import { simulationToWorld } from '../src/render/app/coordinates';

const cycle = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate;

describe('sun and moon lighting', () => {
  it('resizes existing shadow targets under pressure and restores their full resolution', () => {
    const lights = new BattleLighting(new THREE.Scene());
    lights.sun.shadow.map = new THREE.WebGLRenderTarget(2048, 2048);
    const dispose = vi.spyOn(lights.sun.shadow.map, 'dispose');
    lights.setResolutionScale(.5);
    expect(lights.sun.shadow.mapSize.x).toBe(1024);
    expect(lights.moon.shadow.mapSize.x).toBe(512);
    expect(lights.sun.shadow.map.width).toBe(1024);
    expect(dispose).toHaveBeenCalledOnce();
    lights.setResolutionScale(.5);
    expect(dispose).toHaveBeenCalledOnce();
    lights.setResolutionScale(1);
    expect(lights.sun.shadow.map.width).toBe(2048);
    expect(lights.moon.shadow.mapSize.x).toBe(1024);
    lights.dispose();
  });
  it('moves the sun east to west and casts longer, opposite-facing morning/evening shadows', () => {
    const morning = celestialAtTick(cycle * .8, 0).sun;
    const evening = celestialAtTick(cycle * .2, 0).sun;
    const noon = celestialAtTick(0, 0).sun;
    const shadow = (position: [number, number, number]) => new THREE.Vector2(-position[0] / position[1], -position[2] / position[1]);
    expect(morning.position[0]).toBeGreaterThan(0);
    expect(evening.position[0]).toBeLessThan(0);
    expect(shadow(morning.position).x).toBeLessThan(0);
    expect(shadow(evening.position).x).toBeGreaterThan(0);
    expect(shadow(morning.position).length()).toBeGreaterThan(shadow(noon.position).length() * 3);
    expect(shadow(evening.position).length()).toBeCloseTo(shadow(morning.position).length());
  });

  it('uses the moon for directional light and shadows when the sun is below the horizon', () => {
    const scene = new THREE.Scene();
    const lights = new BattleLighting(scene);
    lights.update(celestialAtTick(cycle * .5, 0), 'clear');
    expect(lights.sun.visible).toBe(false);
    expect(lights.sun.intensity).toBe(0);
    expect(lights.moon.visible).toBe(true);
    expect(lights.moon.intensity).toBeGreaterThan(0);
    expect(lights.moon.castShadow).toBe(true);
    expect(lights.moon.shadow.intensity).toBeGreaterThan(0);
    expect(lights.moon.position.y).toBeGreaterThan(0);
    lights.dispose();
  });

  it('moves moon shadows during the night as well', () => {
    const rising = celestialAtTick(cycle * .3, 0).moon;
    const setting = celestialAtTick(cycle * .7, 0).moon;
    expect(rising.position[0] * setting.position[0]).toBeLessThan(0);
    expect(rising.elevation).toBeGreaterThan(0);
    expect(setting.elevation).toBeGreaterThan(0);
  });

  it.each([.125, .25, .375, .625, .75, .875, 1])('crosses cycle fraction %s without light or color jumps', (fraction) => {
    const scene = new THREE.Scene();
    const lights = new BattleLighting(scene);
    lights.update(celestialAtTick(cycle * fraction - .01, 0), 'clear');
    const before = { color: lights.ambient.color.toArray(), intensity: lights.ambient.intensity, sun: lights.sun.intensity, moon: lights.moon.intensity };
    lights.update(celestialAtTick(cycle * fraction + .01, 0), 'clear');
    lights.ambient.color.toArray().forEach((value, i) => expect(Math.abs(value - before.color[i]!)).toBeLessThan(.001));
    expect(Math.abs(lights.ambient.intensity - before.intensity)).toBeLessThan(.001);
    expect(Math.abs(lights.sun.intensity - before.sun)).toBeLessThan(.001);
    expect(Math.abs(lights.moon.intensity - before.moon)).toBeLessThan(.001);
    lights.dispose();
  });

  it('keeps ground and tall props inside the shadow camera throughout the entire orbit', () => {
    const scene = new THREE.Scene();
    const lights = new BattleLighting(scene);
    for (let i = 0; i < 48; i++) {
      lights.update(celestialAtTick(cycle * i / 48, 0), 'clear');
      scene.updateMatrixWorld(true);
      for (const light of [lights.sun, lights.moon]) {
        if (!light.visible) continue;
        light.shadow.updateMatrices(light);
        for (const x of [0, CONFIG.field.width]) for (const y of [0, CONFIG.field.height]) for (const height of [0, 3.5]) {
          const clip = new THREE.Vector3(...simulationToWorld(x, y, height)).project(light.shadow.camera);
          expect(Math.abs(clip.x)).toBeLessThan(1);
          expect(Math.abs(clip.y)).toBeLessThan(1);
          expect(Math.abs(clip.z)).toBeLessThan(1);
        }
      }
    }
    lights.dispose();
  });

  it('reduces direct light and shadow strength under heavy clouds while keeping ambient fill', () => {
    const scene = new THREE.Scene();
    const lights = new BattleLighting(scene);
    const noon = celestialAtTick(0, 0);
    lights.update(noon, 'clear');
    const clear = { direct: lights.sun.intensity, shadow: lights.sun.shadow.intensity };
    lights.update(noon, 'heavyRain');
    expect(lights.sun.intensity).toBeLessThan(clear.direct);
    expect(lights.sun.shadow.intensity).toBeLessThan(clear.shadow);
    expect(lights.ambient.intensity).toBeGreaterThan(1);
    lights.dispose();
  });

  it('holds daylight before the cycle unlocks and reproduces paused, restored, and wrapped times', () => {
    expect(celestialAtTick(10_000, null)).toEqual(celestialAtTick(0, null));
    expect(celestialAtTick(90, 100)).toEqual(celestialAtTick(0, null));
    const at = celestialAtTick(1234.5, 100);
    expect(celestialAtTick(1234.5, 100)).toEqual(at);
    const nextCycle = celestialAtTick(1234.5 + cycle, 100);
    expect(nextCycle).toEqual(at);
    expect(celestialAtTick(1234.75, 100).sun.position).not.toEqual(at.sun.position);
  });

  it('releases both shadow maps and their scene objects', () => {
    const scene = new THREE.Scene();
    const lights = new BattleLighting(scene);
    const sunDispose = vi.spyOn(lights.sun.shadow, 'dispose');
    const moonDispose = vi.spyOn(lights.moon.shadow, 'dispose');
    lights.dispose();
    expect(sunDispose).toHaveBeenCalledOnce();
    expect(moonDispose).toHaveBeenCalledOnce();
    expect(scene.children).toHaveLength(0);
  });
});
