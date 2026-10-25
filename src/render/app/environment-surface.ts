import type { TerrainData } from '../../simulation/terrain';
import { distanceToRoad, isRiverAt } from '../../simulation/terrain';
import { nearestRoadPoint } from '../../simulation/landscape-details';
import { deriveRng, rngRange } from '../../simulation/rng';
import { CONFIG } from '../../content/config';
import { seasonPalette } from './season-palette';

/** Low-contrast, bounded patches read as land use rather than a noise filter. */
export function drawMeadows(ctx: CanvasRenderingContext2D, data: TerrainData): void {
  const rng = deriveRng(data.seed, 0x4d454144);
  const winter = data.season === 'winter';
  ctx.save(); ctx.filter = 'blur(3px)';
  for (let patch = 0; patch < 150; patch++) {
    const x = rngRange(rng, 0, CONFIG.field.width), y = rngRange(rng, 0, CONFIG.field.height);
    const radius = rngRange(rng, 9, 48);
    ctx.fillStyle = winter ? 'rgba(140,145,128,.035)' : patch % 3 === 0 ? 'rgba(155,143,91,.055)' : 'rgba(65,83,42,.045)';
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const angle = i / 14 * Math.PI * 2, r = radius * rngRange(rng, .65, 1.1);
      const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r * .58;
      if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // Short blades remain below unit contrast at the normal tactical zoom.
  ctx.strokeStyle = winter ? 'rgba(94,100,85,.06)' : 'rgba(53,70,33,.10)'; ctx.lineWidth = .45;
  ctx.beginPath();
  for (let blade = 0; blade < 6500; blade++) {
    const x = rngRange(rng, 0, CONFIG.field.width), y = rngRange(rng, 0, CONFIG.field.height);
    ctx.moveTo(x, y); ctx.lineTo(x + .7, y - rngRange(rng, .7, 2));
  }
  ctx.stroke();
}

export function drawHabitation(ctx: CanvasRenderingContext2D, data: TerrainData): void {
  if (!data.layout) return;
  const rng = deriveRng(data.seed, 0x59415244), cell = data.terrain.cell;
  const palette = seasonPalette(data.season);
  for (const lot of data.layout.lots ?? []) {
    const x = lot.col * cell, y = lot.row * cell, w = lot.cols * cell, h = lot.rows * cell;
    ctx.fillStyle = lot.use === 'farmyard' ? palette.yard : lot.use === 'churchyard' ? '#7f8660' : '#7a8051';
    ctx.globalAlpha = .6; ctx.fillRect(x + 3, y + 3, w - 6, h - 6); ctx.globalAlpha = 1;
    if (lot.use === 'garden') {
      for (let row = 12; row < h - 8; row += 7) {
        ctx.fillStyle = '#726548'; ctx.globalAlpha = .48; ctx.fillRect(x + 12, y + row, w - 24, 3);
        ctx.fillStyle = '#4d6438'; ctx.fillRect(x + 14, y + row, w - 28, 1.5);
      }
      ctx.globalAlpha = 1;
    } else if (lot.use === 'churchyard') {
      for (let row = 16; row < h - 10; row += 14) for (let col = 15; col < w - 10; col += 15) {
        ctx.fillStyle = 'rgba(63,65,48,.3)'; ctx.fillRect(x + col + 1, y + row + 1, 4, 7);
        ctx.fillStyle = '#aca78d'; ctx.fillRect(x + col, y + row, 3, 5);
      }
    } else {
      ctx.strokeStyle = 'rgba(73,59,40,.24)'; ctx.lineWidth = 1.3;
      for (const offset of [-3, 3]) {
        ctx.beginPath(); ctx.moveTo(x + w / 2 + offset, y + 5); ctx.lineTo(x + w / 2 + offset + 3, y + h - 6); ctx.stroke();
      }
    }
    for (let dot = 0; dot < 65; dot++) {
      ctx.fillStyle = dot % 2 ? 'rgba(206,192,151,.14)' : 'rgba(62,54,35,.12)';
      ctx.fillRect(x + rngRange(rng, 4, w - 4), y + rngRange(rng, 4, h - 4), 1, .7);
    }
  }
  // Frontage wear connects the nearest actual door to a projected street point.
  for (const building of data.buildings) {
    const center = { x: (building.col + building.cols / 2) * cell, y: (building.row + building.rows / 2) * cell };
    const to = nearestRoadPoint(data.layout, center);
    const dx = to.x - center.x, dy = to.y - center.y;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const from = horizontal ? { x: center.x + Math.sign(dx) * building.cols * cell / 2, y: center.y }
      : { x: center.x, y: center.y + Math.sign(dy) * building.rows * cell / 2 };
    if (Math.hypot(to.x - from.x, to.y - from.y) > 120) continue;
    if (Array.from({ length: 16 }, (_, i) => i / 15).some((t) => isRiverAt(data.zones, data.seed, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t))) continue;
    ctx.strokeStyle = building.kind === 'barn' ? 'rgba(103,83,53,.4)' : 'rgba(175,157,112,.6)';
    ctx.lineWidth = building.kind === 'barn' ? 9 : 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }
  // Narrow silt drainage margins follow Dutch parcels; road crossings stay dry.
  if (data.campaignCountry === 'netherlands') {
    for (const field of data.layout.fields) {
      const x = (field.col + field.cols) * cell + 4;
      ctx.strokeStyle = 'rgba(66,74,55,.6)'; ctx.lineWidth = 2.3;
      for (let y = field.row * cell; y < (field.row + field.rows) * cell; y += 4) {
        const point = { x, y };
        if (isRiverAt(data.zones, data.seed, x, y) || data.layout.roads.some((road) => distanceToRoad(road, point) < road.halfWidth + 7)) continue;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 3); ctx.stroke();
      }
    }
  }
}

/** Ragged land-side margins preserve the exact simulation water contour. */
export function drawRiverMargins(ctx: CanvasRenderingContext2D, data: TerrainData, outline: readonly { x: number; y: number }[]): void {
  const rng = deriveRng(data.seed, 0x42414e4b);
  for (let i = 0; i < outline.length; i += 2) {
    const point = outline[i]!;
    if (data.zones.bridges.some((bridge) => Math.hypot(point.x - bridge.x, point.y - bridge.y) < bridge.halfLength + 12)) continue;
    const x = point.x + rngRange(rng, -3, 3), y = point.y + rngRange(rng, -3, 3);
    if (isRiverAt(data.zones, data.seed, x, y)) continue;
    ctx.fillStyle = i % 4 === 0 ? 'rgba(77,79,47,.48)' : 'rgba(119,103,70,.42)';
    ctx.beginPath(); ctx.ellipse(x, y, rngRange(rng, 2, 6), rngRange(rng, 1, 3), rngRange(rng, 0, Math.PI), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(57,78,43,.48)'; ctx.lineWidth = .65;
    ctx.beginPath();
    for (let reed = 0; reed < 3; reed++) { ctx.moveTo(x + reed, y); ctx.lineTo(x + reed - .6, y - rngRange(rng, 2, 4)); }
    ctx.stroke();
  }
  for (const bridge of data.zones.bridges) {
    for (const sign of [-1, 1]) {
      const x = bridge.x + (bridge.axis === 'horizontal' ? sign * (bridge.halfLength + 9) : 0);
      const y = bridge.y + (bridge.axis === 'vertical' ? sign * (bridge.halfLength + 9) : 0);
      ctx.fillStyle = 'rgba(108,91,61,.2)'; ctx.beginPath();
      ctx.ellipse(x, y, bridge.axis === 'horizontal' ? 14 : 8, bridge.axis === 'vertical' ? 14 : 8, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
}
