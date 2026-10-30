import { describe, expect, it } from 'vitest';
import { Simulation, sec } from '../src/simulation/simulation';
import { CONFIG } from '../src/content/config';
import { earlyWaveReward } from '../src/simulation/waves';

function clearWave(sim: Simulation) {
  sim.state.scheduler.spawnQueue = [];
  sim.state.scheduler.phase = 'active';
  sim.state.units = sim.state.units.filter((u) => u.team === 'friendly');
  return sim.step();
}

describe('battle initiative and clean defense', () => {
  it('starts an early wave immediately and pays only once', () => {
    const sim = new Simulation(2026);
    sim.state.scheduler.prepTicksLeft = sec(30);
    const points = sim.state.points;
    expect(sim.command({ type: 'callWave' }).ok).toBe(true);
    expect(sim.state.scheduler.phase).toBe('spawning');
    expect(sim.state.scheduler.spawnQueue.length).toBeGreaterThan(0);
    expect(sim.state.points).toBe(points + 3);
    expect(sim.command({ type: 'callWave' }).ok).toBe(false);
    expect(sim.state.points).toBe(points + 3);
  });

  it('rejects calls while paused, after battle, and during extraction', () => {
    const sim = new Simulation(2026);
    sim.paused = true;
    expect(sim.command({ type: 'callWave' }).ok).toBe(false);
    sim.paused = false;
    sim.state.scheduler.phase = 'advance';
    expect(sim.command({ type: 'callWave' }).ok).toBe(false);
    sim.state.phase = 'defeat';
    expect(sim.command({ type: 'callWave' }).ok).toBe(false);
    expect(sim.state.points).toBe(CONFIG.start.points);
  });

  it('bounds rewards and reduces them with the skipped time', () => {
    expect([0, 1, 10, 11, 20, 21, 100].map((s) => earlyWaveReward(sec(s)))).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('keeps the standard wave economy when preparation is not skipped', () => {
    const sim = new Simulation(2026);
    sim.state.scheduler.prepTicksLeft = 1;
    sim.step();
    expect(sim.state.scheduler.phase).toBe('spawning');
    expect(sim.state.scheduler.calledEarly).toBe(false);
    const points = sim.state.points;
    expect(clearWave(sim).find((e) => e.type === 'waveCleared')).toMatchObject({ cleanBonus: 0, streak: 0 });
    expect(sim.state.points).toBe(points + CONFIG.rewards.waveClearBase);
  });

  it('grows clean rewards to a cap, persists them, and resets on losses', () => {
    let sim = new Simulation(2026);
    for (const bonus of [1, 2, 3, 3]) {
      sim.command({ type: 'callWave' });
      const event = clearWave(sim).find((e) => e.type === 'waveCleared');
      expect(event).toMatchObject({ type: 'waveCleared', cleanBonus: bonus });
      sim = Simulation.fromSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    }
    expect(sim.state.scheduler.cleanStreak).toBe(4);
    sim.command({ type: 'callWave' });
    // A real casualty anywhere during the wave invalidates the reward.
    sim.state.battleRecord.casualties++;
    expect(clearWave(sim).find((e) => e.type === 'waveCleared')).toMatchObject({ cleanBonus: 0, streak: 0 });
    sim.command({ type: 'callWave' });
    expect(clearWave(sim).find((e) => e.type === 'waveCleared')).toMatchObject({ cleanBonus: 1, streak: 1 });
    sim.command({ type: 'callWave' });
    sim.state.battleRecord.breakthroughs++;
    expect(clearWave(sim).find((e) => e.type === 'waveCleared')).toMatchObject({ cleanBonus: 0, streak: 0 });
  });

  it('keeps a mid-wave save in lockstep and does not invent legacy clean rewards', () => {
    const sim = new Simulation(2026);
    sim.command({ type: 'callWave' });
    const restored = Simulation.fromSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(clearWave(restored).filter((e) => e.type === 'waveCleared')).toEqual(clearWave(sim).filter((e) => e.type === 'waveCleared'));
    expect(restored.snapshot()).toEqual(sim.snapshot());
    delete sim.state.scheduler.startCasualties;
    delete sim.state.scheduler.startBreakthroughs;
    expect(clearWave(sim).find((e) => e.type === 'waveCleared')).toMatchObject({ cleanBonus: 0 });
  });
});
