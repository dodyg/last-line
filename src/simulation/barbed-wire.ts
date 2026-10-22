import { CONFIG } from '../content/config';
import type { BarbedWire, Vec2 } from './types';

/** Wire is a movement hazard, never a solid navigation or sight obstacle. */
export function wireContains(wire: BarbedWire, pos: Vec2, padding = 0): boolean {
  return Math.abs(wire.pos.x - pos.x) <= CONFIG.barbedWire.halfLength + padding
    && Math.abs(wire.pos.y - pos.y) <= CONFIG.barbedWire.halfDepth + padding;
}

export function wireDistance(wire: BarbedWire, pos: Vec2): number {
  return Math.hypot(Math.max(0, Math.abs(wire.pos.x - pos.x) - CONFIG.barbedWire.halfLength),
    Math.max(0, Math.abs(wire.pos.y - pos.y) - CONFIG.barbedWire.halfDepth));
}
