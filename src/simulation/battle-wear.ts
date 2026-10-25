import { CONFIG } from '../content/config';
import { isRiverAt, type TerrainData } from './terrain';
import { bridgeContains } from './bridges';
import type { SimState, Vec2 } from './types';

export const MAX_VEHICLE_TRACKS = 256;
export interface VehicleTrack { unitId: number; from: Vec2; to: Vec2; tick: number; }

/** Cosmetic history uses no combat randomness or entity IDs. */
export function recordVehicleTracks(state: SimState, zones: TerrainData['zones']): void {
  const tracks = state.vehicleTracks ??= [];
  for (const unit of state.units) {
    if (unit.dead || unit.health <= 0 || unit.crossed || !['vehicle', 'gun_truck', 'troop_transport'].includes(unit.role)) continue;
    const dx = unit.pos.x - unit.prevPos.x, dy = unit.pos.y - unit.prevPos.y, distance = Math.hypot(dx, dy);
    if (distance < .01 || distance > 8) continue;
    const points = [unit.prevPos, { x: (unit.prevPos.x + unit.pos.x) / 2, y: (unit.prevPos.y + unit.pos.y) / 2 }, unit.pos];
    const nx = -dy / distance, ny = dx / distance;
    const footprint = points.flatMap((point) => [-7, 0, 7].map((offset) => ({ x: point.x + nx * offset, y: point.y + ny * offset })));
    if (footprint.some((point) => point.x < 0 || point.y < 0 || point.x >= CONFIG.field.width || point.y >= CONFIG.field.height
      || isRiverAt(zones, state.seed, point.x, point.y)
      || state.terrain.bridges?.some((bridge) => bridgeContains(bridge, point)))) continue;
    let last: VehicleTrack | undefined;
    for (let i = tracks.length - 1; i >= 0; i--) if (tracks[i]!.unitId === unit.id) { last = tracks[i]; break; }
    if (last && Math.hypot(last.to.x - unit.prevPos.x, last.to.y - unit.prevPos.y) < 1
      && Math.hypot(unit.pos.x - last.from.x, unit.pos.y - last.from.y) < 24) {
      const lx = last.to.x - last.from.x, ly = last.to.y - last.from.y;
      if ((lx * dx + ly * dy) / Math.max(.0001, Math.hypot(lx, ly) * distance) > .985) {
        last.to = { ...unit.pos }; last.tick = state.ticks; continue;
      }
    }
    tracks.push({ unitId: unit.id, from: { ...unit.prevPos }, to: { ...unit.pos }, tick: state.ticks });
  }
  if (tracks.length > MAX_VEHICLE_TRACKS) tracks.splice(0, tracks.length - MAX_VEHICLE_TRACKS);
}
