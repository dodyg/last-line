import { CONFIG } from '../../content/config';

/** Presentation scale only; simulation values remain logical pixels. */
export const WORLD_UNITS_PER_PIXEL = 1 / 24;

export function simulationToWorld(x: number, y: number, height = 0): [number, number, number] {
  return [(x - CONFIG.field.width / 2) * WORLD_UNITS_PER_PIXEL, height, (y - CONFIG.field.height / 2) * WORLD_UNITS_PER_PIXEL];
}

export function worldToSimulation(x: number, z: number): { x: number; y: number } {
  return { x: x / WORLD_UNITS_PER_PIXEL + CONFIG.field.width / 2, y: z / WORLD_UNITS_PER_PIXEL + CONFIG.field.height / 2 };
}

export function insideField(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < CONFIG.field.width && y < CONFIG.field.height;
}
