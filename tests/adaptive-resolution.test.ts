import { describe, expect, it } from 'vitest';
import { AdaptiveResolution } from '../src/render/app/adaptive-resolution';

function run(controller: AdaptiveResolution, frameMs: number, duration: number): void {
  for (let time = 0; time < duration; time += frameMs) controller.sample(frameMs);
}

describe('adaptive canvas resolution', () => {
  it('ignores loading, isolated stalls, and hidden-tab gaps', () => {
    const resolution = new AdaptiveResolution();
    run(resolution, 80, 1800);
    expect(resolution.scale).toBe(1);
    resolution.sample(5000);
    run(resolution, 1000 / 60, 3000);
    expect(resolution.scale).toBe(1);
    resolution.sample(200);
    run(resolution, 1000 / 60, 1000);
    expect(resolution.scale).toBe(1);
    resolution.sample(NaN);
    resolution.sample(-1);
    expect(resolution.scale).toBe(1);
  });

  it('bounds degradation under sustained pressure and restores slowly with headroom', () => {
    const resolution = new AdaptiveResolution();
    run(resolution, 50, 15000);
    expect(resolution.scale).toBe(.5);
    run(resolution, 1000 / 60, 3000);
    expect(resolution.scale).toBe(.5);
    run(resolution, 1000 / 60, 3500);
    expect(resolution.scale).toBe(.55);
    run(resolution, 1000 / 60, 60000);
    expect(resolution.scale).toBe(1);
  });

  it('holds quality through small timing fluctuations in the hysteresis band', () => {
    const resolution = new AdaptiveResolution();
    run(resolution, 30, 5000);
    run(resolution, 20, 1500); // Finish the mixed window at the load transition.
    const scale = resolution.scale;
    run(resolution, 20, 10000);
    expect(resolution.scale).toBe(scale);
  });

  it('still adapts when sustained frames exceed the simulation catch-up limit', () => {
    const resolution = new AdaptiveResolution();
    run(resolution, 300, 20000);
    expect(resolution.scale).toBe(.5);
  });
});
