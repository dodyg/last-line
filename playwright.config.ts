import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Default suite: browser smoke only. Set STRESS=1 to include the
  // provisional performance probe (tests/stress.spec.ts).
  testMatch: process.env.STRESS ? /.*(browser|stress)\.spec\.ts/ : /browser\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4173' },
  outputDir: '/tmp/opencode/lastline-test-results',
  reporter: [['list'], ['html', { outputFolder: '/tmp/opencode/lastline-report', open: 'never' }]],
  // Run against the production build served by `vite preview`.
  webServer: {
    // Bind IPv4 explicitly: `vite preview` otherwise listens on ::1 only, while
    // baseURL below is an IPv4 address, and every navigation fails with
    // ERR_CONNECTION_REFUSED. scripts/stress.mjs uses 127.0.0.1 for the same reason.
    command: 'npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    port: 4173,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
