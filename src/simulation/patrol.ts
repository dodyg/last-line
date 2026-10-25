import { CONFIG } from '../content/config';
import { findPath } from './navigation';
import type { PatrolArea, Terrain, Vec2 } from './types';

export function isPatrolRole(role: string): boolean {
  return role === 'scout' || role === 'rifleman' || role === 'sniper' || role === 'medic';
}

export function patrolArea(from: Vec2, to: Vec2): PatrolArea {
  return { min: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y) },
    max: { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y) } };
}

export function insidePatrolArea(area: PatrolArea, point: Vec2): boolean {
  return point.x >= area.min.x && point.x <= area.max.x && point.y >= area.min.y && point.y <= area.max.y;
}

export function validPatrolArea(area: PatrolArea): boolean {
  return [area.min.x, area.min.y, area.max.x, area.max.y].every(Number.isFinite)
    && area.min.x >= 4 && area.min.y >= 4 && area.max.x <= CONFIG.field.width - 4 && area.max.y <= CONFIG.field.height - 4
    && area.max.x - area.min.x >= 48 && area.max.y - area.min.y >= 48;
}

/** Use the existing navigation and bridge rules, with cells outside the area closed. */
export function patrolTerrain(terrain: Terrain, area: PatrolArea): Terrain {
  const blocked = terrain.blocked.slice();
  for (let i = 0; i < blocked.length; i++) {
    const point = { x: (i % terrain.cols + .5) * terrain.cell, y: (Math.floor(i / terrain.cols) + .5) * terrain.cell };
    if (!insidePatrolArea(area, point)) blocked[i] = 1;
  }
  return { ...terrain, blocked };
}

/** Corner stations move onto nearby open ground, with every leg confined to the area. */
export function patrolPoints(terrain: Terrain, area: PatrolArea): Vec2[] | null {
  const bounded = patrolTerrain(terrain, area), cells: Vec2[] = [];
  for (let i = 0; i < bounded.blocked.length; i++) {
    if (bounded.blocked[i] === 0) cells.push({ x: (i % terrain.cols + .5) * terrain.cell, y: (Math.floor(i / terrain.cols) + .5) * terrain.cell });
  }
  if (cells.length < 2) return null;
  const corners = [area.min, { x: area.max.x, y: area.min.y }, area.max, { x: area.min.x, y: area.max.y }];
  const points: Vec2[] = [];
  for (const corner of corners) {
    const closest = cells.reduce((a, b) => Math.hypot(a.x - corner.x, a.y - corner.y) <= Math.hypot(b.x - corner.x, b.y - corner.y) ? a : b);
    if (!points.some((point) => point.x === closest.x && point.y === closest.y)) points.push(closest);
  }
  if (points.length < 2) return null;
  return points.every((point, i) => findPath(bounded, point, points[(i + 1) % points.length]!).reachable) ? points : null;
}
