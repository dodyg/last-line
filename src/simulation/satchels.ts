import { CONFIG } from '../content/config';
import type { SimState, Unit, Vec2 } from './types';

/** Shared by commands, the selection button, and the placement preview. */
export function satchelError(state: SimState, unit: Unit | undefined, pos?: Vec2): string | null {
  if (!unit || unit.team !== 'friendly' || unit.role !== 'engineer' || unit.dead || unit.health <= 0 || unit.crossed) {
    return 'Select one living Combat Support Engineer on the battlefield.';
  }
  if (unit.pinned) return 'Pinned engineers cannot plant satchel charges.';
  if (unit.buildingPosition || unit.buildingOrder) return 'Leave the building before planting a satchel charge.';
  if ((unit.upgradeTimer ?? 0) > 0 || state.constructionSites.some((site) => site.builderId === unit.id)) return 'This engineer is busy.';
  if (state.satchelCharges.some((charge) => charge.unitId === unit.id)) return 'This engineer already has a satchel fuse burning.';
  if (state.points < CONFIG.satchel.cost) return `Satchel charges cost ${CONFIG.satchel.cost} points.`;
  if (pos) {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x < 4 || pos.y < 4
      || pos.x > CONFIG.field.width - 4 || pos.y > CONFIG.field.height - 4) return 'Plant satchel charges inside the battlefield.';
    if (Math.hypot(unit.pos.x - pos.x, unit.pos.y - pos.y) > CONFIG.satchel.placementRange) {
      return `Plant within ${CONFIG.satchel.placementRange}px of the engineer.`;
    }
    const { terrain } = state;
    const cell = Math.floor(pos.y / terrain.cell) * terrain.cols + Math.floor(pos.x / terrain.cell);
    if (terrain.blocked[cell]) return 'Plant on open ground beside the target.';
  }
  return null;
}
