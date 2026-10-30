import { expect, test } from '@playwright/test';

test('grenadier and flamethrower recruitment, combat rendering and saved ammunition', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('lastline/prefs/v1', JSON.stringify({
    graphics: 'low', shadows: false, muted: true, renderScale: .6,
  })));
  await page.goto('/?e2e');
  await page.waitForFunction(() => !!(window as any).__lastlineTest);
  await page.evaluate(() => {
    const hook = (window as any).__lastlineTest;
    hook.startRun(7); hook.givePoints(100);
  });
  await page.locator('#tab-army').click();
  for (const [role, label, ammo, x] of [
    ['grenadier', 'Grenadier', '6 rifle grenades', 520],
    ['flamethrower', 'Flamethrower Operator', '12 fuel bursts', 600],
  ] as const) {
    await page.locator(`.recruit-button[data-role="${role}"]`).click();
    await expect(page.getByRole('dialog', { name: `Prepare ${label}` })).toBeVisible();
    await expect(page.locator('#recruit-role-kit')).toContainText(ammo);
    await expect(page.locator('#recruit-weapon')).toBeDisabled();
    await page.locator('#recruit-stance').selectOption('crouching');
    await page.locator('#btn-recruit-deploy').click();
    await page.waitForFunction(() => (window as any).__lastlineTest.rendererReady());
    const point = await page.evaluate((x) => (window as any).__lastlineTest.worldToClient(x, 680), x);
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => page.evaluate((role) => (window as any).__lastlineTest.getState().units.some((u: any) => u.role === role), role)).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__lastlineTest.getState().points)).toBe(79);
  await page.evaluate(() => {
    const hook = (window as any).__lastlineTest;
    for (const role of ['grenadier', 'flamethrower']) {
      const unit = hook.getState().units.find((u: any) => u.role === role);
      hook.spawnEnemyAt('rifle', unit.pos.x, unit.pos.y - 70);
      const target = hook.getState().units.at(-1);
      if (!hook.fireShot(unit.id, target.id)) throw new Error(`${role} did not fire`);
    }
    hook.step(1);
  });
  await page.screenshot({ path: testInfo.outputPath('new-specialists.png') });
  const ammoBefore = await page.evaluate(() => {
    const hook = (window as any).__lastlineTest; hook.pause(); hook.save();
    return hook.getState().units.filter((u: any) => ['grenadier', 'flamethrower'].includes(u.role)).map((u: any) => u.specialistAmmo);
  });
  expect(ammoBefore[0]).toBeLessThan(6); expect(ammoBefore[1]).toBeLessThan(12);
  await page.reload();
  await page.locator('#btn-continue').click();
  expect(await page.evaluate(() => (window as any).__lastlineTest.getState().units.filter((u: any) => ['grenadier', 'flamethrower'].includes(u.role)).map((u: any) => u.specialistAmmo))).toEqual(ammoBefore);
  expect(errors).toEqual([]);
});
