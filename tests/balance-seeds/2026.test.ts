import { expect, it } from 'vitest';
import { autoplay } from '../helpers/autoplay';

// Separate files let the CPU-heavy seed probes run in independent workers.
it('secures all fifteen waves on seed 2026', () => {
  const result = autoplay(2026);
  expect(result.sectorSecured, `wave ${result.waveReached}, integrity ${result.integrity}, ${result.breakthroughs} breakthroughs after ${result.ticks / 1800} minutes`).toBe(true);
  expect(result.integrity).toBeGreaterThan(0);
  expect(result.waveReached).toBe(15);
  expect(result.ticks / 1800).toBeGreaterThan(10);
  expect(result.ticks / 1800).toBeLessThan(40);
}, 240_000);
