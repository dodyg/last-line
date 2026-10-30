import { CONFIG } from './config';
import type { SimState, Terrain, Vec2 } from '../simulation/types';
import { TERRAIN_KIND } from '../simulation/terrain';

export type RunMode = 'campaign' | 'operation';
export const OPERATION_SECTORS = [
  { title: 'Bridgehead', waves: 3, holdSeconds: 10 },
  { title: 'Crossroads', waves: 4, holdSeconds: 8 },
  { title: 'Rear guard', waves: 6, holdSeconds: 0 },
] as const;

export function campaignGoal(state: { runMode?: RunMode }): number {
  return state.runMode === 'operation' ? OPERATION_SECTORS.length : CONFIG.crossing.campaignMaps;
}

export function operationSector(state: Pick<SimState, 'mapsCleared'>) {
  return OPERATION_SECTORS[Math.min(state.mapsCleared, OPERATION_SECTORS.length - 1)]!;
}

export function sectorWaves(state: Pick<SimState, 'runMode' | 'mapsCleared'>): number {
  return state.runMode === 'operation' ? operationSector(state).waves : CONFIG.crossing.captureAfterWaves;
}

const targetCache = new WeakMap<Terrain, Map<number, Vec2>>();

/** Choose a fixed, walkable target from the regenerated map, never from combat RNG. */
export function operationTarget(state: Pick<SimState, 'terrain' | 'mapsCleared'>): Vec2 {
  const terrain = state.terrain;
  const cached = targetCache.get(terrain)?.get(state.mapsCleared);
  if (cached) return cached;
  const bridge = state.mapsCleared === 0 ? terrain.bridges?.[0] : undefined;
  const desired = bridge ?? { x: CONFIG.field.width / 2, y: CONFIG.field.height / 3 };
  let target: Vec2 = { x: 36, y: 36 }, distance = Infinity;
  for (let row = 3; row < terrain.rows - 3; row++) for (let col = 1; col < terrain.cols - 1; col++) {
    if ((terrain.baseBlocked ?? terrain.blocked)[row * terrain.cols + col]) continue;
    if (terrain.buildings?.some((building) => col >= building.pos.x / terrain.cell && col < building.pos.x / terrain.cell + building.cols && row >= building.pos.y / terrain.cell && row < building.pos.y / terrain.cell + building.rows)) continue;
    const pos = { x: (col + .5) * terrain.cell, y: (row + .5) * terrain.cell };
    const roadCell = (index: number) => terrain.kinds?.[index] === TERRAIN_KIND.road || terrain.kinds?.[index] === TERRAIN_KIND.bridge;
    const index = row * terrain.cols + col;
    const junction = !bridge && [-1, 1, -terrain.cols, terrain.cols].filter((offset) => roadCell(index + offset)).length >= 3;
    const d = Math.hypot(pos.x - desired.x, pos.y - desired.y) + (roadCell(index) ? 0 : CONFIG.field.width * 2) - (junction ? CONFIG.field.width : 0);
    if (d < distance) { target = pos; distance = d; }
  }
  if (!targetCache.has(terrain)) targetCache.set(terrain, new Map());
  targetCache.get(terrain)!.set(state.mapsCleared, target);
  return target;
}

export const OPERATION_RADIUS = 72;

export function operationOrders(state: SimState): string {
  const sector = operationSector(state);
  if (state.sectorCaptured) return 'Sector secured. Move every survivor through the north exit.';
  if (state.scheduler.phase === 'advance' && sector.holdSeconds) {
    return `Occupy the marked ${state.mapsCleared === 0 && state.terrain.bridges?.length ? 'bridgehead' : 'position'} with one unpinned soldier. Keep enemies out for ${sector.holdSeconds}s (${Math.floor(state.captureTicks / CONFIG.tickRate)}/${sector.holdSeconds}s).`;
  }
  return `${sector.title}: repel ${sector.waves} waves${sector.holdSeconds ? ', then occupy the marked position' : ', then extract every survivor north'}.`;
}
