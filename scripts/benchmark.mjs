import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, hostname, platform, arch, release } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { SCENARIOS, FIXTURE_VERSION, frameMetrics, summarize, compareReports } from './benchmark-metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' },
  'skip-build': { type: 'boolean' },
  headed: { type: 'boolean' },
  repeats: { type: 'string', default: '3' },
  'duration-ms': { type: 'string', default: '5000' },
  'warmup-ms': { type: 'string', default: '3000' },
  seed: { type: 'string', default: '99' },
  scenario: { type: 'string', default: 'all' },
  output: { type: 'string' },
  baseline: { type: 'string' },
  'max-regression-percent': { type: 'string', default: '20' },
  'min-fps': { type: 'string', default: '0' },
} });

if (values.help) {
  console.log(`Usage: npm run perf -- [options]
Builds production assets, starts a private preview server, and benchmarks Chromium serially.
  --scenario all|normal|combat|effects   Workloads (default: all)
  --repeats N                          Fresh page runs per workload (default: 3)
  --duration-ms N                      Measurement window (default: 5000)
  --warmup-ms N                        Warmup per run (default: 3000)
  --seed N                             Initial map seed (default: 99)
  --headed                             Show Chromium (default: headless)
  --skip-build                         Use the existing dist/ build
  --output path.json                   Also save the report at this path
  --baseline path.json                 Compare with a previous compatible report
  --max-regression-percent N           Allowed frame-time increase or pixel-ratio drop (default: 20)
  --min-fps N                          Optional median FPS floor (default: disabled)
Reports, raw frame samples, and screenshots: artifacts/benchmarks/<timestamp>/
Install the browser once: npx playwright install chromium`);
} else {
  await main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}

async function main() {
  const number = (name, min, max, integer = true) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
    }
    return value;
  };
  const settings = {
    fixtureVersion: FIXTURE_VERSION,
    scenarios: values.scenario === 'all' ? SCENARIOS : [values.scenario],
    repeats: number('repeats', 1, 100),
    durationMs: number('duration-ms', 500, 60_000),
    warmupMs: number('warmup-ms', 0, 60_000),
    seed: number('seed', 0, 0xffffffff),
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    headed: Boolean(values.headed),
  };
  const maxRegressionPercent = number('max-regression-percent', 0, 1000, false);
  const minFps = number('min-fps', 0, 1000, false);
  if (settings.scenarios.some((scenario) => !SCENARIOS.includes(scenario))) throw new Error('Unknown --scenario');
  if (values.output && values.baseline && resolve(values.output) === resolve(values.baseline)) {
    throw new Error('--output must not overwrite --baseline');
  }
  const baseline = values.baseline ? JSON.parse(await readFile(resolve(values.baseline), 'utf8')) : null;
  const startedAt = new Date().toISOString();
  const outputDir = join(root, 'artifacts', 'benchmarks', startedAt.replace(/[:.]/g, '-'));
  await mkdir(outputDir, { recursive: true });
  const report = { schemaVersion: 1, startedAt, settings, environment: {}, runs: [], summary: {}, failures: [] };
  let server, browser;
  try {
    const vite = await import('vite');
    if (!values['skip-build']) {
      const check = spawnSync(process.execPath, [join(root, 'scripts/typecheck.mjs'), '--noEmit'], { cwd: root, stdio: 'inherit' });
      if (check.error) throw check.error;
      if (check.status !== 0) throw new Error(`Type checking failed (exit ${check.status})`);
      await vite.build({ root });
    }
    report.build = { indexSha256: createHash('sha256').update(await readFile(join(root, 'dist/index.html'))).digest('hex') };
    // An ephemeral loopback port avoids sharing another run's build or server.
    server = await vite.preview({ root, preview: { host: '127.0.0.1', port: 0, open: false } });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Preview server has no TCP address');
    const url = `http://127.0.0.1:${address.port}/?e2e`;
    browser = await chromium.launch({ headless: !settings.headed });
    report.environment = {
      hostname: hostname(), platform: platform(), arch: arch(), osRelease: release(),
      cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length,
      node: process.version, browser: browser.version(),
    };
    for (const scenario of settings.scenarios) {
      for (let repeat = 1; repeat <= settings.repeats; repeat++) {
        console.log(`Benchmark ${scenario} ${repeat}/${settings.repeats}...`);
        const context = await browser.newContext({ viewport: settings.viewport, deviceScaleFactor: settings.deviceScaleFactor });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        try {
          await page.goto(url);
          await page.waitForFunction(() => Boolean(window.__lastlineTest));
          await page.evaluate(({ scenario, seed }) => window.__lastlineTest.benchmarkSetup(scenario, seed), { scenario, seed: settings.seed });
          await page.waitForFunction(() => window.__lastlineTest.rendererReady());
          const fixture = await readScene(page);
          if (fixture.paused || fixture.phase !== 'running' || fixture.friendlies !== (scenario === 'normal' ? 4 : 14)
            || fixture.enemies !== (scenario === 'normal' ? 0 : 80)) throw new Error(`Invalid ${scenario} fixture: ${JSON.stringify(fixture)}`);
          await page.waitForTimeout(settings.warmupMs);
          const sceneAtStart = await readScene(page);
          if (!report.environment.webgl) report.environment.webgl = sceneAtStart.webgl;
          const sample = await measure(page, settings.durationMs);
          const sceneAtEnd = await readScene(page);
          const timing = frameMetrics(sample.frameMs);
          timing.simulationTicksPerSecond = (sceneAtEnd.ticks - sceneAtStart.ticks) * 1000 / timing.elapsedMs;
          if (sceneAtStart.paused || sceneAtEnd.paused || sceneAtEnd.phase !== 'running'
            || sceneAtEnd.ticks <= sceneAtStart.ticks || timing.frames < 2
            || !sceneAtEnd.renderer?.calls || !sceneAtEnd.webgl) throw new Error('Benchmark did not measure an active rendered simulation');
          if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
          const screenshot = `${scenario}-${repeat}.png`;
          await page.screenshot({ path: join(outputDir, screenshot) });
          const run = { scenario, repeat, timing, longTasks: sample.longTasks, fixture, sceneAtStart, sceneAtEnd,
            frameMs: sample.frameMs, screenshot };
          report.runs.push(run);
          console.log(`  ${timing.fps.toFixed(1)} FPS; p95 ${timing.p95Ms.toFixed(1)} ms; pixel ratio ${sceneAtEnd.renderer.pixelRatio}`);
        } finally { await context.close(); }
      }
    }
    report.summary = summarize(report.runs);
    if (baseline) {
      report.comparisons = compareReports(report, baseline, maxRegressionPercent);
      for (const comparison of report.comparisons) {
        if (comparison.regression) report.failures.push(`${comparison.scenario}.${comparison.metric}: ${comparison.changePercent.toFixed(1)}% regression (limit ${maxRegressionPercent}%)`);
      }
    }
    for (const [scenario, summary] of Object.entries(report.summary)) {
      if (summary.fps < minFps) report.failures.push(`${scenario}: median ${summary.fps.toFixed(1)} FPS is below ${minFps}`);
    }
  } catch (error) {
    report.failures.push(error.message);
  } finally {
    if (browser) await browser.close().catch((error) => report.failures.push(error.message));
    if (server) await server.close().catch((error) => report.failures.push(error.message));
    report.finishedAt = new Date().toISOString();
    report.summary = summarize(report.runs);
    const json = JSON.stringify(report, null, 2) + '\n';
    await writeFile(join(outputDir, 'report.json'), json);
    // Failed or partial runs never replace a good latest report.
    if (!report.failures.length) await writeFile(join(root, 'artifacts/benchmarks/latest.json'), json);
    if (values.output) {
      const destination = resolve(values.output);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, json);
    }
    console.table(Object.entries(report.summary).map(([scenario, row]) => ({ scenario, runs: row.runs,
      FPS: row.fps.toFixed(1), 'avg ms': row.averageMs.toFixed(1), 'p95 ms': row.p95Ms.toFixed(1), 'pixel ratio': row.pixelRatio })));
    console.log(`Report: ${join(outputDir, 'report.json')}`);
  }
  if (report.failures.length) throw new Error(report.failures.join('\n'));
}

async function readScene(page) {
  return page.evaluate(() => {
    const hook = window.__lastlineTest;
    const state = hook.getState();
    const canvas = document.querySelector('#game canvas');
    const gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      ticks: state.ticks, phase: state.phase, paused: hook.paused(),
      friendlies: state.units.filter((unit) => unit.team === 'friendly' && !unit.dead && !unit.crossed).length,
      enemies: state.units.filter((unit) => unit.team === 'enemy' && !unit.dead).length,
      projectiles: state.projectiles.length, strikes: state.strikes.length,
      smokes: state.smokes.length, flares: state.flares.length,
      renderer: hook.rendererDiagnostics(),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      webgl: gl ? { version: gl.getParameter(gl.VERSION), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) } : null,
      heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    };
  });
}

async function measure(page, durationMs) {
  return page.evaluate((duration) => new Promise((resolve, reject) => {
    const frameMs = [];
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: 'longtask' });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Frame sampling timed out')); }, duration + 30_000);
    let started, last;
    function frame(now) {
      if (last !== undefined) frameMs.push(now - last);
      else started = now;
      last = now;
      if (now - started < duration) requestAnimationFrame(frame);
      else {
        for (const entry of observer.takeRecords()) longTasks.push(entry.duration);
        observer.disconnect();
        clearTimeout(timeout);
        resolve({ frameMs, longTasks });
      }
    }
    requestAnimationFrame(frame);
  }), durationMs);
}
