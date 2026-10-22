import { CONFIG } from '../content/config';
import { getContent } from '../content/validate';
import type { EnemyArchetype, WaveDef, WaveScheduler } from './types';
import { rngShuffle, type RngState } from './rng';

/**
 * Wave composition helpers, including bounded endless-mode generation that
 * reuses the authored archetypes past wave 15.
 */

export function waveNumber(scheduler: WaveScheduler): number {
  return scheduler.waveIndex + 1;
}

/**
 * Endless wave number, counting every endless wave cleared across all maps. The
 * per-map wave counter restarts at 1 on each new map, so the authored index
 * alone cannot express how deep into endless the run has gone.
 */
export function endlessWaveNumber(scheduler: WaveScheduler): number {
  return 1 + (scheduler.endlessWavesCleared ?? 0);
}

export function currentWaveDef(scheduler: WaveScheduler): WaveDef | null {
  const content = getContent();
  return scheduler.waveIndex < content.waves.length ? (content.waves[scheduler.waveIndex] as WaveDef) : null;
}

/** Reserve the escorts before random ordering can spawn them individually. */
function orderSappers(queue: EnemyArchetype[], enabled: boolean): EnemyArchetype[] {
  return enabled ? [...queue.filter((role) => role === 'sapper'), ...queue.filter((role) => role !== 'sapper')] : queue;
}

/** Build the spawn queue for a wave. Endless waves scale authored content with caps. */
export function buildSpawnQueue(rng: RngState, scheduler: WaveScheduler, endless: boolean): {
  queue: EnemyArchetype[];
  spawnIntervalSeconds: number;
  label: string;
  telegraph?: string;
} {
  const content = getContent();
  const def = currentWaveDef(scheduler);

  if (def && !endless) {
    const queue: EnemyArchetype[] = [];
    for (const part of def.composition) {
      for (let i = 0; i < part.count; i++) queue.push(part.archetype);
    }
    return {
      queue: orderSappers(rngShuffle(rng, queue), scheduler.waveIndex + 1 >= CONFIG.enemySappers.firstWave),
      spawnIntervalSeconds: def.spawnIntervalSeconds,
      label: def.label,
      telegraph: def.telegraph,
    };
  }

  // Endless: grow the final authored wave's shape with bounded counts. The
  // difficulty index counts endless waves cleared, not the per-map wave counter,
  // so marching north for a fresh map does not reset the escalation.
  const endlessNumber = endlessWaveNumber(scheduler);
  const base = content.waves[content.waves.length - 1] as WaveDef;
  const growth = Math.pow(CONFIG.endless.countGrowth, endlessNumber - 1);
  const label = `Endless ${endlessNumber}`;
  const queue: EnemyArchetype[] = [];
  const telegraph = endlessNumber % CONFIG.endless.vehicleEveryWaves === 0 ? 'Armor inbound again.' : undefined;
  for (const part of base.composition) {
    let count = part.archetype === 'vehicle'
      ? Math.max(1, Math.floor(endlessNumber / CONFIG.endless.vehicleEveryWaves) - 4)
      : Math.ceil(part.count * growth);
    count = Math.min(count, CONFIG.endless.maxCountPerArchetype);
    for (let i = 0; i < count; i++) queue.push(part.archetype);
  }
  return {
    queue: orderSappers(rngShuffle(rng, queue), true),
    spawnIntervalSeconds: Math.max(CONFIG.endless.minSpawnIntervalSeconds, base.spawnIntervalSeconds * Math.pow(0.97, endlessNumber - 1)),
    label,
    telegraph,
  };
}
