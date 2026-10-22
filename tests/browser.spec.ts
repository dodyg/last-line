import { expect, test, type Page } from '@playwright/test';
import type { SimSnapshot } from '../src/simulation/types';
import { soldierName } from '../src/simulation/soldiers';
import { CONFIG } from '../src/content/config';
import { CAMPAIGN_COUNTRIES, CAMPAIGNS } from '../src/content/campaigns';
import { buildingArchitecture, buildingSlot } from '../src/simulation/buildings';
import { generateTerrain, isBridgeAt, riverPathPoints } from '../src/simulation/terrain';
import { isTreeKind, treeCellPosition, treeOnShot } from '../src/simulation/tree-damage';
import { bridgeKey } from '../src/simulation/bridges';
import { SEASONS, SEASON_NAMES } from '../src/simulation/seasons';

/**
 * Browser smoke coverage against the production preview build.
 * The suite uses the ?e2e automation hook to reach fixture states quickly;
 * the hook is inert without the URL parameter.
 */

const URL = '/?e2e';

type Snapshot = SimSnapshot;

/** A building as the test hook reports it. */
interface BuildingInfo {
  id: number;
  kind: string;
  name: string;
  health: number;
  maxHealth: number;
  destroyed: boolean;
  pos: { x: number; y: number };
  cols: number;
  rows: number;
}

interface TestApi {
  damageBuilding(index: number, amount: number): boolean;
  startRun(seed?: number): void;
  step(n: number): void;
  givePoints(n: number): void;
  setIntegrity(n: number): void;
  spawnEnemyAt(archetype: string, x: number, y: number): void;
  spawnSapperTeamAt(x: number, y: number): boolean;
  /** Kill a friendly unit outright, so casualty handling can be tested cheaply. */
  killFriendly(unitId: number): boolean;
  armMineAt(x: number, y: number): void;
  screenShake(): number;
  worldToClient(x: number, y: number, height?: number): { x: number; y: number } | null;
  clientToWorld(x: number, y: number): { x: number; y: number } | null;
  rendererReady(): boolean;
  rendererDiagnostics(): { geometries: number; textures: number; calls: number; triangles: number } | null;
  renderTestShot(shooterId: number, toX: number, toY: number, targetId?: number): boolean;
  fireShot(shooterId: number, targetId: number): boolean;
  getState(): Snapshot | null;
  save(): void;
  pause(): void;
  selectUnit(index: number): number | null;
  selection(): number | null;
  selectionIds(): number[];
  clickUnitAt(x: number, y: number, additive?: boolean): void;
  dragSelect(x0: number, y0: number, x1: number, y1: number, additive?: boolean): void;
  mode(): string;
  paused(): boolean;
  moveUnit(index: number, x: number, y: number): boolean;
  recruit(role: string, x: number, y: number): boolean;
  /** Order a mine laid, without going through a HUD placement mode. */
  orderMine(kind: 'ap' | 'at', x: number, y: number): boolean;
  /** Why a placement would be refused: empty string when it is allowed. */
  placementError(kind: 'recruit' | 'sandbag' | 'trench' | 'mine' | 'artillery', x: number, y: number, mineKind?: 'ap' | 'at'): string;
  /** Teleport the living squad onto the northern exit band, ready to cross. */
  rallyAtNorthEdge(): void;
  /** What the ground under a soldier costs it, or null when there is no such unit. */
  terrainAt(unitId: number): { speedMult: number; accuracyMult: number; reloadMult: number } | null;
  /** The map's buildings, standing and ruined. */
  buildings(): Array<{
    id: number;
    kind: string;
    name: string;
    health: number;
    maxHealth: number;
    destroyed: boolean;
    pos: { x: number; y: number };
    cols: number;
    rows: number;
  }>;
  /** The building blocking a shot along a segment, or null when the way is clear. */
  wallBetween(from: { x: number; y: number }, to: { x: number; y: number }): { id: number; name: string } | null;
  /** Destroy a building outright, as a direct artillery hit would. */
  razeBuilding(index: number): boolean;
  /** Fire an Axis barrage now, whatever wave the run is on. */
  enemyBarrage(shells?: number): { shells: number; landTick: number } | null;
  /** Fire an Axis barrage and walk every shell onto a chosen point. */
  aimBarrageAt(x: number, y: number, shells?: number): { shells: number; landTick: number } | null;
}

type ApiMethod = keyof TestApi;

/** Hook methods cannot cross the evaluate boundary; invoke them inside the page. */
async function call<R>(page: Page, method: ApiMethod, ...args: unknown[]): Promise<R> {
  return page.evaluate(({ method: m, args: a }) => {
    const hook = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
    return (hook[m] as (...xs: unknown[]) => R)(...a);
  }, { method, args });
}

async function startRun(page: Page, seed = 2026): Promise<void> {
  await page.goto(URL);
  await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
  await call<void>(page, 'startRun', seed);
}

const getState = (page: Page) => call<Snapshot | null>(page, 'getState');

/** Map battlefield coordinates through the renderer's live camera to client CSS pixels. */
async function gamePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  await page.waitForFunction(
    () => (window as unknown as { __lastlineTest?: TestApi }).__lastlineTest?.rendererReady() === true,
    undefined,
    { timeout: 5000 },
  );
  const point = await page.evaluate(({ x: px, y: py }) => (window as unknown as { __lastlineTest: TestApi }).__lastlineTest.worldToClient(px, py), { x, y });
  if (point === null) throw new Error(`simulation point (${x}, ${y}) is not projectable`);
  return point;
}

test.describe('Last Line smoke', () => {
  test('ambush orders prepare a selected squad, hold fire outside the arc, and survive Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T14:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-21T14:01:00Z'));
    await call<void>(page, 'spawnEnemyAt', 'rifle', 732, 612);
    const staged = (await getState(page))!, rifle = staged.units[0]!, mg = staged.units[1]!, flank = staged.units.at(-1)!;
    staged.units = [rifle, mg, flank];
    for (const [unit, x] of [[rifle, 492], [mg, 612]] as const) {
      unit.pos = { x, y: 612 }; unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null;
      unit.pinned = false; unit.suppression = 0; unit.reloadTimer = 0; unit.shotTimer = 0;
    }
    mg.role = 'mg'; mg.health = 115; mg.grenades = 0;
    flank.pinned = true; flank.suppression = CONFIG.suppression.max; flank.reloadTimer = 100_000;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000;
    const selectSquad = async () => {
      await page.locator('.roster-soldier').nth(0).click();
      await page.locator('.roster-soldier').nth(1).click({ modifiers: ['Shift'] });
      await call<void>(page, 'step', 0);
    };
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    await selectSquad();
    const button = page.locator('#btn-ambush');
    const arc = page.locator('#ambush-arc');
    await expect(button).toHaveAttribute('aria-label', 'Set ambush');
    await expect(arc).toBeHidden();
    await button.click(); await call<void>(page, 'step', 0);
    await expect(arc).toBeVisible();
    await expect(arc).toBeEnabled();
    await arc.selectOption('45');
    expect(await call<string>(page, 'mode')).toBe('ambush');
    const target = await gamePoint(page, 552, 492);
    await page.mouse.move(target.x, target.y); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('ambush-preview.png') });
    await page.mouse.click(target.x, target.y); await call<void>(page, 'step', 30);
    let state = (await getState(page))!;
    expect(state.units.find((unit) => unit.id === rifle.id)!.ambush).toMatchObject({ prepTicks: 60, arcDegrees: 45 });
    expect(state.units.find((unit) => unit.id === mg.id)!.ambush).toMatchObject({ prepTicks: 60, arcDegrees: 45 });
    expect(state.units.find((unit) => unit.id === flank.id)!.health).toBe(70);
    await expect(button).toHaveAttribute('aria-label', 'Cancel ambush');
    await expect(arc).toBeVisible();
    await expect(arc).toBeDisabled();
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.units.find((unit) => unit.id === rifle.id)!.ambush!.prepTicks).toBe(60);
    await selectSquad(); await call<void>(page, 'step', 90);
    state = (await getState(page))!;
    expect(state.units.find((unit) => unit.id === flank.id)!.health).toBe(70);
    expect(state.units.find((unit) => unit.id === rifle.id)!.ambush!.prepTicks).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('ambush-ready.png') });
    await page.locator('.roster-soldier').nth(0).click(); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-action')).toContainText('Ambush ready');
    await selectSquad();
    await call<void>(page, 'spawnEnemyAt', 'rifle', 552, 540); await call<void>(page, 'step', 1);
    state = (await getState(page))!;
    expect(state.units.find((unit) => unit.id === rifle.id)!.ambush).toBeUndefined();
    expect(state.units.find((unit) => unit.id === mg.id)!.ambush?.triggered).toBe(true);
    await expect(page.locator('#notices')).toContainText('Ambush sprung!');
    await page.screenshot({ path: testInfo.outputPath('ambush-sprung.png') });
    const openingMG = state.units.find((unit) => unit.id === mg.id)!;
    await call<void>(page, 'step', openingMG.burstRemaining * Math.max(1, openingMG.shotTimer) + 1);
    await expect(button).toHaveAttribute('aria-label', 'Set ambush');
    await expect(arc).toBeHidden();
    await button.click(); await call<void>(page, 'step', 0);
    expect(await call<string>(page, 'mode')).toBe('ambush');
    await expect(arc).toBeVisible();
    await button.click(); await call<void>(page, 'step', 0);
    await expect(arc).toBeHidden();
    await button.click(); await call<void>(page, 'step', 0);
    await page.keyboard.press('Escape'); await call<void>(page, 'step', 0);
    expect(await call<string>(page, 'mode')).toBe('none');
    await expect(arc).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('enemy sapper team marks a bunker, arms demolition, and destroys it across Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-21T12:01:00Z'));
    const staged = (await getState(page))!, defender = staged.units[0]!;
    staged.units = [defender]; defender.pos = { x: 850, y: 612 }; defender.prevPos = { ...defender.pos };
    defender.path = []; defender.moveGoal = null; defender.reloadTimer = 100_000; defender.grenades = 0;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.bunkers = [{ id: staged.nextEntityId++, pos: { x: 492, y: 564 } }];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect(await call<boolean>(page, 'spawnSapperTeamAt', 492, 480)).toBe(true);
    await call<void>(page, 'step', 1);
    let state = (await getState(page))!;
    expect(state.enemySapperTeams).toHaveLength(1);
    expect(state.enemySapperTeams![0]!.target).toMatchObject({ kind: 'bunker' });
    await expect(page.locator('#notices')).toContainText('Sapper team targeting bunker');
    await page.screenshot({ path: testInfo.outputPath('sapper-approach.png') });
    await call<void>(page, 'step', 120);
    state = (await getState(page))!;
    const planting = state.enemySapperTeams![0]!.plantTicks;
    expect(planting).toBeGreaterThan(0); expect(planting).toBeLessThan(120);
    await page.screenshot({ path: testInfo.outputPath('sapper-planting.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.enemySapperTeams![0]!.plantTicks).toBe(planting);
    await call<void>(page, 'step', 120 - planting);
    state = (await getState(page))!; expect(state.enemyDemolitionCharges).toHaveLength(1);
    expect(state.enemyDemolitionCharges![0]!.ticksRemaining).toBe(240);
    await expect(page.locator('#notices')).toContainText('Enemy demolition charge armed!');
    await page.screenshot({ path: testInfo.outputPath('enemy-demolition-armed.png') });
    await call<void>(page, 'step', 90); await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.enemyDemolitionCharges![0]!.ticksRemaining).toBe(150);
    await call<void>(page, 'step', 149); expect((await getState(page))!.bunkers).toHaveLength(1);
    await call<void>(page, 'step', 1);
    state = (await getState(page))!; expect(state.bunkers).toEqual([]); expect(state.enemyDemolitionCharges).toEqual([]);
    await expect(page.locator('#notices')).toContainText('Bunker demolished!');
    await page.screenshot({ path: testInfo.outputPath('bunker-demolished.png') });
    expect(errors).toEqual([]);
  });

  test('enemy demolition removes a bridge and preserves the destroyed crossing after Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-21T12:01:00Z'));
    const staged = (await getState(page))!, defender = staged.units[0]!;
    staged.units = [defender]; defender.pos = { x: 850, y: 612 }; defender.prevPos = { ...defender.pos };
    defender.path = []; defender.moveGoal = null; defender.reloadTimer = 100_000; defender.grenades = 0;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000;
    const bridge = generateTerrain(2026, false, 2, staged.campaignCountry, staged.season).zones.bridges[0]!, key = bridgeKey(bridge);
    staged.enemyDemolitionCharges = [{ id: staged.nextEntityId++, unitId: 999, target: { kind: 'bridge', key },
      pos: { x: bridge.x, y: bridge.y }, ticksRemaining: 60 }];
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('bridge-charge-armed.png') });
    await call<void>(page, 'step', 60);
    expect((await getState(page))!.destroyedBridgeKeys).toContain(key);
    await expect(page.locator('#notices')).toContainText('Bridge demolished!');
    await page.screenshot({ path: testInfo.outputPath('bridge-demolished.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.destroyedBridgeKeys).toContain(key);
    await page.screenshot({ path: testInfo.outputPath('bridge-demolished-restored.png') });
    expect(errors).toEqual([]);
  });

  test('barbed wire builds around a lane and enemy engineers cut a breach that survives Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-21T10:00:01Z'));
    const staged = (await getState(page))!, engineer = staged.units[0]!;
    staged.units = [engineer]; engineer.role = 'engineer'; engineer.pos = { x: 552, y: 612 };
    engineer.prevPos = { ...engineer.pos }; engineer.path = []; engineer.moveGoal = null;
    engineer.pinned = false; engineer.suppression = 0; engineer.grenades = 0; engineer.reloadTimer = 100_000;
    staged.points = 100; staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('#tab-support').click();
    const button = page.locator('#btn-barbed-wire');
    await expect(button).toBeEnabled(); await expect(button).toContainText('4');
    expect(await call<string>(page, 'placementError', 'barbedWire', 492, 564)).toBe('');
    await button.click(); expect(await call<string>(page, 'mode')).toBe('barbedWire');
    const target = await gamePoint(page, 492, 564);
    await page.mouse.move(target.x, target.y); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('wire-placement.png') });
    await page.mouse.click(target.x, target.y); await call<void>(page, 'step', 60);
    let state = (await getState(page))!;
    expect(state.barbedWire).toHaveLength(0); expect(state.points).toBe(96);
    expect(state.constructionSites[0]!.kind).toBe('barbedWire');
    await expect(page.locator('#construction-status')).toContainText('Barbed wire');
    await page.screenshot({ path: testInfo.outputPath('wire-construction.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 60);
    expect((await getState(page))!.barbedWire).toHaveLength(1);
    await page.locator('#tab-support').click(); await button.click();
    const second = await gamePoint(page, 612, 564);
    await page.mouse.click(second.x, second.y); await call<void>(page, 'step', 120);
    state = (await getState(page))!;
    expect(state.barbedWire).toHaveLength(2); expect(state.points).toBe(92);
    await page.screenshot({ path: testInfo.outputPath('wire-clear-lane.png') });
    await call<void>(page, 'spawnEnemyAt', 'sapper', 492, 546);
    await call<void>(page, 'step', 90);
    state = (await getState(page))!;
    expect(state.barbedWire![0]!.cutTicks).toBe(90);
    await page.screenshot({ path: testInfo.outputPath('wire-cutting.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    expect((await getState(page))!.barbedWire![0]!.cutTicks).toBe(90);
    await call<void>(page, 'step', 89); expect((await getState(page))!.barbedWire).toHaveLength(2);
    await call<void>(page, 'step', 1); expect((await getState(page))!.barbedWire).toHaveLength(1);
    await expect(page.locator('#notices')).toContainText('Barbed wire breached');
    await page.screenshot({ path: testInfo.outputPath('wire-breached.png') });
    expect(errors).toEqual([]);
  });

  test('combat engineer plants a satchel with a 10-second fuse that survives Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-21T10:00:01Z'));
    const staged = (await getState(page))!, engineer = staged.units[0]!;
    staged.units = [engineer]; engineer.role = 'engineer'; engineer.pos = { x: 492, y: 612 };
    engineer.prevPos = { ...engineer.pos }; engineer.path = []; engineer.moveGoal = null;
    engineer.pinned = false; engineer.suppression = 0; engineer.grenades = 0; engineer.reloadTimer = 100_000;
    staged.points = 100; staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    await page.locator('#tab-support').click();
    const button = page.locator('#btn-satchel');
    await expect(button).toBeEnabled(); await expect(button).toContainText('10s fuse');
    await button.click(); expect(await call<string>(page, 'mode')).toBe('satchel');
    const target = await gamePoint(page, 492, 600);
    await page.mouse.move(target.x, target.y); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('satchel-placement-preview.png') });
    await page.mouse.click(target.x, target.y); await call<void>(page, 'step', 0);
    let state = (await getState(page))!;
    expect(state.satchelCharges).toHaveLength(1); expect(state.satchelCharges![0]!.ticksRemaining).toBe(300);
    expect(state.points).toBe(95); await expect(button).toBeDisabled();
    await expect(page.locator('#satchel-status')).toContainText('10s');
    await call<void>(page, 'step', 1);
    await page.screenshot({ path: testInfo.outputPath('satchel-armed.png') });
    expect(await call<boolean>(page, 'moveUnit', 0, 660, 612)).toBe(true);
    await call<void>(page, 'step', 149);
    state = (await getState(page))!;
    expect(state.satchelCharges![0]!.ticksRemaining).toBe(150);
    expect(Math.hypot(state.units[0]!.pos.x - 492, state.units[0]!.pos.y - 600)).toBeGreaterThan(CONFIG.satchel.radius);
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    expect((await getState(page))!.satchelCharges![0]!.ticksRemaining).toBe(150);
    await expect(page.locator('#satchel-status')).toContainText('5s');
    await page.screenshot({ path: testInfo.outputPath('satchel-restored.png') });
    await call<void>(page, 'step', 149);
    expect((await getState(page))!.satchelCharges).toHaveLength(1);
    await call<void>(page, 'step', 1);
    expect((await getState(page))!.satchelCharges).toEqual([]);
    await expect(page.locator('#satchel-status')).toBeHidden();
    await expect(page.locator('#notices')).toContainText('Satchel charge detonated');
    await page.screenshot({ path: testInfo.outputPath('satchel-detonated.png') });
    expect(errors).toEqual([]);
  });

  for (const season of SEASONS) {
    test(`${season} environment persists across clear weather and Continue`, async ({ page }, testInfo) => {
      const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
      await startRun(page, 2026); await call<void>(page, 'pause');
      await page.clock.install({ time: new Date('2026-10-19T10:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-19T10:00:01Z'));
      const staged = (await getState(page))!;
      staged.season = season; staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000;
      await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
      await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
      await call<void>(page, 'step', 0);
      await expect(page.locator('#hud-setting')).toContainText(SEASON_NAMES[season]);
      expect((await getState(page))!.season).toBe(season);
      await call<void>(page, 'step', 60);
      expect((await getState(page))!.weather).toBe('clear'); expect((await getState(page))!.season).toBe(season);
      await page.screenshot({ path: testInfo.outputPath(`${season}-environment.png`) });
      await call<void>(page, 'save'); await page.reload();
      await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
      expect((await getState(page))!.season).toBe(season); await expect(page.locator('#hud-setting')).toContainText(SEASON_NAMES[season]);
      expect(errors).toEqual([]);
    });
  }

  test('enemy troop transports unload six soldiers and lose all embarked troops when destroyed', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-19T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-19T10:00:01Z'));
    await call<void>(page, 'spawnEnemyAt', 'troop_transport', 360, 480);
    const staged = (await getState(page))!, defender = staged.units.find((u) => u.team === 'friendly')!;
    const truck = staged.units.find((u) => u.role === 'troop_transport')!;
    staged.units = [defender, truck]; staged.terrainLayoutVersion = 2;
    staged.terrainHasBuildings = false; staged.buildings = [];
    defender.pos = { x: 480, y: 480 }; defender.prevPos = { ...defender.pos };
    defender.health = 100; defender.grenades = 0; defender.reloadTimer = 100_000;
    truck.transport!.dropOff = { ...truck.pos }; truck.transport!.unloadTicks = CONFIG.tickRate; truck.transport!.retryTick = 0;
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.pinned = false; unit.suppression = 0;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    expect((await getState(page))!.units.find((u) => u.id === truck.id)!.transport!.passengers).toBe(6);
    await page.screenshot({ path: testInfo.outputPath('enemy-transport-loaded.png') });
    await call<void>(page, 'step', 12); await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    let state = (await getState(page))!;
    expect(state.units.find((u) => u.id === truck.id)!.transport!.passengers).toBe(6);
    expect(state.units.find((u) => u.id === truck.id)!.transport!.unloadTicks).toBe(CONFIG.tickRate - 12);
    await call<void>(page, 'step', CONFIG.tickRate - 12 + 1); state = (await getState(page))!;
    expect(state.units.filter((u) => u.team === 'enemy' && u.role === 'rifle')).toHaveLength(6);
    expect(state.units.find((u) => u.id === truck.id)!.transport!.passengers).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('enemy-transport-unloaded.png') });
    for (let i = 0; i < 20 && (await getState(page))!.units.some((u) => u.id === truck.id && u.health > 0); i++) {
      await call<boolean>(page, 'fireShot', defender.id, truck.id);
    }
    expect((await getState(page))!.battleRecord.enemyKills).toBe(1);
    expect((await getState(page))!.units.filter((u) => u.team === 'enemy' && u.role === 'rifle')).toHaveLength(6);
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    for (let i = 0; i < 20 && (await getState(page))!.units.some((u) => u.id === truck.id && u.health > 0); i++) {
      await call<boolean>(page, 'fireShot', defender.id, truck.id);
    }
    await call<void>(page, 'step', 1); state = (await getState(page))!;
    expect(state.battleRecord.enemyKills).toBe(7);
    expect(state.units.filter((u) => u.team === 'enemy')).toHaveLength(0);
    await expect(page.locator('#notices')).toContainText('all 6 passengers killed');
    await page.screenshot({ path: testInfo.outputPath('enemy-transport-destroyed-loaded.png') });
    expect(errors).toEqual([]);
  });

  test('tank crew bail out after a bazooka knockout and survive Continue without duplicate deployment', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T10:01:00Z'));
    await call<void>(page, 'spawnEnemyAt', 'vehicle', 492, 432);
    const staged = (await getState(page))!, soldier = staged.units.find((unit) => unit.team === 'friendly')!, tank = staged.units.find((unit) => unit.role === 'vehicle')!;
    soldier.role = 'at'; soldier.rockets = 4; soldier.pos = { x: 492, y: 612 }; soldier.prevPos = { ...soldier.pos };
    soldier.path = []; soldier.moveGoal = null; soldier.grenades = 0; soldier.reloadTimer = 100_000;
    tank.tankDamage = { tracks: true, turret: true, machineGun: false }; tank.health = 280;
    tank.reloadTimer = tank.secondaryReloadTimer = 100_000; tank.path = []; tank.moveGoal = null;
    staged.units = [soldier, tank]; staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000; staged.rng = { s: 7 };
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect(await call<boolean>(page, 'fireShot', soldier.id, tank.id)).toBe(true);
    await call<void>(page, 'step', 24);
    let state = (await getState(page))!;
    const crew = state.units.filter((unit) => unit.tankCrew?.tankId === tank.id);
    expect(crew).toHaveLength(CONFIG.armoredVehicle.crew.size);
    expect(state.units.some((unit) => unit.id === tank.id)).toBe(false);
    expect(state.battleRecord.enemyKills).toBe(1);
    await expect(page.locator('#notices')).toContainText('tank crew bailed out');
    await page.screenshot({ path: testInfo.outputPath('tank-crew-bailout.png') });
    await call<void>(page, 'save'); await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    state = (await getState(page))!;
    expect(state.units.filter((unit) => unit.tankCrew).map((unit) => unit.id)).toEqual(crew.map((unit) => unit.id));
    expect(state.units.filter((unit) => unit.tankCrew).map((unit) => unit.tankCrew)).toEqual(crew.map((unit) => unit.tankCrew));
    await call<void>(page, 'step', 90);
    expect((await getState(page))!.units.filter((unit) => unit.tankCrew)).toHaveLength(crew.length);
    await page.screenshot({ path: testInfo.outputPath('tank-crew-after-continue.png') });
    expect(errors).toEqual([]);
  });

  test('trees splinter under gunfire and bombs, retain visible damage, and survive Continue', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') }); await page.clock.pauseAt(new Date('2026-10-21T10:01:00Z'));
    await call<void>(page, 'spawnEnemyAt', 'rifle', 600, 500);
    const staged = (await getState(page))!;
    const grove = (seed: number) => {
      const data = generateTerrain(seed, false, 2, staged.campaignCountry, staged.season);
      const candidates = Array.from(data.kinds, (kind, cell) => ({ kind, cell, pos: treeCellPosition(data.terrain, cell) }))
        .filter((tree) => isTreeKind(tree.kind) && tree.pos.x > 280 && tree.pos.x < 690 && tree.pos.y > 290 && tree.pos.y < 550)
        .filter((tree) => treeOnShot(data.terrain, data.kinds, { x: tree.pos.x - 60, y: tree.pos.y }, { x: tree.pos.x + 60, y: tree.pos.y }) === tree.cell)
        .sort((a, b) => a.pos.x - b.pos.x || a.pos.y - b.pos.y);
      return candidates;
    };
    let candidates = grove(staged.seed);
    for (let seed = 2027; candidates.length < 4 && seed < 2100; seed++) {
      candidates = grove(seed); staged.seed = staged.baseTerrainSeed = seed;
    }
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    const bulletTree = candidates[0]!, bombTree = candidates.at(-1)!;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    const shooter = staged.units.find((unit) => unit.team === 'friendly')!, target = staged.units.find((unit) => unit.team === 'enemy')!;
    shooter.pos = { x: bulletTree.pos.x - 60, y: bulletTree.pos.y }; shooter.accuracySkill = .4; shooter.morale = 0; shooter.suppression = CONFIG.suppression.max; shooter.pinned = true;
    target.pos = { x: bulletTree.pos.x + 60, y: bulletTree.pos.y }; target.health = 1000;
    staged.units = [shooter, target]; for (const unit of staged.units) { unit.prevPos = { ...unit.pos }; unit.reloadTimer = 100_000; unit.path = []; unit.moveGoal = null; unit.grenades = 0; }
    staged.treeDamage = candidates.slice(1, -1).filter((tree) => Math.hypot(tree.pos.x - bombTree.pos.x, tree.pos.y - bombTree.pos.y) > 40)
      .map((tree, i) => ({ cell: tree.cell, kind: tree.kind, health: [88, 50, 0][i % 3]! }));
    staged.strikes = [{ id: staged.nextEntityId++, pos: bombTree.pos, landTick: staged.ticks + 1,
      radius: 32, damage: 120, suppressionAmount: 0, source: 'friendly', delivery: 'airSupport' }];
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    const zoom = async () => { await page.locator('#game canvas').focus(); for (let i = 0; i < 4; i++) await page.keyboard.press('='); await call<void>(page, 'step', 0); };
    await zoom();
    for (let shot = 0; shot < 10; shot++) {
      expect(await call<boolean>(page, 'fireShot', shooter.id, target.id)).toBe(true);
      if ((await getState(page))!.treeDamage!.some((tree) => tree.cell === bulletTree.cell)) break;
    }
    expect((await getState(page))!.treeDamage!.find((tree) => tree.cell === bulletTree.cell)!.health).toBeLessThan(100);
    await call<void>(page, 'step', 1); await page.clock.runFor(150);
    expect((await getState(page))!.treeDamage!.find((tree) => tree.cell === bombTree.cell)!.health).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('trees-splintering.png') });
    await page.clock.runFor(1600); await page.screenshot({ path: testInfo.outputPath('trees-damaged.png') });
    const bounds = (await page.locator('#game canvas').boundingBox())!, center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const projected = await gamePoint(page, bombTree.pos.x, bombTree.pos.y);
    await page.mouse.move(center.x, center.y); await page.keyboard.down('Control'); await page.mouse.down();
    await page.mouse.move(center.x * 2 - projected.x, center.y * 2 - projected.y, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Control');
    await page.locator('#game canvas').focus(); await page.keyboard.press('='); await page.keyboard.press('='); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('trees-damage-detail.png') });
    const before = (await getState(page))!.treeDamage;
    await call<void>(page, 'save'); await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await zoom();
    expect((await getState(page))!.treeDamage).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath('trees-damaged-restored.png') }); expect(errors).toEqual([]);
  });

  test('destroyed houses show varied rubble and retain their appearance through Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') }); await page.clock.pauseAt(new Date('2026-10-21T10:01:00Z'));
    const staged = (await getState(page))!;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = true;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    staged.units = [staged.units[0]!]; staged.units[0]!.pos = { x: 300, y: 650 }; staged.units[0]!.prevPos = { ...staged.units[0]!.pos };
    staged.buildings = Array.from({ length: 9 }, (_, i) => ({
      id: staged.nextEntityId++, kind: 'house', name: `House ${i + 1}`, pos: { x: 336 + i % 3 * 120, y: 288 + Math.floor(i / 3) * 96 },
      ...CONFIG.buildings.footprints.house, health: CONFIG.buildings.health.house, maxHealth: CONFIG.buildings.health.house,
      floors: 2 + i % 2, roofStyle: i % 2 ? 'flat' : 'pitched', rooftopAccess: i % 2 === 1, destroyed: false,
    }));
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    for (let i = 0; i < 9; i++) expect(await call<boolean>(page, 'damageBuilding', i, CONFIG.buildings.health.house)).toBe(true);
    await call<void>(page, 'step', 1); await page.clock.runFor(1200);
    const ruins = (await getState(page))!.buildings; expect(ruins.every((b) => b.destroyed && b.health === 0)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('house-rubble-normal.png') });
    const zoom = async () => { await page.locator('#game canvas').focus(); for (let i = 0; i < 4; i++) await page.keyboard.press('='); await call<void>(page, 'step', 0); };
    await zoom(); await page.screenshot({ path: testInfo.outputPath('house-rubble-detail.png') });
    await call<void>(page, 'save'); await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await zoom();
    expect((await getState(page))!.buildings).toEqual(ruins);
    await page.screenshot({ path: testInfo.outputPath('house-rubble-restored.png') });
    expect(errors).toEqual([]);
  });

  test('mortar, artillery and bombs leave distinct persistent earth scars after the dust settles', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') }); await page.clock.pauseAt(new Date('2026-10-21T10:01:00Z'));
    const staged = (await getState(page))!;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    staged.units = [staged.units[0]!]; staged.units[0]!.pos = { x: 300, y: 650 }; staged.units[0]!.prevPos = { ...staged.units[0]!.pos };
    const impacts = [
      { kind: 'mortar', x: 320, y: 315 }, { kind: 'artillery', x: 460, y: 315 }, { kind: 'airSupport', x: 620, y: 315 },
      { kind: 'airSupport', x: 420, y: 450 }, { kind: 'airSupport', x: 468, y: 450 }, { kind: 'airSupport', x: 516, y: 450 },
    ] as const;
    staged.strikes = impacts.map((impact) => ({ id: staged.nextEntityId++, pos: { x: impact.x, y: impact.y }, landTick: staged.ticks + 1,
      delivery: impact.kind, radius: impact.kind === 'mortar' ? CONFIG.mortar.radius : impact.kind === 'artillery' ? CONFIG.artillery.radius : CONFIG.airSupport.radius,
      damage: 0, suppressionAmount: 0, source: 'friendly' })); staged.groundImpacts = [];
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    const zoom = async () => { await page.locator('#game canvas').focus(); for (let i = 0; i < 4; i++) await page.keyboard.press('='); await call<void>(page, 'step', 0); };
    await zoom(); await call<void>(page, 'step', 1); expect((await getState(page))!.groundImpacts).toHaveLength(6);
    await page.clock.runFor(350); await page.screenshot({ path: testInfo.outputPath('earth-impact-dust.png') });
    await page.clock.runFor(2800); await page.screenshot({ path: testInfo.outputPath('earth-impact-scars.png') });
    const corner = await gamePoint(page, 270, 250), opposite = await gamePoint(page, 720, 535), bounds = (await page.locator('#game canvas').boundingBox())!;
    const x = Math.max(bounds.x, corner.x), y = Math.max(bounds.y, corner.y - 15);
    await page.screenshot({ path: testInfo.outputPath('earth-impact-detail.png'), clip: {
      x, y, width: Math.min(bounds.x + bounds.width, opposite.x) - x, height: Math.min(bounds.y + bounds.height, opposite.y + 15) - y,
    } });
    const before = (await getState(page))!.groundImpacts;
    await call<void>(page, 'save'); await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await zoom();
    expect((await getState(page))!.groundImpacts).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath('earth-impact-restored.png') }); expect(errors).toEqual([]);
  });

  test('field fortifications look rough at normal and close range and retain their appearance after Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-21T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-21T10:01:00Z'));
    const staged = (await getState(page))!;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.sandbags = [{ id: staged.nextEntityId++, pos: { x: 380, y: 340 } }];
    staged.trenches = [{ id: staged.nextEntityId++, pos: { x: 560, y: 340 } }];
    staged.bunkers = [{ id: staged.nextEntityId++, pos: { x: 400, y: 440 } }];
    staged.mortarPits = [{ id: staged.nextEntityId++, pos: { x: 565, y: 440 } }];
    staged.units = [staged.units[0]!]; staged.units[0]!.pos = { x: 480, y: 430 }; staged.units[0]!.prevPos = { ...staged.units[0]!.pos };
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('field-fortifications-overview.png') });
    const zoom = async () => {
      const distance = async () => { const a = await gamePoint(page, 480, 390), b = await gamePoint(page, 580, 390); return Math.hypot(b.x - a.x, b.y - a.y); };
      const baseline = await distance();
      await page.locator('#game canvas').focus();
      for (let i = 0; i < 4; i++) await page.keyboard.press('=');
      await call<void>(page, 'step', 0);
      expect(await distance()).toBeGreaterThan(baseline * 1.5);
    };
    await zoom(); await page.screenshot({ path: testInfo.outputPath('field-fortifications-closeup.png') });
    const corner = await gamePoint(page, 340, 300), opposite = await gamePoint(page, 640, 485);
    await page.screenshot({ path: testInfo.outputPath('field-fortifications-detail.png'), clip: {
      x: Math.floor(corner.x), y: Math.floor(corner.y - 20), width: Math.ceil(opposite.x - corner.x), height: Math.ceil(opposite.y - corner.y + 40),
    } });
    const before = (await getState(page))!;
    await call<void>(page, 'save'); await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    const restored = (await getState(page))!;
    for (const key of ['sandbags', 'trenches', 'bunkers', 'mortarPits', 'rng'] as const) expect(restored[key]).toEqual(before[key]);
    await zoom(); await page.screenshot({ path: testInfo.outputPath('field-fortifications-restored.png') });
    expect(errors).toEqual([]);
  });

  for (const role of ['rifleman', 'engineer', 'at', 'mortarman'] as const) test(`veteran ${role} automatically calls medical and ammunition support after Continue`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T10:01:00Z'));
    await page.locator('#btn-resume').click(); await call<void>(page, 'givePoints', 100);
    for (const recruit of [role, 'medic', 'supply_officer']) expect(await call<boolean>(page, 'recruit', recruit, 492, 680)).toBe(true);
    await call<void>(page, 'pause');
    const staged = (await getState(page))!, soldier = staged.units.filter((unit) => unit.role === role).at(-1)!, medic = staged.units.find((unit) => unit.role === 'medic')!, officer = staged.units.find((unit) => unit.role === 'supply_officer')!;
    staged.units = [medic, officer, soldier]; soldier.pos = { x: 588, y: 612 }; medic.pos = { x: 156, y: 612 }; officer.pos = { x: 156, y: 564 };
    soldier.health = 40; soldier.xp = CONFIG.automaticSupport.unlockXp;
    soldier.grenades = 0; soldier.rockets = 0; soldier.mortarBombs = 0;
    for (const unit of staged.units) { unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.reloadTimer = 100_000; unit.stance = 'standing'; }
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 1); let state = (await getState(page))!;
    expect(state.medicalQueue).toEqual([soldier.id]); expect(state.grenadeSupplyQueue).toEqual([soldier.id]);
    const row = page.locator(`.roster-soldier[data-unit-id="${soldier.id}"]`); await row.click(); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-xp')).toContainText('Auto support');
    await expect(row).toContainText('Medic assigned'); await expect(row).toContainText('supplies incoming');
    await expect(page.locator('#notices')).toContainText('automatically requested a medic');
    const ammunition = role === 'at' ? 'rocket supplies' : role === 'mortarman' ? 'mortar supplies' : 'grenade supplies';
    await expect(page.locator('#notices')).toContainText(`automatically requested ${ammunition}`);
    if (role === 'engineer') {
      await row.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Grenade supplies' })).toBeDisabled(); await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: testInfo.outputPath('automatic-support-incoming.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect((await getState(page))!.medicalQueue).toEqual([soldier.id]); expect((await getState(page))!.grenadeSupplyQueue).toEqual([soldier.id]);
    for (let i = 0; i < 60; i++) {
      await call<void>(page, 'step', 30); state = (await getState(page))!;
      if (!state.medicalQueue?.length && !state.grenadeSupplyQueue?.length) break;
    }
    const restored = state.units.find((unit) => unit.id === soldier.id)!;
    expect(restored.health).toBeGreaterThan(40); expect(state.medicalQueue).toEqual([]); expect(state.grenadeSupplyQueue).toEqual([]);
    expect(role === 'at' ? restored.rockets : role === 'mortarman' ? restored.mortarBombs : restored.grenades).toBe(role === 'mortarman' ? 6 : 4);
    await row.click(); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('automatic-support-delivered.png') });
    expect(errors).toEqual([]);
  });

  for (const disrupted of [false, true]) test(`enemy smoke-screen assaults warn, ${disrupted ? 'are disrupted by suppression' : 'advance infantry and survive Continue'}`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T10:01:00Z'));
    await page.locator('#btn-resume').click();
    await call<void>(page, 'spawnEnemyAt', 'assault', 492, 372);
    await call<void>(page, 'spawnEnemyAt', 'rifle', 516, 372); await call<void>(page, 'pause');
    const staged = (await getState(page))!, defender = staged.units.find((unit) => unit.team === 'friendly')!, leader = staged.units.find((unit) => unit.role === 'assault')!, rifle = staged.units.find((unit) => unit.team === 'enemy' && unit.role === 'rifle')!;
    staged.units = [defender, leader, rifle]; defender.pos = { x: 492, y: 612 }; leader.health = 10_000;
    for (const unit of staged.units) { unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.reloadTimer = 100_000; unit.grenades = 0; unit.stance = 'standing'; unit.morale = 100; }
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.scheduler.waveIndex = 3; staged.scheduler.prepTicksLeft = 100_000;
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 1);
    let state = (await getState(page))!;
    expect(state.enemySmokeAssaults).toHaveLength(1); expect(state.smokes).toHaveLength(0);
    await expect(page.locator('#notices')).toContainText('Enemy smoke-screen assault!');
    await page.screenshot({ path: testInfo.outputPath('enemy-smoke-warning.png') });
    if (disrupted) {
      for (let i = 0; i < 9; i++) expect(await call<boolean>(page, 'fireShot', defender.id, leader.id)).toBe(true);
      await call<void>(page, 'step', 1);
      await expect(page.locator('#notices')).toContainText('Enemy smoke throw disrupted.');
      await call<void>(page, 'step', 50); state = (await getState(page))!;
      expect(state.smokes).toHaveLength(0); expect(state.enemySmokeAssaults).toHaveLength(0);
      expect(state.units.find((unit) => unit.id === leader.id)!.smokeGrenades).toBe(1);
      expect(errors).toEqual([]); return;
    }
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect((await getState(page))!.enemySmokeAssaults![0]!.deployed).toBe(false);
    await call<void>(page, 'step', 45); state = (await getState(page))!;
    expect(state.enemySmokeAssaults![0]!.deployed).toBe(true); expect(state.smokes).toHaveLength(1);
    expect(state.units.find((unit) => unit.id === leader.id)!.smokeGrenades).toBe(0);
    await expect(page.locator('#notices')).toContainText('Enemy infantry advancing under smoke');
    await page.screenshot({ path: testInfo.outputPath('enemy-smoke-deployed.png') });
    await call<void>(page, 'pause');
    state.units.find((unit) => unit.id === defender.id)!.reloadTimer = 0;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), state);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    const beforeY = state.units.find((unit) => unit.id === leader.id)!.pos.y;
    await call<void>(page, 'step', 60); state = (await getState(page))!;
    expect(state.units.find((unit) => unit.id === leader.id)!.pos.y).toBeGreaterThan(beforeY);
    expect(state.units.find((unit) => unit.id === leader.id)!.running).toBe(false);
    expect(state.units.find((unit) => unit.id === defender.id)!.reloadTimer).toBe(0);
    expect(state.units.find((unit) => unit.id === leader.id)!.health).toBe(10_000);
    const endTick = state.enemySmokeAssaults![0]!.endTick;
    await call<void>(page, 'step', endTick - state.ticks); state = (await getState(page))!;
    expect(state.smokes).toHaveLength(0); expect(state.enemySmokeAssaults).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test('both combat engineer classes recruit with STENs and fight after Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T10:01:00Z'));
    await page.locator('#btn-resume').click(); await call<void>(page, 'givePoints', 100);
    await page.locator('#tab-army').click();
    for (const role of ['engineer', 'radio_engineer']) {
      await expect(page.locator(`.recruit-button[data-role="${role}"]`)).toHaveAttribute('title', /STEN Submachine Gun/);
      expect(await call<boolean>(page, 'recruit', role, role === 'engineer' ? 300 : 480, 680)).toBe(true);
    }
    await call<void>(page, 'spawnEnemyAt', 'rifle', 492, 432); await call<void>(page, 'pause');
    const staged = (await getState(page))!, engineer = staged.units.find((unit) => unit.role === 'engineer')!, radio = staged.units.find((unit) => unit.role === 'radio_engineer')!, enemy = staged.units.find((unit) => unit.team === 'enemy')!;
    staged.units = [engineer, radio, enemy]; engineer.pos = { x: 492, y: 612 }; radio.pos = { x: 516, y: 612 };
    for (const unit of staged.units) { unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.grenades = 0; unit.reloadTimer = 0; unit.stance = 'standing'; }
    enemy.health = 10_000; enemy.reloadTimer = 100_000; enemy.pinned = true; enemy.suppression = CONFIG.suppression.max;
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000; staged.rng = { s: 7 };
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await page.locator('#tab-squad').click(); await call<void>(page, 'step', 10);
    const state = (await getState(page))!;
    for (const unit of [engineer, radio]) {
      const fighter = state.units.find((candidate) => candidate.id === unit.id)!;
      expect(fighter.burstRemaining).toBeGreaterThan(0); expect(fighter.burstRemaining).toBeLessThan(8);
      expect(fighter.targetId).toBe(enemy.id);
    }
    expect(state.units.find((unit) => unit.id === enemy.id)!.health).toBeLessThan(10_000);
    expect(state.projectiles).toHaveLength(0);
    await page.locator(`.roster-soldier[data-unit-id="${radio.id}"]`).click(); await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('engineers-sten-burst.png') });
    expect(errors).toEqual([]);
  });

  test('bazooka ammunition runs out and Supply Officers deliver rockets through the roster menu and Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T10:01:00Z'));
    await page.locator('#btn-resume').click(); await call<void>(page, 'givePoints', 100);
    expect(await call<boolean>(page, 'recruit', 'at', 300, 680)).toBe(true);
    expect(await call<boolean>(page, 'recruit', 'supply_officer', 480, 680)).toBe(true);
    await call<void>(page, 'spawnEnemyAt', 'rifle', 588, 372); await call<void>(page, 'pause');
    const staged = (await getState(page))!, soldier = staged.units.find((unit) => unit.role === 'at')!, officer = staged.units.find((unit) => unit.role === 'supply_officer')!, enemy = staged.units.find((unit) => unit.team === 'enemy')!;
    expect(soldier.rockets).toBe(4);
    staged.units = [officer, soldier, enemy]; soldier.pos = { x: 588, y: 612 }; officer.pos = { x: 156, y: 612 }; enemy.health = 10_000;
    enemy.pinned = true; enemy.suppression = CONFIG.suppression.max;
    for (const unit of staged.units) { unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.grenades = 0; unit.reloadTimer = 100_000; unit.stance = 'standing'; }
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000; staged.rng = { s: 7 };
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    for (let i = 0; i < 4; i++) expect(await call<boolean>(page, 'fireShot', soldier.id, enemy.id)).toBe(true);
    const rocketsInFlight = (await getState(page))!.projectiles.length;
    expect(await call<boolean>(page, 'fireShot', soldier.id, enemy.id)).toBe(true); await call<void>(page, 'step', 0);
    expect((await getState(page))!.projectiles).toHaveLength(rocketsInFlight);
    expect((await getState(page))!.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(0);
    const row = page.locator(`.roster-soldier[data-unit-id="${soldier.id}"]`), action = page.getByRole('menuitem', { name: 'Rocket supplies' });
    await expect(row).toContainText('Out of rockets');
    await row.click({ button: 'right' }); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-rockets')).toHaveText('Rockets: 0/4'); await expect(page.locator('#sel-grenades')).toBeHidden();
    await expect(page.locator('#sel-action')).toContainText('Using rifle');
    await expect(action).toBeEnabled(); await action.click();
    await expect(page.locator('#radio-chatter')).toContainText('Rocket supplies!');
    await call<void>(page, 'step', 120);
    expect((await getState(page))!.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(0);
    expect((await getState(page))!.units.find((unit) => unit.id === officer.id)!.pos.x).toBeGreaterThan(156);
    await expect(row).toContainText('Rocket supplies incoming');
    await row.click({ button: 'right' }); await expect(action).toBeDisabled(); await page.screenshot({ path: testInfo.outputPath('bazooka-supplies-incoming.png') });
    await page.keyboard.press('Escape'); await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect((await getState(page))!.grenadeSupplyQueue).toEqual([soldier.id]);
    let state = (await getState(page))!;
    for (let i = 0; i < 50 && state.units.find((unit) => unit.id === soldier.id)!.rockets !== 4; i++) { await call<void>(page, 'step', 30); state = (await getState(page))!; }
    expect(state.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(4); expect(state.grenadeSupplyQueue).toEqual([]);
    await row.click({ button: 'right' }); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-rockets')).toHaveText('Rockets: 4/4'); await expect(action).toBeDisabled();
    await expect(page.locator('#sel-action')).not.toContainText('Using rifle');
    await expect(page.locator('#soldier-supply-note')).toContainText('Rockets are full');
    await page.screenshot({ path: testInfo.outputPath('bazooka-supplies-delivered.png') });
    await page.keyboard.press('Escape'); expect(await call<boolean>(page, 'fireShot', soldier.id, enemy.id)).toBe(true);
    expect((await getState(page))!.units.find((unit) => unit.id === soldier.id)!.rockets).toBe(3);
    expect(errors).toEqual([]);
  });

  test('mortarmen exhaust bombs and receive Supply Officer refills through the roster and Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T10:01:00Z'));
    await page.locator('#btn-resume').click(); await call<void>(page, 'givePoints', 100);
    expect(await call<boolean>(page, 'recruit', 'mortarman', 300, 680)).toBe(true);
    expect(await call<boolean>(page, 'recruit', 'supply_officer', 480, 680)).toBe(true);
    await call<void>(page, 'spawnEnemyAt', 'rifle', 588, 372); await call<void>(page, 'pause');
    const staged = (await getState(page))!, soldier = staged.units.find((unit) => unit.role === 'mortarman')!, officer = staged.units.find((unit) => unit.role === 'supply_officer')!, enemy = staged.units.find((unit) => unit.team === 'enemy')!;
    expect(soldier.mortarBombs).toBe(6);
    staged.units = [officer, soldier, enemy]; soldier.pos = { x: 588, y: 612 }; officer.pos = { x: 450, y: 612 }; enemy.health = 10_000;
    soldier.mortarBombs = 1; soldier.mortarTimer = 0; enemy.pinned = true; enemy.suppression = CONFIG.suppression.max;
    for (const unit of staged.units) { unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.grenades = 0; unit.reloadTimer = 100_000; unit.stance = 'standing'; }
    staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000; staged.scheduler.prepTicksLeft = 100_000; staged.rng = { s: 7 };
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 1);
    expect((await getState(page))!.strikes.filter((strike) => strike.delivery === 'mortar')).toHaveLength(1);
    const row = page.locator(`.roster-soldier[data-unit-id="${soldier.id}"]`), action = page.getByRole('menuitem', { name: 'Mortar supplies' });
    await expect(row).toContainText('Out of mortar bombs');
    await row.click({ button: 'right' }); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-mortar-bombs')).toHaveText('Mortar bombs: 0/6');
    await expect(page.locator('#sel-action')).toContainText('Using rifle');
    expect(await call<boolean>(page, 'fireShot', soldier.id, enemy.id)).toBe(true);
    expect((await getState(page))!.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(0);
    await expect(page.locator('#sel-rockets')).toBeHidden(); await expect(page.locator('#sel-grenades')).toBeHidden();
    await expect(action).toBeEnabled(); await action.click();
    await expect(page.locator('#radio-chatter')).toContainText('Mortar supplies!');
    await call<void>(page, 'step', 30);
    expect((await getState(page))!.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(0);
    expect((await getState(page))!.units.find((unit) => unit.id === officer.id)!.pos.x).toBeGreaterThan(450);
    await expect(row).toContainText('Mortar supplies incoming');
    await row.click({ button: 'right' }); await expect(action).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('mortar-supplies-incoming.png') });
    await page.keyboard.press('Escape'); await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect((await getState(page))!.grenadeSupplyQueue).toEqual([soldier.id]);
    let state = (await getState(page))!;
    for (let i = 0; i < 12 && state.units.find((unit) => unit.id === soldier.id)!.mortarBombs !== 6; i++) { await call<void>(page, 'step', 30); state = (await getState(page))!; }
    expect(state.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(6); expect(state.grenadeSupplyQueue).toEqual([]);
    await row.click({ button: 'right' }); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-mortar-bombs')).toHaveText('Mortar bombs: 6/6'); await expect(action).toBeDisabled();
    await expect(page.locator('#sel-action')).not.toContainText('Using rifle');
    await expect(page.locator('#soldier-supply-note')).toContainText('Mortar bombs are full');
    await page.screenshot({ path: testInfo.outputPath('mortar-supplies-delivered.png') });
    await page.keyboard.press('Escape');
    await call<void>(page, 'step', CONFIG.mortar.intervalSeconds * CONFIG.tickRate);
    expect((await getState(page))!.units.find((unit) => unit.id === soldier.id)!.mortarBombs).toBe(5);
    expect(errors).toEqual([]);
  });

  test('Supply Officers can be recruited and deliver queued grenade supplies after riflemen call out', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const tracked = window as unknown as { __grenadeCalls: number }; tracked.__grenadeCalls = 0;
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        if (this.buffer && Math.abs(this.buffer.duration - 1.605125) < 0.005) tracked.__grenadeCalls++;
        return start.apply(this, args);
      };
    });
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-19T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-19T10:01:00Z'));
    await page.locator('#btn-resume').click(); await call<void>(page, 'givePoints', 100);
    await call<void>(page, 'step', 0); await page.locator('#tab-army').click();
    const recruit = page.locator('.recruit-button[data-role="supply_officer"]');
    await expect(recruit).toContainText('Supply Officer'); await recruit.click();
    const deployment = await gamePoint(page, 480, 680); await page.mouse.click(deployment.x, deployment.y);
    expect((await getState(page))!.units.some((u) => u.role === 'supply_officer')).toBe(true);
    await call<void>(page, 'pause');
    const staged = (await getState(page))!, rifleman = staged.units.find((u) => u.role === 'rifleman')!;
    const officer = staged.units.find((u) => u.role === 'supply_officer')!, second = structuredClone(rifleman);
    second.id = staged.nextEntityId++; staged.units = [officer, rifleman, second]; staged.terrainLayoutVersion = 2;
    officer.pos = { x: 360, y: 600 }; rifleman.pos = { x: 552, y: 600 }; second.pos = { x: 408, y: 600 };
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.grenades = 0; unit.reloadTimer = 100_000;
      unit.pinned = false; unit.suppression = 0; unit.stance = 'standing'; unit.crawling = false;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    const riflemanRow = page.locator(`.roster-soldier[data-unit-id="${rifleman.id}"]`);
    const secondRow = page.locator(`.roster-soldier[data-unit-id="${second.id}"]`);
    const supplyAction = page.getByRole('menuitem', { name: 'Grenade supplies' });
    await riflemanRow.click({ button: 'right' }); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-grenades')).toHaveText('Grenades: 0/4');
    await expect(supplyAction).toBeEnabled(); await page.keyboard.press('ArrowDown'); await expect(supplyAction).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __grenadeCalls: number }).__grenadeCalls)).toBe(1);
    await expect(page.locator('#radio-chatter')).toContainText('Grenade supplies!');
    expect((await getState(page))!.units[0]!.supplyTargetId).toBe(rifleman.id);
    await secondRow.click({ button: 'right' }); await supplyAction.click(); await call<void>(page, 'step', 0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __grenadeCalls: number }).__grenadeCalls)).toBe(2);
    expect((await getState(page))!.grenadeSupplyQueue).toEqual([rifleman.id, second.id]);
    await expect(riflemanRow).toContainText('Grenade supplies incoming'); await expect(secondRow).toContainText('Waiting for grenades · #1');
    await secondRow.click({ button: 'right' }); await expect(supplyAction).toBeDisabled();
    await expect(page.locator('#soldier-supply-note')).toContainText('queue position 1');
    await page.screenshot({ path: testInfo.outputPath('grenade-supplies-queued.png') });
    await page.keyboard.press('Escape'); await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect((await getState(page))!.grenadeSupplyQueue).toEqual([rifleman.id, second.id]);
    let state = (await getState(page))!;
    for (let i = 0; i < 100 && state.units[1]!.grenades === 0; i++) {
      await call<void>(page, 'step', 10); state = (await getState(page))!;
      if (state.units[1]!.grenades === 0) expect(state.units[2]!.grenades).toBe(0);
    }
    expect(state.units[1]!.grenades).toBe(4); await call<void>(page, 'step', 600);
    expect((await getState(page))!.units[2]!.grenades).toBe(4); expect((await getState(page))!.grenadeSupplyQueue).toEqual([]);
    await secondRow.click({ button: 'right' }); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-grenades')).toHaveText('Grenades: 4/4'); await expect(supplyAction).toBeDisabled();
    await expect(page.locator('#soldier-supply-note')).toContainText('Grenades are full');
    await page.screenshot({ path: testInfo.outputPath('grenade-supplies-delivered.png') });
    await page.keyboard.press('Escape');
    await page.locator(`.roster-soldier[data-unit-id="${officer.id}"]`).click({ button: 'right' });
    await expect(supplyAction).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('roster right-click options dispatch a medic and support keyboard dismissal', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const tracked = window as unknown as { __medicCallsStarted: number[] }; tracked.__medicCallsStarted = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        if (this.buffer && Math.abs(this.buffer.duration - 0.688345) < 0.005) tracked.__medicCallsStarted.push(this.buffer.duration);
        return start.apply(this, args);
      };
    });
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-19T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-19T10:00:01Z'));
    const staged = (await getState(page))!, medic = staged.units[0]!, patient = staged.units[1]!;
    const waiting = structuredClone(patient); waiting.id = staged.nextEntityId++; waiting.pos = { x: 408, y: 600 }; waiting.health = 40;
    staged.units = [medic, patient, waiting]; staged.terrainLayoutVersion = 2;
    medic.role = 'medic'; medic.health = 100; medic.healTimer = 0; medic.pos = { x: 360, y: 600 };
    patient.health = 40; patient.pos = { x: 552, y: 600 };
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.grenades = 0; unit.reloadTimer = 100_000;
      unit.pinned = false; unit.suppression = 0; unit.stance = 'standing'; unit.crawling = false;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    const patientRow = page.locator(`.roster-soldier[data-unit-id="${patient.id}"]`);
    const medicRow = page.locator(`.roster-soldier[data-unit-id="${medic.id}"]`);
    const waitingRow = page.locator(`.roster-soldier[data-unit-id="${waiting.id}"]`);
    const menu = page.getByRole('menu', { name: soldierName(staged.baseTerrainSeed, patient.id) });
    await patientRow.click({ button: 'right' }); await call<void>(page, 'step', 0);
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Call medic' })).toBeEnabled();
    const bounds = (await menu.boundingBox())!, viewport = page.viewportSize()!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await call<number | null>(page, 'selection')).toBe(patient.id);
    await page.screenshot({ path: testInfo.outputPath('call-medic-options.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden(); await expect(patientRow).toBeFocused();
    expect(await call<boolean>(page, 'paused')).toBe(false);
    await patientRow.press('Shift+F10'); await expect(menu).toBeVisible();
    await page.keyboard.press('Enter'); await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __medicCallsStarted: number[] }).__medicCallsStarted.length)).toBe(1);
    await expect(page.locator('#radio-chatter')).toContainText('Medic!');
    expect((await getState(page))!.units[0]!.medicalTargetId).toBe(patient.id);
    await waitingRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Call medic' })).toBeEnabled();
    await page.getByRole('menuitem', { name: 'Call medic' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __medicCallsStarted: number[] }).__medicCallsStarted.length)).toBe(2);
    await call<void>(page, 'step', 0);
    expect((await getState(page))!.medicalQueue).toEqual([patient.id, waiting.id]);
    await expect(waitingRow).toContainText('Waiting for medic · #1');
    await waitingRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Call medic' })).toBeDisabled();
    await expect(page.locator('#soldier-options')).toContainText('queue position 1');
    await page.screenshot({ path: testInfo.outputPath('medic-request-queued.png') });
    await expect(patientRow).toContainText('Medic assigned');
    await expect(medicRow).toContainText('Attending wounded');
    await patientRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Call medic' })).toBeDisabled();
    await expect(menu).toContainText('already attending');
    await page.locator('#hud-points').click(); await expect(menu).toBeHidden();
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    expect((await getState(page))!.units[0]!.medicalTargetId).toBe(patient.id);
    expect((await getState(page))!.medicalQueue).toEqual([patient.id, waiting.id]);
    let treatment = (await getState(page))!;
    for (let i = 0; i < 1200 && treatment.units[1]!.health < 100; i++) {
      await call<void>(page, 'step', 10); treatment = (await getState(page))!;
      if (treatment.units[1]!.health < 100) expect(treatment.units[2]!.health).toBe(40);
    }
    expect((await getState(page))!.units[1]!.health).toBe(100);
    await call<void>(page, 'step', 1200);
    expect((await getState(page))!.units[2]!.health).toBe(100);
    expect((await getState(page))!.units[0]!.medicalTargetId).toBeUndefined();
    await patientRow.click({ button: 'right' });
    await call<void>(page, 'step', 0);
    await expect(page.getByRole('menuitem', { name: 'Call medic' })).toBeDisabled();
    await expect(menu).toContainText('full health');
    await page.screenshot({ path: testInfo.outputPath('call-medic-healed.png') });
    await page.keyboard.press('Escape');
    await call<void>(page, 'pause');
    medic.role = 'rifleman';
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await patientRow.click(); await call<void>(page, 'step', 0);
    await page.locator('#sel-name').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Call medic' })).toBeDisabled();
    await expect(menu).toContainText('No medic available');
    expect(errors).toEqual([]);
  });

  test('every infantry soldier can light a small fire at night and keep it through Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-18T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-18T10:00:10Z'));
    const staged = (await getState(page))!, soldier = staged.units[0]!;
    staged.units = [soldier]; staged.terrainHasBuildings = false; staged.buildings = [];
    soldier.role = 'medic'; soldier.pos = { x: 480, y: 600 }; soldier.prevPos = { ...soldier.pos };
    soldier.path = []; soldier.moveGoal = null; soldier.pinned = false; soldier.suppression = 0;
    staged.ticks = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate / 2;
    staged.wavesCompleted = 3; staged.dayNightStartTick = 0;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    const button = page.locator('#btn-light-fire');
    await expect(button).toBeEnabled();
    await button.click(); await call<void>(page, 'step', 0);
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Fire burning · 60s');
    const lit = (await getState(page))!;
    expect(lit.campfires).toHaveLength(1);
    expect(lit.campfires![0]).toMatchObject({ unitId: soldier.id, pos: soldier.pos, radius: 70 });
    expect(lit.points).toBe(staged.points);
    await call<void>(page, 'moveUnit', 0, 540, 600); await call<void>(page, 'step', 90);
    await page.screenshot({ path: `artifacts/campfire-night-${testInfo.project.name}.png` });
    await call<void>(page, 'save');
    const saved = (await getState(page))!;
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.campfires).toEqual(saved.campfires);
    await expect(button).toBeDisabled();
    await expect(button).toContainText('Fire burning');
    expect(errors).toEqual([]);
  });

  test('run to gunfire can be selected, restored, and stops to engage', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026); await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-18T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-18T10:00:10Z'));
    const staged = (await getState(page))!, rifleman = staged.units[0]!;
    staged.units = [rifleman]; staged.terrainLayoutVersion = 2; staged.terrainHasBuildings = false; staged.buildings = [];
    rifleman.role = 'rifleman'; rifleman.pos = { x: 36, y: 600 }; rifleman.prevPos = { ...rifleman.pos };
    rifleman.path = []; rifleman.moveGoal = null; rifleman.grenades = 0; rifleman.reloadTimer = 0;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    for (let cycle = 0; cycle < 4; cycle++) { await page.locator('#btn-fire-order').click(); await call<void>(page, 'step', 0); }
    await expect(page.locator('#btn-fire-order')).toHaveAttribute('aria-label', 'Fire order: Run to gunfire');
    await expect(page.locator('#btn-fire-order')).toHaveAttribute('title', /nearest heard enemy gunfire/);
    await expect(page.locator('#sel-action')).toHaveText('Listening for gunfire');
    await call<void>(page, 'spawnEnemyAt', 'rifle', 36, 300);
    const enemy = (await getState(page))!.units.find((unit) => unit.team === 'enemy')!;
    expect(await call<boolean>(page, 'fireShot', enemy.id, rifleman.id)).toBe(true);
    await call<void>(page, 'step', 1);
    let current = (await getState(page))!.units[0]!;
    expect(current.gunfirePursuit?.sourceId).toBe(enemy.id); expect(current.running).toBe(true);
    await expect(page.locator('#sel-action')).toHaveText('Running to gunfire');
    await page.screenshot({ path: testInfo.outputPath('running-to-gunfire.png') });
    await call<void>(page, 'save'); const saved = current;
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    current = (await getState(page))!.units[0]!;
    expect(current.fireOrder).toBe('seekGunfire'); expect(current.gunfirePursuit).toEqual(saved.gunfirePursuit);
    expect(current.stamina).toBe(saved.stamina);
    await call<void>(page, 'step', 45);
    current = (await getState(page))!.units[0]!;
    expect(current.targetId).toBe(enemy.id); expect(current.path).toHaveLength(0); expect(current.running).toBe(false);
    await expect(page.locator('#sel-action')).toHaveText('Gunfire order · engaging');
    await page.screenshot({ path: testInfo.outputPath('gunfire-order-engaging.png') });
    await page.locator('#btn-fire-order').click(); await call<void>(page, 'step', 0);
    await expect(page.locator('#btn-fire-order')).toHaveAttribute('aria-label', 'Fire order: Auto');
    expect((await getState(page))!.units[0]!.gunfirePursuit).toBeUndefined(); expect(errors).toEqual([]);
  });

  test('combat engineers build a floating pontoon crossing that survives Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await call<void>(page, 'pause');
    await page.clock.install({ time: new Date('2026-10-17T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-17T10:00:10Z'));
    const staged = (await getState(page))!, data = generateTerrain(staged.seed, true, staged.terrainLayoutVersion ?? 3, staged.campaignCountry);
    const point = riverPathPoints(data.zones.river!, staged.seed, 24).find((candidate) =>
      candidate.x > 40 && candidate.x < 920 && candidate.y > 40 && candidate.y < 680
      && !isBridgeAt(data.zones, staged.seed, candidate.x, candidate.y)
      && data.zones.bridges.every((bridge) => Math.hypot(bridge.x - candidate.x, bridge.y - candidate.y) > 150))!;
    expect(point).toBeDefined();
    const engineer = staged.units[0]!; staged.units = [engineer]; staged.points = 1000;
    engineer.role = 'engineer'; engineer.pos = { ...point }; engineer.prevPos = { ...point };
    engineer.path = []; engineer.moveGoal = null; engineer.grenades = 0; engineer.reloadTimer = 100_000;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    await page.locator('#tab-support').click();
    await expect(page.locator('#btn-bridge')).toContainText('Pontoon bridge');
    await page.locator('#btn-bridge').click();
    const target = await gamePoint(page, point.x, point.y); await page.mouse.click(target.x, target.y);
    expect((await getState(page))!.constructionSites.some((site) => site.kind === 'bridge')).toBe(true);
    await call<void>(page, 'step', CONFIG.construction.bridgeSeconds * CONFIG.tickRate + 1);
    const built = (await getState(page))!;
    expect(built.builtBridges).toHaveLength(1); expect(built.units[0]!.bridgePosition?.level).toBe('deck');
    const bridge = built.builtBridges![0]!;
    const focus = async () => {
      const bounds = (await page.locator('#game canvas').boundingBox())!;
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await page.mouse.move(center.x, center.y); await page.mouse.wheel(0, -1000);
      const projected = await gamePoint(page, point.x, point.y);
      await page.keyboard.down('Control'); await page.mouse.down();
      await page.mouse.move(center.x * 2 - projected.x, center.y * 2 - projected.y, { steps: 4 });
      await page.mouse.up(); await page.keyboard.up('Control'); await call<void>(page, 'step', 0);
    };
    await focus(); await page.screenshot({ path: testInfo.outputPath('engineer-pontoon-built.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.builtBridges).toEqual(built.builtBridges);
    expect((await getState(page))!.units[0]!.bridgePosition).toEqual(built.units[0]!.bridgePosition);
    await focus(); await page.screenshot({ path: testInfo.outputPath('engineer-pontoon-restored.png') });
    const end = bridge.axis === 'horizontal' ? { x: point.x + bridge.halfLength + 24, y: point.y }
      : { x: point.x, y: point.y + bridge.halfLength + 24 };
    expect(await call<boolean>(page, 'moveUnit', 0, end.x, end.y)).toBe(true);
    await call<void>(page, 'step', 600);
    const crossed = (await getState(page))!.units[0]!;
    expect(crossed.bridgePosition).toBeUndefined(); expect(crossed.path).toHaveLength(0);
    expect(Math.hypot(crossed.pos.x - end.x, crossed.pos.y - end.y)).toBeLessThan(24);
    expect(errors).toEqual([]);
  });

  for (const role of ['rifleman', 'sniper', 'medic'] as const) {
  test(`${role} patrol a marked area, restore it, and cancel through movement or Stop patrol`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    const staged = (await getState(page))!, rifleman = staged.units[0]!;
    rifleman.role = role;
    rifleman.health = role === 'sniper' ? 80 : 100;
    staged.units = [rifleman]; staged.terrainLayoutVersion = 2;
    rifleman.pos = { x: 360, y: 600 }; rifleman.prevPos = { ...rifleman.pos };
    rifleman.path = []; rifleman.moveGoal = null; rifleman.grenades = 0; rifleman.reloadTimer = 100_000;
    const gunner = structuredClone(rifleman); gunner.id = staged.nextEntityId++; gunner.role = 'mg';
    gunner.health = 115;
    gunner.pos = { x: 660, y: 600 }; gunner.prevPos = { ...gunner.pos }; staged.units.push(gunner);
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    await page.locator('.roster-soldier').nth(1).click(); await call<void>(page, 'step', 0);
    await expect(page.locator('#btn-patrol')).toBeHidden();
    await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    const first = await gamePoint(page, 330, 564), opposite = await gamePoint(page, 552, 684);
    const assignPatrol = async () => {
      await page.locator('#btn-patrol').click();
      await expect(page.locator('#mode-hint')).toContainText('first corner');
      await page.mouse.click(first.x, first.y);
      await expect(page.locator('#mode-hint')).toContainText('opposite corner');
      await page.mouse.move(opposite.x, opposite.y); await call<void>(page, 'step', 0);
      await page.screenshot({ path: testInfo.outputPath('patrol-area-preview.png') });
      await page.mouse.click(opposite.x, opposite.y); await call<void>(page, 'step', 0);
      await expect(page.locator('#btn-patrol')).toHaveText('Stop patrol');
    };
    await assignPatrol();
    let current = (await getState(page))!.units[0]!;
    expect(current.patrol).toBeDefined();
    const firstStation = current.patrol!.nextPoint;
    await call<void>(page, 'step', 150);
    current = (await getState(page))!.units[0]!;
    expect(current.patrol!.nextPoint).not.toBe(firstStation);
    expect(current.running).toBe(false);
    await expect(page.locator('#sel-action')).toHaveText('Patrolling');
    await page.screenshot({ path: testInfo.outputPath('patrolling-area.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.units[0]!.patrol).toEqual(current.patrol);
    await expect(page.locator('#btn-patrol')).toHaveText('Stop patrol');
    const moveTo = await gamePoint(page, 600, 660);
    await page.mouse.click(moveTo.x, moveTo.y, { button: 'right' }); await call<void>(page, 'step', 0);
    expect((await getState(page))!.units[0]!.patrol).toBeUndefined();
    await assignPatrol();
    await page.locator('#btn-patrol').click(); await call<void>(page, 'step', 0);
    const stopped = (await getState(page))!.units[0]!;
    expect(stopped.patrol).toBeUndefined(); expect(stopped.path).toHaveLength(0);
    await call<void>(page, 'step', 30);
    expect((await getState(page))!.units[0]!.pos).toEqual(stopped.pos);
    await page.locator('#btn-patrol').click(); await page.mouse.click(first.x, first.y); await page.keyboard.press('Escape');
    expect(await call<string>(page, 'mode')).toBe('none');
    expect((await getState(page))!.units[0]!.patrol).toBeUndefined();
    expect(errors).toEqual([]);
  });
  }

  test('a medic patrol pauses for treatment, survives Continue, and resumes its route', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-17T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-17T10:00:01Z'));
    const staged = (await getState(page))!, medic = staged.units[0]!, patient = staged.units[1]!;
    staged.units = [medic, patient]; staged.terrainLayoutVersion = 2;
    medic.role = 'medic'; medic.health = 100; medic.healTimer = 0; medic.pos = { x: 360, y: 600 };
    patient.health = 40; patient.pos = { x: 384, y: 600 };
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null; unit.grenades = 0; unit.reloadTimer = 100_000;
      unit.pinned = false; unit.suppression = 0; unit.stance = 'standing'; unit.crawling = false; unit.terrainCrawling = false;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    await page.locator('#btn-patrol').click();
    const first = await gamePoint(page, 330, 564), opposite = await gamePoint(page, 552, 684);
    await page.mouse.click(first.x, first.y); await page.mouse.click(opposite.x, opposite.y);
    await call<void>(page, 'step', 1);
    let current = (await getState(page))!;
    expect(current.units[1]!.health).toBe(65); expect(current.units[0]!.patrol).toBeDefined();
    expect(current.units[0]!.path).toHaveLength(0);
    await expect(page.locator('#sel-action')).toHaveText('Patrol · tending wounded');
    await expect(page.locator('#btn-patrol')).toHaveText('Stop patrol');
    await page.screenshot({ path: testInfo.outputPath('medical-patrol-treating.png') });
    const patrol = current.units[0]!.patrol;
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.units[0]!.patrol).toEqual(patrol);
    await expect(page.locator('#sel-action')).toHaveText('Patrol · tending wounded');
    await call<void>(page, 'step', 300);
    current = (await getState(page))!;
    expect(current.units[1]!.health).toBe(100);
    expect(current.units[0]!.patrol!.area).toEqual(patrol!.area);
    expect(current.units[0]!.path.length).toBeGreaterThan(0);
    await expect(page.locator('#sel-action')).toHaveText('Patrolling');
    await page.screenshot({ path: testInfo.outputPath('medical-patrol-resumed.png') });
    expect(errors).toEqual([]);
  });

  test('building damage progresses visibly with HP and survives Continue', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    const staged = (await getState(page))!;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    const flat = staged.buildings.find((building) => buildingArchitecture(building).roofStyle === 'flat')!;
    const centerOf = (building: typeof flat) => ({ x: building.pos.x + building.cols * 12, y: building.pos.y + building.rows * 12 });
    const center = centerOf(flat);
    const pitched = staged.buildings.filter((building) => buildingArchitecture(building).roofStyle === 'pitched')
      .sort((a, b) => Math.hypot(centerOf(a).x - center.x, centerOf(a).y - center.y) - Math.hypot(centerOf(b).x - center.x, centerOf(b).y - center.y))[0]!;
    const targets = [flat, pitched].map((building) => ({ id: building.id, index: staged.buildings.findIndex((b) => b.id === building.id), max: building.maxHealth }));
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    const focus = async () => {
      const bounds = (await page.locator('#game canvas').boundingBox())!;
      const screenCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await page.mouse.move(screenCenter.x, screenCenter.y); await page.mouse.wheel(0, -700);
      const other = centerOf(pitched), worldCenter = { x: (center.x + other.x) / 2, y: (center.y + other.y) / 2 };
      const projected = await gamePoint(page, worldCenter.x, worldCenter.y);
      await page.keyboard.down('Control'); await page.mouse.down();
      await page.mouse.move(screenCenter.x * 2 - projected.x, screenCenter.y * 2 - projected.y, { steps: 4 });
      await page.mouse.up(); await page.keyboard.up('Control'); await call<void>(page, 'step', 0);
    };
    await focus();
    await page.screenshot({ path: testInfo.outputPath('buildings-100-percent.png') });
    for (const percent of [85, 60, 30, 10, 0]) {
      for (const target of targets) {
        const current = (await getState(page))!.buildings.find((building) => building.id === target.id)!;
        expect(await call<boolean>(page, 'damageBuilding', target.index, current.health - target.max * percent / 100)).toBe(true);
      }
      await call<void>(page, 'step', 1);
      for (const target of targets) {
        const current = (await getState(page))!.buildings.find((building) => building.id === target.id)!;
        expect(current.health).toBeCloseTo(target.max * percent / 100); expect(current.destroyed).toBe(percent === 0);
      }
      await page.screenshot({ path: testInfo.outputPath(`buildings-${percent}-percent.png`) });
      if (percent === 85) {
        const before = (await call<ReturnType<TestApi['rendererDiagnostics']>>(page, 'rendererDiagnostics'))!;
        for (let hit = 0; hit < 5; hit++) { await call<boolean>(page, 'damageBuilding', targets[0]!.index, 1); await call<void>(page, 'step', 1); }
        expect((await call<ReturnType<TestApi['rendererDiagnostics']>>(page, 'rendererDiagnostics'))!.geometries).toBe(before.geometries);
      }
      if (percent === 30) {
        await call<void>(page, 'save'); await page.reload();
        await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
        for (const target of targets) expect((await getState(page))!.buildings.find((building) => building.id === target.id)!.health).toBeCloseTo(target.max * .3);
        await focus();
        await page.screenshot({ path: testInfo.outputPath('buildings-restored-30-percent.png') });
      }
    }
    expect(errors).toEqual([]);
  });

  for (const level of ['under', 'deck'] as const) {
    test(`soldiers walk on the ${level} bridge route and preserve their level through Continue`, async ({ page }, testInfo) => {
      const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
      await startRun(page, 2026);
      await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
      const staged = (await getState(page))!, soldier = staged.units[0]!;
      const bridge = generateTerrain(2026, true, 2, staged.campaignCountry).zones.bridges.find((candidate) => candidate.type !== 'pontoon')!;
      const point = (along: number, across: number) => bridge.axis === 'horizontal'
        ? { x: bridge.x + along, y: bridge.y + across } : { x: bridge.x + across, y: bridge.y + along };
      const start = level === 'under' ? point(0, -bridge.halfWidth - 24) : point(-bridge.halfLength - 24, 0);
      const end = level === 'under' ? point(0, bridge.halfWidth + 36) : point(bridge.halfLength + 36, 0);
      staged.units = [soldier]; staged.terrainLayoutVersion = 2;
      soldier.pos = start; soldier.prevPos = { ...start }; soldier.stance = 'standing';
      soldier.path = []; soldier.moveGoal = null; soldier.crawling = false; soldier.terrainCrawling = false;
      delete soldier.bridgePosition;
      staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
      await call<void>(page, 'pause');
      await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
      await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
      await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click();
      expect(await call<boolean>(page, 'moveUnit', 0, end.x, end.y)).toBe(true);
      let current = (await getState(page))!.units[0]!;
      for (let tick = 0; tick < 500 && !current.bridgePosition && current.path.length; tick += 5) {
        await call<void>(page, 'step', 5); current = (await getState(page))!.units[0]!;
      }
      expect(current.bridgePosition).toEqual({ key: bridgeKey(bridge), level });
      // Show the soldier within the central span rather than at the entry lip.
      const distanceFromCenter = () => Math.abs(level === 'under'
        ? bridge.axis === 'horizontal' ? current.pos.y - bridge.y : current.pos.x - bridge.x
        : bridge.axis === 'horizontal' ? current.pos.x - bridge.x : current.pos.y - bridge.y);
      for (let tick = 0; tick < 300 && distanceFromCenter() > (level === 'under' ? bridge.halfWidth / 2 : bridge.halfLength / 3); tick += 3) {
        await call<void>(page, 'step', 3); current = (await getState(page))!.units[0]!;
      }
      expect(current.bridgePosition).toEqual({ key: bridgeKey(bridge), level });
      await expect(page.locator('#sel-action')).toContainText(level === 'under' ? 'Under bridge' : 'Bridge deck');
      const bounds = (await page.locator('#game canvas').boundingBox())!;
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await page.mouse.move(center.x, center.y); await page.mouse.wheel(0, -1000);
      const projected = await gamePoint(page, bridge.x, bridge.y);
      await page.keyboard.down('Control'); await page.mouse.move(center.x, center.y); await page.mouse.down();
      await page.mouse.move(center.x * 2 - projected.x, center.y * 2 - projected.y, { steps: 4 });
      await page.mouse.up(); await page.keyboard.up('Control'); await call<void>(page, 'step', 0);
      await page.screenshot({ path: testInfo.outputPath(`bridge-${level}-passage.png`) });
      await call<void>(page, 'save'); await page.reload();
      await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click(); await call<void>(page, 'step', 0);
      expect((await getState(page))!.units[0]!.bridgePosition).toEqual({ key: bridgeKey(bridge), level });
      await call<void>(page, 'step', 600);
      current = (await getState(page))!.units[0]!;
      expect(current.path).toHaveLength(0); expect(current.bridgePosition).toBeUndefined();
      expect(Math.hypot(current.pos.x - end.x, current.pos.y - end.y)).toBeLessThan(20);
      expect(errors).toEqual([]);
    });
  }

  for (const [count, stamina] of [[1, 1], [2, 1], [1, .1]] as const) {
    test(`double right-click runs ${count} selected infantry with stamina ${stamina}`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await startRun(page, 2026);
      await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
      const staged = (await getState(page))!;
      staged.units = staged.units.filter((unit) => unit.team === 'friendly').slice(0, count);
      staged.terrainLayoutVersion = 2;
      for (const [index, unit] of staged.units.entries()) {
        unit.pos = { x: 330 + index * 60, y: 600 }; unit.prevPos = { ...unit.pos };
        unit.stance = 'standing'; unit.crawling = false; unit.terrainCrawling = false;
        unit.path = []; unit.moveGoal = null; unit.running = false; unit.movementPace = 'walk'; unit.stamina = stamina;
      }
      staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
      await call<void>(page, 'pause');
      await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
      await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
      await call<void>(page, 'step', 0);
      await page.locator('.roster-soldier').first().click();
      if (count > 1) await page.locator('.roster-soldier').nth(1).click({ modifiers: ['Shift'] });
      const walkTo = await gamePoint(page, 540, 600);
      await page.mouse.click(walkTo.x, walkTo.y, { button: 'right' });
      await call<void>(page, 'step', 1);
      for (const unit of (await getState(page))!.units) {
        expect(unit.movementPace).toBe('walk'); expect(unit.running).toBe(false); expect(unit.path.length).toBeGreaterThan(0);
      }
      const runTo = await gamePoint(page, 660, 600);
      await page.mouse.dblclick(runTo.x, runTo.y, { button: 'right', delay: 80 });
      await call<void>(page, 'step', 1);
      for (const unit of (await getState(page))!.units) {
        expect(unit.movementPace).toBe(stamina >= .25 ? 'run' : 'walk');
        expect(unit.running).toBe(stamina >= .25);
        expect(unit.moveGoal!.x).toBeGreaterThan(600);
      }
      await page.screenshot({ path: testInfo.outputPath('double-right-click-pace.png') });
      // A new single click cancels the run; two clicks at different places are
      // independent walking orders even when issued quickly.
      const next = await gamePoint(page, 480, 650);
      await page.mouse.click(next.x, next.y, { button: 'right' });
      await page.mouse.click(walkTo.x, walkTo.y, { button: 'right' });
      await call<void>(page, 'step', 1);
      for (const unit of (await getState(page))!.units) { expect(unit.running).toBe(false); expect(unit.movementPace).toBe('walk'); }
      // Repeating a click after the double-click window is still a walk order.
      await page.clock.runFor(450);
      await page.mouse.click(walkTo.x, walkTo.y, { button: 'right' });
      await call<void>(page, 'step', 1);
      for (const unit of (await getState(page))!.units) expect(unit.movementPace).toBe('walk');
      expect(errors).toEqual([]);
    });
  }

  for (const [delivery, warningTicks] of [['artillery', 30], ['mortar', 18]] as const) {
    test(`${delivery} gives only the shortened impact warning before soldiers evade`, async ({ page }, testInfo) => {
      const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
      await startRun(page, 2026);
      await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
      const staged = (await getState(page))!, unit = staged.units[0]!;
      staged.units = [unit]; staged.terrainLayoutVersion = 2;
      unit.pos = { x: 360, y: 600 }; unit.prevPos = { ...unit.pos };
      unit.path = []; unit.moveGoal = null; unit.buildingCooldown = 100_000;
      unit.reloadTimer = 100_000; unit.grenades = 0;
      staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
      staged.strikes = [{ id: staged.nextEntityId++, pos: { ...unit.pos }, landTick: staged.ticks + 90,
        radius: delivery === 'mortar' ? 42 : 85, damage: 1, suppressionAmount: 0, delivery, source: 'enemy' }];
      await call<void>(page, 'pause');
      await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
      await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
      await call<void>(page, 'step', 90 - warningTicks - 1);
      expect((await getState(page))!.units[0]!.pos).toEqual(unit.pos);
      await page.screenshot({ path: testInfo.outputPath('before-impact-warning.png') });
      await call<void>(page, 'step', 1);
      expect((await getState(page))!.units[0]!.pos).not.toEqual(unit.pos);
      await page.screenshot({ path: testInfo.outputPath('impact-warning.png') });
      expect(errors).toEqual([]);
    });
  }

  test('infantry walk by default, run on command, and resume walking when stamina runs out', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    const staged = (await getState(page))!, soldier = staged.units[0]!;
    staged.units = [soldier]; staged.terrainLayoutVersion = 2;
    soldier.pos = { x: 360, y: 600 }; soldier.prevPos = { ...soldier.pos };
    soldier.stance = 'standing'; soldier.crawling = false; soldier.terrainCrawling = false;
    soldier.movementPace = 'walk'; soldier.running = false; soldier.stamina = 1;
    soldier.path = []; soldier.moveGoal = null; soldier.reloadTimer = 100_000; soldier.grenades = 0;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    await page.locator('.roster-soldier').first().click();
    expect(await call<boolean>(page, 'moveUnit', 0, 900, 600)).toBe(true);
    await call<void>(page, 'step', 10);
    await expect(page.locator('#sel-action')).toHaveText('Walking');
    await expect(page.locator('#sel-stamina-text')).toHaveText('100%');
    const walking = (await getState(page))!.units[0]!;
    expect(walking.running).toBe(false);
    await page.locator('#btn-run').click(); await call<void>(page, 'step', 30);
    const running = (await getState(page))!.units[0]!;
    expect(running.running).toBe(true); expect(running.stamina).toBeLessThan(1);
    expect(Math.hypot(running.pos.x - walking.pos.x, running.pos.y - walking.pos.y) / 30)
      .toBeGreaterThan(Math.hypot(walking.pos.x - soldier.pos.x, walking.pos.y - soldier.pos.y) / 10 * 1.5);
    await expect(page.locator('#sel-action')).toContainText('Running');
    await expect(page.locator('.roster-soldier').first()).toContainText('Running');
    await expect(page.locator('#sel-action')).toContainText('7s stamina');
    await expect(page.locator('#btn-run')).toHaveAccessibleName('Switch to walking');
    await page.screenshot({ path: testInfo.outputPath('running-stamina.png') });
    await call<void>(page, 'save'); await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0);
    await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    expect((await getState(page))!.units[0]!.stamina).toBe(running.stamina);
    const remaining = Math.round(running.stamina! * CONFIG.infantryMovement.runSeconds * CONFIG.tickRate);
    await call<void>(page, 'step', remaining);
    const exhausted = (await getState(page))!.units[0]!;
    expect(exhausted.stamina).toBe(0); expect(exhausted.running).toBe(false);
    expect(exhausted.movementPace).toBe('walk');
    await expect(page.locator('#sel-action')).toHaveText('Walking');
    await expect(page.locator('#btn-run')).toHaveAccessibleName('Run');
    await expect(page.locator('#btn-run')).toBeDisabled();
    await expect(page.locator('#sel-stamina-text')).toHaveText('0%');
    await page.screenshot({ path: testInfo.outputPath('walking-after-exhaustion.png') });
    await call<void>(page, 'step', 150);
    expect((await getState(page))!.units[0]!.stamina).toBeGreaterThanOrEqual(.25);
    await expect(page.locator('#btn-run')).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('a medic leaves its completed move order without twitching back toward it', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-17T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-17T10:00:01Z'));
    const staged = (await getState(page))!, medic = staged.units[0]!, patient = staged.units[1]!;
    staged.units = [medic, patient]; staged.terrainLayoutVersion = 2;
    medic.role = 'medic'; medic.pos = { x: 396, y: 612 }; medic.moveGoal = { ...medic.pos }; medic.health = 100;
    patient.pos = { x: 396, y: 492 }; patient.moveGoal = null; patient.health = 40;
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.targetId = null; unit.reloadTimer = 100_000; unit.grenades = 0;
      unit.stance = 'standing'; unit.crawling = false; unit.terrainCrawling = false; unit.pinned = false; unit.suppression = 0;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click();
    const bounds = (await page.locator('#game canvas').boundingBox())!;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(center.x, center.y); await page.mouse.wheel(0, -1000);
    const projected = await gamePoint(page, medic.pos.x, (medic.pos.y + patient.pos.y) / 2);
    await page.keyboard.down('Control'); await page.mouse.down();
    await page.mouse.move(center.x * 2 - projected.x, center.y * 2 - projected.y, { steps: 4 });
    await page.mouse.up(); await page.keyboard.up('Control');
    await call<void>(page, 'step', 1);
    await page.screenshot({ path: testInfo.outputPath('medic-facing-casualty-start.png') });
    const travel = await page.evaluate(() => {
      const hook = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      const positions: number[] = [hook.getState()!.units[0]!.pos.y];
      for (let tick = 0; tick < 60; tick++) { hook.step(1); positions.push(hook.getState()!.units[0]!.pos.y); }
      return positions;
    });
    expect(travel.every((y, index) => index === 0 || y <= travel[index - 1]!)).toBe(true);
    expect(travel.at(-1)).toBeLessThan(travel[0]! - 30);
    await expect(page.locator('#sel-action')).toHaveText('Walking');
    await page.screenshot({ path: testInfo.outputPath('medic-facing-casualty-after.png') });
    await call<void>(page, 'step', 240);
    expect((await getState(page))!.units[1]!.health).toBeGreaterThan(40);
    await expect(page.locator('#sel-action')).toHaveText('Tending wounded');
    expect(errors).toEqual([]);
  });

  test('soldiers hold steadily beside a parked ally instead of switching between walking and holding', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-17T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-17T10:00:01Z'));
    const staged = (await getState(page))!, soldier = staged.units[0]!, parked = staged.units[1]!;
    staged.units = [soldier, parked]; staged.terrainLayoutVersion = 2;
    soldier.pos = { x: 336, y: 600 }; soldier.moveGoal = { x: 360, y: 600 };
    parked.role = 'gun_truck'; parked.health = 155; parked.pos = { x: 360, y: 600 }; parked.moveGoal = null; parked.headlightsOn = false;
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.targetId = null;
      unit.stance = 'standing'; unit.crawling = false; unit.terrainCrawling = false;
      unit.running = false; unit.movementPace = 'walk'; unit.pinned = false; unit.suppression = 0;
      unit.reloadTimer = 100_000; unit.grenades = 0; unit.buildingCooldown = 100_000;
    }
    staged.ticks = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate / 2; staged.dayNightStartTick = 0; staged.wavesCompleted = 3;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 0); await page.locator('.roster-soldier').first().click();
    await call<void>(page, 'step', 0);
    const samples = await page.evaluate(() => {
      const hook = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      const samples: { action: string; path: number }[] = [];
      for (let tick = 0; tick < 120; tick++) {
        hook.step(1);
        samples.push({ action: document.getElementById('sel-action')!.textContent!, path: hook.getState()!.units[0]!.path.length });
      }
      return samples;
    });
    expect(samples.every((sample) => sample.action === 'Holding position' && sample.path === 0)).toBe(true);
    const bounds = (await page.locator('#game canvas').boundingBox())!;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(center.x, center.y); await page.mouse.wheel(0, -800);
    const projected = await gamePoint(page, soldier.pos.x, soldier.pos.y);
    await page.keyboard.down('Control'); await page.mouse.down();
    await page.mouse.move(center.x * 2 - projected.x, center.y * 2 - projected.y, { steps: 4 });
    await page.mouse.up(); await page.keyboard.up('Control');
    await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('steady-holding-beside-ally.png') });
    // Restore the full-field view before issuing the next order; a zoomed
    // projection can place the destination outside the canvas in Firefox.
    await page.locator('#game canvas').focus(); await page.keyboard.press('0');
    await call<void>(page, 'step', 0);
    const destination = await gamePoint(page, 240, 600);
    await page.mouse.click(destination.x, destination.y, { button: 'right' }); await call<void>(page, 'step', 1);
    await expect(page.locator('#sel-action')).toHaveText('Walking');
    expect((await getState(page))!.units[0]!.path.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('pinned soldiers hold position beside a building while nearby allies give way', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    await call<void>(page, 'spawnEnemyAt', 'rifle', 360, 600);
    const staged = (await getState(page))!;
    const friendly = staged.units.find((unit) => unit.team === 'friendly')!;
    const pinned = staged.units.find((unit) => unit.team === 'enemy')!;
    const building = [...staged.buildings].sort((a, b) => Math.hypot(a.pos.x - 480, a.pos.y - 360) - Math.hypot(b.pos.x - 480, b.pos.y - 360))[0]!;
    pinned.pos = { x: building.pos.x + building.cols * 12, y: building.pos.y + building.rows * 24 + 12 };
    pinned.suppression = CONFIG.suppression.max; pinned.pinned = true; pinned.stance = 'crouching';
    const ally = structuredClone(pinned); ally.id = staged.nextEntityId++;
    ally.pos.x += 2; ally.suppression = 0; ally.pinned = false; ally.morale = 0;
    friendly.pos = { x: 924, y: 684 };
    staged.units = [friendly, pinned, ally];
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null;
      unit.targetId = null; unit.reloadTimer = 100_000; unit.grenades = 0; unit.buildingCooldown = 100_000;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload();
    await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    for (let tick = 0; tick < 60; tick++) {
      await call<void>(page, 'step', 1);
      const soldier = (await getState(page))!.units.find((unit) => unit.id === pinned.id)!;
      expect(soldier.pinned).toBe(true);
      expect(soldier.pos).toEqual(pinned.pos);
      expect(soldier.path).toEqual([]);
    }
    const yielded = (await getState(page))!.units.find((unit) => unit.id === ally.id)!;
    expect(yielded.pos).not.toEqual(ally.pos);
    const point = await gamePoint(page, pinned.pos.x, pinned.pos.y);
    await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -800);
    await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('pinned-holding-position.png') });
    expect(errors).toEqual([]);
  });

  for (const [weather, kind, label] of [['clear', 'muzzleFlash', 'Muzzle flash spotted'], ['heavyFog', 'sound', 'Gunfire heard']] as const) {
    test(`night soldiers locate gunfire from ${kind} and preserve the clue through Continue`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await startRun(page, 2026);
      await call<void>(page, 'spawnEnemyAt', 'rifle', 600, 600);
      const staged = (await getState(page))!;
      const friendly = staged.units.find((unit) => unit.team === 'friendly')!;
      const enemy = staged.units.find((unit) => unit.team === 'enemy')!;
      staged.units = [friendly, enemy];
      friendly.pos = { x: 360, y: 600 }; enemy.pos = { x: 600, y: 600 };
      for (const unit of staged.units) {
        unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null;
        unit.targetId = null; unit.reloadTimer = 100_000; unit.grenades = 0;
      }
      staged.terrainLayoutVersion = 2; staged.ticks = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate / 2;
      staged.wavesCompleted = 3; staged.dayNightStartTick = 0;
      staged.scheduler.prepTicksLeft = 100_000; staged.weather = weather; staged.weatherChangeTick = 100_000;
      await call<void>(page, 'pause');
      await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
      await page.reload();
      await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
      await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
      await call<void>(page, 'step', 0);
      await page.locator('.roster-soldier').first().click();
      expect((await getState(page))!.units.find((unit) => unit.id === friendly.id)!.targetId).toBeNull();
      expect(await call<boolean>(page, 'fireShot', enemy.id, friendly.id)).toBe(true);
      await call<void>(page, 'step', 1);
      const located = (await getState(page))!.units.find((unit) => unit.id === friendly.id)!;
      expect(located.nightContacts?.[0]?.kind).toBe(kind);
      expect(located.targetId).toBe(enemy.id);
      await expect(page.locator('#sel-contact')).toContainText(`${label} · East`);
      await page.screenshot({ path: testInfo.outputPath(`night-${kind}-contact.png`) });
      await call<void>(page, 'save');
      await page.reload();
      await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
      await call<void>(page, 'step', 0);
      await page.locator('.roster-soldier').first().click();
      await call<void>(page, 'step', 0);
      await expect(page.locator('#sel-contact')).toContainText(label);
      const remaining = (await getState(page))!.units.find((unit) => unit.id === friendly.id)!.nightContacts![0]!.expiresTick - (await getState(page))!.ticks;
      await call<void>(page, 'step', remaining + 1);
      await expect(page.locator('#sel-contact')).toBeHidden();
      expect(errors).toEqual([]);
    });
  }

  test('an idle gun follows its displayed bullet and keeps that aim during the fade', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    const staged = (await getState(page))!;
    const soldier = staged.units.find((unit) => unit.team === 'friendly')!;
    staged.units = [soldier];
    soldier.pos = { x: 480, y: 450 }; soldier.prevPos = { ...soldier.pos };
    soldier.targetId = null; soldier.path = []; soldier.moveGoal = null;
    staged.terrainLayoutVersion = 2; staged.scheduler.prepTicksLeft = 100_000;
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload();
    await page.locator('#btn-continue').click();
    await page.locator('#btn-resume').click();
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    const bounds = (await page.locator('#game canvas').boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -1100);
    await call<void>(page, 'step', 0);
    expect(await call<boolean>(page, 'renderTestShot', soldier.id, 390, 360)).toBe(true);
    await page.clock.runFor(16);
    await page.screenshot({ path: testInfo.outputPath('gun-and-bullet-aligned.png') });
    await page.clock.runFor(100);
    await page.screenshot({ path: testInfo.outputPath('gun-and-bullet-aligned-fading.png') });
    // A fresh shot changes both barrel and trail, replacing the older direction.
    expect(await call<boolean>(page, 'renderTestShot', soldier.id, 570, 410)).toBe(true);
    await page.clock.runFor(16);
    await page.screenshot({ path: testInfo.outputPath('gun-and-bullet-new-direction.png') });
    expect(errors).toEqual([]);
  });

  test('rooftop and ground guns aim at each other across both axes', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await call<void>(page, 'spawnEnemyAt', 'rifle', 480, 400);
    const staged = (await getState(page))!;
    const building = staged.buildings.find((b) => b.rooftopAccess && b.pos.y > 200)!;
    const friendly = staged.units.find((u) => u.team === 'friendly')!;
    const enemy = staged.units.find((u) => u.team === 'enemy')!;
    staged.units = [friendly, enemy];
    friendly.buildingPosition = { buildingId: building.id, level: 'roof', slot: 4 };
    friendly.pos = buildingSlot(building, friendly.buildingPosition, CONFIG.terrain.cell);
    enemy.pos = { x: friendly.pos.x + 65, y: friendly.pos.y + 70 };
    friendly.targetId = enemy.id; enemy.targetId = friendly.id;
    for (const unit of staged.units) {
      unit.prevPos = { ...unit.pos }; unit.path = []; unit.moveGoal = null;
      unit.reloadTimer = 100_000; unit.grenades = 0;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload();
    await page.locator('#btn-continue').click();
    await page.locator('#btn-resume').click();
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    await call<void>(page, 'step', 0);
    const bounds = (await page.locator('#game canvas').boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -1000);
    await call<void>(page, 'step', 0);
    const current = (await getState(page))!;
    const shooter = current.units.find((u) => u.id === friendly.id)!;
    const target = current.units.find((u) => u.id === enemy.id)!;
    expect(await call<boolean>(page, 'renderTestShot', shooter.id, target.pos.x, target.pos.y, target.id)).toBe(true);
    expect(await call<boolean>(page, 'renderTestShot', target.id, shooter.pos.x, shooter.pos.y, shooter.id)).toBe(true);
    await call<void>(page, 'step', 0);
    await page.screenshot({ path: testInfo.outputPath('rooftop-ground-gun-elevation.png') });
    expect(errors).toEqual([]);
  });

  test('a moving tank keeps its tracks along the route while aiming to the side', async ({ page }, testInfo) => {
    await startRun(page, 2026);
    await call<void>(page, 'spawnEnemyAt', 'vehicle', 480, 450);
    const staged = (await getState(page))!;
    const tank = staged.units.find((u) => u.role === 'vehicle')!;
    const soldier = staged.units.find((u) => u.team === 'friendly')!;
    staged.units = [soldier, tank];
    staged.terrainLayoutVersion = 2; // Flat ground isolates hull heading from climbing routes.
    tank.pos = { x: 480, y: 450 }; tank.prevPos = { x: 480, y: 449 };
    tank.path = [{ x: 480, y: 530 }]; tank.moveGoal = { x: 480, y: 530 };
    tank.targetId = soldier.id; tank.firePauseTicks = 0; tank.firePauseGate = false;
    soldier.pos = { x: 720, y: 450 }; soldier.prevPos = { ...soldier.pos };
    soldier.path = []; soldier.moveGoal = null; soldier.reloadTimer = 100_000;
    tank.reloadTimer = 100_000; tank.secondaryReloadTimer = 100_000;
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload();
    await page.locator('#btn-continue').click();
    await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 5);
    const moving = (await getState(page))!.units.find((u) => u.role === 'vehicle')!;
    expect(moving.pos.y).toBeGreaterThan(moving.prevPos.y);
    expect(Math.abs(moving.pos.x - moving.prevPos.x)).toBeLessThan(.01);
    const point = await gamePoint(page, moving.pos.x, moving.pos.y);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -1100);
    await page.screenshot({ path: testInfo.outputPath('tank-tracks-follow-movement.png') });
  });

  test('medics heal building occupants only at the same floor height', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    await page.clock.install({ time: new Date('2026-10-17T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-17T10:00:01Z'));
    const staged = (await getState(page))!, building = staged.buildings.find((candidate) => candidate.rooftopAccess && candidate.balcony)!;
    const medic = staged.units[0]!, patient = staged.units[1]!;
    medic.role = 'medic'; medic.health = 100; medic.healTimer = 0; patient.health = 40;
    staged.units = [medic, patient];
    for (const [index, unit] of staged.units.entries()) {
      unit.buildingPosition = { buildingId: building.id, level: 1, slot: index * 4 };
      unit.pos = buildingSlot(building, unit.buildingPosition, 24); unit.prevPos = { ...unit.pos };
      unit.path = []; unit.moveGoal = null; unit.grenades = 0; unit.reloadTimer = 100_000;
      unit.pinned = false; unit.suppression = 0; delete unit.buildingOrder;
    }
    staged.scheduler.prepTicksLeft = 100_000; staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload(); await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
    await call<void>(page, 'step', 1);
    expect((await getState(page))!.units[1]!.health).toBe(65);
    await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    await expect(page.locator('#sel-action')).toHaveText('Tending wounded');
    await page.screenshot({ path: testInfo.outputPath('medic-heals-same-floor.png') });
    await page.locator('.roster-soldier').nth(1).click(); await call<void>(page, 'step', 0);
    await page.locator('#building-level').selectOption('roof'); await call<void>(page, 'step', 180);
    let current = (await getState(page))!;
    expect(current.units[1]!.buildingPosition?.level).toBe('roof');
    expect(current.units[1]!.health).toBe(65);
    await page.locator('.roster-soldier').first().click(); await call<void>(page, 'step', 0);
    await page.locator('#building-level').selectOption('roof'); await call<void>(page, 'step', 120);
    current = (await getState(page))!;
    expect(current.units[0]!.buildingPosition?.level).toBe('roof');
    expect(current.units[1]!.health).toBeGreaterThan(65);
    await expect(page.locator('#sel-action')).toHaveText('Tending wounded');
    await page.screenshot({ path: testInfo.outputPath('medic-heals-same-rooftop.png') });
    expect(errors).toEqual([]);
  });

  test('infantry enter multi-floor buildings, choose windows, rooftops and balconies, and resume their position', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    const staged = (await getState(page))!;
    const building = staged.buildings.find((b) => b.rooftopAccess && b.balcony)!;
    expect(building).toBeDefined();
    staged.units = staged.units.filter((u) => u.team === 'friendly').slice(0, 1);
    const soldier = staged.units[0]!;
    soldier.pos = { x: building.pos.x + building.cols * 12, y: building.pos.y + building.rows * 24 + 36 };
    soldier.prevPos = { ...soldier.pos }; soldier.path = []; soldier.moveGoal = null;
    staged.scheduler.prepTicksLeft = 100_000;
    staged.weather = 'clear'; staged.weatherChangeTick = 100_000;
    await call<void>(page, 'pause');
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload();
    await page.locator('#btn-continue').click();
    await page.locator('#btn-resume').click();
    await page.locator('.roster-soldier').first().click();
    const roofPoint = await call<{ x: number; y: number }>(page, 'worldToClient', building.pos.x + building.cols * 12, building.pos.y + building.rows * 12, building.floors! * 20 / 24 + .1);
    await page.mouse.click(roofPoint.x, roofPoint.y, { button: 'right' });
    await expect(page.locator('#building-controls')).toBeVisible();
    await call<void>(page, 'step', 300);
    expect((await getState(page))!.units[0]!.buildingPosition?.level).toBe(0);
    const positionSelector = page.locator('#building-level');
    for (const facing of ['North', 'East', 'South', 'West']) {
      await expect(positionSelector.locator('option', { hasText: `Floor 2 · ${facing}-facing windows` })).toHaveCount(1);
    }
    await expect(positionSelector.locator('option[value="balcony"]')).toHaveText('Balcony · South-facing');
    await expect(positionSelector.locator('option[value="roof"]')).toHaveText('Rooftop · all directions');
    // Native select popups repaint/reset when the HUD writes their current
    // value or attributes again. Keep an open menu untouched across frames.
    await positionSelector.click();
    const dropdownUpdates = await page.evaluate(async () => {
      const select = document.querySelector<HTMLSelectElement>('#building-level')!;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!;
      let valueWrites = 0, mutations = 0;
      const options = Array.from(select.options);
      Object.defineProperty(select, 'value', { configurable: true,
        get() { return descriptor.get!.call(this); },
        set(value: string) { valueWrites++; descriptor.set!.call(this, value); },
      });
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
      try {
        const hook = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
        for (let frame = 0; frame < 60; frame++) hook.step(0);
        await Promise.resolve();
        return { valueWrites, mutations, sameOptions: options.every((option, index) => select.options[index] === option) };
      } finally {
        observer.disconnect(); Reflect.deleteProperty(select, 'value');
      }
    });
    await page.screenshot({ path: testInfo.outputPath('building-position-menu-stable.png') });
    await page.keyboard.press('Enter');
    expect(dropdownUpdates).toEqual({ valueWrites: 0, mutations: 0, sameOptions: true });
    await positionSelector.selectOption('1:east');
    await call<void>(page, 'step', 70);
    expect((await getState(page))!.units[0]!.buildingPosition?.level).toBe(1);
    expect([2, 3]).toContain((await getState(page))!.units[0]!.buildingPosition?.slot);
    await expect(positionSelector).toHaveValue('1:east');
    await expect(page.locator('#building-status')).toContainText('East-facing windows');
    await page.screenshot({ path: testInfo.outputPath('building-window-position.png') });
    await page.locator('#building-level').selectOption('roof');
    await call<void>(page, 'step', 120);
    expect((await getState(page))!.units[0]!.buildingPosition?.level).toBe('roof');
    await page.screenshot({ path: testInfo.outputPath('building-rooftop-position.png') });
    await call<void>(page, 'save');
    await page.reload();
    await page.locator('#btn-continue').click();
    await page.locator('#btn-resume').click();
    await page.locator('.roster-soldier').first().click();
    await expect(page.locator('#building-level')).toHaveValue('roof');
    await page.locator('#building-level').selectOption('balcony');
    await call<void>(page, 'step', 120);
    expect((await getState(page))!.units[0]!.buildingPosition?.level).toBe('balcony');
    await page.screenshot({ path: testInfo.outputPath('building-balcony-position.png') });
    await page.locator('#btn-leave-building').click();
    await expect(page.locator('#building-controls')).toBeHidden();
    expect((await getState(page))!.units[0]!.buildingPosition).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('map review generates country maps and restores the active battlefield', async ({ page }, testInfo) => {
    await startRun(page, 271828);
    const before = (await getState(page))!;
    await page.locator('#btn-settings').click();
    await page.locator('#btn-map-review').click();
    await expect(page.locator('#overlay-map-review')).toBeVisible();
    await expect(page.locator('#overlay-title')).toBeHidden();
    await expect(page.locator('#overlay-settings')).toBeHidden();
    await expect(page.locator('#map-review-country option')).toHaveCount(6);
    expect(await call<boolean>(page, 'paused')).toBe(true);

    await page.locator('#map-review-country').selectOption('belgium');
    await page.locator('#btn-map-review-generate').click();
    await expect(page.locator('#map-review-info')).toContainText('Belgium');
    await page.locator('#map-review-country').selectOption('italy');
    await page.locator('#btn-map-review-generate').click();
    await expect(page.locator('#map-review-info')).toContainText('Italy');
    await page.screenshot({ path: testInfo.outputPath('road-intersection-map-review.png') });
    expect((await getState(page))!.seed).toBe(before.seed);

    await page.locator('#btn-map-review-close').click();
    await expect(page.locator('#overlay-map-review')).toBeHidden();
    await expect(page.locator('#overlay-settings')).toBeVisible();
    await expect(page.locator('#overlay-title')).toBeHidden();
    expect(await call<boolean>(page, 'paused')).toBe(false);
    expect((await getState(page))!.seed).toBe(before.seed);
  });

  test('three snowstorm intensity levels render and survive Continue', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    for (const weather of ['lightSnow', 'snow', 'heavySnow'] as const) {
      await call<void>(page, 'pause');
      await call<void>(page, 'save');
      await page.evaluate((kind) => {
        const save = JSON.parse(localStorage.getItem('lastline/save/v1')!) as SimSnapshot;
        save.weather = kind;
        save.season = 'winter';
        localStorage.setItem('lastline/save/v1', JSON.stringify(save));
      }, weather);
      await page.reload();
      await page.locator('#btn-continue').click();
      await expect(page.locator('#hud-setting')).toContainText(CONFIG.weather[weather].name);
      expect((await getState(page))!.weather).toBe(weather);
      await page.locator('#btn-resume').click();
      await page.screenshot({ path: testInfo.outputPath(`${weather}.png`) });
    }
    expect(errors).toEqual([]);
  });
  for (const country of CAMPAIGN_COUNTRIES) {
    test(`${country} country campaign can be chosen, resumed, and restarted`, async ({ page }, testInfo) => {
      await page.goto(URL);
      await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
      await page.locator('#btn-new').click();
      await expect(page.locator('#overlay-campaign')).toBeVisible();
      await expect(page.locator('.campaign-choice')).toHaveCount(6);
      await page.locator(`[data-country="${country}"]`).click();
      await expect(page.locator(`[data-country="${country}"]`)).toHaveAttribute('aria-pressed', 'true');
      if (country === 'italy') await page.screenshot({ path: testInfo.outputPath('campaign-selector.png') });
      await page.locator('#btn-campaign-start').click();
      await expect(page.locator('#overlay-campaign')).toBeHidden();
      await expect(page.locator('#hud-setting')).toContainText(CAMPAIGNS[country].name);
      if (country === 'italy') await page.screenshot({ path: testInfo.outputPath('italy-battlefield.png') });
      await call<void>(page, 'pause');
      await call<void>(page, 'save');
      const before = (await getState(page))!;
      expect(before.campaignCountry).toBe(country);
      await page.reload();
      await page.locator('#btn-continue').click();
      await expect(page.locator('#overlay-pause')).toBeVisible();
      expect((await getState(page))!.campaignCountry).toBe(country);
      await expect(page.locator('#hud-setting')).toContainText(CAMPAIGNS[country].name);
      await page.locator('#btn-restart').click();
      const restarted = (await getState(page))!;
      expect(restarted.campaignCountry).toBe(country);
      expect(restarted.seed).toBe(before.seed);
      expect(restarted.buildings.map((building) => building.name)).toEqual(before.buildings.map((building) => building.name));
    });
  }
  test('country chooser works on a narrow screen and closes with Escape', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(URL);
    await page.locator('#btn-new').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#overlay-campaign')).toBeHidden();
    await page.locator('#btn-new').click();
    await page.locator('[data-country="netherlands"]').click();
    await expect(page.locator('[data-country="netherlands"]')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath('campaign-selector-narrow.png') });
    const box = await page.locator('.campaign-panel').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.locator('#btn-campaign-start').click();
    await expect(page.locator('#hud-setting')).toContainText('The Netherlands');
  });

  test('country chooser keeps the saved run until replacement is confirmed', async ({ page }) => {
    await startRun(page, 2026);
    await call<void>(page, 'pause');
    await call<void>(page, 'save');
    await page.locator('#btn-quit').click();
    const save = await page.evaluate(() => localStorage.getItem('lastline/save/v1'));
    await page.locator('#btn-new').click();
    await page.locator('[data-country="italy"]').click();
    await page.locator('#btn-campaign-start').click();
    await expect(page.getByRole('heading', { name: 'Replace saved run?' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep Saved Run', exact: true }).click();
    await expect(page.locator('#overlay-campaign')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('lastline/save/v1'))).toBe(save);
    await page.locator('[data-country="germany"]').click();
    await page.locator('#btn-campaign-start').click();
    await page.getByRole('button', { name: 'Start New Game', exact: true }).click();
    expect((await getState(page))!.campaignCountry).toBe('germany');
    await expect(page.locator('#overlay-campaign')).toBeHidden();
  });
  test('named roster preserves ranks and contributions through Continue and the battle report', async ({ page }) => {
    await startRun(page, 7);
    await call<void>(page, 'givePoints', 40);
    expect(await call<boolean>(page, 'recruit', 'medic', 400, 680)).toBe(true);
    expect(await call<boolean>(page, 'recruit', 'engineer', 700, 680)).toBe(true);
    await call<void>(page, 'pause');
    const state = (await getState(page))!;
    const veteran = state.units[0]!;
    veteran.xp = 3;
    veteran.kills = 3;
    veteran.health = 45;
    veteran.pinned = true;
    veteran.suppression = 25;
    veteran.morale = 20;
    const medic = state.units.find((u) => u.role === 'medic')!;
    medic.service.healthRestored = 30;
    medic.healTimer = 1000; // Hold the fixture stable while the report is generated.
    state.units.find((u) => u.role === 'engineer')!.service.fortificationsBuilt = 2;
    state.battleRecord = { enemyKills: 9, casualties: 1, breakthroughs: 2 };
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), state);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
    await page.locator('#btn-continue').click();
    await expect(page.locator('#squad-count')).toHaveText('6/14');
    const row = page.locator(`.roster-soldier[data-unit-id="${veteran.id}"]`);
    const name = soldierName(7, veteran.id);
    await expect(row).toContainText(`Sgt ${name}`);
    await expect(row).toContainText('Pinned · Wounded · Rattled');
    await page.locator('#btn-resume').click();
    await row.click();
    await expect(page.locator('#sel-name')).toHaveText(name);
    await expect(page.locator('#sel-name')).toBeInViewport();
    await expect(page.locator('#sel-rank')).toContainText('Sergeant');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toBeFocused();
    await call<void>(page, 'step', 3);
    await expect(row).toBeFocused();
    await call<void>(page, 'setIntegrity', 1);
    await call<void>(page, 'spawnEnemyAt', 'vehicle', 900, 700);
    await call<void>(page, 'step', 3);
    await expect(page.locator('#overlay-results')).toBeVisible();
    const summary = page.locator('#res-summary');
    await expect(summary.locator('tr').filter({ hasText: 'Enemies destroyed' })).toContainText('9');
    await expect(summary.locator('tr').filter({ hasText: 'Soldiers lost' })).toContainText('1');
    await expect(summary.locator('tr').filter({ hasText: 'Enemy breakthroughs' })).toContainText('3');
    await expect(page.locator('.survivor-report tbody tr')).toHaveCount(6);
    await expect(page.locator('.survivor-report tbody tr').filter({ hasText: name })).toContainText('3 kills');
    await expect(page.locator('.survivor-report')).toContainText('30 HP restored');
    await expect(page.locator('.survivor-report')).toContainText('2 fortifications built');
    await page.locator('#btn-results-new').click();
    await page.locator('#btn-campaign-start').click();
    await expect(page.locator('#squad-count')).toHaveText('4/14');
    await expect(page.locator('.roster-soldier')).toHaveCount(4);
    await expect(page.locator('#sel-details')).toBeHidden();
  });

  test('the roster removes casualties and names the lost soldier', async ({ page }) => {
    await startRun(page, 7);
    await call<void>(page, 'pause');
    const state = (await getState(page))!;
    const soldier = state.units[0]!;
    state.strikes.push({ id: state.nextEntityId++, pos: soldier.pos, landTick: state.ticks + 1, radius: 15, damage: 1000, suppressionAmount: 0 });
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), state);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
    await page.locator('#btn-continue').click();
    await call<void>(page, 'step', 1);
    await expect(page.locator('#squad-count')).toHaveText('3/14');
    await expect(page.locator(`.roster-soldier[data-unit-id="${soldier.id}"]`)).toHaveCount(0);
    await expect(page.locator('#notices')).toContainText(`${soldierName(7, soldier.id)} lost.`);
    expect((await getState(page))!.battleRecord.casualties).toBe(1);
  });

  test('new game creates four friendlies and an operational HUD', async ({ page }) => {
    await startRun(page, 7);
    const state = await getState(page);
    expect(state).not.toBeNull();
    expect(state!.units.filter((u) => u.team === 'friendly')).toHaveLength(4);
    await expect(page.locator('#hud-top')).toBeVisible();
    await expect(page.locator('#hud-points')).toHaveText('12');
    await expect(page.locator('#hud-map')).toHaveText(`Map 1 · 0/${CONFIG.crossing.campaignMaps}`);
    await expect(page.locator('#hud-wave')).toHaveText('1/15');
    await expect(page.locator('#game canvas')).toBeVisible();
  });

  test('marching the whole squad north starts a new map at wave 1 with the squad intact', async ({ page }) => {
    await startRun(page, 7);
    await call<void>(page, 'pause');
    // Make the squad worth carrying over: a veteran with a purchased upgrade, a
    // wound, and a fortification on the map that must not come along.
    const before = (await getState(page))!;
    const veteran = before.units.find((u) => u.team === 'friendly')!;
    const staged = {
      ...before,
      points: 33,
      score: 120,
      integrity: 15,
      sectorCaptured: true,
      units: before.units.map((u) =>
        u.id === veteran.id
          ? { ...u, xp: 4, kills: 6, health: 55, weaponUpgrades: { ...u.weaponUpgrades, damage: 2 } }
          : u,
      ),
      sandbags: [{ id: 9001, pos: { x: 300, y: 520 } }],
    };
    await page.evaluate((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), staged);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
    await page.locator('#btn-continue').click();
    await page.locator('#btn-resume').click();

    // Walk the squad off the northern edge, then keep stepping only until the map
    // changes: the new map starts its own wave 1, so over-stepping would see it.
    await call<void>(page, 'rallyAtNorthEdge');
    let after = (await getState(page))!;
    for (let i = 0; i < 40 && after.mapNumber === before.mapNumber; i++) {
      await call<void>(page, 'step', 30);
      after = (await getState(page))!;
    }
    expect(after.mapNumber).toBe(2);
    expect(after.mapsCleared).toBe(1);
    expect(after.scheduler.waveIndex).toBe(0);
    // A new battlefield, not the one that was just abandoned.
    expect(after.seed).not.toBe(before.seed);
    // Player progress rides along.
    expect(after.points).toBe(33);
    expect(after.score).toBe(120);
    expect(after.integrity).toBe(15);
    expect(after.units.filter((u) => u.team === 'friendly')).toHaveLength(4);
    const carried = after.units.find((u) => u.id === veteran.id)!;
    expect(carried.xp).toBe(4);
    expect(carried.kills).toBe(6);
    expect(carried.health).toBe(55);
    expect(carried.weaponUpgrades.damage).toBe(2);
    // Positions do not march with the squad, and the enemy holding the abandoned
    // map does not follow it.
    expect(after.sandbags).toEqual([]);
    expect(after.units.filter((u) => u.team === 'enemy' && before.units.some((b) => b.id === u.id))).toEqual([]);

    // The HUD reports the campaign position and the reset wave counter.
    await expect(page.locator('#hud-map')).toHaveText(`Map 2 · 1/${CONFIG.crossing.campaignMaps}`);
    await expect(page.locator('#hud-wave')).toHaveText('1/15');
    await expect(page.locator('#squad-count')).toHaveText('4/14');
    await expect(page.locator('#notices')).toContainText('Forward positions are lost');
  });

  test('selecting a soldier and issuing a move updates the selection panel', async ({ page }) => {
    await startRun(page, 7);
    // Left-click the first rifleman.
    const soldier = await gamePoint(page, 330, 600);
    await page.mouse.click(soldier.x, soldier.y);
    await expect(page.locator('#sel-details')).toBeVisible();
    await expect(page.locator('#sel-role')).toContainText('Rifleman');
    // Move order via right-click.
    const dest = await gamePoint(page, 450, 640);
    await page.mouse.click(dest.x, dest.y, { button: 'right' });
    await page.waitForFunction(() => {
      const hook = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      const state = hook.getState();
      const id = hook.selectUnit(0);
      const unit = state?.units.find((u) => u.id === id);
      return unit !== undefined && Math.abs(unit.pos.x - 450) < 40;
    });
  });

  test('recruiting once consumes points once and adds one soldier', async ({ page }) => {
    await startRun(page, 7);
    await page.locator('#tab-army').click();
    await page.locator('.recruit-button[data-role="rifleman"]').click();
    expect(await call<string>(page, 'mode')).toBe('recruit');
    // Confirm inside the deployment zone.
    const spot = await gamePoint(page, 520, 680);
    await page.mouse.click(spot.x, spot.y);
    const state = await getState(page);
    expect(state!.units.filter((u) => u.team === 'friendly')).toHaveLength(5);
    expect(state!.points).toBe(8);
    expect(await call<string>(page, 'mode')).toBe('none');
  });

  /**
   * Personal weapon upgrades put the weapon out of action while they are fitted:
   * the soldier cannot fire or throw, but can still be walked. Everything from
   * the HUD button through the notice, the countdown, the movement order and the
   * save is the production path.
   */
  test('a weapon upgrade silences the soldier while it is fitted', async ({ page }) => {
    await startRun(page, 7);
    await call<void>(page, 'givePoints', 60);
    const id = (await call<number | null>(page, 'selectUnit', 0))!;
    expect(id).not.toBeNull();
    // Select through a real click on the field: the HUD refreshes on the render
    // loop, which a headless test cannot rely on driving a fixture change.
    const start = (await getState(page))!.units.find((u) => u.id === id)!;
    const spot = await gamePoint(page, start.pos.x, start.pos.y);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.locator('#sel-details')).toBeVisible();
    await page.waitForFunction(() => {
      const button = document.getElementById('btn-upgrade-accuracy') as HTMLButtonElement | null;
      return button !== null && !button.disabled;
    });

    const before = (await getState(page))!.units.find((u) => u.id === id)!;
    expect(before.upgradeTimer ?? 0).toBe(0);

    await page.locator('#btn-upgrade-accuracy').click();
    const after = (await getState(page))!.units.find((u) => u.id === id)!;
    // The improvement is banked at once; the weapon is what is unavailable.
    expect(after.weaponUpgrades.accuracy).toBe(1);
    expect(after.upgradeTimer ?? 0).toBeGreaterThan(0);

    // The player is told, and the panel says what the soldier is doing.
    await expect(page.locator('#notices')).toContainText(/upgraded to level 1/i);
    await expect(page.locator('#notices')).toContainText(/cannot fire/i);
    await expect(page.locator('#sel-action')).toContainText('Working on weapon');
    // A second upgrade is refused while the first is being fitted.
    await expect(page.locator('#btn-upgrade-damage')).toBeDisabled();
    await expect(page.locator('#btn-upgrade-damage')).toContainText('in pieces');

    // Movement is untouched: he can still be pulled back behind cover.
    expect(await call<boolean>(page, 'moveUnit', 0, 300, 650)).toBe(true);
    await call<void>(page, 'step', 2);
    expect((await getState(page))!.units.find((u) => u.id === id)!.upgradeTimer ?? 0).toBeGreaterThan(0);

    // A reload mid-upgrade resumes with the work still to finish.
    await call<void>(page, 'save');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lastline/save/v1') ?? 'null') as Snapshot | null);
    expect(saved!.units.find((u) => u.id === id)!.upgradeTimer ?? 0).toBeGreaterThan(0);

    // And when the work is done the weapon is back in action.
    await call<void>(page, 'step', Math.ceil(CONFIG.weaponUpgrades.upgradeSeconds * CONFIG.tickRate) + 4);
    await expect(page.locator('#sel-action')).not.toContainText('Working on weapon');
    expect((await getState(page))!.units.find((u) => u.id === id)!.upgradeTimer ?? 0).toBe(0);
  });

  test('an engineer killed mid-build leaves no half-built marker behind', async ({ page }) => {
    await startRun(page, 2026);
    await page.locator('#tab-support').click();
    // One engineer, plenty of points, no waves to interrupt the look. The mine
    // goes in front of the line, within the engineer's working range.
    // The engineer has to be inside its 112 px working range of the site, and a
    // recruit is snapped to a cell centre, so it is placed with room to spare.
    await call<void>(page, 'givePoints', 60);
    expect(await call<boolean>(page, 'recruit', 'engineer', 480, 580)).toBe(true);
    await call<void>(page, 'step', 2);
    const friends = (await getState(page))!.units.filter((u) => u.team === 'friendly');
    const engineer = friends.find((u) => u.role === 'engineer');
    expect(engineer, `no engineer among ${friends.map((u) => u.role).join(',')}`).toBeDefined();
    const refusal = await call<string>(page, 'placementError', 'mine', 480, 500, 'at');
    expect(refusal, `mine refused at engineer pos ${engineer!.pos.x},${engineer!.pos.y}: ${refusal}`).toBe('');
    expect(await call<boolean>(page, 'orderMine', 'at', 480, 500)).toBe(true);
    await call<void>(page, 'step', 3);

    // The status line and the on-field progress bar are both driven by the same
    // list of work sites, so a site in progress shows up here.
    await expect(page.locator('#construction-status')).toBeVisible();
    const state = (await getState(page))!;
    expect(state.constructionSites.length).toBeGreaterThan(0);

    // Kill the engineer part-way through laying it.
    for (const id of new Set(state.constructionSites.map((site) => site.builderId))) {
      expect(await call<boolean>(page, 'killFriendly', id)).toBe(true);
    }
    await call<void>(page, 'step', 2);

    const after = (await getState(page))!;
    expect(after.constructionSites).toEqual([]);
    // The progress visual is driven by that list, so it is gone from the HUD...
    await expect(page.locator('#construction-status')).toBeHidden();
    // ...and nothing was left half-armed on the field.
    expect(after.mines).toEqual([]);
  });

  test('a building blocks sight and bullets, and opens up once destroyed', async ({ page }) => {
    await startRun(page, 2026);
    const buildings = await call<BuildingInfo[]>(page, 'buildings');
    expect(buildings.length).toBeGreaterThan(0);
    for (const building of buildings) {
      expect(building.health).toBe(building.maxHealth);
      expect(building.destroyed).toBe(false);
      expect(building.name.length).toBeGreaterThan(0);
    }

    // Pick a building with room either side, then look straight through it.
    const index = buildings.findIndex((b) => {
      if (b.pos.x <= 90 || b.pos.x + b.cols * 24 >= 960 - 90) return false;
      return true;
    });
    expect(index).toBeGreaterThanOrEqual(0);
    const target = buildings[index]!;
    const left = { x: target.pos.x - 50, y: target.pos.y + (target.rows * 24) / 2 };
    const right = { x: target.pos.x + target.cols * 24 + 50, y: left.y };
    const wall = await call<{ id: number; name: string } | null>(page, 'wallBetween', left, right);
    expect(wall?.name).toBe(target.name);

    // Level it: the wall is gone and the ground it stood on is walkable.
    expect(await call<boolean>(page, 'razeBuilding', index)).toBe(true);
    await call<void>(page, 'step', 2);
    const remainingWall = await call<{ id: number; name: string } | null>(page, 'wallBetween', left, right);
    expect(remainingWall?.id).not.toBe(target.id);
    const after = await call<BuildingInfo[]>(page, 'buildings');
    const ruin = after.find((b) => b.id === target.id)!;
    expect(ruin.destroyed).toBe(true);
    expect(ruin.health).toBe(0);
    // The ruin stays on the map, so the field still reads as built-up.
    expect(after).toHaveLength(buildings.length);
  });

  test('the river and mud slow a soldier down without blocking the way', async ({ page }) => {
    // Seed 2026 is one of the maps that has a river; whether a map has one at all
    // is part of terrain generation, so the fixture names a wet seed explicitly.
    await startRun(page, 2026);
    const soldierId = (await call<number | null>(page, 'selectUnit', 0))!;

    // The river lies north of the defending line, so wading it means ordering
    // this soldier north, into the water but short of the exit band. The river is
    // passable, so the order itself must be accepted.
    const ordered = await call<boolean>(page, 'moveUnit', 0, 480, 400);
    expect(ordered, 'the river must be wadeable, not an obstacle').toBe(true);

    let waded = false;
    let wadeEffects: { speedMult: number; accuracyMult: number; reloadMult: number } | null = null;
    for (let i = 0; i < 40 && !waded; i++) {
      await call<void>(page, 'step', 20);
      const effects = await call<{ speedMult: number } | null>(page, 'terrainAt', soldierId);
      if (effects !== null && effects.speedMult < 1) {
        waded = true;
        wadeEffects = await call<typeof wadeEffects>(page, 'terrainAt', soldierId);
      }
    }
    expect(waded).toBe(true);
    // Soft ground costs pace, aim and handling, and it is ground rather than a
    // wall: the soldier is still alive and still on the field.
    expect(wadeEffects!.speedMult).toBeLessThan(1);
    expect(wadeEffects!.accuracyMult).toBeLessThan(1);
    expect(wadeEffects!.reloadMult).toBeGreaterThan(1);
    const after = (await getState(page))!;
    const walker = after.units.find((u) => u.id === soldierId);
    expect(walker).toBeDefined();
    expect(walker!.health).toBeGreaterThan(0);
  });

  /**
   * Axis counter-battery fire. The barrage is forced rather than waited for -
   * twelve waves of real-time play is not a browser test - but everything from
   * the simulation event onwards is the production path: the HUD warning, the
   * in-flight shells, the countdown marker the renderer draws from them, the
   * save that freezes the incoming fire, and the landing.
   */
  test('an Axis barrage warns the line, survives a reload, and lands', async ({ page }) => {
    await startRun(page, 11);
    await call<void>(page, 'givePoints', 60);
    const before = (await getState(page))!;
    const mark = before.units.find((u) => u.team === 'friendly')!;

    // Notices are transient live DOM, so record them as they are shown rather
    // than racing the TTL, which a loaded parallel run can lose.
    await page.evaluate(() => {
      const w = window as unknown as { __noticeLog?: string[] };
      w.__noticeLog = [];
      const host = document.getElementById('notices');
      if (host === null) throw new Error('no notice host');
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node.textContent !== null) w.__noticeLog!.push(node.textContent);
          }
        }
      }).observe(host, { childList: true });
    });

    // The barrage is scheduled between ticks - the event is queued and must
    // survive to the next step rather than being cleared by it.
    const fired = await call<{ shells: number; landTick: number } | null>(page, 'enemyBarrage', 1);
    expect(fired).not.toBeNull();
    expect(fired!.landTick).toBeGreaterThan(before.ticks);
    await call<void>(page, 'step', 2);
    await page.waitForFunction(
      () => ((window as unknown as { __noticeLog?: string[] }).__noticeLog ?? []).some((t) => /Axis artillery is ranging the line/i.test(t)),
      undefined,
      { timeout: 10_000 },
    );
    const warnings = await page.evaluate(() => (window as unknown as { __noticeLog: string[] }).__noticeLog);
    expect(warnings.join(' | ')).toContain('Spread out');

    // The shells are Axis shells, still in the air, and on their own countdown.
    const during = (await getState(page))!;
    expect(during.strikes.filter((s) => s.source === 'enemy')).toHaveLength(fired!.shells);
    expect(during.strikes.filter((s) => s.source === 'enemy')[0]!.landTick).toBeGreaterThan(during.ticks);

    // The barrage is still on the map after the reload, so a player cannot
    // dodge incoming fire by reloading the page.
    await call<void>(page, 'pause'); // Keep the countdown fixed while storage and reload are exercised.
    await call<void>(page, 'save');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lastline/save/v1') ?? 'null') as Snapshot | null);
    expect(saved!.strikes.filter((s) => s.source === 'enemy')).toHaveLength(fired!.shells);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
    await page.locator('#btn-continue').click();
    const resumed = (await getState(page))!;
    expect(resumed.strikes.filter((s) => s.source === 'enemy')).toHaveLength(fired!.shells);

    // Walk the shells onto a soldier's position, then let them land. `step`
    // resumes the run, so nothing else is needed to get the clock moving.
    const aimed = await call<{ landTick: number } | null>(page, 'aimBarrageAt', mark.pos.x, mark.pos.y, 1);
    expect(aimed).not.toBeNull();
    await call<void>(page, 'step', 4);
    const after = (await getState(page))!;
    const friendlies = after.units.filter((u) => u.team === 'friendly');
    // The blast kills or maims whoever stood on the mark, exactly as it would
    // have if the squad's own guns had fired it, and the shell is spent.
    const hurt = friendlies.length < 4 || friendlies.some((u) => u.health < 100);
    expect(hurt).toBe(true);
    expect(after.strikes.filter((s) => s.source === 'enemy')).toHaveLength(0);
  });

  test('pause blocks progress and orders; tab hiding auto-pauses', async ({ page }) => {
    await startRun(page, 7);
    await page.keyboard.press('Space');
    await expect(page.locator('#overlay-pause')).toBeVisible();
    const t1 = (await getState(page))!.ticks;
    await page.waitForTimeout(600);
    const t2 = (await getState(page))!.ticks;
    expect(t2).toBe(t1); // frozen
    // Resume via button, then hide the tab: run must auto-pause.
    await page.locator('#btn-resume').click();
    await expect(page.locator('#overlay-pause')).toBeHidden();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await call<boolean>(page, 'paused')).toBe(true);
  });

  test('save, reload, and continue restores a paused run', async ({ page }) => {
    await startRun(page, 31337);
    await page.evaluate(() => {
      const hook = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      hook.givePoints(40);
      hook.step(50);
      hook.pause(); // freeze so the snapshot is deterministic
      hook.save();
    });
    const before = await getState(page);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __lastlineTest?: unknown }).__lastlineTest !== undefined);
    // Continue from the title screen.
    await expect(page.locator('#btn-continue')).toBeEnabled();
    await page.locator('#btn-continue').click();
    await expect(page.locator('#overlay-pause')).toBeVisible();
    const after = await getState(page);
    expect(after!.ticks).toBe(before!.ticks);
    expect(after!.points).toBe(before!.points);
    expect(after!.units.length).toBe(before!.units.length);
  });

  test('support modes can be entered and cancelled; HUD never leaks orders', async ({ page }) => {
    await startRun(page, 7);
    await page.locator('#tab-support').click();
    await call<void>(page, 'givePoints', 40);
    expect(await call<boolean>(page, 'recruit', 'engineer', 400, 660)).toBe(true);
    expect(await call<boolean>(page, 'recruit', 'radio_engineer', 500, 660)).toBe(true);
    for (const selector of ['#btn-sandbag', '#btn-artillery']) {
      const btn = page.locator(selector);
      if (await btn.isEnabled()) {
        await btn.click();
      }
    }
    await page.locator('#tab-army').click();
    const medic = page.locator('.recruit-button[data-role="medic"]');
    if (await medic.isEnabled()) await medic.click();
    expect(await call<string>(page, 'mode')).toBe('recruit');
    // Escape cancels the mode.
    await page.keyboard.press('Escape');
    expect(await call<string>(page, 'mode')).toBe('none');
    // Clicking HUD buttons must not issue battlefield orders: open Help with a mode active.
    await page.locator('#tab-support').click();
    await page.locator('#btn-sandbag').click();
    await page.locator('#btn-help').click();
    await expect(page.locator('#overlay-help')).toBeVisible();
    expect((await getState(page))!.points).toBe(28); // only the two specialists purchased
  });

  test('a result screen is reachable, restartable, and leaves no duplicate updates', async ({ page }) => {
    await startRun(page, 4242);
    await page.evaluate(() => {
      const hook = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      hook.setIntegrity(1);
      hook.spawnEnemyAt('vehicle', 480, 700);
      hook.step(3);
    });
    await expect(page.locator('#overlay-results')).toBeVisible();
    await expect(page.locator('#res-title')).toContainText('broken');
    // New Game from the results screen starts a clean run.
    await page.locator('#btn-results-new').click();
    await page.locator('#btn-campaign-start').click();
    await expect(page.locator('#overlay-results')).toBeHidden();
    // Repeated restart/continue cycles leave no duplicate units or updates.
    for (let i = 0; i < 3; i++) {
      await call<void>(page, 'startRun', 4242);
      const state = await getState(page);
      expect(state!.units.filter((u) => u.team === 'friendly')).toHaveLength(4);
    }
  });

  test('narrow viewport keeps the field and controls usable', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await startRun(page, 7);
    await expect(page.locator('#game canvas')).toBeVisible();
    await expect(page.locator('#hud-side')).toBeVisible();
    const soldier = await gamePoint(page, 330, 600);
    await page.mouse.click(soldier.x, soldier.y);
    await expect(page.locator('#sel-details')).toBeVisible();
  });

  test('camera projection round-trips battlefield points at the narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await startRun(page, 19);
    const result = await page.evaluate(() => {
      const api = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      const samples = [{ x: 1, y: 1 }, { x: 480, y: 360 }, { x: 959, y: 719 }, { x: 105, y: 640 }];
      return samples.map((source) => {
        const client = api.worldToClient(source.x, source.y);
        const back = client ? api.clientToWorld(client.x, client.y) : null;
        return { source, back };
      });
    });
    for (const { source, back } of result) {
      expect(back).not.toBeNull();
      expect(Math.abs(back!.x - source.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(back!.y - source.y)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => (window as unknown as { __lastlineTest: TestApi }).__lastlineTest.worldToClient(-1, 360))).toBeNull();
  });

  test('elevated ground supports picking, automatic climbing crawl, and saved posture', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startRun(page, 2026);
    const fixture = (await getState(page))!;
    expect(fixture.terrainLayoutVersion).toBe(3);
    const soldier = fixture.units.find((unit) => unit.team === 'friendly')!;
    const home = { ...soldier.pos };
    // A gentle approach leading to a steep face and higher terrace.
    const foothill = { x: 714, y: 366 }, summit = { x: 762, y: 462 };
    soldier.pos = { ...foothill }; soldier.prevPos = { ...foothill };
    soldier.path = []; soldier.moveGoal = null;
    soldier.stance = 'crouching'; soldier.crawling = false;
    fixture.scheduler.prepTicksLeft = 100_000;
    fixture.weather = 'clear';
    fixture.weatherChangeTick = 100_000;
    await page.addInitScript((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), fixture);
    await page.reload();
    await page.locator('#btn-continue').click();
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    await page.locator('#btn-resume').click();
    await page.locator(`.roster-soldier[data-unit-id="${soldier.id}"]`).click();
    expect(await call<boolean>(page, 'moveUnit', 0, summit.x, summit.y)).toBe(true);
    await call<void>(page, 'step', 1);
    let climbing = (await getState(page))!.units.find((unit) => unit.id === soldier.id)!;
    expect(climbing.terrainCrawling).toBe(false);
    await expect(page.locator('#sel-action')).not.toHaveText('Crawling on steep ground');
    await page.screenshot({ path: testInfo.outputPath('terrain-walking-approach.png') });
    for (let tick = 0; tick < 400 && !climbing.terrainCrawling && climbing.path.length; tick += 5) {
      await call<void>(page, 'step', 5);
      climbing = (await getState(page))!.units.find((unit) => unit.id === soldier.id)!;
    }
    expect(climbing.terrainCrawling).toBe(true);
    expect(climbing.stance).toBe('crouching');
    await expect(page.locator('#sel-action')).toHaveText('Crawling on steep ground');
    for (const source of [foothill, summit]) {
      const client = await gamePoint(page, source.x, source.y);
      const back = await call<{ x: number; y: number }>(page, 'clientToWorld', client.x, client.y);
      expect(back.x).toBeCloseTo(source.x, 2);
      expect(back.y).toBeCloseTo(source.y, 2);
    }
    await page.screenshot({ path: testInfo.outputPath('terrain-automatic-climb.png') });
    const canvasBounds = (await page.locator('#game canvas').boundingBox())!;
    await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
    await page.mouse.wheel(0, -600);
    const soldierPoint = await gamePoint(page, foothill.x, foothill.y);
    await page.mouse.move(soldierPoint.x, soldierPoint.y);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await page.clock.runFor(16);
    await page.screenshot({ path: testInfo.outputPath('terrain-climbing-close.png') });
    await call<void>(page, 'step', 1500);
    const arrived = (await getState(page))!.units.find((unit) => unit.id === soldier.id)!;
    expect(arrived.path).toHaveLength(0);
    expect(Math.hypot(arrived.pos.x - summit.x, arrived.pos.y - summit.y)).toBeLessThan(18);
    expect(await call<boolean>(page, 'moveUnit', 0, home.x, home.y)).toBe(true);
    await call<void>(page, 'step', 3000);
    const returned = (await getState(page))!.units.find((unit) => unit.id === soldier.id)!;
    expect(returned.path).toHaveLength(0);
    expect(returned.terrainCrawling).toBe(false);
    expect(returned.stance).toBe('crouching');
    expect(returned.crawling).toBe(false);
    // Movement-order pulses use browser time, independently of simulated ticks.
    await page.clock.runFor(1000);
    const warmed = (await call<ReturnType<TestApi['rendererDiagnostics']>>(page, 'rendererDiagnostics'))!;
    for (let crossing = 0; crossing < 2; crossing++) {
      expect(await call<boolean>(page, 'moveUnit', 0, summit.x, summit.y)).toBe(true);
      await call<void>(page, 'step', 3000);
      expect(await call<boolean>(page, 'moveUnit', 0, home.x, home.y)).toBe(true);
      await call<void>(page, 'step', 3000);
    }
    await page.clock.runFor(1000);
    const repeated = (await call<ReturnType<TestApi['rendererDiagnostics']>>(page, 'rendererDiagnostics'))!;
    expect(repeated.geometries).toBe(warmed.geometries);
    expect(errors).toEqual([]);
  });

  test('battlefield zoom works with the wheel and keyboard without on-screen controls', async ({ page }, testInfo) => {
    await startRun(page, 2026);
    const pointDistance = async (): Promise<number> => page.evaluate(() => {
      const api = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      const center = api.worldToClient(480, 360)!;
      const edge = api.worldToClient(240, 360)!;
      return Math.hypot(edge.x - center.x, edge.y - center.y);
    });
    const probePoint = async (): Promise<{ x: number; y: number }> => page.evaluate(() =>
      (window as unknown as { __lastlineTest: TestApi }).__lastlineTest.worldToClient(240, 360)!,
    );

    const defaultDistance = await pointDistance();
    const canvas = page.locator('#game canvas');
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.wheel(0, -240);
    const zoomedDistance = await pointDistance();
    expect(zoomedDistance).toBeGreaterThan(defaultDistance);

    await expect(page.locator('.battlefield-zoom')).toHaveCount(0);
    const beforePan = await probePoint();
    await page.mouse.move(bounds!.x + bounds!.width / 2 - 40, bounds!.y + bounds!.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2 + 20, bounds!.y + bounds!.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    const afterPan = await probePoint();
    expect(afterPan.x).toBeGreaterThan(beforePan.x);

    await canvas.focus();
    await page.keyboard.press('-');
    const zoomedOutDistance = await pointDistance();
    expect(zoomedOutDistance).toBeLessThan(zoomedDistance);
    await page.keyboard.press('0');
    expect(await pointDistance()).toBeCloseTo(defaultDistance, 1);
    await page.mouse.wheel(0, 10000);
    expect(await pointDistance()).toBeCloseTo(defaultDistance, 1);
    await page.keyboard.press('-');
    expect(await pointDistance()).toBeCloseTo(defaultDistance, 1);
    await page.screenshot({ path: testInfo.outputPath('battlefield-without-zoom-buttons.png') });
  });

  test('textured terrain survives map rebuilds and remains readable at night', async ({ page }, testInfo) => {
    await startRun(page, 2026);
    await call<void>(page, 'step', 0);
    const initial = (await call<ReturnType<TestApi['rendererDiagnostics']>>(page, 'rendererDiagnostics'))!;
    expect(initial.textures).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath('smooth-terrain-day.png') });
    for (let i = 0; i < 3; i++) {
      await call<void>(page, 'startRun', 2026);
      await call<void>(page, 'step', 0);
      const rebuilt = (await call<ReturnType<TestApi['rendererDiagnostics']>>(page, 'rendererDiagnostics'))!;
      expect(rebuilt.textures).toBe(initial.textures);
      expect(rebuilt.geometries).toBe(initial.geometries);
    }
    const night = (await getState(page))!;
    night.ticks = CONFIG.dayNight.cycleSeconds * CONFIG.tickRate / 2;
    night.wavesCompleted = CONFIG.dayNight.startAfterWaves;
    night.dayNightStartTick = 0;
    night.weather = 'clear';
    night.weatherChangeTick = night.ticks + CONFIG.weatherChangeSeconds * CONFIG.tickRate;
    // Install after the departing document's autosave, before the new app boots.
    await page.addInitScript((snapshot) => localStorage.setItem('lastline/save/v1', JSON.stringify(snapshot)), night);
    await page.reload();
    await page.locator('#btn-continue').click();
    await page.locator('#btn-resume').click();
    await expect(page.locator('#hud-setting')).toContainText('Night');
    await page.screenshot({ path: testInfo.outputPath('smooth-terrain-night.png') });
    const bounds = (await page.locator('#game canvas').boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -600);
    await page.screenshot({ path: testInfo.outputPath('smooth-terrain-night-close.png') });
  });

  test('friendly and enemy tracers render toward their targets', async ({ page }, testInfo) => {
    await startRun(page, 2026);
    // Freeze browser time so screenshots cannot miss the short-lived tracers.
    await page.clock.install({ time: new Date('2026-10-16T10:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T10:00:01Z'));
    const state = (await getState(page))!;
    const friendly = state.units.find((unit) => unit.team === 'friendly' && unit.health > 0)!;
    const enemyPos = { x: friendly.pos.x + 120, y: friendly.pos.y - 170 };
    await call<void>(page, 'spawnEnemyAt', 'rifle', enemyPos.x, enemyPos.y);
    // Run one render frame without advancing the prep simulation, so both unit
    // meshes exist before the test injects shot events.
    await call<void>(page, 'step', 0);
    const afterSpawn = (await getState(page))!;
    const enemy = afterSpawn.units.find((unit) => unit.team === 'enemy' && unit.health > 0)!;

    const rendered = await page.evaluate(({ friendlyId, enemyId, friendlyPos, enemyPos }) => {
      const api = (window as unknown as { __lastlineTest: TestApi }).__lastlineTest;
      return [
        api.renderTestShot(friendlyId, enemyPos.x, enemyPos.y, enemyId),
        api.renderTestShot(enemyId, friendlyPos.x, friendlyPos.y, friendlyId),
      ];
    }, { friendlyId: friendly.id, enemyId: enemy.id, friendlyPos: friendly.pos, enemyPos: enemy.pos });
    expect(rendered).toEqual([true, true]);
    await page.clock.runFor(16);
    await page.screenshot({ path: testInfo.outputPath('friendly-and-enemy-tracers.png') });
    // Inspect during the fade as well: this is when the old shared expansion
    // animation dragged both endpoints away from their shooter and target.
    await page.clock.runFor(100);
    await page.screenshot({ path: testInfo.outputPath('friendly-and-enemy-tracers-fading.png') });
  });

  test('a mine detonating under a vehicle drives the explosion feedback', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    await startRun(page, 11);
    const mine = { x: 480, y: 300 };
    // Anti-tank: an anti-personnel charge ignores vehicles by design, so the
    // type matters here as much as the placement.
    await call<void>(page, 'armMineAt', mine.x, mine.y, 'at');
    // A vehicle sitting on the charge: the case that used to pass silently.
    await call<void>(page, 'spawnEnemyAt', 'vehicle', mine.x, mine.y);
    await call<void>(page, 'step', 3);

    // The renderer only shakes in response to a detonation reaching its event
    // handler, so a non-zero magnitude proves the whole chain fired: simulation
    // event -> controller -> renderer. Without the handler this stayed 0.
    const shake = await call<number>(page, 'screenShake');
    expect(shake).toBeGreaterThan(0);

    // And the mine was actually consumed by the explosion.
    const state = await call<Snapshot | null>(page, 'getState');
    expect(state?.mines ?? []).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  /**
   * The support buttons carry their price on their face, so the number a player
   * reads has to be the number the simulation deducts. Hand-written markup drifts
   * silently the first time a cost is tuned, which is exactly what happened to
   * the AT mine's price.
   */
  test('a support button advertises the price the simulation actually charges', async ({ page }) => {
    await startRun(page, 7);
    await page.locator('#tab-support').click();
    await call<void>(page, 'givePoints', 60);
    // Mines need an engineer in range; everything else about this placement is
    // ordinary, so it runs the real command path and pays the real cost.
    expect(await call<boolean>(page, 'recruit', 'engineer', 480, 620)).toBe(true);

    const label = await page.locator('#btn-mine-at').textContent();
    const advertised = Number(/\((\d+)\)/.exec(label ?? '')?.[1]);
    expect(Number.isInteger(advertised), `no price found in "${label}"`).toBe(true);

    const before = (await getState(page))!.points;
    await page.locator('#btn-mine-at').click();
    expect(await call<string>(page, 'mode')).toBe('mine');
    const spot = await gamePoint(page, 480, 560);
    await page.mouse.click(spot.x, spot.y);

    const state = (await getState(page))!;
    // The charge is what the button promised, and the mine really was queued.
    expect(before - state.points).toBe(advertised);
    expect(state.constructionSites.map((site) => site.kind)).toEqual(['mine']);
  });

  test('no uncaught page errors or failed asset loads', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    await startRun(page, 7);
    await call<void>(page, 'step', 120);
    const point = await gamePoint(page, 480, 360);
    await page.mouse.click(point.x, point.y);
    expect(errors).toEqual([]);
  });

  /** The four starting riflemen and the positions the squad deploys at. */
  const START_SQUAD = [
    { x: 330, y: 600 },
    { x: 430, y: 620 },
    { x: 530, y: 620 },
    { x: 630, y: 600 },
  ];

  test('shift-click extends a selection and toggles a soldier back out', async ({ page }) => {
    await startRun(page, 11);
    const ids = (await getState(page))!.units.filter((u) => u.team === 'friendly').map((u) => u.id);
    expect(ids).toHaveLength(4);

    await call<void>(page, 'clickUnitAt', START_SQUAD[0]!.x, START_SQUAD[0]!.y);
    expect(await call<number[]>(page, 'selectionIds')).toEqual([ids[0]]);

    // Shift adds rather than replaces.
    await call<void>(page, 'clickUnitAt', START_SQUAD[1]!.x, START_SQUAD[1]!.y, true);
    await call<void>(page, 'clickUnitAt', START_SQUAD[2]!.x, START_SQUAD[2]!.y, true);
    expect(await call<number[]>(page, 'selectionIds')).toEqual([ids[0], ids[1], ids[2]]);

    // Shift on someone already in the group removes them.
    await call<void>(page, 'clickUnitAt', START_SQUAD[1]!.x, START_SQUAD[1]!.y, true);
    expect(await call<number[]>(page, 'selectionIds')).toEqual([ids[0], ids[2]]);

    // A plain click collapses the group back to one soldier.
    await call<void>(page, 'clickUnitAt', START_SQUAD[3]!.x, START_SQUAD[3]!.y);
    expect(await call<number[]>(page, 'selectionIds')).toEqual([ids[3]]);

    // The HUD says it is a group only when it is one.
    await expect(page.locator('#sel-multi')).toBeHidden();
    await call<void>(page, 'clickUnitAt', START_SQUAD[2]!.x, START_SQUAD[2]!.y, true);
    await expect(page.locator('#sel-multi')).toBeVisible();
    await expect(page.locator('#sel-multi-count')).toContainText('2 soldiers selected');
    await expect(page.locator('#sel-multi-list li')).toHaveCount(2);
  });

  test('a drag box selects the squad, and the group moves together', async ({ page }) => {
    await startRun(page, 11);

    // A real press-drag-release, so this covers the pointerup wiring too: without
    // it the rubber band would never resolve into a selection.
    const from = await gamePoint(page, 300, 560);
    const to = await gamePoint(page, 660, 660);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    expect(await call<number[]>(page, 'selectionIds')).toHaveLength(4);

    // Right-click issues one order to the whole group.
    const target = { x: 480, y: 480 };
    const spot = await gamePoint(page, target.x, target.y);
    await page.mouse.click(spot.x, spot.y, { button: 'right' });

    const friendlies = (await getState(page))!.units.filter((u) => u.team === 'friendly');
    const goals = friendlies.map((u) => u.moveGoal);
    expect(goals.every((g) => g !== null)).toBe(true);
    // Each soldier got its own slot: a squad ordered onto a single tile spends
    // the next seconds shoving itself apart instead of marching.
    const keys = new Set(goals.map((g) => `${Math.round(g!.x)},${Math.round(g!.y)}`));
    expect(keys.size).toBe(4);
    for (const g of goals) {
      expect(Math.hypot(g!.x - target.x, g!.y - target.y)).toBeLessThan(90);
    }
  });

  test('a drag box outside every soldier clears the selection', async ({ page }) => {
    await startRun(page, 11);
    await call<void>(page, 'dragSelect', 320, 590, 640, 630);
    expect(await call<number[]>(page, 'selectionIds')).toHaveLength(4);

    // Empty ground in the north of the field: nothing friendly to catch.
    await call<void>(page, 'dragSelect', 60, 60, 300, 200);
    expect(await call<number[]>(page, 'selectionIds')).toEqual([]);
    await expect(page.locator('#sel-empty')).toBeVisible();
  });
});
