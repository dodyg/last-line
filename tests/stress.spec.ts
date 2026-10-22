import { expect, test } from '@playwright/test';

/**
 * Provisional performance probe - NOT part of the default smoke suite.
 * Run explicitly with: npx playwright test stress.spec.ts
 *
 * Builds a saturated battle through the ?e2e hook (full squad, 80 enemies
 * including vehicles whose shells produce live explosive projectiles and
 * area effects) and samples requestAnimationFrame timing for six seconds
 * while the simulation and renderer run at full load.
 *
 * Headless browsers render on software rasterizers, so the numbers recorded
 * here are a lower bound, not a desktop-GPU guarantee.
 */

interface Timing {
  fps: number;
  p95Ms: number;
  maxMs: number;
  samples: number;
}

test('stress: saturated battlefield frame timing', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
  await page.evaluate(() => {
    const hook = (window as unknown as {
      __lastlineTest: {
        startRun(seed?: number): void;
        givePoints(n: number): void;
        recruit(role: string, x: number, y: number): boolean;
        spawnEnemyAt(archetype: string, x: number, y: number): void;
        getState(): { units: Array<{ team: string; role: string }> } | null;
      };
    }).__lastlineTest;
    hook.startRun(99);
    // Fill the squad to the cap: mostly riflemen, two AT for rocket traffic.
    let recruited = 0;
    for (let i = 0; i < 40 && recruited < 14; i++) {
      const role = recruited < 2 ? 'at' : 'rifleman';
      if (hook.recruit(role, 150 + (recruited % 7) * 110, 600 + Math.floor(recruited / 7) * 22)) recruited++;
    }
    // 80 enemies across the northern two thirds; every 9th is a vehicle so
    // explosive shells (projectiles + area damage + effects) stay in the mix.
    for (let n = 0; n < 80; n++) {
      const archetype = n % 9 === 8 ? 'vehicle' : n % 3 === 2 ? 'assault' : 'rifle';
      hook.spawnEnemyAt(archetype, 40 + ((n * 37) % 880), 60 + Math.floor(n / 9) * 42);
    }
    const state = hook.getState();
    console.log(
      `stress setup: friendlies=${state?.units.filter((u) => u.team === 'friendly').length} enemies=${state?.units.filter((u) => u.team === 'enemy').length}`,
    );
  });

  const timing = await page.evaluate(
    () =>
      new Promise<Timing>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const start = last;
        const tick = (): void => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          if (now - start < 6000) {
            requestAnimationFrame(tick);
          } else {
            const sorted = [...deltas].sort((a, b) => a - b);
            const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
            resolve({
              fps: Math.round(1000 / avg),
              p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
              maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
              samples: deltas.length,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`stress timing: ${JSON.stringify(timing)}`);
  // Soft gate: the sim must remain interactive under saturation. Headless
  // software rasterizers measured 24-52 FPS here; desktop GPUs do far better,
  // so the floor is a crude interactivity check, not a performance claim.
  expect(timing.fps).toBeGreaterThan(15);
});
