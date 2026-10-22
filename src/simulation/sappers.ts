import { bridgeKey } from './bridges';
import type { DemolitionTarget, SimState, Vec2 } from './types';

export interface DemolitionSite {
  target: DemolitionTarget;
  label: string;
  pos: Vec2;
  approaches: Vec2[];
  priority: number;
}

/** Work from the live structure lists: destroyed targets cannot attract a team. */
export function demolitionSites(state: SimState): DemolitionSite[] {
  const sites: DemolitionSite[] = [];
  const cell = state.terrain.cell;
  for (const bunker of state.bunkers) sites.push({ target: { kind: 'bunker', id: bunker.id },
    label: 'bunker', pos: { ...bunker.pos }, priority: 2,
    approaches: [{ x: bunker.pos.x, y: bunker.pos.y - 36 }, { x: bunker.pos.x - 36, y: bunker.pos.y },
      { x: bunker.pos.x + 36, y: bunker.pos.y }, { x: bunker.pos.x, y: bunker.pos.y + 36 }] });
  for (const building of state.buildings) {
    if (building.destroyed || !state.units.some((unit) => unit.team === 'friendly' && unit.health > 0 && !unit.dead && !unit.crossed
      && unit.buildingPosition?.buildingId === building.id)) continue;
    const w = building.cols * cell, h = building.rows * cell;
    const pos = { x: building.pos.x + w / 2, y: building.pos.y + h / 2 };
    const approaches: Vec2[] = [];
    for (let offset = cell / 2; offset < w; offset += cell) {
      approaches.push({ x: building.pos.x + offset, y: building.pos.y - cell / 2 },
        { x: building.pos.x + offset, y: building.pos.y + h + cell / 2 });
    }
    for (let offset = cell / 2; offset < h; offset += cell) {
      approaches.push({ x: building.pos.x - cell / 2, y: building.pos.y + offset },
        { x: building.pos.x + w + cell / 2, y: building.pos.y + offset });
    }
    sites.push({ target: { kind: 'building', id: building.id }, label: building.name, pos, approaches, priority: 3 });
  }
  for (const bridge of state.terrain.bridges ?? []) {
    const horizontal = bridge.axis === 'horizontal';
    sites.push({ target: { kind: 'bridge', key: bridgeKey(bridge) }, label: bridge.type === 'pontoon' ? 'pontoon bridge' : 'bridge',
      pos: { x: bridge.x, y: bridge.y }, priority: 1,
      // Place explosives at an abutment so cutters never switch bridge levels.
      approaches: [-1, 1].map((sign) => ({ x: bridge.x + (horizontal ? sign * (bridge.halfLength + cell / 2) : 0),
        y: bridge.y + (horizontal ? 0 : sign * (bridge.halfLength + cell / 2)) })) });
  }
  return sites;
}

export function sameDemolitionTarget(a: DemolitionTarget, b: DemolitionTarget): boolean {
  return a.kind === 'bridge' ? b.kind === 'bridge' && a.key === b.key : b.kind === a.kind && a.id === b.id;
}

/** An armed charge still damages a building if its garrison has evacuated. */
export function demolitionTargetExists(state: SimState, target: DemolitionTarget): boolean {
  if (target.kind === 'building') return state.buildings.some((building) => building.id === target.id && !building.destroyed);
  if (target.kind === 'bunker') return state.bunkers.some((bunker) => bunker.id === target.id);
  return (state.terrain.bridges ?? []).some((bridge) => bridgeKey(bridge) === target.key);
}
