import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://127.0.0.1:4173/?e2e');
  await page.waitForFunction(() => window.__lastlineTest);
  await page.evaluate((live) => {
    window.__lastlineTest.startRun(99);
    if (live) {
      for (let n = 0; n < 80; n++) window.__lastlineTest.spawnEnemyAt(n % 9 === 8 ? 'vehicle' : n % 3 === 2 ? 'assault' : 'rifle', 40 + ((n * 37) % 880), 60 + Math.floor(n / 9) * 42);
    } else window.__lastlineTest.stressSetup();
  }, process.argv[3] === 'live');
  await page.waitForTimeout(1500);
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.start');
  await page.waitForTimeout(6000);
  const { profile } = await session.send('Profiler.stop');
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const totals = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const frame = nodes.get(profile.samples[i]).callFrame;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
    totals.set(name, (totals.get(name) ?? 0) + profile.timeDeltas[i]);
  }
  await mkdir('artifacts/performance', { recursive: true });
  await writeFile(`artifacts/performance/${process.argv[2] ?? 'profile'}.cpuprofile`, JSON.stringify(profile));
  console.log([...totals].sort((a,b) => b[1]-a[1]).slice(0,25).map(([name, time]) => ({ name, ms: Math.round(time/1000) })));
} finally { await browser.close(); }
