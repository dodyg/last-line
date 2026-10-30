import { expect, test } from '@playwright/test';

test.setTimeout(180_000);

test('wave scouting and early calls give the player control of battle pace', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('lastline/prefs/v1', JSON.stringify({ graphics: 'low', shadows: false, particles: false, weatherEffects: false, renderScale: .6 }));
  });
  await page.goto('/?e2e');
  await page.waitForFunction(() => !!(window as any).__lastlineTest);
  await page.evaluate(() => (window as any).__lastlineTest.startRun(2026));
  await expect(page.locator('#wave-intel')).toContainText('4');
  await expect(page.locator('#battle-pace')).toContainText('First Contact');
  await expect(page.locator('#clean-streak')).toContainText('+1 pts');
  const points = await page.evaluate(() => (window as any).__lastlineTest.getState().points);
  await page.screenshot({ path: testInfo.outputPath('wave-scouting.png') });
  await page.locator('#btn-call-wave').click();
  await expect(page.locator('#btn-call-wave')).toBeHidden();
  await expect(page.locator('#wave-intel')).toContainText('on field');
  expect(await page.evaluate(() => (window as any).__lastlineTest.getState().points)).toBe(points + 1);
  await page.locator('#btn-battle-speed').click();
  await expect(page.locator('#btn-battle-speed')).toHaveText('2× speed');
  await expect(page.locator('#btn-battle-speed')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#btn-battle-speed').click();
  await expect(page.locator('#btn-battle-speed')).toHaveText('1× speed');
  await page.screenshot({ path: testInfo.outputPath('early-wave-combat.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#battle-pace')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('battle-pace-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('operation selection, readable markers, right-click movement, and restart protection', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Math.random = () => 2026 / 0x100000000;
    localStorage.setItem('lastline/prefs/v1', JSON.stringify({ graphics: 'low', shadows: false, particles: false, weatherEffects: false, renderScale: .6 }));
  });
  await page.goto('/?e2e');
  await page.locator('#btn-new').click();
  await page.locator('#run-mode').selectOption('operation');
  await expect(page.locator('#btn-campaign-start')).toHaveText('Start France operation');
  await page.locator('#btn-campaign-start').click();
  await expect(page.locator('#overlay-pause')).toContainText('Bridgehead: repel 3 waves');
  await page.locator('#btn-resume').click();
  await expect(page.locator('#operation-objective')).toContainText('Bridgehead');
  await expect(page.locator('#hud-wave')).toHaveText('1/3');
  const markers = page.locator('.unit-marker');
  await expect(markers).toHaveCount(4);
  await expect(markers.first()).toBeEmpty();
  await expect(markers.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await markers.first().click();
  await expect(markers.first()).toHaveAttribute('aria-pressed', 'true');
  expect((await markers.first().boundingBox())!.width).toBeGreaterThanOrEqual(24);
  await expect(page.locator('#btn-move')).toHaveCount(0);
  const target = await page.evaluate(() => {
    const hook = (window as any).__lastlineTest;
    const unit = hook.getState().units[0];
    return hook.worldToClient(unit.pos.x + 48, unit.pos.y);
  });
  await page.mouse.click(target.x, target.y, { button: 'right' });
  await expect.poll(() => page.evaluate(() => (window as any).__lastlineTest.mode())).toBe('none');
  expect(await page.evaluate(() => (window as any).__lastlineTest.getState().units[0].moveGoal)).not.toBeNull();
  await page.screenshot({ path: testInfo.outputPath('operation-markers.png') });
  await page.locator('#btn-pause').click();
  const saved = await page.evaluate(() => localStorage.getItem('lastline/save/v1'));
  await page.locator('#btn-restart').click();
  await expect(page.getByRole('heading', { name: 'Restart this run?' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('lastline/save/v1'))).toBe(saved);
  await page.locator('#btn-restart').click();
  await page.getByRole('dialog', { name: 'Restart this run?' }).getByRole('button', { name: 'Restart Run', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__lastlineTest.getState().runMode)).toBe('operation');
  expect(await page.evaluate(() => (window as any).__lastlineTest.getState().mapsCleared)).toBe(0);
  await page.reload();
  await page.locator('#btn-continue').click();
  expect(await page.evaluate(() => (window as any).__lastlineTest.getState().runMode)).toBe('operation');
  expect(errors).toEqual([]);
});

test.describe('touch commands', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('a soldier marker can be selected with a tap', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
    Math.random = () => 2026 / 0x100000000;
    localStorage.setItem('lastline/prefs/v1', JSON.stringify({ graphics: 'low', shadows: false, particles: false, weatherEffects: false, renderScale: .6 }));
  });
  await page.goto('/?e2e');
    await page.locator('#btn-new').tap();
    await page.locator('#run-mode').selectOption('operation');
    await page.locator('#btn-campaign-start').tap();
    await page.locator('#btn-resume').tap();
    await page.locator('.unit-marker').first().tap();
    await expect(page.locator('.unit-marker').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#btn-move')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('touch-selection.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
