import { deriveRng, rngNext } from './rng';
import type { Season, WeatherKind } from './types';

export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];
export const SEASON_NAMES: Record<Season, string> = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };

/** Independent of layout and combat randomness; a map keeps its season forever. */
export function seasonForSeed(seed: number): Season {
  return SEASONS[Math.floor(rngNext(deriveRng(seed, 0x53454153)) * SEASONS.length)]!;
}

export function isSeason(value: unknown): value is Season {
  return typeof value === 'string' && SEASONS.includes(value as Season);
}

export const SEASON_WEATHER: Record<Season, readonly WeatherKind[]> = {
  spring: ['clear', 'lightRain', 'rain', 'heavyRain', 'lightFog', 'fog', 'heavyFog'],
  summer: ['clear', 'lightRain', 'rain', 'heavyRain', 'lightFog'],
  autumn: ['clear', 'lightFog', 'fog', 'lightRain', 'rain', 'heavyRain', 'heavyFog'],
  winter: ['clear', 'lightFog', 'fog', 'heavyFog', 'lightSnow', 'snow', 'heavySnow'],
};

export function nextSeasonalWeather(season: Season, weather: WeatherKind): WeatherKind {
  const cycle = SEASON_WEATHER[season];
  return cycle[(cycle.indexOf(weather) + 1) % cycle.length]!;
}
