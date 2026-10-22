export const SCENARIOS = ['normal', 'combat', 'effects'];
export const FIXTURE_VERSION = 1;

export function percentile(values, fraction) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Expected nonempty, finite, nonnegative measurements');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function frameMetrics(frameMs) {
  const p50Ms = percentile(frameMs, .5);
  const averageMs = frameMs.reduce((sum, value) => sum + value, 0) / frameMs.length;
  if (averageMs <= 0) throw new Error('Frame measurement did not advance');
  return {
    frames: frameMs.length,
    elapsedMs: frameMs.reduce((sum, value) => sum + value, 0),
    averageMs, p50Ms,
    p95Ms: percentile(frameMs, .95),
    p99Ms: percentile(frameMs, .99),
    maxMs: Math.max(...frameMs),
    fps: 1000 / averageMs,
    overBudgetPercent: 100 * frameMs.filter((value) => value > 1000 / 60 + 1).length / frameMs.length,
    over50MsPercent: 100 * frameMs.filter((value) => value > 50).length / frameMs.length,
  };
}

export function summarize(runs) {
  return Object.fromEntries(SCENARIOS.filter((scenario) => runs.some((run) => run.scenario === scenario)).map((scenario) => {
    const group = runs.filter((run) => run.scenario === scenario);
    const median = (read) => percentile(group.map(read), .5);
    return [scenario, {
      runs: group.length,
      averageMs: median((run) => run.timing.averageMs),
      p95Ms: median((run) => run.timing.p95Ms),
      fps: median((run) => run.timing.fps),
      pixelRatio: median((run) => run.sceneAtEnd.renderer.pixelRatio),
    }];
  }));
}

// Refuse comparisons across different machines, browser versions or workloads.
export function compareReports(current, baseline, maxRegressionPercent) {
  if (baseline.schemaVersion !== current.schemaVersion
    || JSON.stringify(baseline.settings) !== JSON.stringify(current.settings)
    || JSON.stringify(baseline.environment) !== JSON.stringify(current.environment)) {
    throw new Error('Baseline environment or settings differ. Use the same machine, browser, viewport, seed, durations, and repeats.');
  }
  const comparisons = [];
  for (const [scenario, metrics] of Object.entries(current.summary)) {
    const previous = baseline.summary[scenario];
    if (!previous) throw new Error(`Baseline is missing scenario: ${scenario}`);
    for (const metric of ['averageMs', 'p95Ms', 'pixelRatio']) {
      if (!Number.isFinite(previous[metric]) || previous[metric] <= 0
        || !Number.isFinite(metrics[metric]) || metrics[metric] <= 0) throw new Error(`Invalid baseline metric: ${scenario}.${metric}`);
      const changePercent = metric === 'pixelRatio'
        ? (1 - metrics[metric] / previous[metric]) * 100
        : (metrics[metric] / previous[metric] - 1) * 100;
      comparisons.push({ scenario, metric, baseline: previous[metric], current: metrics[metric], changePercent,
        regression: changePercent > maxRegressionPercent });
    }
  }
  return comparisons;
}
