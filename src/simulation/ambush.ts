import { CONFIG } from '../content/config';
import type { AmbushOrder, Unit, Vec2 } from './types';

export const AMBUSH_ARCS = [45, 90, 120] as const;

export function supportsAmbush(unit: Pick<Unit, 'team' | 'role'>): boolean {
  return unit.team === 'friendly' && !['medic', 'mortarman', 'gun_truck', 'vehicle', 'troop_transport'].includes(unit.role);
}

/** The clicked point determines facing and range independently for each soldier. */
export function ambushShape(origin: Vec2, aim: Vec2, weaponRange: number, arcDegrees: number): Pick<AmbushOrder, 'facing' | 'range' | 'arcDegrees'> {
  return { facing: Math.atan2(aim.y - origin.y, aim.x - origin.x), arcDegrees,
    range: Math.max(CONFIG.ambush.minRange, Math.min(CONFIG.ambush.maxRange, weaponRange, Math.hypot(aim.x - origin.x, aim.y - origin.y))) };
}

export function insideAmbushArc(origin: Vec2, order: Pick<AmbushOrder, 'facing' | 'range' | 'arcDegrees'>, point: Vec2): boolean {
  const dx = point.x - origin.x, dy = point.y - origin.y, distance = Math.hypot(dx, dy);
  return distance <= order.range + 1e-7 && (distance < 1e-7
    || (dx * Math.cos(order.facing) + dy * Math.sin(order.facing)) / distance >= Math.cos(order.arcDegrees * Math.PI / 360) - 1e-7);
}
