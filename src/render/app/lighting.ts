import * as THREE from 'three';
import { CONFIG } from '../../content/config';
import { dayNightAtTick, type DayNightState } from '../../simulation/daynight';
import type { WeatherKind } from '../../simulation/types';
import { WORLD_UNITS_PER_PIXEL } from './coordinates';

interface CelestialBody {
  position: [number, number, number];
  elevation: number;
  intensity: number;
}

export interface CelestialState extends DayNightState {
  sun: CelestialBody;
  moon: CelestialBody;
  daylight: number;
  twilight: number;
}

const smoothstep = (low: number, high: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

/** A game sky driven only by the saved simulation clock, including fractional ticks. */
export function celestialAtTick(tick: number, startTick: number | null): CelestialState {
  const cycle = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate;
  const elapsed = startTick === null || tick < startTick ? 0 : tick - startTick;
  const angle = (((elapsed % cycle) + cycle) % cycle) / cycle * Math.PI * 2;
  // East is +X: sunrise in the east, sunset in the west. A tilted orbit keeps
  // useful shadows at noon; the moon follows the opposite half of the sky.
  const x = -Math.sin(angle) * .94, y = Math.cos(angle) * .94, z = .34;
  const body = (sign: number, strength: number): CelestialBody => {
    const elevation = y * sign;
    return {
      position: [x * sign * 80, y * sign * 80, z * sign * 80],
      elevation,
      intensity: strength * smoothstep(0, .14, elevation) * (.5 + .5 * Math.max(0, elevation)),
    };
  };
  return {
    ...dayNightAtTick(tick, startTick),
    sun: body(1, 2.65), moon: body(-1, .75),
    daylight: smoothstep(-.12, .45, y),
    twilight: 1 - smoothstep(0, .38, Math.abs(y)),
  };
}

/** Two moving light sources with full-field shadows and a readable ambient floor. */
export class BattleLighting {
  readonly sun = new THREE.DirectionalLight();
  readonly moon = new THREE.DirectionalLight(0x9eb7e4);
  readonly ambient = new THREE.HemisphereLight();
  private readonly daySky = new THREE.Color(0xd7dfd0);
  private readonly nightSky = new THREE.Color(0x9cabca);
  private readonly warmSky = new THREE.Color(0xd9a77b);
  private readonly dayGround = new THREE.Color(0x484b36);
  private readonly nightGround = new THREE.Color(0x30394b);
  private readonly highSun = new THREE.Color(0xffedcf);
  private readonly lowSun = new THREE.Color(0xffaa64);

  constructor(private readonly scene: THREE.Scene) {
    this.sun.name = 'Sun'; this.moon.name = 'Moon'; this.ambient.name = 'Sky fill';
    // Every possible ground point and tall prop fits for any light direction.
    const radius = Math.hypot(CONFIG.field.width, CONFIG.field.height) * WORLD_UNITS_PER_PIXEL / 2 + 6;
    for (const [light, size] of [[this.sun, 2048], [this.moon, 1024]] as const) {
      light.castShadow = true;
      light.shadow.mapSize.set(size, size);
      light.shadow.camera.left = -radius; light.shadow.camera.right = radius;
      light.shadow.camera.top = radius; light.shadow.camera.bottom = -radius;
      light.shadow.camera.near = 1; light.shadow.camera.far = 140;
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.bias = -.0002;
      light.shadow.normalBias = .025;
      light.shadow.radius = 2;
      light.target.position.set(0, 0, 0);
    }
    scene.add(this.sun, this.sun.target, this.moon, this.moon.target, this.ambient);
    this.update(celestialAtTick(0, null), 'clear');
  }

  update(sky: CelestialState, weather: WeatherKind): void {
    const conditions = CONFIG.weather[weather];
    const cloud = Math.min(.85, conditions.fogIntensity * .55 + conditions.rainIntensity * .45 + (conditions.snowIntensity ?? 0) * .5);
    for (const [light, body] of [[this.sun, sky.sun], [this.moon, sky.moon]] as const) {
      light.position.set(...body.position);
      light.visible = body.elevation > 0;
      light.intensity = body.intensity * (1 - cloud * .65);
      // Fade grazing-angle shadows at the horizon instead of flipping their
      // direction or throwing infinitely long shadows across the whole map.
      light.shadow.intensity = smoothstep(.025, .16, body.elevation) * (1 - cloud * .6);
    }
    this.sun.color.copy(this.lowSun).lerp(this.highSun, smoothstep(.04, .65, sky.sun.elevation));
    this.ambient.color.copy(this.nightSky).lerp(this.daySky, sky.daylight).lerp(this.warmSky, sky.twilight * .35);
    this.ambient.groundColor.copy(this.nightGround).lerp(this.dayGround, sky.daylight);
    this.ambient.intensity = 1.05 + sky.daylight * .75 + cloud * .12;
  }

  setResolutionScale(scale: number): void {
    for (const [light, base] of [[this.sun, 2048], [this.moon, 1024]] as const) {
      const size = Math.round(base * Math.max(.5, Math.min(1, scale)) / 256) * 256;
      if (light.shadow.mapSize.x === size) continue;
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.setSize(size, size);
      light.shadow.mapPass?.setSize(size, size);
      light.shadow.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const light of [this.sun, this.moon]) {
      light.shadow.dispose();
      this.scene.remove(light, light.target);
    }
    this.scene.remove(this.ambient);
  }
}
