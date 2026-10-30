import { describe, expect, it } from 'vitest';
import { CAMPAIGN_COUNTRIES, CAMPAIGNS, LOCAL_BUILDING_NAMES } from '../src/content/campaigns';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, isBridgeAt, isRiverAt } from '../src/simulation/terrain';

describe('country campaigns', { timeout: 120_000 }, () => {
  it('generates country scenery and local names while preserving passable, bridged roads', () => {
    for (const country of CAMPAIGN_COUNTRIES) {
      const languages = new Set<string>();
      for (let seed = 1; seed <= 30; seed++) {
        const data = generateTerrain(seed, true, 4, country);
        expect(data.campaignCountry).toBe(country);
        expect(CAMPAIGNS[country].sectors.some((sector) => sector.label === data.layout!.label)).toBe(true);
        languages.add(data.localLanguage!);
        for (const building of data.buildings) expect(LOCAL_BUILDING_NAMES[data.localLanguage!][building.kind]).toContain(building.name);
        if (country === 'netherlands') expect(data.zones.rapids).toHaveLength(0);
        for (const road of data.layout!.roads) {
          for (let i = 1; i < road.points.length; i++) {
            const a = road.points[i - 1]!;
            const b = road.points[i]!;
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            for (let offset = 0; offset < length; offset += 12) {
              const point = { x: a.x + (b.x - a.x) * offset / length, y: a.y + (b.y - a.y) * offset / length };
              if (point.x >= CONFIG.field.width || point.y >= CONFIG.field.height) continue;
              const index = Math.floor(point.y / data.terrain.cell) * data.terrain.cols + Math.floor(point.x / data.terrain.cell);
              expect(data.terrain.blocked[index], `${country} seed ${seed}: blocked road`).toBe(0);
              if (isRiverAt(data.zones, seed, point.x, point.y)) expect(isBridgeAt(data.zones, seed, point.x, point.y)).toBe(true);
            }
          }
        }
      }
      if (country === 'belgium') expect(languages).toEqual(new Set(['french', 'dutch']));
      if (country === 'luxembourg') expect(languages).toEqual(new Set(['french', 'german', 'luxembourgish']));
    }
  });

  it.each(CAMPAIGN_COUNTRIES)('keeps %s through a JSON save, resume, and march to the next map', (country) => {
    const sim = new Simulation(2026, undefined, generateTerrain(2026, true, 2, country));
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.snapshot()).toEqual(sim.snapshot());
    expect(restored.terrainData()).toEqual(sim.terrainData());
    restored.state.sectorCaptured = true;
    for (const unit of restored.state.units) {
      unit.pos.y = CONFIG.crossing.thresholdY;
      unit.prevPos = { ...unit.pos };
      unit.path = [];
    }
    for (let tick = 0; tick < 200 && restored.state.mapNumber === 1; tick++) restored.step();
    expect(restored.state.mapNumber).toBe(2);
    expect(restored.state.campaignCountry).toBe(country);
    expect(restored.terrainData().campaignCountry).toBe(country);
    const next = validateSnapshot(JSON.parse(JSON.stringify(restored.snapshot())));
    if ('error' in next) throw new Error(next.error);
    expect(Simulation.fromSnapshot(next.snap).terrainData()).toEqual(restored.terrainData());
  });

  it('rejects corrupt country choices and retains original terrain for older saves', () => {
    const sim = new Simulation(2026);
    const save = sim.snapshot();
    expect('error' in validateSnapshot({ ...save, campaignCountry: 'unknown' })).toBe(true);
    const validated = validateSnapshot(JSON.parse(JSON.stringify(save)));
    if ('error' in validated) throw new Error(validated.error);
    expect(validated.snap.campaignCountry).toBeUndefined();
    expect(Simulation.fromSnapshot(validated.snap).terrainData()).toEqual(sim.terrainData());
  });
});
