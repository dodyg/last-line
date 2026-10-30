import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    // Seed sweeps and long deterministic simulations need a bounded, explicit budget.
    testTimeout: 60_000,
    maxWorkers: 4,
    include: ['tests/**/*.test.ts'],
  },
});
