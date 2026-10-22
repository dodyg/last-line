import type { LandscapeRoad } from '../simulation/terrain';

export interface RoadBasePass {
  layer: 'shoulder' | 'surface';
  road: LandscapeRoad;
  width: number;
  color: number;
  alpha: 1;
}

/**
 * Draw the whole network as an opaque union: shoulders first, road surfaces
 * second. Since every road in a layout shares its material, overlapping strokes
 * become idempotent and cannot leave a dark, translucent knot at a junction.
 */
export function roadBasePasses(roads: readonly LandscapeRoad[]): RoadBasePass[] {
  return [
    ...roads.map((road): RoadBasePass => ({
      layer: 'shoulder', road, width: road.halfWidth * 2 + 8, color: 0x514a3b, alpha: 1,
    })),
    ...roads.map((road): RoadBasePass => ({
      layer: 'surface',
      road,
      width: road.halfWidth * 2,
      color: road.surface === 'cobble' ? 0x908570 : 0x89734e,
      alpha: 1,
    })),
  ];
}
