import { CONFIG } from '../content/config';
import type { Building, TerrainEffects, Unit, Vec2, WeatherKind } from './types';

export function inRubble(buildings: readonly Building[], pos: Vec2, cell: number): boolean {
  return buildings.some((b) => b.destroyed && pos.x >= b.pos.x && pos.y >= b.pos.y && pos.x <= b.pos.x + b.cols * cell && pos.y <= b.pos.y + b.rows * cell);
}

/** Wet soft ground disproportionately hinders vehicles; roads remain valuable. */
export function weatherGroundEffects(effects: TerrainEffects, weather: WeatherKind, vehicle: boolean, rubble: boolean): TerrainEffects {
  const wetness = CONFIG.weather[weather].rainIntensity;
  const soft = effects === CONFIG.terrain.effects.mud || effects === CONFIG.terrain.effects.river || effects === CONFIG.terrain.effects.rapids;
  if (!rubble && (!soft || wetness <= 0)) return effects;
  return { ...effects, speedMult: effects.speedMult * (soft ? 1 - wetness * (vehicle ? .35 : .15) : 1) * (rubble ? vehicle ? .65 : .8 : 1), reloadMult: effects.reloadMult * (soft ? 1 + wetness * .12 : 1) };
}

export function landmarkHint(building: Building): string {
  if (building.destroyed) return 'Rubble gives infantry small-arms cover, but slows infantry by 20% and vehicles by 35%. It no longer blocks sight. Ruins cannot be repaired.';
  const role = building.kind === 'church' ? 'The tower is a useful observation post; a scout observing from an elevated position reaches 620px before weather and darkness.'
    : building.kind === 'barn' ? 'A broad defensive anchor with several firing positions; leave room for troops to reach its entrance.'
      : building.kind === 'castle' ? 'A durable strongpoint with elevated firing positions; keep an escape route ready if it comes under sustained shelling.'
        : 'Windows provide cover and defined firing sectors; keep the entrance accessible for relief and evacuation.';
  return `${role} A collapse can kill occupants or leave them critically wounded. Engineers can repair standing structures from within 160px of their center.`;
}

export function localShelter(unit: Unit | undefined): boolean { return !!unit?.buildingPosition; }
