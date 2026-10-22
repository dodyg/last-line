import { dayNightAtTick } from './daynight';
import type { SimState, Unit, Vec2 } from './types';

/** Shared by the command and HUD so unavailable actions explain why. */
export function campfireError(state: SimState, unit: Unit | undefined): string | null {
  if (!unit || unit.team !== 'friendly' || unit.dead || unit.health <= 0 || unit.crossed) return 'Select one living soldier on the battlefield.';
  if (unit.role === 'gun_truck' || unit.role === 'vehicle') return 'Only infantry can light a fire.';
  if (!dayNightAtTick(state.ticks, state.dayNightStartTick).night) return 'Small fires can only be lit at night.';
  if (unit.pinned) return 'Pinned soldiers cannot light a fire.';
  if (unit.buildingPosition || unit.buildingOrder) return 'Leave the building before lighting a fire.';
  if (state.campfires.some((fire) => fire.unitId === unit.id && fire.ticksRemaining > 0)) return 'This soldier already has a fire burning.';
  return null;
}

/** Firelight exposes soldiers of either army, unlike Allied illumination flares. */
export function campfireIlluminates(state: SimState, pos: Vec2): boolean {
  return dayNightAtTick(state.ticks, state.dayNightStartTick).night
    && state.campfires.some((fire) => fire.ticksRemaining > 0 && Math.hypot(fire.pos.x - pos.x, fire.pos.y - pos.y) <= fire.radius);
}
