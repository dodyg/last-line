import { CONFIG } from '../content/config';
import type { Building, BuildingKind, CampaignCountry, Season, Terrain, TerrainEffects, Vec2, WeatherKind } from './types';
import { seasonForSeed } from './seasons';
import { buildingArchitecture, containsBuilding, FLOOR_HEIGHT } from './buildings';
import { elevationAt } from './elevation';
import { CAMPAIGNS, LOCAL_BUILDING_NAMES, campaignSectorForSeed, type LocalLanguage } from '../content/campaigns';
import { deriveRng, rngInt, rngNext, rngPick, rngRange, rngShuffle, type RngState } from './rng';
import { elevationLineOfSight, generateElevation } from './elevation';

/**
 * Deterministic European landscapes. Roads establish frontage, field parcels,
 * river crossings, and vegetation boundaries before combat clutter is placed.
 * Protected approach/deployment strips and clear routes preserve connectivity.
 * The original pattern generator remains available for existing saves.
 */

type Pattern = readonly string[];

/** A soft-ground area: passable everywhere, but costly to be caught in. */
export interface TerrainZone {
  cx: number;
  cy: number;
  halfLength: number;
  halfWidth: number;
  /** Present on irregular mud in current landscapes; older maps keep their bounds. */
  shapeSeed?: number;
  /** River axis; omitted on mud and on saved rivers from before orientation support. */
  orientation?: 'horizontal' | 'vertical' | 'diagonal';
  /** Slope of diagonal channels in map coordinates (y increases southward). */
  diagonalSlope?: -1 | 1;
  /** Side streams that join the main river; absent on old saves and on mud. */
  branches?: RiverBranch[];
}

export interface RiverBranch {
  points: Vec2[];
  halfWidth: number;
}

export type RiverBridgeType = 'timber' | 'stone' | 'bailey' | 'pontoon';

export interface RiverBridge {
  x: number;
  y: number;
  /** Road axis running along the deck. */
  axis: 'horizontal' | 'vertical';
  type: RiverBridgeType;
  /** Half-width of the deck along the river bank. */
  halfWidth: number;
  /** Half-length spanning from bank to bank. */
  halfLength: number;
}

interface RiverRapid {
  cx: number;
  halfLength: number;
}

// 'X' = solid cell. Trees/rocks/ruins drawn by the renderer from cell kind.
const PATTERNS: readonly { cells: Pattern; kind: number }[] = [
  { cells: [' X ', 'XXX', ' X '], kind: 11 }, // English oak grove
  { cells: ['XX', 'XX', ' X'], kind: 12 }, // European beech stand
  { cells: ['X X', 'XXX', 'X X'], kind: 13 }, // silver birch stand
  { cells: [' X ', 'XXX', ' X '], kind: 14 }, // Scots pine grove
  { cells: ['XX.X', 'X..X'], kind: 2 }, // rock ridge
  { cells: ['.XX.', 'XXXX'], kind: 3 }, // ruin block
  { cells: ['X', 'X', 'X'], kind: 2 }, // boulder line
  { cells: ['.X.', 'XXX', '.X.'], kind: 1 }, // thicket
  { cells: ['XXXX'], kind: 8 }, // low fieldstone fence
  { cells: ['X', 'X', 'X', 'X'], kind: 8 }, // fieldstone fence, turned
];

const GROVE_SHAPES: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1]],
  [[0, 0], [1, 0], [2, 0], [1, 1], [2, 1], [3, 1]],
  [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2], [3, 2]],
  [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
  [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1], [2, 2]],
];

/** Per-cell visual kind written into `TerrainData.kinds`. */
export const TERRAIN_KIND = {
  open: 0,
  trees: 1,
  rocks: 2,
  ruins: 3,
  obstacle: 4,
  river: 5,
  mud: 6,
  /**
   * The footprint a building stands on. Solid while the building stands, and a
   * walkable ruin once it is destroyed - which is why the renderer draws the
   * wreckage for it rather than treating the cell as scenery.
   */
  building: 7,
  stoneFence: 8,
  rapids: 9,
  bridge: 10,
  oak: 11,
  beech: 12,
  birch: 13,
  pine: 14,
  road: 15,
  crops: 16,
  orchard: 17,
  farmyard: 18,
  fruitTree: 19,
  shrub: 20,
  tallGrass: 21,
  wildflower: 22,
  woodFence: 23,
} as const;

/** Foliage is passable, but slows infantry and obscures shots. */
export function isFoliageKind(kind: number): boolean {
  return kind === TERRAIN_KIND.trees || kind === TERRAIN_KIND.oak || kind === TERRAIN_KIND.beech
    || kind === TERRAIN_KIND.birch || kind === TERRAIN_KIND.pine || kind === TERRAIN_KIND.fruitTree
    || kind === TERRAIN_KIND.shrub || kind === TERRAIN_KIND.tallGrass;
}

export function isDeciduousKind(kind: number): boolean {
  return kind === TERRAIN_KIND.oak || kind === TERRAIN_KIND.beech || kind === TERRAIN_KIND.birch || kind === TERRAIN_KIND.fruitTree;
}

export interface LandscapeRoad {
  points: Vec2[];
  halfWidth: number;
  surface: 'cobble' | 'dirt';
  /** Marks the circular carriageway whose centre is left open as a traffic island. */
  roundabout?: boolean;
}

export interface LandscapeField {
  col: number;
  row: number;
  cols: number;
  rows: number;
  crop: 'wheat' | 'ploughed' | 'pasture' | 'orchard';
  vertical: boolean;
}

export interface LandscapeLayout {
  label: string;
  archetype: 'village' | 'farm' | 'fields' | 'forest' | 'bocage';
  roads: LandscapeRoad[];
  fields: LandscapeField[];
}

/** A building the generator placed, before the simulation takes ownership of it. */
export interface GeneratedBuilding {
  kind: BuildingKind;
  name: string;
  /** Footprint in cells. */
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface TerrainData {
  season: Season;
  campaignCountry?: CampaignCountry;
  localLanguage?: LocalLanguage;
  layoutVersion?: 1 | 2 | 3;
  layout?: LandscapeLayout;
  terrain: Terrain;
  /** Per-cell terrain identity, including tree species, roads, crops, and yards. */
  kinds: Uint8Array;
  lanes: number[];
  /** Seed-derived battlefield dressing. Stable when a run is restored. */
  settingId: number;
  /** Weather is derived from the map seed, so it is stable across save/restore. */
  weather: WeatherKind;
  /**
   * The seed this battlefield was generated from. Terrain is regenerated rather
   * than persisted, so the seed is the identity of a map: when the simulation's
   * seed no longer matches, the rendered battlefield is stale.
   */
  seed: number;
  /**
   * The wadeable river and the mud patches, as areas. The blocked grid says what
   * cannot be walked on; these say what can be walked through and what it costs,
   * so both the movement and the combat penalty can be answered with one lookup.
   * `river` is null on a map that has no water: not every battlefield has one,
   * and a map without it plays as a faster, more open field.
   */
  zones: {
    river: TerrainZone | null;
    bridges: RiverBridge[];
    rapids: RiverRapid[];
    mud: TerrainZone[];
    roads?: LandscapeRoad[];
  };
  /**
   * Buildings placed on this map, in generation order. Their footprints are the
   * only cells that can become passable during a battle, so the blocked grid is
   * rebuilt from `baseBlocked` whenever one is destroyed.
   */
  buildings: GeneratedBuilding[];
}

export const BATTLEFIELD_SETTINGS = [
  'Normandy Bocage',
  'Orchard Farmland',
  'Village Outskirts',
  'Forest Road',
  'Rolling Farmland',
  'French Village',
] as const;

function settingForSeed(seed: number, country?: CampaignCountry): number {
  if (country !== undefined) return campaignSectorForSeed(country, seed).setting;
  return deriveRng(seed, 0x19440606).s % BATTLEFIELD_SETTINGS.length;
}

function verticalBandWeights(seed: number, salt: number): number[] {
  const rng = deriveRng(seed, salt);
  return [0, 1, 2].map(() => 0.82 + rngNext(rng) * 0.36);
}

/** Pick from the least-used vertical third, with a small seed-specific bias. */
function balancedVerticalRow(rng: RngState, minRow: number, maxRow: number, counts: number[], weights: readonly number[]): number {
  const span = maxRow - minRow + 1;
  const bands = [0, 1, 2].map((index) => ({
    start: minRow + Math.floor(span * index / 3),
    end: minRow + Math.floor(span * (index + 1) / 3) - 1,
  }));
  const leastUsed = Math.min(...counts.map((count, index) => count / (weights[index] ?? 1)));
  const choices = [0, 1, 2].filter((index) => counts[index]! / (weights[index] ?? 1) <= leastUsed + 1e-9);
  const bandIndex = choices[rngInt(rng, 0, choices.length - 1)]!;
  counts[bandIndex] = (counts[bandIndex] ?? 0) + 1;
  const band = bands[bandIndex]!;
  return rngInt(rng, band.start, Math.max(band.start, band.end));
}

export function weatherForSeed(seed: number, country?: CampaignCountry, season = seasonForSeed(seed)): WeatherKind {
  if (season === 'winter') {
    const snowRoll = rngNext(deriveRng(seed, 0x534e4f57));
    if (snowRoll < .18) return 'clear';
    if (snowRoll < .26) return 'lightFog';
    if (snowRoll < .34) return 'fog';
    if (snowRoll < .4) return 'heavyFog';
    return snowRoll < .65 ? 'lightSnow' : snowRoll < .87 ? 'snow' : 'heavySnow';
  }
  const roll = rngNext(deriveRng(seed, 0x57454154));
  if (season === 'summer' && roll >= .82) return 'clear';
  if (country === 'italy') {
    if (roll < 0.55) return 'clear';
    if (roll < 0.67) return 'lightRain';
    if (roll < 0.78) return 'rain';
    if (roll < 0.86) return 'heavyRain';
    if (roll < 0.93) return 'lightFog';
    return roll < 0.98 ? 'fog' : 'heavyFog';
  }
  if (country === 'netherlands') {
    if (roll < 0.22) return 'clear';
    if (roll < 0.45) return 'lightRain';
    if (roll < 0.65) return 'rain';
    if (roll < 0.8) return 'heavyRain';
    if (roll < 0.9) return 'lightFog';
    return roll < 0.96 ? 'fog' : 'heavyFog';
  }
  if (roll < 0.32) return 'clear';
  if (roll < 0.45) return 'lightRain';
  if (roll < 0.61) return 'rain';
  if (roll < 0.74) return 'heavyRain';
  if (roll < 0.82) return 'lightFog';
  if (roll < 0.92) return 'fog';
  return 'heavyFog';
}

function cellCenterX(col: number, cell: number): number {
  return col * cell + cell / 2;
}

function cellCenterY(row: number, cell: number): number {
  return row * cell + cell / 2;
}

export function cellCenter(terrain: Terrain, col: number, row: number): Vec2 {
  return { x: cellCenterX(col, terrain.cell), y: cellCenterY(row, terrain.cell) };
}

export function posToCol(terrain: Terrain, x: number): number {
  return Math.min(terrain.cols - 1, Math.max(0, Math.floor(x / terrain.cell)));
}

export function posToRow(terrain: Terrain, y: number): number {
  return Math.min(terrain.rows - 1, Math.max(0, Math.floor(y / terrain.cell)));
}

export function isBlockedAt(terrain: Terrain, x: number, y: number): boolean {
  return terrain.blocked[posToRow(terrain, y) * terrain.cols + posToCol(terrain, x)] === 1;
}

export function isCellBlocked(terrain: Terrain, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= terrain.cols || row >= terrain.rows) return true;
  return terrain.blocked[row * terrain.cols + col] === 1;
}

/**
 * The river's centreline at an x coordinate. The meander is a pure function of x
 * and the seed rather than a random walk, so the band has no seam where an
 * attempt boundary would fall and the soft edges can be evaluated per cell.
 * Exported so the renderer draws the water exactly where the simulation puts it.
 */
export function riverCentreY(seed: number, x: number, band: { cy: number; meander: number; wavelength: number }): number {
  const angle = (x / band.wavelength) * Math.PI * 2 + (deriveRng(seed, 0x2e1a9e).s % 628) / 100;
  return band.cy + Math.sin(angle) * band.meander;
}

/** The matching centreline for a river that runs north to south. */
export function riverCentreX(seed: number, y: number, band: { cy: number; meander: number; wavelength: number }): number {
  const angle = (y / band.wavelength) * Math.PI * 2 + (deriveRng(seed, 0x2e1a9e).s % 628) / 100;
  return band.cy + Math.sin(angle) * band.meander;
}

export function riverAlongAtPoint(river: TerrainZone, x: number, y: number): number {
  if (river.orientation === 'vertical') return y;
  if (river.orientation === 'diagonal') return (x + (river.diagonalSlope ?? 1) * y) / Math.SQRT2;
  return x;
}

/** Main channel centre at a distance along the river, including 45° channels. */
export function riverPointAt(river: TerrainZone, seed: number, along: number): Vec2 {
  const band = { cy: river.cy, meander: CONFIG.terrain.river.meander, wavelength: CONFIG.terrain.river.meanderWavelength };
  if (river.orientation === 'vertical') return { x: riverCentreX(seed, along, band), y: along };
  if (river.orientation !== 'diagonal') return { x: along, y: riverCentreY(seed, along, band) };
  const slope = river.diagonalSlope ?? 1;
  const centerAlong = (river.cx + slope * river.cy) / Math.SQRT2;
  const distance = along - centerAlong;
  const angle = (along / band.wavelength) * Math.PI * 2 + (deriveRng(seed, 0x2e1a9e).s % 628) / 100;
  const offset = Math.sin(angle) * band.meander * 0.42;
  return {
    x: river.cx + distance / Math.SQRT2 - slope * offset / Math.SQRT2,
    y: river.cy + slope * distance / Math.SQRT2 + offset / Math.SQRT2,
  };
}

/** Sample the complete main channel so drawing and flow share the exact path. */
export function riverPathPoints(river: TerrainZone, seed: number, spacing = 6): Vec2[] {
  const width = CONFIG.field.width;
  const height = CONFIG.field.height;
  let start: number;
  let end: number;
  if (river.orientation === 'vertical') {
    start = -80;
    end = height + 80;
  } else if (river.orientation === 'diagonal') {
    const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: height }, { x: width, y: height }];
    const projections = corners.map((point) => riverAlongAtPoint(river, point.x, point.y));
    // Extend far enough past the corners for the full bank width and meander
    // to leave the viewport. A short 80px extension let diagonal polygons end
    // inside the field and exposed their blunt caps near map edges.
    const margin = Math.max(160, river.halfWidth * 2 + CONFIG.terrain.river.meander * 2 + 40);
    start = Math.min(...projections) - margin;
    end = Math.max(...projections) + margin;
  } else {
    start = -80;
    end = width + 80;
  }
  const samples = Math.ceil((end - start) / spacing);
  return Array.from({ length: samples + 1 }, (_, index) => riverPointAt(river, seed, start + (end - start) * index / samples));
}

function riverCrossingAtX(river: TerrainZone, seed: number, x: number): Vec2 {
  return riverPathPoints(river, seed, 8).reduce((nearest, point) => Math.abs(point.x - x) < Math.abs(nearest.x - x) ? point : nearest);
}

function riverCrossingAtY(river: TerrainZone, seed: number, y: number): Vec2 {
  return riverPathPoints(river, seed, 8).reduce((nearest, point) => Math.abs(point.y - y) < Math.abs(nearest.y - y) ? point : nearest);
}

/** The channel's normal-axis coordinate at a distance along its length. */
export function riverCentreAt(zones: TerrainData['zones'], seed: number, along: number): number {
  const band = riverBand(zones);
  if (zones.river?.orientation === 'vertical') return riverCentreX(seed, along, band);
  if (zones.river?.orientation === 'diagonal') return riverPointAt(zones.river, seed, along).y;
  return riverCentreY(seed, along, band);
}

/** Smooth bank variation that stays reproducible for a map seed. */
function riverWidthAt(river: TerrainZone, seed: number, along: number): number {
  const phase = (Math.imul(seed ^ 0x52495657, 0x9e3779b9) >>> 0) / 0x100000000 * Math.PI * 2;
  const centerAlong = river.orientation === 'vertical' ? river.cy
    : river.orientation === 'diagonal' ? (river.cx + (river.diagonalSlope ?? 1) * river.cy) / Math.SQRT2 : river.cx;
  const normalized = (along - centerAlong) / Math.max(1, river.halfLength);
  const variation = Math.sin(normalized * Math.PI * 2.2 + phase) * 0.48
    + Math.sin(normalized * Math.PI * 5.1 + phase * 1.73) * 0.32
    + Math.sin(normalized * Math.PI * 9.4 - phase * 0.61) * 0.2;
  return river.halfWidth * (1 + variation * 0.34);
}

export function riverHalfWidthAt(zones: TerrainData['zones'], seed: number, along: number): number {
  return zones.river === null ? 0 : riverWidthAt(zones.river, seed, along);
}

export function riverHalfWidthAtPoint(river: TerrainZone, seed: number, x: number, y: number): number {
  return riverWidthAt(river, seed, riverAlongAtPoint(river, x, y));
}

function bridgeTypeFor(rng: RngState, country?: CampaignCountry): RiverBridgeType {
  const types: readonly RiverBridgeType[] = country === 'netherlands'
    ? ['timber', 'timber', 'bailey', 'pontoon', 'pontoon', 'stone']
    : country === 'italy'
      ? ['stone', 'stone', 'stone', 'timber', 'bailey', 'pontoon']
      : ['timber', 'stone', 'stone', 'bailey', 'bailey', 'pontoon'];
  return rngPick(rng, types);
}

/** Distance from a point to the river's centreline at that x. */
function distanceToPolyline(points: readonly Vec2[], x: number, y: number): number {
  let distance = Infinity;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / Math.max(1, dx * dx + dy * dy)));
    distance = Math.min(distance, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return distance;
}

function mainRiverDistance(seed: number, x: number, y: number, river: TerrainZone): number {
  const band = { cy: river.cy, meander: CONFIG.terrain.river.meander, wavelength: CONFIG.terrain.river.meanderWavelength };
  if (river.orientation === 'vertical') return Math.abs(x - riverCentreX(seed, y, band));
  if (river.orientation !== 'diagonal') return Math.abs(y - riverCentreY(seed, x, band));
  const along = riverAlongAtPoint(river, x, y);
  const center = riverPointAt(river, seed, along);
  return Math.hypot(x - center.x, y - center.y);
}

/** True when a point lies in the main channel or any tributary, with clearance. */
function riverNear(seed: number, x: number, y: number, river: TerrainZone, clearance = 0): boolean {
  const mainDistance = mainRiverDistance(seed, x, y, river);
  if (mainDistance <= riverHalfWidthAtPoint(river, seed, x, y) + clearance) return true;
  return river.branches?.some((branch) => distanceToPolyline(branch.points, x, y) <= branch.halfWidth + clearance) ?? false;
}

function makeRiverBranches(river: TerrainZone, seed: number, rng: RngState, count: number): RiverBranch[] {
  const width = CONFIG.field.width;
  const height = CONFIG.field.height;
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: height }, { x: width, y: height }];
  const project = (point: Vec2): number => riverAlongAtPoint(river, point.x, point.y);
  const projections = corners.map(project);
  const low = Math.min(...projections) + 80;
  const high = Math.max(...projections) - 80;
  const branches: RiverBranch[] = [];
  const mainTangent = (along: number): Vec2 => {
    const before = riverPointAt(river, seed, along - 6);
    const after = riverPointAt(river, seed, along + 6);
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    return { x: dx / length, y: dy / length };
  };
  for (let index = 0; index < count; index++) {
    let start: Vec2;
    let end: Vec2;
    let along = (low + high) / 2;
    for (let attempt = 0; attempt < 12; attempt++) {
      along = rngRange(rng, low, high);
      const center = riverPointAt(river, seed, along);
      if (center.x < 48 || center.x > width - 48 || center.y < 48 || center.y > height - 48) continue;
      const side = rngInt(rng, 0, 3);
      start = side === 0 ? { x: 0, y: rngRange(rng, height * 0.14, height * 0.86) }
        : side === 1 ? { x: width, y: rngRange(rng, height * 0.14, height * 0.86) }
          : side === 2 ? { x: rngRange(rng, width * 0.14, width * 0.86), y: 0 }
            : { x: rngRange(rng, width * 0.14, width * 0.86), y: height };
      const branchHalfWidth = river.halfWidth * rngRange(rng, 0.38, 0.56);
      const tangent = mainTangent(along);
      const normal = { x: -tangent.y, y: tangent.x };
      const bankSide = Math.sign((start.x - center.x) * normal.x + (start.y - center.y) * normal.y) || 1;
      const joinOffset = riverHalfWidthAtPoint(river, seed, center.x, center.y) * 0.45;
      // Carry the branch centreline well inside the main channel. The main
      // water pass then masks the branch's flat polygon cap, leaving a visibly
      // continuous confluence instead of a tributary that stops at the bank.
      end = { x: center.x + normal.x * bankSide * joinOffset, y: center.y + normal.y * bankSide * joinOffset };
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      if (distance < 180) continue;
      const control1 = { x: start.x + (end.x - start.x) * 0.42, y: start.y + (end.y - start.y) * 0.42 };
      // Approach the bank at a clear confluence angle, with a downstream
      // component, instead of tracing alongside the main channel before joining.
      const joinTangentRaw = { x: tangent.x - normal.x * bankSide * 0.72, y: tangent.y - normal.y * bankSide * 0.72 };
      const joinTangentLength = Math.max(1, Math.hypot(joinTangentRaw.x, joinTangentRaw.y));
      const joinTangent = { x: joinTangentRaw.x / joinTangentLength, y: joinTangentRaw.y / joinTangentLength };
      const control2 = { x: end.x - joinTangent.x * Math.min(110, distance * 0.24), y: end.y - joinTangent.y * Math.min(110, distance * 0.24) };
      const samples = Math.ceil(distance / 10);
      const points = Array.from({ length: samples + 1 }, (_, sample) => {
        const t = sample / samples;
        const inverse = 1 - t;
        return {
          x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * end.x,
          y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * end.y,
        };
      });
      branches.push({ points, halfWidth: branchHalfWidth });
      break;
    }
  }
  return branches;
}

/**
 * The wadeable river and the mud patches, derived from the seed alone so every
 * map has its own ground and every reload reproduces it. When a river is present
 * it crosses the contested field horizontally, vertically, or diagonally, so it
 * is ground an attack has to wade rather than a wall either side can hide behind.
 * Some channels collect one or two tributaries. Not every map has one:
 * `CONFIG.terrain.river.presenceChance` decides, and a dry map carries more mud
 * instead, so soft ground is always worth reading.
 */
function generateZones(seed: number, irregularMud = false, country?: CampaignCountry): TerrainData['zones'] {
  const cell = CONFIG.terrain.cell;
  const rows = Math.floor(CONFIG.field.height / cell);
  const rng = deriveRng(seed, 0x5a17e2);
  const top = CONFIG.terrain.protectedTopRows;
  const bottom = rows - CONFIG.terrain.protectedBottomRows;
  const minRow = top + 4;
  const maxRow = bottom - 6;

  // Does this battlefield have water at all? The roll comes first, so the rest
  // of the layout is generated the same way whether or not a river follows.
  const hasRiver = rngNext(rng) < (country === undefined ? CONFIG.terrain.river.presenceChance : CAMPAIGNS[country].riverChance);
  const band = {
    cy: 0,
    meander: CONFIG.terrain.river.meander,
    wavelength: CONFIG.terrain.river.meanderWavelength,
  };
  let river: TerrainZone | null = null;
  if (hasRiver) {
    const orientationRoll = rngNext(rng);
    const orientation: TerrainZone['orientation'] = orientationRoll < 0.24 ? 'diagonal' : orientationRoll < 0.52 ? 'vertical' : 'horizontal';
    const diagonalSlope: -1 | 1 = rngNext(rng) < 0.5 ? -1 : 1;
    let center: number;
    if (orientation === 'vertical') {
      // Keep a vertical river well clear of the main north-south road, so a
      // crossing bridge has a real approach instead of landing at a junction.
      const layoutRng = deriveRng(seed, 0x4c41594f);
      const setting = settingForSeed(seed, country);
      const village = setting === 2 || setting === 5;
      const archetype = setting === 4 ? 'fields' : setting === 3 ? 'forest' : setting === 0 ? 'bocage' : 'farm';
      const variant = rngInt(layoutRng, 0, 2);
      const mainCol = village ? (variant === 1 ? rngInt(layoutRng, 17, 22) : rngInt(layoutRng, 10, 14))
        : archetype === 'fields' ? rngInt(layoutRng, 29, 33) : rngInt(layoutRng, 16, 23);
      const mainX = (mainCol + 0.5) * cell;
      const roadHalfWidth = village ? 12 : 10;
      const roundaboutClearance = village ? 38 : 0;
      const maximumBank = CONFIG.terrain.river.widthMax / 2 * (country === 'netherlands' ? 1.15 : 1) * 1.34;
      const minimumGap = maximumBank
        + CONFIG.terrain.river.meander + roadHalfWidth + roundaboutClearance + 12;
      const left = [(8 + 0.5) * cell, mainX - minimumGap] as const;
      const right = [mainX + minimumGap, (Math.floor(CONFIG.field.width / cell) - 8 + 0.5) * cell] as const;
      const ranges = [left, right].filter(([low, high]) => high > low);
      const totalLength = ranges.reduce((total, [low, high]) => total + high - low, 0);
      const positionRng = deriveRng(seed, 0x56524956);
      let pick = rngNext(positionRng) * totalLength;
      let chosenRange = ranges[ranges.length - 1] ?? [(8 + 0.5) * cell, (Math.floor(CONFIG.field.width / cell) - 8 + 0.5) * cell] as const;
      for (const range of ranges) {
        if (pick <= range[1] - range[0]) { chosenRange = range; break; }
        pick -= range[1] - range[0];
      }
      center = rngRange(positionRng, chosenRange[0], chosenRange[1]);
    } else if (orientation === 'horizontal') {
      center = (Math.max(minRow, Math.min(maxRow, rngInt(rng, minRow, maxRow))) + 0.5) * cell;
    } else {
      center = CONFIG.field.height / 2;
    }
    band.cy = center;
    river = {
      cx: orientation === 'vertical' ? center : CONFIG.field.width / 2,
      cy: orientation === 'vertical' ? CONFIG.field.height / 2 : band.cy,
      halfLength: orientation === 'diagonal' ? Math.hypot(CONFIG.field.width, CONFIG.field.height) / 2 + 80
        : (orientation === 'vertical' ? CONFIG.field.height : CONFIG.field.width) / 2 + 80,
      halfWidth: rngRange(rng, CONFIG.terrain.river.widthMin, CONFIG.terrain.river.widthMax) / 2 * (country === 'netherlands' ? 1.15 : 1),
      orientation,
      ...(orientation === 'diagonal' ? { diagonalSlope } : {}),
    };
    const branchRoll = rngNext(rng);
    if (branchRoll < 0.64) river.branches = makeRiverBranches(river, seed, rng, rngNext(rng) < 0.68 ? 1 : 2);
  }

  const mud: TerrainZone[] = [];
  const patchCount = hasRiver
    ? rngInt(rng, CONFIG.terrain.mud.patchMin, CONFIG.terrain.mud.patchMax)
    : rngInt(rng, CONFIG.terrain.mud.patchMinWithoutRiver, CONFIG.terrain.mud.patchMaxWithoutRiver);
  // Each patch searches its own window of rows, which advances as patches are
  // placed. Purely random rows collide and the spacing rule then rejects whole
  // patches; fully disjoint slices are worse, because a river cuts the usable
  // rows into two groups and a slice can land entirely on unusable ground. A
  // rolling window keeps the vertical spread while leaving every patch a real
  // chance of finding open ground.
  const rowSpan = Math.max(1, maxRow - minRow - 1);
  const windowSize = Math.max(3, Math.min(8, Math.floor(rowSpan / Math.max(1, patchCount)) * 2));
  // Plenty of attempts: a candidate has to clear the water and every patch
  // already placed, and on a river map the water takes a wide bite out of the
  // rows a patch could use. These are cheap arithmetic tests, so trying often is
  // far better than silently shipping fewer patches than configured.
  const maxAttempts = 200;
  for (let i = 0; i < patchCount; i++) {
    const halfLength = rngRange(rng, CONFIG.terrain.mud.radiusMin, CONFIG.terrain.mud.radiusMax);
    const aspect = rngRange(rng, CONFIG.terrain.mud.aspectMin, CONFIG.terrain.mud.aspectMax);
    const halfWidth = halfLength * aspect;
    const start = Math.min(maxRow - 1, minRow + Math.floor((i * (rowSpan - windowSize)) / Math.max(1, patchCount - 1)));
    const bandLow = Math.max(minRow, Math.min(maxRow - 1, start));
    const bandHigh = Math.max(bandLow, Math.min(maxRow - 1, start + windowSize));
    let place: TerrainZone | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Alternate halves of the field rather than drawing every patch from the
      // whole width: independent uniform draws cluster, and the scattered half of
      // the map ends up with all the mud. Each patch starts on its own side and
      // flips every attempt, so a patch that cannot fit on one side - the water
      // may leave only a narrow strip there - still gets a fair try on the other.
      const onRight = (i + attempt) % 2 === 0;
      const low = halfLength + cell;
      const high = CONFIG.field.width - halfLength - cell;
      const midpoint = (low + high) / 2;
      const cx = onRight ? rngRange(rng, midpoint, high) : rngRange(rng, low, midpoint);
      const row = rngInt(rng, bandLow, bandHigh);
      const cy = (row + 0.5) * cell;
      // Off the water and clear of its bank, so the two hazards stay readable as
      // separate ground rather than one muddy blur. Nothing to avoid on a dry map.
      if (river !== null && riverNear(seed, cx, cy, river, CONFIG.terrain.mud.riverClearance)) continue;
      // And clear of one another. Patches are wide and flat, so the axis test is
      // deliberately asymmetric: they need much more room side by side than
      // stacked. Without that, three patches on one row fuse into a single band
      // marching across the field.
      const gapX = CONFIG.terrain.mud.minGapFactorX;
      const gapY = CONFIG.terrain.mud.minGapFactorY;
      const crowding = mud.some((other) =>
        Math.abs(other.cx - cx) < (other.halfLength + halfLength) * gapX &&
        Math.abs(other.cy - cy) < (other.halfWidth + halfWidth) * gapY);
      if (crowding) continue;
      place = { cx, cy, halfLength, halfWidth, ...(irregularMud ? { shapeSeed: deriveRng(seed, 0x4d554400 + i).s >>> 0 } : {}) };
      break;
    }
    if (place !== null) mud.push(place);
  }

  const bridges: RiverBridge[] = [];
  const rapids: RiverRapid[] = [];
  if (river !== null) {
    const bridgeCount = rngNext(rng) < 0.58 ? 2 : 1;
    const bridgeFractions = bridgeCount === 1
      ? [rngRange(rng, 0.43, 0.57)]
      : [rngRange(rng, 0.27, 0.33), rngRange(rng, 0.67, 0.73)];
    for (const fraction of bridgeFractions) {
      const vertical = river.orientation === 'vertical';
      if (river.orientation === 'diagonal') {
        const corners = [{ x: 0, y: 0 }, { x: CONFIG.field.width, y: 0 }, { x: 0, y: CONFIG.field.height }, { x: CONFIG.field.width, y: CONFIG.field.height }];
        const projections = corners.map((point) => riverAlongAtPoint(river!, point.x, point.y));
        const along = Math.min(...projections) + (Math.max(...projections) - Math.min(...projections)) * fraction;
        const point = riverPointAt(river, seed, along);
        bridges.push({ x: point.x, y: point.y, type: bridgeTypeFor(rng, country), axis: bridges.length % 2 === 0 ? 'horizontal' : 'vertical', halfWidth: 17, halfLength: riverHalfWidthAtPoint(river, seed, point.x, point.y) * Math.SQRT2 + 10 });
        continue;
      }
      const along = (vertical ? CONFIG.field.height : CONFIG.field.width) * fraction;
      const center = vertical ? riverCentreX(seed, along, band) : riverCentreY(seed, along, band);
      const x = vertical ? center : along;
      const y = vertical ? along : center;
      bridges.push({
        x,
        y,
        type: bridgeTypeFor(rng, country),
        axis: vertical ? 'horizontal' : 'vertical',
        halfWidth: 17,
        halfLength: riverWidthAt(river, seed, along) + 10,
      });
    }
    // The outer reaches are deliberately rougher than the ordinary central
    // channel and remain clear of the usual bridge locations.
    for (const fraction of river.orientation !== 'horizontal' || country === 'netherlands' ? [] : [0.14, 0.86]) {
      rapids.push({ cx: CONFIG.field.width * fraction, halfLength: CONFIG.field.width * 0.065 });
    }
  }
  return { river, bridges, rapids, mud };
}

/**
 * The meander parameters a generated river's centreline was built from. The
 * shape is configuration plus the stored centre row, so the renderer can walk
 * the same curve the simulation tested against.
 */
export function riverBand(zones: TerrainData['zones']): { cy: number; meander: number; wavelength: number } {
  return {
    cy: zones.river?.cy ?? 0,
    meander: CONFIG.terrain.river.meander,
    wavelength: CONFIG.terrain.river.meanderWavelength,
  };
}

/** Whether a point is in the wadeable river. Always false on a dry map. */
export function isRiverAt(zones: TerrainData['zones'], seed: number, x: number, y: number): boolean {
  if (zones.river === null) return false;
  return riverNear(seed, x, y, zones.river);
}

/** Whether a point is on a bridge deck spanning the river. */
export function isBridgeAt(zones: TerrainData['zones'], seed: number, x: number, y: number): boolean {
  if (!isRiverAt(zones, seed, x, y)) return false;
  return zones.bridges.some((bridge) => bridge.axis === 'vertical'
    ? Math.abs(x - bridge.x) <= bridge.halfWidth && Math.abs(y - bridge.y) <= bridge.halfLength
    : Math.abs(y - bridge.y) <= bridge.halfWidth && Math.abs(x - bridge.x) <= bridge.halfLength);
}

/** Whether a point is in one of the short, fast-flowing river reaches. */
export function isRapidsAt(zones: TerrainData['zones'], seed: number, x: number, y: number): boolean {
  if (zones.river?.orientation !== 'horizontal') return false;
  return isRiverAt(zones, seed, x, y) && zones.rapids.some((reach) => Math.abs(x - reach.cx) <= reach.halfLength);
}

/** Normalized distance to the mud outline: 1 is its edge, shared with rendering. */
export function mudPatchDistance(patch: TerrainZone, x: number, y: number): number {
  const dx = (x - patch.cx) / patch.halfLength;
  const dy = (y - patch.cy) / patch.halfWidth;
  const radius = Math.hypot(dx, dy);
  if (patch.shapeSeed === undefined || radius === 0 || radius > 1) return radius;
  const angle = Math.atan2(dy, dx);
  const phase = patch.shapeSeed / 0xffffffff * Math.PI * 2;
  // Broad bays and smaller eroded edges, staying within the original spacing
  // envelope so patch placement and river clearance remain valid.
  const boundary = Math.min(0.99, 0.82 + Math.sin(angle * 3 + phase) * 0.1
    + Math.sin(angle * 5 - phase * 1.7) * 0.065 + Math.sin(angle * 9 + phase * 0.4) * 0.025);
  return radius / boundary;
}

/** Whether a point is in a mud patch. */
export function isMudAt(zones: TerrainData['zones'], x: number, y: number): boolean {
  for (const patch of zones.mud) {
    if (mudPatchDistance(patch, x, y) <= 1) return true;
  }
  return false;
}

/**
 * Stamp soft ground into the kind grid. River cells are marked wherever the
 * water reaches the cell's centre, mud wherever a patch covers it. Neither ever
 * marks a cell blocked.
 *
 * `markBuildingCells` is only true for a map that is actually being given
 * buildings: on a map generated without them - a legacy save - the footprints
 * were never marked at all, so there is nothing to re-type and the ground stays
 * whatever the underlying terrain says.
 */
function markZones(kinds: Uint8Array, terrain: Terrain, zones: TerrainData['zones'], seed: number, markBuildingCells: boolean): void {
  for (let row = 0; row < terrain.rows; row++) {
    for (let col = 0; col < terrain.cols; col++) {
      const idx = row * terrain.cols + col;
      if (terrain.blocked[idx] === 1) continue;
      const x = col * terrain.cell + terrain.cell / 2;
      const y = row * terrain.cell + terrain.cell / 2;
      if (isBridgeAt(zones, seed, x, y)) kinds[idx] = TERRAIN_KIND.bridge;
      else if (isRapidsAt(zones, seed, x, y)) kinds[idx] = TERRAIN_KIND.rapids;
      else if (isRiverAt(zones, seed, x, y)) kinds[idx] = TERRAIN_KIND.river;
      else if (isRoadAt(zones, x, y)) kinds[idx] = TERRAIN_KIND.road;
      else if (isMudAt(zones, x, y)) kinds[idx] = TERRAIN_KIND.mud;
      else if (markBuildingCells && kinds[idx] === TERRAIN_KIND.building) kinds[idx] = TERRAIN_KIND.ruins;
    }
  }
}

/** Building names, so a report can say which one came down. */
const BUILDING_NAMES: Record<BuildingKind, readonly string[]> = {
  church: ['Église Saint-Michel', 'Église Notre-Dame', 'Chapelle Sainte-Anne'],
  castle: ['Château de la Motte', 'Forteresse du Vieux Pont', 'Château des Prés'],
  hospital: ['Hôpital Saint-Jean', 'Hôtel-Dieu', 'Clinique de la Croix'],
  house: ['Ferme Dupont', 'Maison Lambert', 'Boulangerie Marchand', 'Mairie', 'Auberge du Pont', 'Grange Moreau'],
  school: ['École Jean Moulin', 'École communale', 'École du village'],
  restaurant: ['Restaurant de la Gare', 'Auberge du Marché', 'Le Relais'],
  bakery: ['Boulangerie Marchand', 'Le Fournil', 'Boulangerie du village'],
  clinic: ['Cabinet médical', 'Clinique Saint-Jean', 'Clinique du village'],
  generalStore: ['Épicerie Dupont', 'Magasin Général', 'Coopérative du village'],
  bar: ['Le Bistrot', 'Café des Sports', 'Bar du village'],
  barn: ['Grange Moreau', 'Grange du Moulin', 'Grange des Prés'],
};

/**
 * Place the map's buildings. They go in the contested middle of the field, never
 * on the deployment strip or the protected spawn rows, never in the river, and
 * never touching one another. A footprint is marked solid and typed as a
 * building, so the renderer draws it and the simulation can later open it.
 *
 * Placement is best-effort: a cramped map gets fewer buildings rather than a
 * forced overlap, and the attempt count is generous because a rejected rectangle
 * costs nothing but arithmetic.
 */
function placeBuildings(
  seed: number,
  blocked: Uint8Array,
  kinds: Uint8Array,
  zones: TerrainData['zones'],
  terrain: Terrain,
  lanes: readonly number[],
): GeneratedBuilding[] {
  const { cell, cols, rows } = terrain;
  const rng = deriveRng(seed, 0x8b1d1e);
  const cfg = CONFIG.buildings;
  const urban = settingForSeed(seed) === BATTLEFIELD_SETTINGS.length - 1;
  const top = CONFIG.terrain.protectedTopRows;
  const bottom = rows - CONFIG.terrain.protectedBottomRows;
  const deployRow = Math.floor(CONFIG.deploymentZone.yMin / cell) - cfg.deploymentClearanceCells;
  const urbanCenter = Math.floor((top + deployRow) / 2) + rngInt(rng, -4, 4);
  const districtTop = Math.max(top, urbanCenter - 7);
  const districtBottom = Math.min(deployRow, urbanCenter + 7);
  const placed: GeneratedBuilding[] = [];
  const inRiver = (col: number, row: number): boolean => {
    if (zones.river === null) return false;
    const x = col * cell + cell / 2;
    const y = row * cell + cell / 2;
    return riverNear(seed, x, y, zones.river, cell);
  };

  // Build the roster: churches first, so the landmark always finds room.
  const roster: BuildingKind[] = [];
  const urbanCounts = {
    church: { min: 1, max: 1 },
    castle: { min: 0, max: 0 },
    hospital: { min: 0, max: 1 },
    house: { min: 7, max: 10 },
    school: { min: 1, max: 1 },
    restaurant: { min: 1, max: 1 },
    bakery: { min: 1, max: 1 },
    clinic: { min: 1, max: 1 },
    generalStore: { min: 1, max: 1 },
    bar: { min: 1, max: 1 },
    barn: { min: 0, max: 0 },
  } satisfies typeof cfg.counts;
  for (const kind of ['church', 'hospital', 'school', 'clinic', 'generalStore', 'bakery', 'restaurant', 'bar', 'house'] as const) {
    const { min, max } = urban ? urbanCounts[kind] : cfg.counts[kind];
    const count = rngInt(rng, min, max);
    for (let i = 0; i < count; i++) roster.push(kind);
  }

  for (const kind of roster) {
    const size = cfg.footprints[kind];
    const margin = cfg.minGapCells;
    let built: GeneratedBuilding | null = null;
    for (let attempt = 0; attempt < 220; attempt++) {
      const colMin = urban ? 2 : 1;
      const colMax = Math.max(colMin, cols - size.cols - (urban ? 2 : 1));
      const rowMin = urban ? districtTop : top;
      const rowLimit = urban ? districtBottom : Math.min(deployRow, bottom);
      const col = rngInt(rng, colMin, colMax);
      const row = rngInt(rng, rowMin, Math.max(rowMin, rowLimit - size.rows));
      const maxRow = row + size.rows - 1;
      const maxCol = col + size.cols - 1;
      if (row < top || maxRow >= deployRow) continue;
      // Keep guaranteed north-to-south routes clear through the village.
      if (lanes.some((lane) => col <= lane + 1 && maxCol >= lane - 1)) continue;
      // Clear of every building already standing, by a margin.
      const overlaps = placed.some((other) =>
        col < other.col + other.cols + margin && col + size.cols + margin > other.col &&
        row < other.row + other.rows + margin && row + size.rows + margin > other.row);
      if (overlaps) continue;
      // Clear ground: a building may not swallow an obstacle, close a lane, or
      // stand in the water. Scenery kinds (trees, rocks) are fair game to replace.
      let clear = true;
      for (let r = row; r <= maxRow && clear; r++) {
        for (let c = col; c <= maxCol; c++) {
          const idx = r * cols + c;
          if (blocked[idx] === 1) { clear = false; break; }
          if (inRiver(c, r)) { clear = false; break; }
        }
      }
      if (!clear) continue;
      built = { kind, name: pickName(rng, kind), col, row, cols: size.cols, rows: size.rows };
      break;
    }
    if (built === null) continue;
    placed.push(built);
    for (let r = built.row; r < built.row + built.rows; r++) {
      for (let c = built.col; c < built.col + built.cols; c++) {
        const idx = r * cols + c;
        blocked[idx] = 1;
        kinds[idx] = TERRAIN_KIND.building;
      }
    }
  }
  return placed;
}

function pickName(rng: RngState, kind: BuildingKind): string {
  const names = BUILDING_NAMES[kind];
  return names[rngInt(rng, 0, names.length - 1)] as string;
}

/**
 * The live blocked grid for a map: the floor plan plus whichever buildings still
 * stand. Destroying a building calls this, which is how its footprint becomes
 * walkable ground again without disturbing anything else on the map.
 */
export function rebuildBlocked(terrain: Terrain, buildings: readonly Building[]): void {
  terrain.buildings = buildings;
  const base = terrain.baseBlocked;
  if (base === undefined) return;
  terrain.blocked.set(base);
  const cell = terrain.cell;
  for (const building of buildings) {
    if (building.destroyed) continue;
    const col0 = Math.floor(building.pos.x / cell);
    const row0 = Math.floor(building.pos.y / cell);
    for (let r = row0; r < row0 + building.rows; r++) {
      if (r < 0 || r >= terrain.rows) continue;
      for (let c = col0; c < col0 + building.cols; c++) {
        if (c < 0 || c >= terrain.cols) continue;
        terrain.blocked[r * terrain.cols + c] = 1;
      }
    }
  }
}

function generateAttempt(seed: number, attempt: number, withBuildings = true): TerrainData {
  const cell = CONFIG.terrain.cell;
  const cols = Math.floor(CONFIG.field.width / cell);
  const rows = Math.floor(CONFIG.field.height / cell);
  const blocked = new Uint8Array(cols * rows);
  const kinds = new Uint8Array(cols * rows);
  // Soft ground is a property of the map, not of an attempt: the same river and
  // the same mud patches appear whichever attempt's obstacles are accepted.
  const zones = generateZones(seed);
  // Obstacles are kept out of the water: a line of them across a river would turn
  // a wadeable hazard into a wall. A dry map has no such cells.
  const inRiver = (col: number, row: number): boolean => {
    if (zones.river === null) return false;
    const x = col * cell + cell / 2;
    const y = row * cell + cell / 2;
    return riverNear(seed, x, y, zones.river);
  };

  const rng: RngState = deriveRng(seed, 0x51ed + attempt * 0x7f4a);
  const protectedTop = CONFIG.terrain.protectedTopRows;
  const protectedBottom = rows - CONFIG.terrain.protectedBottomRows;

  // Seeded open lanes guarantee north-south connectivity.
  const laneCount = 3;
  const lanes: number[] = [];
  for (let i = 0; i < laneCount; i++) {
    const base = Math.floor(((i + 0.5) * cols) / laneCount);
    lanes.push(Math.min(cols - 3, Math.max(1, base + rngInt(rng, -3, 3))));
  }
  const laneCells = new Set<number>();
  for (const lane of lanes) {
    for (const col of [lane - 1, lane, lane + 1]) {
      laneCells.add(col);
    }
  }

  const featureCount = rngInt(rng, CONFIG.terrain.featureMin, CONFIG.terrain.featureMax);
  for (let f = 0; f < featureCount; f++) {
    const feature = rngPick(rng, PATTERNS);
    const pattern = feature.cells;
    const featureKind = feature.kind;
    const pw = pattern[0]!.length;
    const ph = pattern.length;
    const col0 = rngInt(rng, 0, cols - pw);
    const row0 = rngInt(rng, protectedTop, protectedBottom - ph);
    for (let r = 0; r < ph; r++) {
      const line = pattern[r]!;
      for (let c = 0; c < pw; c++) {
        if (line[c] !== 'X') continue;
        const col = col0 + c;
        const row = row0 + r;
        if (row < protectedTop || row >= protectedBottom) continue;
        if (laneCells.has(col)) continue;
        if (inRiver(col, row)) continue;
        const idx = row * cols + col;
        blocked[idx] = 1;
        kinds[idx] = featureKind;
      }
    }
  }

  // Scattered single rubble cells for texture.
  const rubble = rngInt(rng, 2, 5);
  for (let i = 0; i < rubble; i++) {
    const col = rngInt(rng, 0, cols - 1);
    const row = rngInt(rng, protectedTop, protectedBottom - 1);
    if (laneCells.has(col) || inRiver(col, row)) continue;
    const idx = row * cols + col;
    blocked[idx] = 1;
    kinds[idx] = 2;
  }

  // Anti-tank obstacles are real blockers, not just scenery. Keep them out of
  // the protected deployment bands, the guaranteed travel lanes, and the water:
  // a line of obstacles across a river would turn a wadeable hazard into a wall.
  // Connectivity is checked after this pass and the attempt regenerated if needed.
  for (let row = protectedTop; row < protectedBottom; row++) {
    const y = row * cell + cell / 2;
    if (Math.abs(y - CONFIG.lineY) <= 56) continue;
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (blocked[idx] === 1 || laneCells.has(col) || inRiver(col, row)) continue;
      const crateHere = (idx * 17 + row * 13) % 67 === 7 && Math.abs(y - CONFIG.lineY) > 46;
      const obstacleHere = (idx * 11 + col * 19) % 127 === 13 && Math.abs(y - CONFIG.lineY) > 56;
      if (crateHere || !obstacleHere) continue;
      blocked[idx] = 1;
      kinds[idx] = TERRAIN_KIND.obstacle;
    }
  }

  const terrain: Terrain = { cell, cols, rows, blocked };

  // The floor plan is the map with every building treated as a ruin: obstacles
  // and scenery only. It is captured before any footprint is marked solid, because
  // it is what the live grid is rebuilt from when a building comes down - so it
  // must not contain the buildings themselves.
  terrain.baseBlocked = blocked.slice();

  // Buildings may replace scenery, but never an obstacle, a lane, or the water.
  // Connectivity is verified after this, so a building can never wall the map off.
  const buildings = withBuildings ? placeBuildings(seed, blocked, kinds, zones, terrain, lanes) : [];

  // Soft ground last, and building footprints re-typed from solid to a ruin's
  // ground: a footprint is only ever marked on a map that has buildings, so a map
  // generated without them carries no trace of the type at all.
  markZones(kinds, terrain, zones, seed, withBuildings);
  // Foliage is soft cover: walkers can pass through it, while its kind remains
  // available to movement, combat, and rendering systems.
  for (let index = 0; index < kinds.length; index++) {
    if (!isFoliageKind(kinds[index]!)) continue;
    terrain.blocked[index] = 0;
    if (terrain.baseBlocked !== undefined) terrain.baseBlocked[index] = 0;
  }

  terrain.kinds = kinds;
  terrain.bridges = zones.bridges;
  return { terrain, kinds, lanes, settingId: settingForSeed(seed), season: seasonForSeed(seed), weather: weatherForSeed(seed), seed, zones, buildings };
}

/** Flood fill: any top-row cell can reach any bottom-row cell. */
function connectivityHolds(terrain: Terrain): boolean {
  const { cols, rows, blocked } = terrain;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  for (let c = 0; c < cols; c++) {
    if (blocked[c] === 0) {
      seen[c] = 1;
      stack.push(c);
    }
  }
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const neighbors = [
      [col - 1, row],
      [col + 1, row],
      [col, row - 1],
      [col, row + 1],
    ] as const;
    for (const [nc, nr] of neighbors) {
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const nidx = nr * cols + nc;
      if (blocked[nidx] === 0 && seen[nidx] === 0) {
        seen[nidx] = 1;
        stack.push(nidx);
      }
    }
  }
  const lastRow = (rows - 1) * cols;
  for (let c = 0; c < cols; c++) {
    if (blocked[lastRow + c] === 0 && seen[lastRow + c] === 1) return true;
  }
  return false;
}

/**
 * Generate terrain purely from the seed (stable across save/restore).
 *
 * `withBuildings` exists for save compatibility: a run saved before buildings
 * were part of the game has no record of them, so its map is regenerated without
 * any rather than with ruins the save cannot describe.
 */
function generateLegacyTerrain(seed: number, withBuildings = true): TerrainData {
  for (let attempt = 0; attempt < 25; attempt++) {
    const data = generateAttempt(seed, attempt, withBuildings);
    if (connectivityHolds(data.terrain)) return data;
  }
  // With protected lanes this is unreachable; fall back to fully open terrain
  // rather than shipping an unplayable map.
  const cell = CONFIG.terrain.cell;
  const cols = Math.floor(CONFIG.field.width / cell);
  const rows = Math.floor(CONFIG.field.height / cell);
  const zones = generateZones(seed);
  const terrain: Terrain = { cell, cols, rows, blocked: new Uint8Array(cols * rows) };
  const kinds = new Uint8Array(cols * rows);
  terrain.baseBlocked = terrain.blocked.slice();
  const lanes = [Math.floor(cols / 4), Math.floor(cols / 2), Math.floor((3 * cols) / 4)];
  const buildings = withBuildings ? placeBuildings(seed, terrain.blocked, kinds, zones, terrain, lanes) : [];
  markZones(kinds, terrain, zones, seed, withBuildings);
  // Existing maps retain their original layout, but tree cells are now soft
  // cover rather than solid walls. Keep structures and other obstacles intact.
  for (let index = 0; index < kinds.length; index++) {
    if (!isFoliageKind(kinds[index]!)) continue;
    terrain.blocked[index] = 0;
    if (terrain.baseBlocked !== undefined) terrain.baseBlocked[index] = 0;
  }
  terrain.kinds = kinds;
  return {
    terrain,
    kinds,
    lanes,
    settingId: settingForSeed(seed),
    weather: weatherForSeed(seed),
    season: seasonForSeed(seed),
    seed,
    zones,
    buildings,
  };
}

/** Distance to the actual road geometry, shared by placement and inspection. */
export function distanceToRoad(road: LandscapeRoad, point: Vec2): number {
  let nearest = Infinity;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!;
    const b = road.points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(1, dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return nearest;
}

export function isRoadAt(zones: TerrainData['zones'], x: number, y: number): boolean {
  return zones.roads?.some((road) => distanceToRoad(road, { x, y }) <= road.halfWidth + 3) ?? false;
}

function planLandscape(seed: number, zones: TerrainData['zones'], terrain: Terrain, country?: CampaignCountry): LandscapeLayout {
  const rng = deriveRng(seed, 0x4c41594f);
  const setting = settingForSeed(seed, country);
  const { cell, cols, rows } = terrain;
  const village = setting === 2 || setting === 5;
  const archetype: LandscapeLayout['archetype'] = village ? 'village' : setting === 3 ? 'forest' : setting === 4 ? 'fields' : setting === 0 ? 'bocage' : 'farm';
  const variant = rngInt(rng, 0, 2);
  const labels = [
    ['Normandy bocage farms', 'Normandy hedged pastures', 'Normandy country lanes'],
    ['Loire orchard farms', 'Normandy orchard estate', 'Picardy mixed farmland'],
    ['French roadside hamlet', 'French village outskirts', 'French farming hamlet'],
    ['Ardennes forest road', 'Mixed European woodland', 'Forest crossroads'],
    ['Flemish open fields', 'Picardy tree-lined fields', 'European harvest fields'],
    ['French crossroads village', 'French ribbon village', 'French market village'],
  ];
  const roads: LandscapeRoad[] = [];
  const fields: LandscapeField[] = [];
  const mainCol = village ? (variant === 1 ? rngInt(rng, 17, 22) : rngInt(rng, 10, 14))
    : archetype === 'fields' ? rngInt(rng, 29, 33) : rngInt(rng, 16, 23);
  const mainX = (mainCol + 0.5) * cell;
  const surface = village ? 'cobble' : 'dirt';
  const halfWidth = village ? 12 : 10;
  const verticalColumns = [mainCol];
  const dryRows = Array.from({ length: 16 }, (_, i) => i + 4).filter((row) => zones.river === null || zones.river.orientation === 'vertical' || Math.abs((row + 0.5) * cell - zones.river.cy) > zones.river.halfWidth + CONFIG.terrain.river.meander + cell);
  const nearestDryRow = (wanted: number, avoid?: number): number => [...dryRows].filter((row) => avoid === undefined || Math.abs(row - avoid) >= 4).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0] ?? dryRows[0]!;
  const firstRow = nearestDryRow(rngInt(rng, 8, 10));
  const secondRow = nearestDryRow(rngInt(rng, 16, 18), firstRow);
  const horizontalRows = [firstRow];
  const road = (points: Vec2[], width = halfWidth, roundabout = false): void => { roads.push({ points, halfWidth: width, surface, ...(roundabout ? { roundabout: true } : {}) }); };
  const width = cols * cell;
  const height = rows * cell;
  const curvedHorizontal = (y: number, amplitude: number, x0 = 0, x1 = width, fixedX: readonly number[] = [mainX]): Vec2[] => {
    const points: Vec2[] = [];
    const anchors = [...new Set([x0, ...fixedX.filter((x) => x > x0 + 1 && x < x1 - 1), x1])].sort((a, b) => a - b);
    const lengths = anchors.slice(1).map((x, index) => x - anchors[index]!);
    const curveSection = lengths.indexOf(Math.max(...lengths));
    // Keep the road straight through junctions and bridge landings. A single
    // shallow bend on the longest uninterrupted stretch reads like a lane
    // following a field edge instead of a decorative sine wave.
    const direction = variant % 2 === 0 ? 1 : -1;
    for (let section = 1; section < anchors.length; section++) {
      const start = anchors[section - 1]!;
      const end = anchors[section]!;
      for (let i = section === 1 ? 0 : 1; i <= 12; i++) {
        const t = i / 12;
        const bend = section - 1 === curveSection ? direction * amplitude * Math.sin(Math.PI * t) ** 2 : 0;
        points.push({ x: start + (end - start) * t, y: y + bend });
      }
    }
    return points;
  };
  const curvedVerticalRoute = (x: number, anchors: readonly number[], amplitude: number): Vec2[] => {
    const points: Vec2[] = [];
    const routeAnchors = [...new Set(anchors)].sort((a, b) => a - b);
    const lengths = routeAnchors.slice(1).map((anchor, index) => anchor - routeAnchors[index]!);
    const curveSection = lengths.indexOf(Math.max(...lengths));
    const direction = variant % 2 === 0 ? 1 : -1;
    for (let section = 1; section < routeAnchors.length; section++) {
      const y0 = routeAnchors[section - 1]!;
      const y1 = routeAnchors[section]!;
      if (y1 - y0 < 1) continue;
      for (let i = section === 1 ? 0 : 1; i <= 12; i++) {
        const t = i / 12;
        // A single field-edge sweep between junctions; every crossing anchor
        // stays exactly on the road centreline and has a vertical tangent.
        const bend = section - 1 === curveSection ? direction * amplitude * Math.sin(Math.PI * t) ** 2 : 0;
        points.push({ x: x + bend, y: y0 + (y1 - y0) * t });
      }
    }
    return points;
  };
  const horizontalRouteAnchors = (y: number): number[] => [
    mainX,
    ...(zones.river?.orientation === 'vertical' ? [riverCentreX(seed, y, riverBand(zones))]
      : zones.river?.orientation === 'diagonal' ? [riverCrossingAtY(zones.river, seed, y).x] : []),
  ];
  const verticalRouteAnchors = (x: number, route: readonly number[]): number[] => {
    const crossing = zones.river?.orientation === 'horizontal' ? riverCentreY(seed, x, riverBand(zones))
      : zones.river?.orientation === 'diagonal' ? riverCrossingAtX(zones.river, seed, x).y : undefined;
    return crossing !== undefined && crossing > Math.min(...route) + 1 && crossing < Math.max(...route) - 1
      ? [...route, crossing] : [...route];
  };
  const hasRoundabout = village && rngNext(rng) < 0.48;
  const roundaboutY = (firstRow + 0.5) * cell;
  const secondRoadY = (secondRow + 0.5) * cell;
  const roundaboutRadius = 38;
  // Keep bridges on the through road while joining all four approaches at the
  // circular carriageway. The island is rendered inside the ring below.
  if (hasRoundabout) {
    road(curvedVerticalRoute(mainX, verticalRouteAnchors(mainX, [0, roundaboutY - roundaboutRadius]), rngRange(rng, 4, 7)));
    road(curvedVerticalRoute(mainX, verticalRouteAnchors(mainX, [roundaboutY + roundaboutRadius, height]), rngRange(rng, 4, 7)));
    road([{ x: 0, y: roundaboutY }, { x: mainX - roundaboutRadius, y: roundaboutY }]);
    road([{ x: mainX + roundaboutRadius, y: roundaboutY }, { x: width, y: roundaboutY }]);
    const ring: Vec2[] = [];
    for (let i = 0; i <= 48; i++) {
      const angle = (i / 48) * Math.PI * 2;
      ring.push({ x: mainX + Math.cos(angle) * roundaboutRadius, y: roundaboutY + Math.sin(angle) * roundaboutRadius });
    }
    road(ring, halfWidth, true);
  } else {
    road(curvedVerticalRoute(mainX, verticalRouteAnchors(mainX, [0, roundaboutY, secondRoadY, height]), rngRange(rng, 4, 7)));
  }
  if (village && variant !== 1) {
    const secondCol = rngInt(rng, 26, 29);
    verticalColumns.push(secondCol);
    const x = (secondCol + 0.5) * cell;
    road(curvedVerticalRoute(x, verticalRouteAnchors(x, [0, roundaboutY, secondRoadY, height]), rngRange(rng, 4, 7)), 10);
  }
  if (!hasRoundabout) road(curvedHorizontal(roundaboutY, rngRange(rng, 12, 20), 0, width, horizontalRouteAnchors(roundaboutY)));
  if (archetype !== 'fields' && archetype !== 'forest') {
    const secondStart = village ? 0 : mainX;
    if (secondStart === 0) horizontalRows.unshift(secondRow);
    else horizontalRows.push(secondRow);
    road(curvedHorizontal(secondRoadY, rngRange(rng, 8, 15), secondStart, width, horizontalRouteAnchors(secondRoadY)), 9);
  }
  if (archetype === 'forest' && variant === 2) {
    horizontalRows.push(secondRow);
    road([{ x: 0, y: secondRoadY }, { x: mainX, y: secondRoadY }], 8);
  }
  zones.roads = roads;
  // Place a bridge only where the actual road centreline intersects a river
  // centreline. Using the generated geometry covers curved roads, diagonal
  // rivers and tributaries, and prevents an unbridged road from being painted
  // straight through the water.
  if (zones.river !== null) {
    const channels = [
      { points: riverPathPoints(zones.river, seed, 5), halfWidthAt: (point: Vec2): number => riverHalfWidthAtPoint(zones.river!, seed, point.x, point.y) },
      ...(zones.river.branches ?? []).map((branch) => ({ points: branch.points, halfWidthAt: (): number => branch.halfWidth })),
    ];
    const crossings: Array<{ x: number; y: number; axis: 'horizontal' | 'vertical'; halfLength: number }> = [];
    for (const roadPath of roads) {
      for (let ri = 1; ri < roadPath.points.length; ri++) {
        const a = roadPath.points[ri - 1]!;
        const b = roadPath.points[ri]!;
        const rdx = b.x - a.x;
        const rdy = b.y - a.y;
        const roadLength = Math.hypot(rdx, rdy);
        if (roadLength < 0.01) continue;
        for (const channel of channels) {
          for (let ci = 1; ci < channel.points.length; ci++) {
            const c = channel.points[ci - 1]!;
            const d = channel.points[ci]!;
            const cdx = d.x - c.x;
            const cdy = d.y - c.y;
            const denominator = rdx * cdy - rdy * cdx;
            if (Math.abs(denominator) < 0.01) continue;
            const t = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / denominator;
            const u = ((c.x - a.x) * rdy - (c.y - a.y) * rdx) / denominator;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const sine = Math.abs(denominator) / (roadLength * Math.max(0.01, Math.hypot(cdx, cdy)));
            // Nearly parallel banks should not create a bridge along the river.
            if (sine < 0.34) continue;
            const x = a.x + rdx * t;
            const y = a.y + rdy * t;
            if (crossings.some((crossing) => Math.hypot(crossing.x - x, crossing.y - y) < 32)) continue;
            const riverHalfWidth = channel.halfWidthAt({ x, y });
            crossings.push({
              x, y,
              axis: Math.abs(rdx) >= Math.abs(rdy) ? 'horizontal' : 'vertical',
              halfLength: Math.min(60, riverHalfWidth / sine + 10),
            });
          }
        }
      }
    }
    zones.bridges = crossings.map((crossing, index) => ({
      ...crossing,
      type: zones.bridges[index]?.type ?? bridgeTypeFor(deriveRng(seed, 0x42520000 + index), country),
      halfWidth: 17,
    }));
    zones.rapids = zones.rapids.filter((rapid) => !zones.bridges.some((bridge) => Math.abs(bridge.x - rapid.cx) < rapid.halfLength + 36));
  }
  if (!village && archetype !== 'forest') {
    const xRanges = [[3, mainCol - 2], [mainCol + 2, cols - 3]];
    const yRanges = archetype === 'fields' ? [[4, 7], [9, 15], [17, 22]] : [[4, firstRow - 1], [firstRow + 2, 21]];
    let index = 0;
    for (const [left, right] of xRanges) {
      for (const [top, bottom] of yRanges) {
        if (right! - left! < 3 || bottom! - top! < 3) continue;
        const crop: LandscapeField['crop'] = setting === 1 && index % 2 === variant % 2 ? 'orchard'
          : archetype === 'bocage' && index % 2 === 0 ? 'pasture' : (index + variant) % 2 === 0 ? 'wheat' : 'ploughed';
        fields.push({ col: left!, row: top!, cols: right! - left!, rows: bottom! - top!, crop, vertical: rngNext(rng) < 0.5 });
        index++;
      }
    }
  }
  return { label: country === undefined ? labels[setting]![variant]! : campaignSectorForSeed(country, seed).label, archetype, roads, fields };
}

/** Road frontage is a placement constraint, not decoration painted afterward. */
function placeLandscapeBuildings(seed: number, terrain: Terrain, kinds: Uint8Array, zones: TerrainData['zones'], layout: LandscapeLayout, reserved: Uint8Array, country?: CampaignCountry): GeneratedBuilding[] {
  const rng = deriveRng(seed, 0x4c4f5453);
  const { cell, cols, rows, blocked } = terrain;
  const village = layout.archetype === 'village';
  const roster: BuildingKind[] = village
    ? ['church', ...(settingForSeed(seed, country) === 5 ? ['school', 'clinic', 'generalStore', 'bakery', 'restaurant', 'bar'] as BuildingKind[] : ['generalStore', 'bar'] as BuildingKind[]), ...(rngNext(rng) < 0.45 ? ['hospital'] as BuildingKind[] : []), ...Array.from({ length: rngInt(rng, 6, 10) }, (): BuildingKind => 'house')]
    : layout.archetype === 'forest' ? ['house']
    : layout.archetype === 'fields' ? ['barn', 'house'] : ['barn', 'barn', 'house', 'house'];
  // Historic fortifications are a country-weighted landmark, not a routine
  // village building. The lower Dutch rate reflects the flatter campaign map.
  const castleChance: Record<CampaignCountry, number> = {
    france: 0.38,
    belgium: 0.24,
    italy: 0.3,
    germany: 0.4,
    luxembourg: 0.32,
    netherlands: 0.08,
  };
  if (country !== undefined && rngNext(rng) < castleChance[country]) roster.unshift('castle');
  const placed: GeneratedBuilding[] = [];
  const limit = Math.floor(CONFIG.deploymentZone.yMin / cell) - CONFIG.buildings.deploymentClearanceCells;
  const buildingBandCounts = [0, 0, 0];
  const buildingBandWeights = verticalBandWeights(seed, 0x44495354);
  const buildingTop = CONFIG.terrain.protectedTopRows;
  const buildingBottom = Math.min(limit, rows - CONFIG.terrain.protectedBottomRows);
  for (const kind of roster) {
    const size = CONFIG.buildings.footprints[kind];
    const candidates: Array<{ col: number; row: number }> = [];
    const addFrontageCandidate = (point: Vec2, dx: number, dy: number, halfRoadWidth: number, side: number, setback: number): void => {
      const length = Math.hypot(dx, dy);
      if (length < 1) return;
      const tangentX = dx / length;
      const tangentY = dy / length;
      const normalX = -tangentY * side;
      const normalY = tangentX * side;
      const halfBuildingWidth = size.cols * cell / 2;
      const halfBuildingHeight = size.rows * cell / 2;
      const frontageDistance = halfRoadWidth + Math.abs(normalX) * halfBuildingWidth + Math.abs(normalY) * halfBuildingHeight + setback * cell + 2;
      const center = { x: point.x + normalX * frontageDistance, y: point.y + normalY * frontageDistance };
      candidates.push({ col: Math.floor((center.x - halfBuildingWidth) / cell), row: Math.floor((center.y - halfBuildingHeight) / cell) });
    };
    for (const road of layout.roads) {
      let pathDistance = 0;
      let nextSample = 0;
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1]!;
        const b = road.points[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.001) continue;
        // Sample by distance along the complete path, not once per polyline
        // segment. Curved roads have more vertices, but should not gain extra
        // building frontage candidates or repeated candidates at every join.
        while (nextSample <= pathDistance + length) {
          const t = (nextSample - pathDistance) / length;
          const point = { x: a.x + dx * t, y: a.y + dy * t };
          for (const side of [-1, 1]) {
            for (const setback of [0, 1]) addFrontageCandidate(point, dx, dy, road.halfWidth, side, setback);
          }
          nextSample += cell;
        }
        pathDistance += length;
      }
    }
    const bandCandidates: Array<Array<{ col: number; row: number }>> = [[], [], []];
    for (const spot of candidates) {
      const centerRow = spot.row + size.rows / 2;
      const band = Math.min(2, Math.max(0, Math.floor((centerRow - buildingTop) * 3 / Math.max(1, buildingBottom - buildingTop))));
      bandCandidates[band]!.push(spot);
    }
    for (const band of bandCandidates) rngShuffle(rng, band);
    const lowestLoad = Math.min(...buildingBandCounts.map((count, index) => count / buildingBandWeights[index]!));
    const preferredBands = [0, 1, 2]
      .sort((a, b) => buildingBandCounts[a]! / buildingBandWeights[a]! - buildingBandCounts[b]! / buildingBandWeights[b]!);
    const tieCount = preferredBands.filter((band) => buildingBandCounts[band]! / buildingBandWeights[band]! <= lowestLoad + 1e-9).length;
    const preferred = preferredBands.slice(0, Math.max(1, tieCount));
    const orderedBands = [...preferred, ...preferredBands.filter((band) => !preferred.includes(band))];
    let placedBand = -1;
    for (const bandIndex of orderedBands) {
      for (const spot of bandCandidates[bandIndex]!) {
        const { col, row } = spot;
        if (col < 3 || col + size.cols > cols - 3 || row < CONFIG.terrain.protectedTopRows || row + size.rows > Math.min(limit, rows - CONFIG.terrain.protectedBottomRows)) continue;
        if (placed.some((other) => col < other.col + other.cols + 1 && col + size.cols + 1 > other.col && row < other.row + other.rows + 1 && row + size.rows + 1 > other.row)) continue;
        const left = col * cell;
        const top = row * cell;
        const right = (col + size.cols) * cell;
        const bottom = (row + size.rows) * cell;
        const perimeter = [{ x: left, y: (top + bottom) / 2 }, { x: right, y: (top + bottom) / 2 }, { x: (left + right) / 2, y: top }, { x: (left + right) / 2, y: bottom }];
        if (Math.min(...layout.roads.flatMap((candidate) => perimeter.map((point) => distanceToRoad(candidate, point)))) > cell * 1.5) continue;
        let clear = true;
        for (let r = row; r < row + size.rows && clear; r++) {
          for (let c = col; c < col + size.cols; c++) {
            const index = r * cols + c;
            const x = (c + 0.5) * cell;
            const y = (r + 0.5) * cell;
            if (blocked[index] || reserved[index] || (zones.river && riverNear(seed, x, y, zones.river, cell))) { clear = false; break; }
          }
        }
        if (!clear) continue;
        const name = country !== undefined ? rngPick(rng, LOCAL_BUILDING_NAMES[campaignSectorForSeed(country, seed).language][kind])
          : kind === 'house' ? rngPick(rng, village ? ['Maison Lambert', 'Maison Dupont', 'Maison Lefèvre', 'Maison Morel'] : ['Ferme Dupont', 'Maison du garde', 'Ferme Lambert']) : pickName(rng, kind);
        placed.push({ kind, name, col, row, ...size });
        placedBand = bandIndex;
        for (let r = row; r < row + size.rows; r++) {
          for (let c = col; c < col + size.cols; c++) { blocked[r * cols + c] = 1; kinds[r * cols + c] = TERRAIN_KIND.building; }
        }
        break;
      }
      if (placedBand >= 0) break;
    }
    if (placedBand >= 0) buildingBandCounts[placedBand] = buildingBandCounts[placedBand]! + 1;
  }
  return placed;
}

/** Locations are generated as roads, lots, parcels, and vegetation in that order. */
export function generateTerrain(seed: number, withBuildings = true, version: 1 | 2 | 3 = 3, country?: CampaignCountry, season = seasonForSeed(seed)): TerrainData {
  if (version === 1) return { ...generateLegacyTerrain(seed, withBuildings), layoutVersion: 1, season, weather: weatherForSeed(seed, country, season) };
  const cell = CONFIG.terrain.cell;
  const cols = Math.floor(CONFIG.field.width / cell);
  const rows = Math.floor(CONFIG.field.height / cell);
  const terrain: Terrain = { cell, cols, rows, blocked: new Uint8Array(cols * rows) };
  const kinds = new Uint8Array(cols * rows);
  const zones = generateZones(seed, true, country);
  const layout = planLandscape(seed, zones, terrain, country);
  const reserved = new Uint8Array(cols * rows);
  const lanes = [1, cols - 2];
  const rng = deriveRng(seed, 0x56454745);
  const top = CONFIG.terrain.protectedTopRows;
  const bottom = rows - CONFIG.terrain.protectedBottomRows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      const point = { x: (col + 0.5) * cell, y: (row + 0.5) * cell };
      const road = layout.roads.some((road) => distanceToRoad(road, point) <= road.halfWidth + cell * 0.25);
      if (road) kinds[index] = TERRAIN_KIND.road;
      if (road || row < top || row >= bottom || lanes.some((lane) => Math.abs(col - lane) <= 1)) reserved[index] = 1;
    }
  }
  const buildings = withBuildings ? placeLandscapeBuildings(seed, terrain, kinds, zones, layout, reserved, country) : [];
  const buildingBuffer = new Uint8Array(cols * rows);
  for (const building of buildings) {
    for (let row = building.row - 1; row <= building.row + building.rows; row++) {
      for (let col = building.col - 1; col <= building.col + building.cols; col++) {
        const index = row * cols + col;
        buildingBuffer[index] = 1;
        if (building.kind === 'barn' && !terrain.blocked[index] && kinds[index] === TERRAIN_KIND.open && !reserved[index]) kinds[index] = TERRAIN_KIND.farmyard;
      }
    }
  }
  const stamp = (col: number, row: number, kind: number): void => {
    if (col < 0 || col >= cols || row < top || row >= bottom) return;
    const index = row * cols + col;
    if (reserved[index] || buildingBuffer[index] || terrain.blocked[index] || isRiverAt(zones, seed, (col + 0.5) * cell, (row + 0.5) * cell)) return;
    terrain.blocked[index] = isFoliageKind(kind) || kind === TERRAIN_KIND.wildflower ? 0 : 1;
    kinds[index] = kind;
  };
  for (let fieldIndex = 0; fieldIndex < layout.fields.length; fieldIndex++) {
    const field = layout.fields[fieldIndex]!;
    const orchardRng = deriveRng(seed, 0x4f524300 + fieldIndex);
    const orchardSpacing = rngInt(orchardRng, 3, 5);
    const orchardRowOffset = rngInt(orchardRng, 0, orchardSpacing - 1);
    const orchardColOffset = rngInt(orchardRng, 0, orchardSpacing - 1);
    for (let row = field.row; row < field.row + field.rows; row++) {
      for (let col = field.col; col < field.col + field.cols; col++) {
        const index = row * cols + col;
        if (terrain.blocked[index] || reserved[index] || buildingBuffer[index]) continue;
        kinds[index] = field.crop === 'orchard' ? TERRAIN_KIND.orchard : TERRAIN_KIND.crops;
        const rowPhase = (row - field.row + orchardRowOffset) % orchardSpacing;
        const colPhase = (col - field.col + orchardColOffset + (row % 2)) % orchardSpacing;
        if (field.crop === 'orchard' && rowPhase === 0 && colPhase === 0) stamp(col, row, TERRAIN_KIND.fruitTree);
      }
    }
  }
  if (layout.archetype === 'fields' || layout.archetype === 'bocage' || layout.archetype === 'farm') {
    // Long, mostly continuous field boundaries. Materials vary by region, and
    // the run length keeps each fence looking like a built boundary instead of
    // a random checkerboard of individual posts.
    const boundaryRows = layout.archetype === 'fields' ? [7, 15, 22] : [...new Set(layout.fields.map((field) => field.row + field.rows))];
    const fenceKind = (): number => {
      const roll = rngNext(rng);
      if (layout.archetype === 'bocage') {
        return roll < 0.58 ? TERRAIN_KIND.trees : roll < 0.8 ? TERRAIN_KIND.woodFence : TERRAIN_KIND.stoneFence;
      }
      if (country === 'italy') return roll < 0.66 ? TERRAIN_KIND.stoneFence : TERRAIN_KIND.woodFence;
      if (country === 'netherlands') return roll < 0.68 ? TERRAIN_KIND.woodFence : TERRAIN_KIND.stoneFence;
      if (country === 'france') return roll < 0.52 ? TERRAIN_KIND.stoneFence : TERRAIN_KIND.woodFence;
      return roll < 0.5 ? TERRAIN_KIND.woodFence : TERRAIN_KIND.stoneFence;
    };
    for (const row of boundaryRows) {
      const gate = rngInt(rng, 5, cols - 6);
      let runKind = fenceKind();
      let runEndsAt = 3 + rngInt(rng, 7, 15);
      for (let col = 3; col < cols - 3; col++) {
        if (col >= runEndsAt) {
          runKind = fenceKind();
          runEndsAt = col + rngInt(rng, 7, 15);
        }
        if (Math.abs(col - gate) <= 1) continue;
        stamp(col, row, runKind);
      }
    }
    // A few cross-field boundaries turn the long rows into believable parcels.
    // Each side has its own gate, and the terrain reservation mask preserves
    // any road or bridge that crosses it.
    if (layout.archetype === 'fields') {
      for (const field of layout.fields) {
        if (rngNext(rng) > 0.62) continue;
        const kind = fenceKind();
        for (const col of [field.col - 1, field.col + field.cols]) {
          const gateRow = rngInt(rng, field.row + 1, Math.max(field.row + 1, field.row + field.rows - 2));
          for (let row = field.row; row < field.row + field.rows; row++) {
            if (Math.abs(row - gateRow) <= 1) continue;
            stamp(col, row, kind);
          }
        }
      }
    }
    if (layout.archetype === 'bocage') {
      for (const field of layout.fields) {
        for (let row = field.row; row < field.row + field.rows; row++) {
          if ((row - field.row) % 7 === 3 || (row - field.row) % 7 === 4) continue;
          stamp(field.col - 1, row, TERRAIN_KIND.trees);
          stamp(field.col + field.cols, row, TERRAIN_KIND.trees);
        }
      }
    }
  }
  const groves = layout.archetype === 'forest' ? country === 'netherlands' ? 16 : country === 'italy' ? 20 : 26 : layout.archetype === 'village' ? 4 : 3;
  const elementBandCounts = [0, 0, 0];
  const elementBandWeights = verticalBandWeights(seed, 0x454c454d);
  for (let grove = 0; grove < groves; grove++) {
    const species = country !== undefined ? TERRAIN_KIND[rngPick(rng, CAMPAIGNS[country].trees)] : rngPick(rng, layout.archetype === 'forest' ? [TERRAIN_KIND.pine, TERRAIN_KIND.pine, TERRAIN_KIND.beech, TERRAIN_KIND.oak] : [TERRAIN_KIND.oak, TERRAIN_KIND.beech, TERRAIN_KIND.birch]);
    const shape = GROVE_SHAPES[rngInt(rng, 0, GROVE_SHAPES.length - 1)]!;
    const rotation = rngInt(rng, 0, 3);
    const rotated = shape.map(([dc, dr]) => rotation === 0 ? [dc, dr] as const
      : rotation === 1 ? [-dr, dc] as const
        : rotation === 2 ? [-dc, -dr] as const : [dr, -dc] as const);
    const minCol = Math.min(...rotated.map(([dc]) => dc));
    const minRow = Math.min(...rotated.map(([, dr]) => dr));
    const maxCol = Math.max(...rotated.map(([dc]) => dc));
    const maxRow = Math.max(...rotated.map(([, dr]) => dr));
    const col = rngInt(rng, 3, Math.max(3, cols - 4 - (maxCol - minCol)));
    const row = balancedVerticalRow(rng, top + 1, Math.max(top + 1, bottom - 3 - (maxRow - minRow)), elementBandCounts, elementBandWeights);
    for (const [dc, dr] of rotated) {
      const targetCol = col + dc - minCol;
      const targetRow = row + dr - minRow;
      const index = targetRow * cols + targetCol;
      if (kinds[index] === TERRAIN_KIND.crops || kinds[index] === TERRAIN_KIND.orchard) continue;
      stamp(targetCol, targetRow, species);
    }
  }
  // Undergrowth patches mix low shrubs and rough grass between larger crowns.
  // Their counts rise in woodland and fall back around open fields and villages.
  const undergrowthPatches = layout.archetype === 'forest' ? country === 'netherlands' ? 28 : 42
    : layout.archetype === 'village' ? 9 : 20;
  const undergrowthOffsets = [
    [[0, 0], [1, 0], [0, 1]],
    [[0, 0], [1, 0], [2, 0], [1, 1]],
    [[0, 0], [0, 1], [1, 1], [2, 1]],
  ] as const;
  for (let patch = 0; patch < undergrowthPatches; patch++) {
    const shape = undergrowthOffsets[rngInt(rng, 0, undergrowthOffsets.length - 1)]!;
    const col = rngInt(rng, 3, cols - 6);
    const row = balancedVerticalRow(rng, top + 1, bottom - 2, elementBandCounts, elementBandWeights);
    const kind = rngNext(rng) < (layout.archetype === 'forest' ? 0.68 : 0.48) ? TERRAIN_KIND.shrub : TERRAIN_KIND.tallGrass;
    for (const [dc, dr] of shape) {
      const target = (row + dr) * cols + col + dc;
      if (kinds[target] === TERRAIN_KIND.crops || kinds[target] === TERRAIN_KIND.orchard) continue;
      stamp(col + dc, row + dr, kind);
    }
  }
  const flowerPatches = layout.archetype === 'forest' ? 12 : 24;
  for (let patch = 0; patch < flowerPatches; patch++) {
    const col = rngInt(rng, 3, cols - 4);
    const row = balancedVerticalRow(rng, top + 1, bottom - 1, elementBandCounts, elementBandWeights);
    const index = row * cols + col;
    if (kinds[index] === TERRAIN_KIND.crops || kinds[index] === TERRAIN_KIND.orchard) continue;
    stamp(col, row, TERRAIN_KIND.wildflower);
  }
  // Combat clutter is sparse and obeys the same roads, water, and lot clearance.
  const rockCount = country === 'italy' ? 10 : country === 'netherlands' ? 1 : 4;
  for (let item = 0; item < rockCount + 5; item++) {
    stamp(rngInt(rng, 3, cols - 4), balancedVerticalRow(rng, top + 1, bottom - 1, elementBandCounts, elementBandWeights), item < rockCount ? TERRAIN_KIND.rocks : TERRAIN_KIND.obstacle);
  }
  terrain.baseBlocked = terrain.blocked.slice();
  for (const building of buildings) {
    for (let row = building.row; row < building.row + building.rows; row++) {
      for (let col = building.col; col < building.col + building.cols; col++) terrain.baseBlocked[row * cols + col] = 0;
    }
  }
  markZones(kinds, terrain, zones, seed, withBuildings);
  // Protected edge lanes and the reserved through roads guarantee this invariant.
  if (!connectivityHolds(terrain)) throw new Error('Landscape has no north-south route.');
  terrain.kinds = kinds;
  if (version === 3) generateElevation(terrain, seed, (x, y) =>
    [[0, 0], [-12, 0], [12, 0], [0, -12], [0, 12]].some(([dx, dy]) => isRiverAt(zones, seed, x + dx!, y + dy!))
    || layout.roads.some((road) => distanceToRoad(road, { x, y }) <= road.halfWidth + 12)
    || buildings.some((building) => x >= building.col * cell - 6 && x <= (building.col + building.cols) * cell + 6 && y >= building.row * cell - 6 && y <= (building.row + building.rows) * cell + 6));
  terrain.bridges = zones.bridges;
  return { terrain, kinds, lanes, layoutVersion: version, layout, settingId: settingForSeed(seed, country), season, weather: weatherForSeed(seed, country, season), seed, zones, buildings,
    ...(country === undefined ? {} : { campaignCountry: country, localLanguage: campaignSectorForSeed(country, seed).language }) };
}

/**
 * What the ground at a point costs whoever is standing on it. Solid terrain is
 * not handled here: a unit can never be inside it. Anything that is not water or
 * mud is firm ground, so the common case is free.
 */
export function terrainEffectsAt(zones: TerrainData['zones'], seed: number, pos: Vec2): TerrainEffects {
  if (isBridgeAt(zones, seed, pos.x, pos.y)) return CONFIG.terrain.effects.bridge;
  if (isRapidsAt(zones, seed, pos.x, pos.y)) return CONFIG.terrain.effects.rapids;
  if (isRiverAt(zones, seed, pos.x, pos.y)) return CONFIG.terrain.effects.river;
  if (isRoadAt(zones, pos.x, pos.y)) return CONFIG.terrain.effects.road;
  if (isMudAt(zones, pos.x, pos.y)) return CONFIG.terrain.effects.mud;
  return FIRM_GROUND;
}

/** Firm ground: no penalty at all, shared so callers never allocate one. */
const FIRM_GROUND: TerrainEffects = { speedMult: 1, accuracyMult: 1, reloadMult: 1 };

/** Find the nearest unblocked cell center to a point, or null if none within radius cells. */
export function nearestOpenCell(terrain: Terrain, pos: Vec2, maxRadiusCells: number): Vec2 | null {
  const col = posToCol(terrain, pos.x);
  const row = posToRow(terrain, pos.y);
  if (!isCellBlocked(terrain, col, row)) return cellCenter(terrain, col, row);
  for (let r = 1; r <= maxRadiusCells; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        if (!isCellBlocked(terrain, col + dc, row + dr)) {
          return cellCenter(terrain, col + dc, row + dr);
        }
      }
    }
  }
  return null;
}

/**
 * Line of sight: sample along the segment; solid cells block sight, except
 * low fence cells, which soldiers can fire over.
 */
export function hasLineOfSight(terrain: Terrain, from: Vec2, to: Vec2, fromEye = 12, toEye = 12, ignoredBuildings: readonly number[] = []): boolean {
  if (!elevationLineOfSight(terrain, from, to, fromEye, toEye)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  const cell = terrain.cell;
  const startCol = posToCol(terrain, from.x);
  const startRow = posToRow(terrain, from.y);
  const endCol = posToCol(terrain, to.x);
  const endRow = posToRow(terrain, to.y);
  const steps = Math.max(1, Math.ceil(dist / (cell / 3)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const col = posToCol(terrain, x);
    const row = posToRow(terrain, y);
    if (col === startCol && row === startRow) continue;
    if (col === endCol && row === endRow) continue;
    const index = row * terrain.cols + col;
    const kind = terrain.kinds?.[index];
    if (isCellBlocked(terrain, col, row) && kind !== TERRAIN_KIND.stoneFence && kind !== TERRAIN_KIND.woodFence) {
      const building = terrain.buildings?.find((b) => !b.destroyed && containsBuilding(b, { x, y }, cell));
      if (building) {
        if (ignoredBuildings.includes(building.id)) continue;
        const shotHeight = (elevationAt(terrain, from.x, from.y) + fromEye) * (1 - t) + (elevationAt(terrain, to.x, to.y) + toEye) * t;
        const roofHeight = elevationAt(terrain, building.pos.x + building.cols * cell / 2, building.pos.y + building.rows * cell / 2) + buildingArchitecture(building).floors * FLOOR_HEIGHT;
        if (shotHeight > roofHeight + 3) continue;
      }
      return false;
    }
  }
  return true;
}

/** Count unique foliage cells crossed by a shot; a single tree row only obscures. */
export function foliageAlongLine(terrain: Terrain, kinds: Uint8Array, from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return 0;
  const steps = Math.max(1, Math.ceil(distance / (terrain.cell / 3)));
  const startCol = posToCol(terrain, from.x);
  const startRow = posToRow(terrain, from.y);
  const endCol = posToCol(terrain, to.x);
  const endRow = posToRow(terrain, to.y);
  const seen = new Set<number>();
  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    const col = posToCol(terrain, from.x + dx * t);
    const row = posToRow(terrain, from.y + dy * t);
    if ((col === startCol && row === startRow) || (col === endCol && row === endRow)) continue;
    const index = row * terrain.cols + col;
    if (isFoliageKind(kinds[index] ?? TERRAIN_KIND.open)) seen.add(index);
  }
  return seen.size;
}
