import { describe, expect, it } from 'vitest';
import { fenceSegments } from '../src/render/app/fences';
import { TERRAIN_KIND } from '../src/simulation/terrain';
import type { Terrain } from '../src/simulation/types';

function fixture(cells: Array<[number, number, number]>) {
  const terrain: Terrain = { cols: 8, rows: 8, cell: 24, blocked: new Uint8Array(64) };
  const kinds = new Uint8Array(64);
  cells.forEach(([col, row, kind]) => { kinds[row * terrain.cols + col] = kind; terrain.blocked[row * terrain.cols + col] = 1; });
  return (col: number, row: number) => fenceSegments(terrain, kinds, col, row);
}

const wood = TERRAIN_KIND.woodFence, stone = TERRAIN_KIND.stoneFence;

describe('fence boundary connections', () => {
  it('runs east-west sections along their neighbors rather than perpendicular to them', () => {
    const segments = fixture([[1, 2, wood], [2, 2, wood], [3, 2, wood]]);
    expect(segments(2, 2)).toEqual([{ from: { x: 48, y: 60 }, to: { x: 72, y: 60 } }]);
    expect(segments(1, 2)[0]!.to).toEqual(segments(2, 2)[0]!.from);
    expect(segments(2, 2)[0]!.to).toEqual(segments(3, 2)[0]!.from);
  });

  it('runs north-south sections along their neighbors', () => {
    const segments = fixture([[2, 1, stone], [2, 2, stone], [2, 3, stone]]);
    expect(segments(2, 2)).toEqual([{ from: { x: 60, y: 48 }, to: { x: 60, y: 72 } }]);
    expect(segments(2, 1)[0]!.to).toEqual(segments(2, 2)[0]!.from);
  });

  it('keeps wood-to-stone transitions aligned', () => {
    const segments = fixture([[1, 2, wood], [2, 2, stone]]);
    expect(segments(1, 2)[0]!.to).toEqual(segments(2, 2)[0]!.from);
    const vertical = fixture([[2, 1, stone], [2, 2, wood]]);
    expect(vertical(2, 1)[0]!.to).toEqual(vertical(2, 2)[0]!.from);
  });

  it('joins both arms of a corner without extending through the open quadrant', () => {
    const segments = fixture([[1, 2, wood], [2, 2, wood], [2, 3, stone]]);
    expect(segments(2, 2)).toEqual([
      { from: { x: 60, y: 60 }, to: { x: 48, y: 60 } },
      { from: { x: 60, y: 60 }, to: { x: 60, y: 72 } },
    ]);
  });

  it('connects every arm of a junction, including a hedgerow boundary', () => {
    const segments = fixture([[1, 2, wood], [2, 2, wood], [3, 2, stone], [2, 1, TERRAIN_KIND.trees]]);
    const junction = segments(2, 2);
    expect(junction).toHaveLength(3);
    expect(junction.map((segment) => segment.to)).toEqual([{ x: 48, y: 60 }, { x: 72, y: 60 }, { x: 60, y: 48 }]);
  });

  it('orients isolated sections using the run across a gate without bridging the opening', () => {
    const segments = fixture([[2, 1, wood], [2, 5, stone]]);
    expect(segments(2, 1)).toEqual([{ from: { x: 60, y: 24 }, to: { x: 60, y: 48 } }]);
    expect(segments(2, 5)).toEqual([{ from: { x: 60, y: 120 }, to: { x: 60, y: 144 } }]);
  });

  it('does not mistake the opposite map edge for a neighboring cell', () => {
    const segments = fixture([[7, 0, wood], [0, 1, wood]]);
    expect(segments(0, 1)).toEqual([{ from: { x: 0, y: 36 }, to: { x: 24, y: 36 } }]);
  });
});
