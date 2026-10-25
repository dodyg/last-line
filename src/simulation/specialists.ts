import { CONFIG } from '../content/config';
import type { Unit, Vec2 } from './types';

export function crewTuning(unit: Pick<Unit, 'role'>) {
  if (unit.role === 'at_gun') return { setupSeconds: 4, packSeconds: 3, arc: 50, turnRate: .35 };
  if (unit.role === 'heavy_mg' || unit.role === 'mg_team') return { setupSeconds: 3, packSeconds: 2, arc: 70, turnRate: .6 };
  return null;
}
export function crewArcContains(unit: Unit, point: Vec2): boolean {
  const tuning = crewTuning(unit);
  if (!tuning || !unit.deployment) return true;
  const bearing = Math.atan2(point.y-unit.pos.y, point.x-unit.pos.x);
  const angle = Math.atan2(Math.sin(bearing-unit.deployment.facing), Math.cos(bearing-unit.deployment.facing));
  return Math.abs(angle) <= tuning.arc * Math.PI / 360;
}
export function updateCrew(unit: Unit, target: Unit | null, moved: boolean): boolean {
  const tuning = crewTuning(unit);
  if (!tuning) return true;
  const setup = Math.round(tuning.setupSeconds * CONFIG.tickRate);
  const deployment = unit.deployment ??= { ticks: setup, facing: unit.team === 'friendly' ? -Math.PI/2 : Math.PI/2, packingTicks: 0 };
  if (moved || unit.path.length > 0 || unit.pinned) { deployment.ticks = setup; unit.burstRemaining = 0; return false; }
  if (target && !crewArcContains(unit, target.pos)) {
    const bearing = Math.atan2(target.pos.y-unit.pos.y, target.pos.x-unit.pos.x);
    const angle = Math.atan2(Math.sin(bearing-deployment.facing), Math.cos(bearing-deployment.facing));
    deployment.facing += Math.sign(angle) * Math.min(Math.abs(angle), tuning.turnRate / CONFIG.tickRate);
    deployment.ticks = setup; unit.burstRemaining = 0; return false;
  }
  if (deployment.packingTicks > 0) return false;
  deployment.ticks = Math.max(0, deployment.ticks-1);
  return deployment.ticks === 0;
}
export function specialistPriority(shooter: Unit, target: Unit): number {
  if (shooter.role === 'at_gun') return ['vehicle','gun_truck','troop_transport'].includes(target.role) ? .1 : 2;
  if (shooter.role === 'sharpshooter') return ['medic','radio_engineer','supply_officer','officer','mortarman','scout'].includes(target.role) ? .2 : 1;
  return 1;
}
