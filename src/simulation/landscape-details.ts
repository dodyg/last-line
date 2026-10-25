import { CONFIG } from '../content/config';
import type { CampaignCountry, Vec2 } from './types';
import { deriveRng, rngRange } from './rng';
import { isBridgeAt, isRiverAt, TERRAIN_KIND, type GeneratedBuilding, type LandscapeLayout, type TerrainData } from './terrain';

export interface LandscapeLot {
  building: number;
  use: 'garden' | 'farmyard' | 'churchyard';
  col: number; row: number; cols: number; rows: number;
  entrance: Vec2;
  path: Vec2[];
}

export interface DefensivePosition {
  pos: Vec2;
  facing: 'north';
  cover: number[];
  approach: Vec2;
}

/** Project onto segments, so doors connect to the actual street, including bends. */
export function nearestRoadPoint(layout: LandscapeLayout, point: Vec2): Vec2 {
  let best = point, distance = Infinity;
  for (const road of layout.roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(1, dx * dx + dy * dy)));
    const candidate = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (d < distance) { best = candidate; distance = d; }
  }
  return best;
}

/** Back lots are real open ground with gated boundaries, never overlapping roads or houses. */
export function planLots(data: TerrainData, reserved: Uint8Array): LandscapeLot[] {
  const { terrain, buildings, layout } = data;
  if (!layout) return [];
  const { cell, cols, rows } = terrain;
  const used = new Set<number>();
  const lots: LandscapeLot[] = [];
  buildings.forEach((building, index) => {
    const center = { x: (building.col + building.cols / 2) * cell, y: (building.row + building.rows / 2) * cell };
    const road = nearestRoadPoint(layout, center);
    const horizontal = Math.abs(road.x - center.x) > Math.abs(road.y - center.y);
    const side = horizontal ? Math.sign(road.x - center.x) || 1 : Math.sign(road.y - center.y) || 1;
    const entrance = horizontal ? { x: center.x + side * building.cols * cell / 2, y: center.y }
      : { x: center.x, y: center.y + side * building.rows * cell / 2 };
    const back = horizontal ? { dx: -side, dy: 0 } : { dx: 0, dy: -side };
    const directions = [back, { dx: back.dy, dy: back.dx }, { dx: -back.dy, dy: -back.dx }];
    for (const direction of directions) for (const depth of [3, 2]) {
      const lotCols = direction.dx ? depth : building.cols;
      const lotRows = direction.dy ? depth : building.rows;
      const col = direction.dx < 0 ? building.col - lotCols : direction.dx > 0 ? building.col + building.cols : building.col;
      const row = direction.dy < 0 ? building.row - lotRows : direction.dy > 0 ? building.row + building.rows : building.row;
      const cells: number[] = [];
      let valid = true;
      for (let r = row; r < row + lotRows; r++) for (let c = col; c < col + lotCols; c++) {
        const i = r * cols + c;
        if (c < 3 || c >= cols - 3 || r < CONFIG.terrain.protectedTopRows || r >= rows - CONFIG.terrain.protectedBottomRows
          || r * cell >= CONFIG.deploymentZone.yMin - cell || reserved[i] || terrain.blocked[i] || used.has(i)
          || buildings.some((b) => c >= b.col && c < b.col + b.cols && r >= b.row && r < b.row + b.rows)
          || isRiverAt(data.zones, data.seed, (c + .5) * cell, (r + .5) * cell)) valid = false;
        cells.push(i);
      }
      if (!valid) continue;
      cells.forEach((i) => used.add(i));
      lots.push({ building: index, use: building.kind === 'church' ? 'churchyard' : building.kind === 'barn' ? 'farmyard' : 'garden', col, row, cols: lotCols, rows: lotRows, entrance, path: [entrance, nearestRoadPoint(layout, entrance)] });
      return;
    }
  });
  return lots;
}

/** Each cover line has a walkable rear and a two-cell flank opening. */
export function addDefensivePositions(data: TerrainData, reserved: Uint8Array, lotCells: Set<number>): DefensivePosition[] {
  const { terrain, layout, seed, zones } = data;
  if (!layout) return [];
  const { cell, cols, rows } = terrain;
  const rng = deriveRng(seed, 0x44454650);
  const targets: Vec2[] = [
    ...zones.bridges.map((bridge) => ({ x: bridge.x + (bridge.axis === 'vertical' ? cell * 3 : 0), y: bridge.y + bridge.halfLength + cell * 2 })),
    { x: CONFIG.field.width * .18, y: CONFIG.deploymentZone.yMin - cell * 4 },
    { x: CONFIG.field.width * .56, y: CONFIG.deploymentZone.yMin - cell * 5 },
  ];
  const positions: DefensivePosition[] = [];
  for (const target of targets.slice(0, 5)) {
    for (let attempt = 0; attempt < 160; attempt++) {
      const col = Math.floor((target.x + rngRange(rng, -168, 168)) / cell);
      const row = Math.floor((target.y + rngRange(rng, -96, 96)) / cell);
      if (col < 5 || col >= cols - 6 || row < CONFIG.terrain.protectedTopRows + 2 || row >= Math.min(rows - CONFIG.terrain.protectedBottomRows - 2, CONFIG.deploymentZone.yMin / cell - 1)) continue;
      if (positions.some((position) => Math.hypot(position.pos.x - (col + .5) * cell, position.pos.y - (row + .5) * cell) < cell * 5)) continue;
      const footprint: number[] = [];
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 3; dc++) footprint.push((row + dr) * cols + col + dc);
      if (footprint.some((i) => reserved[i] || lotCells.has(i) || terrain.blocked[i]
        || data.buildings.some((b) => i % cols >= b.col - 1 && i % cols <= b.col + b.cols && Math.floor(i / cols) >= b.row - 1 && Math.floor(i / cols) <= b.row + b.rows)
        || isRiverAt(zones, seed, (i % cols + .5) * cell, (Math.floor(i / cols) + .5) * cell))) continue;
      const cover = [-2, -1, 0, 1].map((dc) => row * cols + col + dc);
      for (const i of cover) {
        data.kinds[i] = TERRAIN_KIND.stoneFence; terrain.blocked[i] = 1;
      }
      // The offset foliage lane trades concealment and slower movement for the exposed front.
      for (let dr = -2; dr <= 2; dr++) data.kinds[(row + dr) * cols + col + 3] = TERRAIN_KIND.shrub;
      positions.push({ pos: { x: (col + .5) * cell, y: (row + 1.5) * cell }, facing: 'north', cover, approach: { x: (col + 3.5) * cell, y: (row + 1.5) * cell } });
      break;
    }
  }
  return positions;
}

/** Candidate priority forms village clusters and pairs barns with nearby houses. */
export function settlementScore(building: Pick<GeneratedBuilding, 'col' | 'row'>, placed: GeneratedBuilding[], village: boolean, seed: number): number {
  if (!placed.length) return 0;
  const neighbors = placed.map((other) => Math.hypot(other.col - building.col, other.row - building.row));
  const spacing = village ? 5 + seed % 3 : 6;
  return Math.min(...neighbors.map((distance) => Math.abs(distance - spacing)));
}

export function regionalRelief(country?: CampaignCountry): number {
  return country === 'netherlands' ? .2 : country === 'italy' ? 1.2 : country === 'luxembourg' ? 1.1 : 1;
}

/** A road can graze a tributary without intersecting its centreline. Fit its entire wet run. */
export function fitRoadBridges(seed: number, zones: TerrainData['zones'], layout: LandscapeLayout, country?: CampaignCountry): void {
  if (!zones.river) return;
  for (const road of layout.roads) {
    let run: Vec2[] = [];
    const flush = () => {
      if (!run.length) return;
      const points = run; run = [];
      if (points.every((point) => isBridgeAt(zones, seed, point.x, point.y))) return;
      const minX = Math.min(...points.map((p) => p.x)), maxX = Math.max(...points.map((p) => p.x));
      const minY = Math.min(...points.map((p) => p.y)), maxY = Math.max(...points.map((p) => p.y));
      const axis = maxX - minX >= maxY - minY ? 'horizontal' : 'vertical';
      const x = (minX + maxX) / 2, y = (minY + maxY) / 2;
      const halfLength = (axis === 'horizontal' ? maxX - minX : maxY - minY) / 2 + 12;
      const halfWidth = (axis === 'horizontal' ? maxY - minY : maxX - minX) / 2 + road.halfWidth + 4;
      const existing = zones.bridges.find((bridge) => bridge.axis === axis
        && Math.abs(axis === 'horizontal' ? bridge.x - x : bridge.y - y) <= bridge.halfLength + halfLength
        && Math.abs(axis === 'horizontal' ? bridge.y - y : bridge.x - x) <= bridge.halfWidth + halfWidth);
      if (existing) {
        const alongLow = Math.min((axis === 'horizontal' ? existing.x : existing.y) - existing.halfLength, (axis === 'horizontal' ? x : y) - halfLength);
        const alongHigh = Math.max((axis === 'horizontal' ? existing.x : existing.y) + existing.halfLength, (axis === 'horizontal' ? x : y) + halfLength);
        const acrossLow = Math.min((axis === 'horizontal' ? existing.y : existing.x) - existing.halfWidth, (axis === 'horizontal' ? y : x) - halfWidth);
        const acrossHigh = Math.max((axis === 'horizontal' ? existing.y : existing.x) + existing.halfWidth, (axis === 'horizontal' ? y : x) + halfWidth);
        existing.x = axis === 'horizontal' ? (alongLow + alongHigh) / 2 : (acrossLow + acrossHigh) / 2;
        existing.y = axis === 'vertical' ? (alongLow + alongHigh) / 2 : (acrossLow + acrossHigh) / 2;
        existing.halfLength = (alongHigh - alongLow) / 2; existing.halfWidth = (acrossHigh - acrossLow) / 2;
      } else zones.bridges.push({ x, y, axis, halfLength, halfWidth, type: country === 'netherlands' ? 'pontoon' : 'timber' });
    };
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
      for (let step = 0; step < steps; step++) {
        const point = { x: a.x + (b.x - a.x) * step / steps, y: a.y + (b.y - a.y) * step / steps };
        if (isRiverAt(zones, seed, point.x, point.y)) run.push(point); else flush();
      }
    }
    flush();
  }
  // A dry cross street can also meet a bridge's side before reaching the water.
  // Such junctions need an open low platform rather than an impassable side rail.
  for (const bridge of zones.bridges) for (const road of layout.roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const axis = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
      if (axis === bridge.axis) continue;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
      for (let step = 0; step <= steps; step++) {
        const x = a.x + dx * step / steps, y = a.y + dy * step / steps;
        const along = bridge.axis === 'horizontal' ? x - bridge.x : y - bridge.y;
        const across = bridge.axis === 'horizontal' ? y - bridge.y : x - bridge.x;
        if (Math.abs(along) <= bridge.halfLength && Math.abs(across) <= bridge.halfWidth) {
          bridge.junction = true; bridge.type = 'pontoon'; break;
        }
      }
    }
  }
  // Overlapping road crossings form one low platform. Mixed raised slabs would
  // leave a height discontinuity and invisible side rails at the intersection.
  for (const a of zones.bridges) for (const b of zones.bridges) {
    if (a === b) continue;
    const ax = a.axis === 'horizontal' ? a.halfLength : a.halfWidth;
    const ay = a.axis === 'vertical' ? a.halfLength : a.halfWidth;
    const bx = b.axis === 'horizontal' ? b.halfLength : b.halfWidth;
    const by = b.axis === 'vertical' ? b.halfLength : b.halfWidth;
    if (Math.abs(a.x - b.x) >= ax + bx || Math.abs(a.y - b.y) >= ay + by) continue;
    a.junction = b.junction = true; a.type = b.type = 'pontoon';
  }
}
