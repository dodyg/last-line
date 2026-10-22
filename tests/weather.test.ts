import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { weatherForSeed } from '../src/simulation/terrain';
import type { WeatherKind } from '../src/simulation/types';

const snowLevels = ['lightSnow', 'snow', 'heavySnow'] as const;

function riflemanIn(weather: WeatherKind): Simulation {
  const sim = new Simulation(2026);
  sim.state.weather = weather;
  const soldier = sim.state.units[0]!;
  sim.state.units = [soldier];
  soldier.pos = { x: 36, y: 600 };
  soldier.prevPos = { ...soldier.pos };
  return sim;
}

describe('snowstorms', () => {
  it('progressively slows actual movement and reduces target acquisition range', () => {
    const movement = (weather: WeatherKind): number => {
      const sim = riflemanIn(weather);
      sim.state.units[0]!.path = [{ x: 36, y: 650 }];
      sim.step();
      return sim.state.units[0]!.pos.y - 600;
    };
    const distances = ['clear', ...snowLevels].map((weather) => movement(weather as WeatherKind));
    expect(distances[0]).toBeGreaterThan(distances[1]!);
    expect(distances[1]).toBeGreaterThan(distances[2]!);
    expect(distances[2]).toBeGreaterThan(distances[3]!);
    expect(distances[3]).toBeGreaterThan(0);

    const seesTarget = (weather: WeatherKind, distance: number): boolean => {
      const sim = riflemanIn(weather);
      sim.spawnEnemy('rifle', { x: 36, y: 600 - distance });
      sim.step();
      return sim.state.units[0]!.targetId !== null;
    };
    expect(seesTarget('lightSnow', 220)).toBe(true);
    expect(seesTarget('snow', 220)).toBe(false);
    expect(seesTarget('snow', 180)).toBe(true);
    expect(seesTarget('heavySnow', 180)).toBe(false);
  });

  it.each(snowLevels)('preserves %s and its next transition through a validated save', (weather) => {
    const sim = new Simulation(2026);
    sim.state.season = 'winter';
    sim.state.weather = weather;
    sim.state.weatherChangeTick = sim.state.ticks + 1;
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const restored = Simulation.fromSnapshot(saved.snap);
    expect(restored.state.weather).toBe(weather);
    expect(restored.snapshot()).toEqual(sim.snapshot());
    const next = weather === 'lightSnow' ? 'snow' : weather === 'snow' ? 'heavySnow' : 'clear';
    expect(restored.step()).toContainEqual({ type: 'weatherChanged', weather: next });
    expect(restored.state.weatherChangeTick).toBe(restored.state.ticks + CONFIG.weatherChangeSeconds * CONFIG.tickRate);
  });

  it('can start snowy campaign maps deterministically', () => {
    const seen = new Set<WeatherKind>();
    for (let seed = 1; seed <= 240; seed++) {
      const weather = weatherForSeed(seed, 'germany');
      expect(weatherForSeed(seed, 'germany')).toBe(weather);
      if (snowLevels.includes(weather as typeof snowLevels[number])) seen.add(weather);
    }
    expect(seen).toEqual(new Set(snowLevels));
  });
});
