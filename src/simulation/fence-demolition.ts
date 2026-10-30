import { CONFIG } from '../content/config';
import { TERRAIN_KIND } from './terrain';
import type { SimState, Unit, Vec2 } from './types';

export const FENCE_DEMOLITION_RANGE = 64;

export function fenceDemolitionError(state: SimState, unit: Unit | undefined, pos?: Vec2): string | null {
  if (!unit || unit.team !== 'friendly' || unit.role !== 'engineer' || unit.dead || unit.health <= 0 || unit.crossed) {
    return 'Select one living Combat Support Engineer on the battlefield.';
  }
  if (unit.pinned) return 'Pinned engineers cannot demolish fences.';
  if (unit.buildingPosition || unit.buildingOrder) return 'Leave the building before demolishing a fence.';
  if ((unit.upgradeTimer ?? 0) > 0 || state.constructionSites.some((site) => site.builderId === unit.id)) return 'This engineer is busy.';
  if (!pos) return null;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x < 0 || pos.y < 0
    || pos.x >= CONFIG.field.width || pos.y >= CONFIG.field.height) return 'Choose a fence inside the battlefield.';
  const terrain = state.terrain;
  const col = Math.floor(pos.x / terrain.cell), row = Math.floor(pos.y / terrain.cell);
  const kind = terrain.kinds?.[row * terrain.cols + col];
  if (kind !== TERRAIN_KIND.woodFence && kind !== TERRAIN_KIND.stoneFence) return 'Choose a wood rail or fieldstone fence section.';
  const center = { x: (col + .5) * terrain.cell, y: (row + .5) * terrain.cell };
  if (Math.hypot(unit.pos.x - center.x, unit.pos.y - center.y) > FENCE_DEMOLITION_RANGE) {
    return `Move the engineer within ${FENCE_DEMOLITION_RANGE}px of the fence section.`;
  }
  return null;
}
