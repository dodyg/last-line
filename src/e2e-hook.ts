import type { GameController } from './game/controller';
import { CONFIG } from './content/config';
import type { EnemyArchetype, FriendlyRole, SimEvent } from './simulation/types';
import type { RendererPort } from './game/render-contract';
import type { BattleRuntime } from './render/app/BattleRuntime';

/**
 * Test-only automation hooks. Installed exclusively when the page URL carries
 * ?e2e; the production game path never imports this module. Used by the
 * Playwright suite to reach fixture states quickly instead of waiting out
 * real-time waves.
 */

interface E2EApi {
  startRun(seed?: number): void;
  /** Advance the simulation by N ticks through the normal frame pipeline so events reach the UI. */
  step(n: number): void;
  pause(): void;
  givePoints(n: number): void;
  setIntegrity(n: number): void;
  spawnEnemyAt(archetype: EnemyArchetype, x: number, y: number): void;
  /** Kill a friendly unit outright, so casualty handling can be tested cheaply. */
  killFriendly(unitId: number): boolean;
  /** Drop an already-armed mine, bypassing the engineer and the lay timer. */
  armMineAt(x: number, y: number, kind?: 'ap' | 'at'): void;
  /** Teleport every living soldier onto the northern exit strip, ready to cross. */
  rallyAtNorthEdge(): void;
  /** Magnitude of the renderer's current screen shake; 0 when none is active. */
  screenShake(): number;
  /** Render a deterministic shot event from a visible unit for tracer playtests. */
  renderTestShot(shooterId: number, toX: number, toY: number, targetId?: number): boolean;
  fireShot(shooterId: number, targetId: number): boolean;
  /** Project simulation pixels to viewport CSS pixels through the displayed camera. */
  worldToClient(x: number, y: number, height?: number): { x: number; y: number } | null;
  clientToWorld(x: number, y: number): { x: number; y: number } | null;
  rendererReady(): boolean;
  rendererDiagnostics(): { geometries: number; textures: number; calls: number; triangles: number } | null;
  /** What the ground under a soldier costs it: water and mud penalties alike. */
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
  getState(): unknown;
  save(): void;
  selectUnit(index: number): number | null;
  selection(): number | null;
  /** Every id in the current selection; `selection()` returns only the primary. */
  selectionIds(): number[];
  /** Left-press and release without pointer travel: a plain click. */
  clickUnitAt(x: number, y: number, additive?: boolean): void;
  /** A full rubber-band gesture between two corners of the battlefield. */
  dragSelect(x0: number, y0: number, x1: number, y1: number, additive?: boolean): void;
  pointer(): { x: number; y: number };
  tap(x: number, y: number): void;
  mode(): string;
  paused(): boolean;
  /** Attempt a move order for a friendly unit by index. */
  moveUnit(index: number, x: number, y: number): boolean;
  recruit(role: FriendlyRole, x: number, y: number): boolean;
  /** Order a mine laid, without going through a HUD placement mode. */
  orderMine(kind: 'ap' | 'at', x: number, y: number): boolean;
  /** Why a placement would be refused: empty string when it is allowed. */
  placementError(kind: 'recruit' | 'barbedWire' | 'sandbag' | 'trench' | 'bunker' | 'bridge' | 'mortarPit' | 'mine' | 'artillery' | 'airSupport', x: number, y: number, mineKind?: 'ap' | 'at'): string;
  /** Provisional stress scenario: 14 friendlies, 80 enemies, massed artillery in flight. */
  stressSetup(): void;
  /** Fixed initial workloads used by the repeatable browser benchmarks. */
  benchmarkSetup(scenario: 'normal' | 'combat' | 'effects', seed: number): void;
  /** Apply a real structure hit for staged damage previews. */
  spawnSapperTeamAt(x: number, y: number): boolean;
  damageBuilding(index: number, amount: number): boolean;
  /** Fire an Axis barrage now, whatever wave the run is on, for UI coverage. */
  enemyBarrage(shells?: number): { shells: number; landTick: number } | null;
  /**
   * Fire an Axis barrage and walk every shell onto a chosen point, so a test can
   * assert what an impact does without hunting for a seed that happens to
   * scatter a shell onto somebody.
   */
  aimBarrageAt(x: number, y: number, shells?: number): { shells: number; landTick: number } | null;
}

export function installE2EHooks(controller: GameController, getRuntime: () => BattleRuntime | null = () => null): void {
  const current = (): import('./simulation/simulation').Simulation | null =>
    ((controller as unknown as { sim: import('./simulation/simulation').Simulation | null }).sim);

  const api: E2EApi = {
    startRun(seed?: number) {
      controller.newRun(seed);
      controller.resumeRun();
    },
    step(n: number) {
      controller.advanceForE2E(n);
    },
    pause() {
      (controller as unknown as { pauseRun(auto: boolean): void }).pauseRun(false);
    },
    givePoints(n: number) {
      const sim = current();
      if (sim !== null) sim.state.points = n;
    },
    setIntegrity(n: number) {
      const sim = current();
      if (sim !== null) sim.state.integrity = n;
    },
    spawnSapperTeamAt(x, y) { return current()?.spawnEnemySapperTeam({ x, y }) ?? false; },
    spawnEnemyAt(archetype, x, y) {
      current()?.spawnEnemy(archetype, { x, y });
    },
    /** Kill a friendly unit outright, as a direct hit would, without waiting for one. */
    killFriendly(unitId) {
      const sim = current();
      if (sim === null) return false;
      const unit = sim.state.units.find((u) => u.id === unitId && u.team === 'friendly');
      if (unit === undefined) return false;
      unit.health = 0;
      unit.dead = true;
      return true;
    },
    armMineAt(x, y, kind = 'ap') {
      const sim = current();
      if (sim === null) return;
      sim.state.mines.push({ id: sim.state.nextEntityId++, pos: { x, y }, kind, armed: true });
    },
    rallyAtNorthEdge() {
      const sim = current();
      if (sim === null) return;
      const friendlies = sim.state.units.filter((u) => u.team === 'friendly' && u.health > 0 && u.crossed !== true);
      friendlies.forEach((unit, index) => {
        const x = 120 + index * 90;
        unit.pos = { x, y: CONFIG.crossing.thresholdY - 2 };
        unit.prevPos = { x, y: CONFIG.crossing.thresholdY - 2 };
        unit.path = [];
        unit.moveGoal = null;
        unit.pinned = false;
      });
    },
    screenShake() {
      const renderer = (controller as unknown as { renderer: { getShakeMagnitude(): number } | null }).renderer;
      return renderer?.getShakeMagnitude() ?? 0;
    },
    renderTestShot(shooterId, toX, toY, targetId) {
      const sim = current();
      const renderer = (controller as unknown as { renderer: RendererPort | null }).renderer;
      const shooter = sim?.state.units.find((unit) => unit.id === shooterId);
      if (sim === null || renderer === null || shooter === undefined) return false;
      const event: SimEvent = {
        type: 'shot', shooterId, shooterTeam: shooter.team,
        from: { ...shooter.pos }, to: { x: toX, y: toY }, hit: false,
        weapon: 'test tracer', targetId: targetId ?? null,
      };
      renderer.handleEvents(sim.state, [event]);
      return true;
    },
    fireShot(shooterId, targetId) {
      const sim = current();
      const shooter = sim?.state.units.find((unit) => unit.id === shooterId && !unit.dead && unit.health > 0);
      const target = sim?.state.units.find((unit) => unit.id === targetId && !unit.dead && unit.health > 0);
      if (!sim || !shooter || !target || shooter.team === target.team) return false;
      const weapon = sim.weaponOf(shooter);
      if (!weapon) return false;
      return sim.fireShot(shooter, target, weapon);
    },
    worldToClient(x, y, height = 0) { return getRuntime()?.worldToClient({ x, y }, height) ?? null; },
    clientToWorld(x, y) { return getRuntime()?.clientToWorld(x, y) ?? null; },
    rendererReady() { return getRuntime()?.ready ?? false; },
    rendererDiagnostics() { return getRuntime()?.diagnostics() ?? null; },
    terrainAt(unitId) {
      const sim = current();
      if (sim === null) return null;
      const unit = sim.state.units.find((u) => u.id === unitId && u.team === 'friendly');
      return unit === undefined ? null : sim.terrainEffectsFor(unit);
    },
    buildings() {
      return current()?.state.buildings.map((b) => ({
        id: b.id,
        kind: b.kind,
        name: b.name,
        health: b.health,
        maxHealth: b.maxHealth,
        destroyed: b.destroyed,
        pos: { ...b.pos },
        cols: b.cols,
        rows: b.rows,
      })) ?? [];
    },
    /** Whether the segment from one point to another is stopped by a standing building. */
    wallBetween(from, to) {
      const building = current()?.buildingOnSegment(from, to);
      return building === undefined || building === null ? null : { id: building.id, name: building.name };
    },
    /** Apply a real hit without waiting for a barrage. */
    damageBuilding(index, amount): boolean {
      const sim = current(), building = sim?.state.buildings[index];
      if (!sim || !building || !Number.isFinite(amount) || amount <= 0) return false;
      sim.damageBuilding(building, amount); return true;
    },
    /** Level a building by index, as artillery would. */
    razeBuilding(index): boolean {
      const sim = current();
      if (sim === null) return false;
      const building = sim.state.buildings[index];
      if (building === undefined) return false;
      sim.damageBuilding(building, building.maxHealth);
      return true;
    },
    getState() {
      return current()?.snapshot() ?? null;
    },
    save() {
      controller.saveRun();
    },
    selectUnit(index: number): number | null {
      const sim = current();
      if (sim === null) return null;
      const friendlies = sim.state.units.filter((u) => u.team === 'friendly' && u.crossed !== true);
      return friendlies[index]?.id ?? null;
    },
    selection(): number | null {
      return (controller as unknown as { selectionId: number | null }).selectionId;
    },
    /** Every id in the current selection; `selection()` returns only the primary. */
    selectionIds(): number[] {
      return [...controller.selectionIds];
    },
    /** Left-press, then release, without the pointer having travelled. */
    clickUnitAt(x: number, y: number, additive = false): void {
      controller.pointerLeft(x, y, additive);
      controller.pointerUp(x, y, additive);
    },
    /** A full rubber-band gesture from one corner to another. */
    dragSelect(x0: number, y0: number, x1: number, y1: number, additive = false): void {
      controller.pointerLeft(x0, y0, additive);
      controller.pointerMove(x1, y1);
      controller.pointerUp(x1, y1, additive);
    },
    /** Invoke the controller's left-click handler directly (bypasses canvas input). */
    tap(x: number, y: number): void {
      (controller as unknown as { pointerLeft(x: number, y: number): void }).pointerLeft(x, y);
    },
    pointer(): { x: number; y: number } {
      return { ...(controller as unknown as { pointerPos: { x: number; y: number } }).pointerPos };
    },
    mode() {
      return controller.mode.kind;
    },
    paused() {
      return current()?.paused ?? true;
    },
    moveUnit(index, x, y) {
      const id = api.selectUnit(index);
      if (id === null) return false;
      const sim = current();
      if (sim === null) return false;
      return sim.command({ type: 'move', unitId: id, pos: { x, y } }).ok;
    },
    recruit(role, x, y) {
      const sim = current();
      if (sim === null) return false;
      return sim.command({ type: 'recruit', role, pos: { x, y } }).ok;
    },
    /** Give an engineer something to build, without going through a HUD mode. */
    orderMine(kind, x, y) {
      const sim = current();
      if (sim === null) return false;
      return sim.command({ type: 'mine', kind, pos: { x, y } }).ok;
    },
    /** Why a placement would be refused, straight from the simulation. */
    placementError(kind, x, y, mineKind) {
      const sim = current();
      if (sim === null) return 'no run';
      return sim.validatePlacement(kind, { x, y }, undefined, mineKind).reason ?? '';
    },
    stressSetup() {
      const sim = current();
      if (sim === null) return;
      sim.state.points = 400;
      // France starts with four friendlies; add ten for a 14-unit stress squad.
      const roles: Array<'rifleman' | 'mg' | 'medic' | 'at' | 'gun_truck'> = ['rifleman', 'mg', 'at', 'gun_truck', 'medic', 'rifleman', 'mg', 'at', 'rifleman', 'gun_truck'];
      roles.forEach((role, i) => {
        sim.spawnFriendly(role, { x: 190 + (i % 5) * 105, y: 590 + Math.floor(i / 5) * 28 });
      });
      for (let i = 0; i < 80; i++) {
        sim.spawnEnemy(i % 17 === 0 ? 'vehicle' : i % 13 === 0 ? 'gun_truck' : i % 4 === 3 ? 'assault' : 'rifle', { x: 160 + (i * 67) % 640, y: -14 - (i % 5) * 12 });
      }
      // Long-lived artillery markers keep all 30 visible during an 8-second run.
      for (let i = 0; i < 30; i++) {
        sim.artilleryStrikeFor(10000, { x: 180 + (i * 61) % 600, y: 120 + (i * 37) % 420 });
      }
      sim.state.smokes.push(...Array.from({ length: 8 }, (_, i) => ({ id: sim.state.nextEntityId++, pos: { x: 160 + i * 86, y: 280 + (i % 2) * 40 }, radius: 56, ticksRemaining: 10000 })));
      sim.state.flares.push({ id: sim.state.nextEntityId++, pos: { x: 480, y: 280 }, radius: 150, ticksRemaining: 10000 });
    },
    benchmarkSetup(scenario, seed) {
      api.startRun(seed);
      const sim = current();
      if (sim === null) throw new Error('Benchmark simulation did not start');
      // Keep automatic wave spawning outside the measurement window.
      sim.state.scheduler.phase = 'prep';
      sim.state.scheduler.prepTicksLeft = 1_000_000;
      if (scenario === 'normal') return;
      api.stressSetup();
      if (scenario === 'combat') {
        sim.state.strikes = [];
        sim.state.smokes = [];
        sim.state.flares = [];
        let index = 0;
        for (const unit of sim.state.units) {
          if (unit.team !== 'enemy') continue;
          unit.pos = { x: 80 + ((index * 37) % 800), y: 100 + Math.floor(index / 9) * 35 };
          unit.prevPos = { ...unit.pos };
          index++;
        }
      }
    },
    /**
     * Put an Axis fire mission in the air without waiting out twelve waves for
     * the battery to wake up. The wave number is passed as the current one plus
     * the gate, so the shells carry the scatter the barrage would really have.
     */
    enemyBarrage(shells) {
      const sim = current();
      if (sim === null) return null;
      const aim = sim.state.units.find((u) => u.team === 'friendly' && u.health > 0 && u.crossed !== true);
      if (aim === undefined) return null;
      const wave = CONFIG.enemyArtillery.firstWaveWithBarrage + sim.state.scheduler.waveIndex;
      const strikes = sim.fireEnemyBarrage(aim, Math.max(wave, CONFIG.enemyArtillery.firstWaveWithBarrage), shells);
      // Keep the save/reload fixture in flight while browser storage work runs;
      // aimBarrageAt replaces these land ticks before the impact assertion.
      for (const strike of strikes) strike.landTick = sim.state.ticks + 900;
      const first = strikes[0];
      return first === undefined ? null : { shells: strikes.length, landTick: first.landTick };
    },
    aimBarrageAt(x, y, shells) {
      const fired = api.enemyBarrage(shells);
      const sim = current();
      if (fired === null || sim === null) return null;
      for (const strike of sim.state.strikes) {
        if (strike.source !== 'enemy') continue;
        strike.pos = { x, y };
        strike.landTick = sim.state.ticks + 1;
      }
      return { shells: fired.shells, landTick: sim.state.ticks + 1 };
    },
  };

  (window as unknown as { __lastlineTest: E2EApi }).__lastlineTest = api;
}
