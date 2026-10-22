import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameMetrics, percentile, summarize, compareReports } from './benchmark-metrics.mjs';

test('frame metrics count real intervals, percentiles and stalls numerically', () => {
  const frames = [...Array(95).fill(10), ...Array(4).fill(30), 100];
  const result = frameMetrics(frames);
  assert.equal(result.frames, 100);
  assert.equal(result.elapsedMs, 1170);
  assert.equal(result.averageMs, 11.7);
  assert.equal(result.p50Ms, 10);
  assert.equal(result.p95Ms, 10);
  assert.equal(result.p99Ms, 30);
  assert.equal(result.maxMs, 100);
  assert.equal(result.over50MsPercent, 1);
  assert.equal(result.overBudgetPercent, 5);
  assert.equal(result.fps, 1000 / 11.7);
});

test('invalid and empty frame samples cannot produce a successful benchmark', () => {
  for (const sample of [[], [NaN], [Infinity], [-1], [0, 0]]) {
    assert.throws(() => frameMetrics(sample));
  }
});

test('percentiles sort numerically without modifying raw samples', () => {
  const samples = [100, 2, 20];
  assert.equal(percentile(samples, .5), 20);
  assert.deepEqual(samples, [100, 2, 20]);
});

test('summaries use per-scenario medians so one slow repeat does not dominate', () => {
  const run = (scenario, value) => ({ scenario, timing: { averageMs: value, p95Ms: value, fps: value }, sceneAtEnd: { renderer: { pixelRatio: 1 } } });
  const summary = summarize([run('combat', 100), run('normal', 5), run('combat', 20), run('combat', 10)]);
  assert.equal(summary.combat.averageMs, 20);
  assert.equal(summary.combat.runs, 3);
  assert.equal(summary.normal.averageMs, 5);
  assert.equal(summary.effects, undefined);
});

function report() {
  return {
    schemaVersion: 1,
    settings: { seed: 99, repeats: 3 },
    environment: { cpu: 'test CPU', browser: 'test browser' },
    summary: { combat: { averageMs: 10, p95Ms: 20, pixelRatio: 1 } },
  };
}

test('slower frames and reduced rendering quality both fail the regression gate', () => {
  const baseline = report();
  const current = report();
  current.summary.combat = { averageMs: 13, p95Ms: 21, pixelRatio: .7 };
  const comparisons = compareReports(current, baseline, 20);
  assert.deepEqual(comparisons.filter((entry) => entry.regression).map((entry) => entry.metric), ['averageMs', 'pixelRatio']);
  assert.equal(baseline.summary.combat.averageMs, 10);
});

test('identical or faster frames pass a zero-tolerance comparison', () => {
  const baseline = report();
  const current = report();
  current.summary.combat.averageMs = 9;
  assert.equal(compareReports(current, baseline, 0).some((entry) => entry.regression), false);
});

test('different machines, browser versions, settings and report schemas cannot be compared', () => {
  for (const change of [
    (value) => { value.environment.cpu = 'another CPU'; },
    (value) => { value.environment.browser = 'another browser'; },
    (value) => { value.settings.repeats = 1; },
    (value) => { value.schemaVersion = 2; },
  ]) {
    const baseline = report();
    change(baseline);
    assert.throws(() => compareReports(report(), baseline, 20), /environment or settings differ/);
  }
});

test('missing or invalid baseline metrics fail instead of silently skipping a comparison', () => {
  const missing = report();
  delete missing.summary.combat;
  assert.throws(() => compareReports(report(), missing, 20), /missing scenario/);
  for (const value of [0, null, NaN, Infinity, '10', -1]) {
    const invalid = report();
    invalid.summary.combat.averageMs = value;
    assert.throws(() => compareReports(report(), invalid, 20), /Invalid baseline metric/);
  }
});
