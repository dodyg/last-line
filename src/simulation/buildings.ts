import type { Building, BuildingFacing, BuildingLevel, BuildingPosition, Terrain, Unit, Vec2 } from './types';
import { elevationAt } from './elevation';
import { bridgeFootHeight } from './bridges';

export const FLOOR_HEIGHT = 20;
export const BUILDING_FACINGS: readonly BuildingFacing[] = ['north', 'east', 'south', 'west'];

/** Slots run clockwise from the north facade; balconies are on the south. */
export function positionFacing(position: Pick<BuildingPosition, 'level' | 'slot'>): BuildingFacing {
  return position.level === 'balcony' ? 'south' : BUILDING_FACINGS[Math.floor(position.slot / 2)]!;
}

export function fightingPositionLabel(level: BuildingLevel, facing?: BuildingFacing): string {
  if (level === 'roof') return 'Rooftop · all directions';
  if (typeof level === 'number' && facing === undefined) return levelLabel(level);
  const side = level === 'balcony' ? 'south' : facing;
  const direction = side ? side[0]!.toUpperCase() + side.slice(1) : '';
  return level === 'balcony' ? 'Balcony · South-facing' : `Floor ${level + 1} · ${direction}-facing windows`;
}

export function fightingPositionOptions(building: Building): { value: string; label: string }[] {
  return buildingLevels(building).flatMap((level) => typeof level === 'number'
    ? BUILDING_FACINGS.map((facing) => ({ value: `${level}:${facing}`, label: fightingPositionLabel(level, facing) }))
    : [{ value: level, label: fightingPositionLabel(level) }]);
}

export function fightingPositionValue(position: BuildingPosition): string {
  return typeof position.level === 'number' ? `${position.level}:${positionFacing(position)}` : position.level;
}

/** Architecture is derived without consuming the combat or map RNG. */
export function buildingArchitecture(building: Building) {
  const variant = Math.abs(Math.floor(building.pos.x / 24) + Math.floor(building.pos.y / 24));
  const civic = ['castle', 'hospital', 'school'].includes(building.kind);
  const floors = building.floors ?? (building.kind === 'barn' ? 1 : civic ? 3 : 2 + variant % 2);
  const roofStyle = building.roofStyle ?? (civic || variant % 2 === 0 ? 'flat' : 'pitched');
  return {
    floors, roofStyle,
    rooftopAccess: building.rooftopAccess ?? roofStyle === 'flat',
    balcony: building.balcony ?? (!['barn', 'church', 'castle'].includes(building.kind) && floors > 1),
  };
}

export function buildingLevels(building: Building): BuildingLevel[] {
  const a = buildingArchitecture(building);
  return [...Array.from({ length: a.floors }, (_, i) => i), ...(a.balcony ? ['balcony' as const] : []), ...(a.rooftopAccess ? ['roof' as const] : [])];
}

export function levelLabel(level: BuildingLevel): string {
  return level === 'roof' ? 'Rooftop' : level === 'balcony' ? 'Balcony' : `Floor ${level + 1} · windows`;
}

export function positionHeight(building: Building, level: BuildingLevel): number {
  return level === 'roof' ? buildingArchitecture(building).floors * FLOOR_HEIGHT + 2
    : level === 'balcony' ? FLOOR_HEIGHT : level * FLOOR_HEIGHT;
}

export function positionCapacity(level: BuildingLevel): number { return level === 'balcony' ? 2 : 8; }

export function containsBuilding(building: Building, pos: Vec2, cell: number): boolean {
  return pos.x >= building.pos.x && pos.x < building.pos.x + building.cols * cell
    && pos.y >= building.pos.y && pos.y < building.pos.y + building.rows * cell;
}

/** Two firing slots on each facade; roof slots sit behind the parapet. */
export function buildingSlot(building: Building, position: BuildingPosition, cell: number): Vec2 {
  const w = building.cols * cell, h = building.rows * cell;
  const slot = position.slot % 8, side = Math.floor(slot / 2), fraction = slot % 2 === 0 ? .28 : .72;
  const inset = position.level === 'roof' ? 7 : -2;
  const x = building.pos.x, y = building.pos.y;
  if (position.level === 'balcony') return { x: x + w * fraction, y: y + h + 6 };
  if (side === 0) return { x: x + w * fraction, y: y + inset };
  if (side === 1) return { x: x + w - inset, y: y + h * fraction };
  if (side === 2) return { x: x + w * fraction, y: y + h - inset };
  return { x: x + inset, y: y + h * fraction };
}

export function unitBuildingHeight(terrain: Terrain, unit: Unit): number {
  const p = unit.buildingPosition;
  const building = p && terrain.buildings?.find((b) => b.id === p.buildingId && !b.destroyed);
  if (!building || !p) return bridgeFootHeight(terrain, unit) - elevationAt(terrain, unit.pos.x, unit.pos.y);
  const center = { x: building.pos.x + building.cols * terrain.cell / 2, y: building.pos.y + building.rows * terrain.cell / 2 };
  return elevationAt(terrain, center.x, center.y) - elevationAt(terrain, unit.pos.x, unit.pos.y) + positionHeight(building, p.level);
}

export function unitEyeHeight(terrain: Terrain, unit: Unit): number {
  return unitBuildingHeight(terrain, unit) + (unit.terrainCrawling || unit.stance === 'prone' ? 4 : unit.stance === 'crouching' ? 8 : 12);
}
