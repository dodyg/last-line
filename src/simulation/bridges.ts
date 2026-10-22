import { elevationAt } from './elevation';
import type { BridgePosition, BridgeSurface, Terrain, Unit, Vec2 } from './types';

export const BRIDGE = { raisedHeight: 30, lowHeight: 3, thickness: 3, infantryClearance: 19 } as const;
export const bridgeKey = (bridge: Pick<BridgeSurface, 'x' | 'y' | 'axis'>): string => `${bridge.x}:${bridge.y}:${bridge.axis}`;
export const bridgeLocal = (bridge: BridgeSurface, pos: Vec2): { along: number; across: number } => bridge.axis === 'horizontal'
  ? { along: pos.x - bridge.x, across: pos.y - bridge.y } : { along: pos.y - bridge.y, across: pos.x - bridge.x };
export const bridgeContains = (bridge: BridgeSurface, pos: Vec2): boolean => {
  const p = bridgeLocal(bridge, pos);
  return Math.abs(p.along) <= bridge.halfLength && Math.abs(p.across) <= bridge.halfWidth;
};
export const bridgeRampLength = (bridge: BridgeSurface): number => Math.min(36, bridge.halfLength * .5);
export function bridgeDeckHeight(bridge: BridgeSurface, pos: Vec2): number {
  if (bridge.type === 'pontoon') return BRIDGE.lowHeight;
  return BRIDGE.raisedHeight * Math.min(1, Math.max(0, (bridge.halfLength - Math.abs(bridgeLocal(bridge, pos).along)) / bridgeRampLength(bridge)));
}

/** Record whether the segment enters/exits through a road end or a side. */
function crossing(bridge: BridgeSurface, from: Vec2, to: Vec2) {
  const a = bridgeLocal(bridge, from), b = bridgeLocal(bridge, to);
  let entry = 0, exit = 1, entryEnd = true, exitEnd = true;
  for (const [start, delta, extent, end] of [[a.along, b.along - a.along, bridge.halfLength, true], [a.across, b.across - a.across, bridge.halfWidth, false]] as const) {
    if (Math.abs(delta) < 1e-9) { if (Math.abs(start) > extent) return null; continue; }
    let low = (-extent - start) / delta, high = (extent - start) / delta;
    if (low > high) [low, high] = [high, low];
    if (low > entry) { entry = low; entryEnd = end; }
    if (high < exit) { exit = high; exitEnd = end; }
    if (entry > exit) return null;
  }
  if (exit < 0 || entry > 1) return null;
  return { entry: Math.max(0, entry), exit: Math.min(1, exit), entryEnd, exitEnd };
}

/** Rails and abutments separate the two routes. Only infantry fit below. */
export function bridgeTraversal(terrain: Terrain, from: Vec2, to: Vec2, current?: BridgePosition, mode: 'infantry' | 'vehicle' = 'infantry'): { allowed: boolean; position?: BridgePosition } {
  let position: BridgePosition | undefined;
  for (const bridge of terrain.bridges ?? []) {
    const hit = crossing(bridge, from, to);
    if (!hit) continue;
    const key = bridgeKey(bridge), startsInside = bridgeContains(bridge, from), endsInside = bridgeContains(bridge, to);
    const level = startsInside ? current?.key === key ? current.level : 'deck' : hit.entryEnd ? 'deck' : 'under';
    if (level === 'deck' && !endsInside && !hit.exitEnd) return { allowed: false };
    if (level === 'under') {
      if (mode === 'vehicle' || (!endsInside && hit.exitEnd)) return { allowed: false };
      for (const t of [hit.entry, hit.exit]) {
        const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        if (bridgeDeckHeight(bridge, point) - BRIDGE.thickness < BRIDGE.infantryClearance) return { allowed: false };
      }
    }
    if (endsInside) position = { key, level };
  }
  return { allowed: true, position };
}

export function unitBridge(terrain: Terrain, unit: Unit): BridgeSurface | undefined {
  const p = unit.bridgePosition;
  return p ? terrain.bridges?.find((bridge) => bridgeKey(bridge) === p.key && bridgeContains(bridge, unit.pos)) : undefined;
}

export function bridgeFootHeight(terrain: Terrain, unit: Unit): number {
  const bridge = unitBridge(terrain, unit);
  return bridge && unit.bridgePosition?.level === 'deck'
    ? elevationAt(terrain, bridge.x, bridge.y) + bridgeDeckHeight(bridge, unit.pos) : elevationAt(terrain, unit.pos.x, unit.pos.y);
}

/** Keep fire from crossing the solid slab between upper and lower routes. */
export function bridgesBlockSight(terrain: Terrain, from: Vec2, to: Vec2, fromEye: number, toEye: number): boolean {
  for (const bridge of terrain.bridges ?? []) {
    const hit = crossing(bridge, from, to);
    if (!hit) continue;
    const startHeight = elevationAt(terrain, from.x, from.y) + fromEye, endHeight = elevationAt(terrain, to.x, to.y) + toEye;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * (hit.exit - hit.entry) / 2));
    let previous: number | undefined;
    for (let step = 0; step <= steps; step++) {
      const t = hit.entry + (hit.exit - hit.entry) * step / steps;
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      const relative = startHeight + (endHeight - startHeight) * t - elevationAt(terrain, bridge.x, bridge.y) - bridgeDeckHeight(bridge, point);
      if ((relative <= 0 && relative >= -BRIDGE.thickness)
        || (previous !== undefined && ((previous > 0 && relative < -BRIDGE.thickness) || (relative > 0 && previous < -BRIDGE.thickness)))) return true;
      previous = relative;
    }
  }
  return false;
}
