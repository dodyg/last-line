import { CONFIG } from '../../content/config';
import { deriveRng, rngRange } from '../../simulation/rng';
import { isDeciduousKind, isRapidsAt, isRiverAt, mudPatchDistance, riverHalfWidthAtPoint, riverPathPoints, TERRAIN_KIND, type TerrainData, type TerrainZone } from '../../simulation/terrain';
import { seasonPalette } from './season-palette';
import { roadBasePasses } from '../../game/road-drawing';
import type { Vec2 } from '../../simulation/types';

/** Follow the simulation's continuous banks rather than its cell-center samples. */
export function riverOutline(data: TerrainData, widthScale = 1, padding = 0): Vec2[] {
  const river = data.zones.river;
  if (river === null) return [];
  const points = riverPathPoints(river, data.seed, 4);
  const normal = river.orientation === 'vertical' ? { x: 1, y: 0 }
    : river.orientation === 'diagonal' ? { x: -(river.diagonalSlope ?? 1) / Math.SQRT2, y: 1 / Math.SQRT2 }
      : { x: 0, y: 1 };
  const side = (sign: number): Vec2[] => points.map((point) => {
    const width = riverHalfWidthAtPoint(river, data.seed, point.x, point.y) * widthScale + padding;
    return { x: point.x + normal.x * width * sign, y: point.y + normal.y * width * sign };
  });
  return [...side(1), ...side(-1).reverse()];
}

/** Read the same irregular mud boundary used by movement and accuracy checks. */
export function mudOutline(patch: TerrainZone): Vec2[] {
  return Array.from({ length: 96 }, (_, i) => {
    const angle = i / 96 * Math.PI * 2;
    let low = 0, high = 1.01;
    for (let step = 0; step < 16; step++) {
      const radius = (low + high) / 2;
      const x = patch.cx + Math.cos(angle) * patch.halfLength * radius;
      const y = patch.cy + Math.sin(angle) * patch.halfWidth * radius;
      if (mudPatchDistance(patch, x, y) <= 1) low = radius;
      else high = radius;
    }
    return { x: patch.cx + Math.cos(angle) * patch.halfLength * low, y: patch.cy + Math.sin(angle) * patch.halfWidth * low };
  });
}

function polygon(points: readonly Vec2[]): Path2D {
  const path = new Path2D();
  points.forEach((point, i) => i === 0 ? path.moveTo(point.x, point.y) : path.lineTo(point.x, point.y));
  path.closePath();
  return path;
}

function polyline(points: readonly Vec2[]): Path2D {
  const path = new Path2D();
  points.forEach((point, i) => i === 0 ? path.moveTo(point.x, point.y) : path.lineTo(point.x, point.y));
  return path;
}

/** Bake a detailed surface once per map; dynamic effects and units remain 3D. */
export function terrainSurfaceCanvas(data: TerrainData): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1536;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const width = CONFIG.field.width, height = CONFIG.field.height;
  const scale = canvas.width / width;
  ctx.scale(scale, scale);
  const rng = deriveRng(data.seed, 0x53555246);
  const palette = seasonPalette(data.season);
  const color = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

  // Broad, filtered color variation avoids both a flat fill and a visible grid.
  const grass = document.createElement('canvas');
  grass.width = 40; grass.height = 30;
  const grassCtx = grass.getContext('2d')!;
  for (let y = 0; y < grass.height; y++) for (let x = 0; x < grass.width; x++) {
    const shade = Math.floor(rngRange(rng, -7, 7));
    grassCtx.fillStyle = `rgb(${palette.ground[0] + shade},${palette.ground[1] + shade},${palette.ground[2] + shade})`;
    grassCtx.fillRect(x, y, 1, 1);
  }
  ctx.drawImage(grass, 0, 0, width, height);

  // Agricultural parcels stay orderly, with fine crop rows and softened edges.
  for (const field of data.layout?.fields ?? []) {
    const x = field.col * data.terrain.cell, y = field.row * data.terrain.cell;
    const w = field.cols * data.terrain.cell, h = field.rows * data.terrain.cell;
    const shape = new Path2D(); shape.roundRect(x, y, w, h, 5);
    ctx.save();
    ctx.fillStyle = field.crop === 'ploughed' ? palette.ploughed : field.crop === 'wheat' ? palette.wheat : field.crop === 'orchard' ? palette.orchard : palette.pasture;
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 5 * scale;
    ctx.fill(shape); ctx.shadowBlur = 0;
    ctx.clip(shape);
    ctx.strokeStyle = field.crop === 'ploughed' ? 'rgba(40,32,24,.24)' : 'rgba(49,57,29,.16)';
    ctx.lineWidth = .8;
    for (let row = 4; row < (field.vertical ? w : h); row += field.crop === 'orchard' ? 18 : 5) {
      ctx.beginPath();
      if (field.vertical) { ctx.moveTo(x + row, y); ctx.lineTo(x + row, y + h); }
      else { ctx.moveTo(x, y + row); ctx.lineTo(x + w, y + row); }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Feather the small farmyards and retain legacy field/road markings on old maps.
  for (const kind of [TERRAIN_KIND.farmyard, ...(data.layout ? [] : [TERRAIN_KIND.crops, TERRAIN_KIND.orchard, TERRAIN_KIND.road])]) {
    const mask = document.createElement('canvas'); mask.width = canvas.width; mask.height = canvas.height;
    const maskCtx = mask.getContext('2d')!;
    maskCtx.scale(scale, scale);
    maskCtx.fillStyle = kind === TERRAIN_KIND.farmyard ? palette.yard : kind === TERRAIN_KIND.road ? '#8d7f62' : palette.wheat;
    for (let i = 0; i < data.kinds.length; i++) if (data.kinds[i] === kind) {
      maskCtx.fillRect((i % data.terrain.cols) * data.terrain.cell, Math.floor(i / data.terrain.cols) * data.terrain.cell, data.terrain.cell, data.terrain.cell);
    }
    ctx.save(); ctx.filter = 'blur(4px)'; ctx.drawImage(mask, 0, 0, width, height); ctx.restore();
  }

  for (const patch of data.zones.mud) {
    const shape = polygon(mudOutline(patch));
    ctx.save();
    ctx.fillStyle = palette.mud; ctx.shadowColor = palette.mud; ctx.shadowBlur = 5 * scale;
    ctx.fill(shape); ctx.shadowBlur = 0; ctx.clip(shape);
    for (let dot = 0; dot < 160; dot++) {
      ctx.fillStyle = dot % 3 === 0 ? 'rgba(148,134,99,.14)' : 'rgba(40,38,31,.12)';
      ctx.beginPath();
      ctx.ellipse(rngRange(rng, patch.cx - patch.halfLength, patch.cx + patch.halfLength), rngRange(rng, patch.cy - patch.halfWidth, patch.cy + patch.halfWidth), rngRange(rng, 1, 6), rngRange(rng, .3, 1.6), -.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  const roads = data.layout?.roads ?? data.zones.roads ?? [];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const pass of roadBasePasses(roads)) {
    ctx.strokeStyle = pass.layer === 'shoulder' ? palette.shoulder : color(pass.color);
    ctx.lineWidth = pass.width;
    ctx.save();
    if (pass.layer === 'shoulder') { ctx.shadowColor = palette.shoulder; ctx.shadowBlur = 3 * scale; }
    ctx.stroke(polyline(pass.road.points)); ctx.restore();
  }
  // Keep tire wear narrow and understated; intersections remain one surface.
  for (const road of roads) {
    const path = polyline(road.points);
    ctx.save();
    ctx.strokeStyle = road.surface === 'cobble' ? 'rgba(59,57,48,.1)' : 'rgba(191,174,134,.15)';
    ctx.lineWidth = road.halfWidth * .85;
    ctx.stroke(path); ctx.restore();
  }

  if (palette.snowCover > 0) {
    // Ground snow survives clear weather; exposed tracks keep roads readable.
    ctx.save(); ctx.fillStyle = color(palette.snow); ctx.globalAlpha = palette.snowCover;
    ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
    const snowRng = deriveRng(data.seed, 0x534e4f47);
    for (let patch = 0; patch < 700; patch++) {
      ctx.fillStyle = patch % 3 ? 'rgba(255,255,255,.12)' : 'rgba(112,132,139,.08)';
      ctx.beginPath(); ctx.ellipse(rngRange(snowRng, 0, width), rngRange(snowRng, 0, height), rngRange(snowRng, 4, 22), rngRange(snowRng, 2, 7), -.3, 0, Math.PI * 2); ctx.fill();
    }
    for (const road of roads) {
      ctx.strokeStyle = 'rgba(119,117,103,.48)'; ctx.lineWidth = road.halfWidth * .85;
      ctx.stroke(polyline(road.points));
    }
    ctx.restore();
  }

  if (data.season === 'autumn') {
    const leaves = deriveRng(data.seed, 0x4c454146);
    for (let i = 0; i < data.kinds.length; i++) {
      if (!isDeciduousKind(data.kinds[i]!)) continue;
      for (let leaf = 0; leaf < 12; leaf++) {
        ctx.fillStyle = ['#b67c39', '#976035', '#c69b48'][leaf % 3]!;
        ctx.globalAlpha = .42;
        ctx.fillRect((i % data.terrain.cols + .5) * data.terrain.cell + rngRange(leaves, -14, 14), (Math.floor(i / data.terrain.cols) + .5) * data.terrain.cell + rngRange(leaves, -14, 14), 1.3, .8);
      }
    }
    ctx.globalAlpha = 1;
  }

  if (data.zones.river) {
    const bank = polygon(riverOutline(data, 1, 5));
    const water = polygon(riverOutline(data));
    ctx.save();
    ctx.fillStyle = palette.bank; ctx.shadowColor = palette.bank; ctx.shadowBlur = 5 * scale;
    ctx.fill(bank); ctx.shadowBlur = 0;
    // Tributary caps are round and merge into the main channel.
    for (const branch of data.zones.river.branches ?? []) {
      ctx.lineWidth = branch.halfWidth * 2 + 10; ctx.strokeStyle = palette.bank;
      ctx.stroke(polyline(branch.points));
    }
    ctx.fillStyle = '#527472'; ctx.fill(water);
    for (const branch of data.zones.river.branches ?? []) {
      ctx.lineWidth = branch.halfWidth * 2; ctx.strokeStyle = '#527472'; ctx.stroke(polyline(branch.points));
    }
    ctx.fillStyle = '#3c6269'; ctx.fill(polygon(riverOutline(data, .76)));
    for (const branch of data.zones.river.branches ?? []) {
      ctx.lineWidth = branch.halfWidth * 1.5; ctx.strokeStyle = '#3c6269'; ctx.stroke(polyline(branch.points));
    }
    ctx.fillStyle = 'rgba(41,75,87,.42)'; ctx.fill(polygon(riverOutline(data, .42)));
    // Fine ripples and pale rapid streaks follow the real water footprint.
    for (let dot = 0; dot < 2800; dot++) {
      const x = rngRange(rng, 0, width), y = rngRange(rng, 0, height);
      if (!isRiverAt(data.zones, data.seed, x, y)) continue;
      const rapid = isRapidsAt(data.zones, data.seed, x, y);
      ctx.strokeStyle = rapid ? 'rgba(201,218,200,.65)' : 'rgba(158,188,179,.2)';
      ctx.lineWidth = rapid ? .9 : .45;
      ctx.beginPath(); ctx.moveTo(x, y);
      const vertical = data.zones.river.orientation === 'vertical';
      ctx.lineTo(x + (vertical ? .6 : rngRange(rng, 1, 5)), y + (vertical ? rngRange(rng, 1, 5) : .4)); ctx.stroke();
    }
    ctx.restore();
  }

  // Subtle contour edges distinguish terraces from ordinary changes in grass.
  const elevation = data.terrain.elevation;
  if (elevation) {
    ctx.strokeStyle = 'rgba(64,53,36,.19)'; ctx.lineWidth = .6;
    for (const level of [18, 38, 58]) {
      ctx.beginPath();
      for (let row = 0; row + 1 < elevation.rows; row++) for (let col = 0; col + 1 < elevation.cols; col++) {
        const i = row * elevation.cols + col;
        const corners = [
          { x: col * elevation.cell, y: row * elevation.cell, h: elevation.heights[i]! },
          { x: (col + 1) * elevation.cell, y: row * elevation.cell, h: elevation.heights[i + 1]! },
          { x: col * elevation.cell, y: (row + 1) * elevation.cell, h: elevation.heights[i + elevation.cols]! },
          { x: (col + 1) * elevation.cell, y: (row + 1) * elevation.cell, h: elevation.heights[i + elevation.cols + 1]! },
        ];
        for (const triangle of [[0, 2, 1], [1, 2, 3]]) {
          const intersections: Vec2[] = [];
          for (let edge = 0; edge < 3; edge++) {
            const a = corners[triangle[edge]!]!, b = corners[triangle[(edge + 1) % 3]!]!;
            if ((a.h < level) === (b.h < level)) continue;
            const t = (level - a.h) / (b.h - a.h);
            intersections.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
          }
          if (intersections.length === 2) { ctx.moveTo(intersections[0]!.x, intersections[0]!.y); ctx.lineTo(intersections[1]!.x, intersections[1]!.y); }
        }
      }
      ctx.stroke();
    }
  }
  // High-frequency grain gives soil, banks, and grass detail at tactical zoom.
  for (let dot = 0; dot < 55_000; dot++) {
    ctx.fillStyle = dot % 2 ? 'rgba(235,224,176,.045)' : 'rgba(22,30,21,.055)';
    ctx.fillRect(rngRange(rng, 0, width), rngRange(rng, 0, height), rngRange(rng, .3, 1.1), .45);
  }
  return canvas;
}
