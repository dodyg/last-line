import { describe, expect, it } from 'vitest';
import { CAMPAIGN_COUNTRIES } from '../src/content/campaigns';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { SEASONS, SEASON_WEATHER, seasonForSeed } from '../src/simulation/seasons';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain, TERRAIN_KIND, weatherForSeed } from '../src/simulation/terrain';
import { seasonPalette } from '../src/render/app/season-palette';
import { vegetationParts } from '../src/render/app/vegetation';

describe('map seasons', () => {
  it('assigns one of all four seasons deterministically without using the gameplay stream', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 120; seed++) {
      const season = seasonForSeed(seed); expect(seasonForSeed(seed)).toBe(season); seen.add(season);
    }
    expect(seen).toEqual(new Set(SEASONS));
  });

  it.each([1, 2, 3] as const)('keeps layout %s unchanged across seasonal dressing', (version) => {
    const summer = generateTerrain(2026, true, version, 'france', 'summer');
    for (const season of SEASONS) {
      const data = generateTerrain(2026, true, version, 'france', season);
      expect(data.season).toBe(season); expect(data.terrain.blocked).toEqual(summer.terrain.blocked);
      expect(data.kinds).toEqual(summer.kinds); expect(data.buildings).toEqual(summer.buildings); expect(data.zones).toEqual(summer.zones);
      expect(SEASON_WEATHER[season]).toContain(data.weather);
    }
  });

  it('only generates snowfall in winter and includes every snow intensity', () => {
    const snowy = new Set<string>();
    for (const country of CAMPAIGN_COUNTRIES) for (let seed = 1; seed <= 120; seed++) {
      const season = seasonForSeed(seed), weather = weatherForSeed(seed, country);
      expect(SEASON_WEATHER[season]).toContain(weather);
      if (weather.toLowerCase().includes('snow')) { expect(season).toBe('winter'); snowy.add(weather); }
    }
    expect(snowy).toEqual(new Set(['lightSnow', 'snow', 'heavySnow']));
  });

  it.each(SEASONS)('%s stays fixed while weather changes within its seasonal cycle', (season) => {
    const sim = new Simulation(2026, undefined, generateTerrain(2026, true, 3, 'germany', season));
    sim.state.scheduler.prepTicksLeft = 100_000;
    for (let transition = 0; transition < 18; transition++) {
      sim.state.weatherChangeTick = sim.state.ticks + 1; sim.step();
      expect(sim.state.season).toBe(season); expect(SEASON_WEATHER[season]).toContain(sim.state.weather);
      expect(sim.terrainData().season).toBe(season);
    }
  });

  it.each(SEASONS)('preserves %s scenery and weather in a non-campaign save and Continue', (season) => {
    const sim = new Simulation(2026, undefined, generateTerrain(2026, true, 3, undefined, season));
    const parsed = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot()))); if ('error' in parsed) throw new Error(parsed.error);
    const restored = Simulation.fromSnapshot(parsed.snap);
    expect(restored.snapshot()).toEqual(sim.snapshot()); expect(restored.terrainData()).toEqual(sim.terrainData());
  });

  it('gives legacy saves a stable season and keeps existing snowstorms in winter', () => {
    const snapshot = JSON.parse(JSON.stringify(new Simulation(2026).snapshot())); delete snapshot.season;
    snapshot.weather = 'clear';
    const old = validateSnapshot(snapshot); if ('error' in old) throw new Error(old.error);
    expect(old.snap.season).toBe(seasonForSeed(snapshot.seed));
    snapshot.weather = 'heavySnow';
    const snowy = validateSnapshot(snapshot); if ('error' in snowy) throw new Error(snowy.error);
    expect(snowy.snap.season).toBe('winter'); expect(Simulation.fromSnapshot(snowy.snap).terrainData().season).toBe('winter');
  });

  it('assigns the next generated map its own season when the squad marches north', () => {
    const sim = new Simulation(2026); const before = sim.state.seed;
    for (const unit of sim.state.units) {
      unit.pos = { x: 120 + (unit.id % 5) * 90, y: CONFIG.crossing.thresholdY - 2 }; unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null;
    }
    for (let i = 0; i < 300 && sim.state.mapNumber === 1; i++) sim.step();
    expect(sim.state.mapNumber).toBe(2); expect(sim.state.seed).not.toBe(before);
    expect(sim.state.season).toBe(seasonForSeed(sim.state.seed)); expect(sim.terrainData().season).toBe(sim.state.season);
  });

  it.each([null, 'monsoon', 3])('rejects invalid saved season %j', (season) => {
    const snapshot = JSON.parse(JSON.stringify(new Simulation(2026).snapshot())); snapshot.season = season;
    expect(validateSnapshot(snapshot)).toHaveProperty('error');
  });

  it('uses distinct leaf palettes, blossom, bare winter branches and snow-capped evergreens', () => {
    const colors = SEASONS.map((season) => {
      const parts = vegetationParts(TERRAIN_KIND.oak, season);
      const result = parts.map((part) => part.color); parts.forEach((part) => part.geometry.dispose()); return result;
    });
    expect(new Set(colors.map((list) => list.join(','))).size).toBe(4);
    const winterOak = vegetationParts(TERRAIN_KIND.oak, 'winter');
    expect(winterOak.some((part) => part.geometry.type === 'CylinderGeometry')).toBe(true);
    const winterPine = vegetationParts(TERRAIN_KIND.pine, 'winter');
    expect(winterPine.filter((part) => part.color === seasonPalette('winter').snow)).toHaveLength(3);
    expect(seasonPalette('winter').snowCover).toBeGreaterThan(.5); expect(seasonPalette('summer').snowCover).toBe(0);
    [...winterOak, ...winterPine].forEach((part) => part.geometry.dispose());
  });
});
