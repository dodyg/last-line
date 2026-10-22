/**
 * Provisional performance stress test against the production preview build.
 * Scenario: 14 friendlies, 80 enemies, 30 simultaneous artillery shells plus
 * regular combat, while cosmetic effects and sounds are active. Measures
 * requestAnimationFrame frame times for 8 seconds and reports percentiles.
 *
 * Usage: npm run preview (or any static server on :4173), then
 *   node scripts/stress.mjs [port] [warmup-ms] [output.json] [live]
 */
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const port = process.argv[2] ?? '4173';
const warmupMs = Number(process.argv[3] ?? 1000);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://127.0.0.1:${port}/?e2e`);
  await page.waitForFunction(() => (window).__lastlineTest !== undefined);
  await page.evaluate(() => (window).__lastlineTest.startRun(99));
  await page.evaluate((live) => {
    const hook = window.__lastlineTest;
    if (!live) { hook.stressSetup(); return; }
    hook.givePoints(1000);
    for (let i = 0; i < 14; i++) hook.recruit(i < 2 ? 'at' : 'rifleman', 150 + (i % 7) * 110, 600 + Math.floor(i / 7) * 22);
    for (let n = 0; n < 80; n++) hook.spawnEnemyAt(n % 9 === 8 ? 'vehicle' : n % 3 === 2 ? 'assault' : 'rifle', 40 + ((n * 37) % 880), 60 + Math.floor(n / 9) * 42);
  }, process.argv[5] === 'live');
  await page.waitForTimeout(warmupMs);

  const readScene = () => page.evaluate(() => {
    const s = (window).__lastlineTest.getState();
    const canvas = document.querySelector('#game canvas');
    const gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      units: s.units.length,
      ticks: s.ticks,
      paused: window.__lastlineTest.paused(),
      friendlies: s.units.filter((u) => u.team === 'friendly').length,
      enemies: s.units.filter((u) => u.team === 'enemy').length,
      projectiles: s.projectiles.length,
      strikes: s.strikes.length,
      smokes: s.smokes.length,
      flares: s.flares.length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      webgl: gl ? { version: gl.getParameter(gl.VERSION), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) } : null,
      renderer: (window).__lastlineTest.rendererDiagnostics(),
    };
  });
  const sceneAtStart = await readScene();

  const stats = await page.evaluate(() => new Promise((resolve) => {
    const deltas = [];
    const started = performance.now();
    let last = started;
    function tick(now) {
      deltas.push(now - last);
      last = now;
      if (now - started < 8000) requestAnimationFrame(tick);
      else resolve(deltas);
    }
    requestAnimationFrame(tick);
  }));

  const sorted = [...stats].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor(sorted.length * p)].toFixed(1);
  const avg = (stats.reduce((a, b) => a + b, 0) / stats.length).toFixed(1);
  const sceneAtEnd = await readScene();
  const result = {
    framesMeasured: stats.length,
    measurementWindowMs: 8000,
    warmupMs,
    scenario: process.argv[5] === 'live' ? 'live' : 'effects',
    avgFrameMs: avg,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1].toFixed(1),
    fpsEstimate: (1000 / parseFloat(avg)).toFixed(1),
    sceneAtStart,
    sceneAtEnd,
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[4]) await writeFile(process.argv[4], JSON.stringify(result, null, 2) + '\n');
} finally { await browser.close(); }
