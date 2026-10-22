import { CONFIG } from '../content/config';

export interface DayNightState {
  /** 0 at midday, 1 at the darkest point of night, smoothly changing at dawn/dusk. */
  darkness: number;
  /** Named quarter of the cycle, used for lighting and player feedback. */
  phase: DayNightPhase;
  /** Night fighting begins when darkness reaches twilight. */
  night: boolean;
}

export type DayNightPhase = 'day' | 'dusk' | 'night' | 'dawn';

/** The clock is derived from simulation ticks, so it pauses and resumes with the battle. */
export function dayNightAtTick(tick: number, startTick: number | null = 0): DayNightState {
  if (startTick === null || tick < startTick) return { darkness: 0, phase: 'day', night: false };
  const cycleTicks = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate;
  const elapsed = tick - startTick;
  const phase = ((elapsed % cycleTicks) + cycleTicks) % cycleTicks / cycleTicks;
  const darkness = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  const timeOfDay: DayNightPhase = phase < 0.125 || phase >= 0.875
    ? 'day'
    : phase < 0.375
      ? 'dusk'
      : phase < 0.625
        ? 'night'
        : 'dawn';
  return { darkness, phase: timeOfDay, night: darkness >= 0.5 };
}
