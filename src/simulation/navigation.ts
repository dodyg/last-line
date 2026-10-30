import type { BridgePosition, Terrain, Vec2 } from './types';
import { cellCenter, isBlockedAt, isCellBlocked, posToCol, posToRow } from './terrain';
import { elevationTraversal, type TraversalMode } from './elevation';
import { bridgeContains, bridgeKey, bridgeTraversal } from './bridges';

/**
 * Compact grid A* with 8-directional movement and no corner cutting.
 * A stable min-heap keeps pending-node selection logarithmic while preserving
 * insertion order for equal scores, so route choices remain deterministic.
 */

interface Node {
  idx: number;
  g: number;
  f: number;
  order: number;
}

function precedes(a: Node, b: Node): boolean {
  return a.f < b.f || (a.f === b.f && a.order < b.order);
}

function pushOpen(open: Node[], node: Node): void {
  let index = open.length;
  open.push(node);
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (!precedes(node, open[parent]!)) break;
    open[index] = open[parent]!;
    index = parent;
  }
  open[index] = node;
}

function popOpen(open: Node[]): Node {
  const first = open[0]!;
  const last = open.pop()!;
  if (open.length === 0) return first;
  let index = 0;
  while (index * 2 + 1 < open.length) {
    let child = index * 2 + 1;
    if (child + 1 < open.length && precedes(open[child + 1]!, open[child]!)) child++;
    if (!precedes(open[child]!, last)) break;
    open[index] = open[child]!;
    index = child;
  }
  open[index] = last;
  return first;
}

const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

export interface PathResult {
  waypoints: Vec2[];
  reachable: boolean;
}

/**
 * Find a path of cell centers from start to goal. Returns reachable=false
 * when the goal is solid-blocked with no open neighbor or the flood fails.
 */
export function findPath(terrain: Terrain, start: Vec2, goal: Vec2, cellCostMultiplier?: (pos: Vec2, passage?: BridgePosition) => number, mode: TraversalMode = 'infantry', startBridge?: BridgePosition): PathResult {
  const { cols, rows, blocked } = terrain;
  const startCol = posToCol(terrain, start.x);
  const startRow = posToRow(terrain, start.y);
  let goalCol = posToCol(terrain, goal.x);
  let goalRow = posToRow(terrain, goal.y);
  let destination = goal;

  if (isCellBlocked(terrain, goalCol, goalRow)) {
    const nearest = nudgeToOpen(terrain, goalCol, goalRow);
    if (nearest === null) return { waypoints: [], reachable: false };
    goalCol = nearest.col;
    goalRow = nearest.row;
    destination = cellCenter(terrain, goalCol, goalRow);
  }

  const layers = terrain.bridges?.length ? 2 : 1;
  const startCell = startRow * cols + startCol, goalCell = goalRow * cols + goalCol;
  const startDeck = startBridge?.level === 'deck' || (!startBridge && terrain.bridges?.some((bridge) => bridgeContains(bridge, start)));
  const startIdx = startCell * layers + (layers === 2 && startDeck ? 1 : 0);
  if (startCell === goalCell && bridgeTraversal(terrain, start, destination, startBridge, mode).allowed) return { waypoints: [{ ...destination }], reachable: elevationTraversal(terrain, start, destination, mode).allowed };

  const total = cols * rows * layers;
  const gScore = new Float32Array(total).fill(Infinity);
  const cameFrom = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);

  const open: Node[] = [];
  let order = 0;
  gScore[startIdx] = 0;
  pushOpen(open, { idx: startIdx, g: 0, f: octile(startCol, startRow, goalCol, goalRow), order: order++ });

  const goalCenter = cellCenter(terrain, goalCol, goalRow);
  let goalIdx = -1;

  while (open.length > 0) {
    const current = popOpen(open);
    const currentCell = Math.floor(current.idx / layers);
    closed[current.idx] = 1;
    const col = currentCell % cols;
    const row = Math.floor(currentCell / cols);
    const from = current.idx === startIdx ? start : cellCenter(terrain, col, row);
    const currentBridge = terrain.bridges?.find((bridge) => bridgeContains(bridge, from));
    const passage = current.idx === startIdx ? startBridge : currentBridge
      ? { key: bridgeKey(currentBridge), level: current.idx % layers === 1 ? 'deck' as const : 'under' as const } : undefined;
    if (currentCell === goalCell && bridgeTraversal(terrain, from, goalCenter, passage, mode).allowed) { goalIdx = current.idx; break; }

    for (const [dc, dr, cost] of NEIGHBORS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const nextCell = nr * cols + nc;
      if (blocked[nextCell] === 1) continue;
      // No corner cutting: diagonal requires both orthogonal neighbors open.
      if (dc !== 0 && dr !== 0) {
        if (blocked[row * cols + nc] === 1 || blocked[nr * cols + col] === 1) continue;
      }
      const to = cellCenter(terrain, nc, nr);
      const crossing = bridgeTraversal(terrain, from, to, passage, mode);
      if (!crossing.allowed) continue;
      const nIdx = nextCell * layers + (layers === 2 && crossing.position?.level === 'deck' ? 1 : 0);
      if (closed[nIdx] === 1) continue;
      const traversal = elevationTraversal(terrain, from, to, mode);
      if (!traversal.allowed) continue;
      const terrainCost = cellCostMultiplier === undefined ? 1 : Math.max(1, cellCostMultiplier(to, crossing.position));
      const tentative = current.g + cost * terrainCost * traversal.cost;
      const existing = gScore[nIdx] ?? Infinity;
      if (tentative < existing) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = current.idx;
        pushOpen(open, { idx: nIdx, g: tentative, f: tentative + octile(nc, nr, goalCol, goalRow), order: order++ });
      }
    }
  }

  if (goalIdx === -1) {
    return { waypoints: [], reachable: false };
  }

  // Reconstruct cell-center path.
  const cells: number[] = [];
  let cur = goalIdx;
  while (cur !== startIdx && cur !== -1) {
    cells.push(Math.floor(cur / layers));
    cur = cameFrom[cur] as number;
  }
  cells.reverse();

  // Light string-pulling: skip intermediate waypoints reachable in a straight line.
  const raw: Vec2[] = cells.map((idx) => cellCenter(terrain, idx % cols, Math.floor(idx / cols)));
  raw.push(goalCenter);

  if (cellCostMultiplier !== undefined || terrain.elevation !== undefined || layers === 2) return { waypoints: raw, reachable: true };

  const pulled: Vec2[] = [];
  let anchor = { x: start.x, y: start.y };
  let i = 0;
  while (i < raw.length) {
    let furthest = i;
    for (let j = raw.length - 1; j > i; j--) {
      if (segmentClear(terrain, anchor, raw[j] as Vec2)) {
        furthest = j;
        break;
      }
    }
    pulled.push(raw[furthest] as Vec2);
    anchor = raw[furthest] as Vec2;
    i = furthest + 1;
  }
  return { waypoints: pulled, reachable: true };
}

function nudgeToOpen(terrain: Terrain, col: number, row: number): { col: number; row: number } | null {
  for (let r = 1; r <= 4; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        if (isCellBlocked(terrain, col + dc, row + dr)) continue;
        return { col: col + dc, row: row + dr };
      }
    }
  }
  return null;
}

/** Walkable-line test used for string pulling (finer sampling than LOS). */
function segmentClear(terrain: Terrain, from: Vec2, to: Vec2): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / (terrain.cell / 3)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (isBlockedAt(terrain, from.x + dx * t, from.y + dy * t)) return false;
  }
  return true;
}
