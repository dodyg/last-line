import { CONFIG } from '../content/config';
import { soldierAttributeMultiplier } from './soldiers';
import type { Unit } from './types';

export function isInfantry(unit: Unit): boolean {
  return unit.role !== 'vehicle' && unit.role !== 'gun_truck' && unit.role !== 'troop_transport';
}

export function canRun(unit: Unit): boolean {
  return isInfantry(unit) && !['at_gun','heavy_mg','mg_team'].includes(unit.role) && !unit.pinned && !unit.buildingPosition
    && !unit.terrainCrawling && !unit.crawling && (unit.stance ?? 'standing') === 'standing'
    && (unit.stamina ?? 1) > 0;
}

/** Spend endurance only on actual running; walking and holding recover it. */
export function updateStamina(unit: Unit): void {
  if (!isInfantry(unit) || unit.dead || unit.health <= 0 || unit.crossed) { unit.running = false; return; }
  const moved = Math.hypot(unit.pos.x - unit.prevPos.x, unit.pos.y - unit.prevPos.y) > .0001;
  const tuning = CONFIG.infantryMovement;
  if (unit.running && moved) {
    unit.stamina = Math.max(0, (unit.stamina ?? 1) - 1 / (tuning.runSeconds * CONFIG.tickRate * soldierAttributeMultiplier(unit, 'endurance')));
    if (unit.stamina < 1e-9) { unit.stamina = 0; unit.movementPace = 'walk'; unit.running = false; }
  } else {
    unit.running = false;
    unit.stamina = Math.min(1, (unit.stamina ?? 1) + soldierAttributeMultiplier(unit, 'strength') / ((moved ? tuning.walkingRecoverySeconds : tuning.restingRecoverySeconds) * CONFIG.tickRate));
  }
  if (unit.pinned || unit.crawling || (unit.stance ?? 'standing') !== 'standing' || unit.buildingPosition
    || (unit.buildingOrder && !unit.path.length)
    || (moved && !unit.path.length) || (unit.team === 'enemy' && !unit.running)) unit.movementPace = 'walk';
}
