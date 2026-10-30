import { expect, it, vi } from 'vitest';
import { GameController } from '../src/game/controller';
import { Simulation } from '../src/simulation/simulation';

it('double speed advances the fixed simulation twice as far and pause stops both speeds', () => {
  const sim = new Simulation(2026);
  const speedReadout = vi.fn();
  // Isolate the controller clock from rendering, sound, and menus.
  const controller = Object.assign(Object.create(GameController.prototype), {
    sim, renderer: { frame: vi.fn(), handleEvents: vi.fn() },
    audio: { setAtmosphere: vi.fn() },
    hud: { update: vi.fn(), setPlacementFeedback: vi.fn(), setBattleSpeed: speedReadout },
    terrainData: { seed: sim.state.seed },
    selectionIds: [], accumulator: 0, alpha: 0, lastSaveTick: 0,
    battleSpeed: 1, overlayOpen: false, mapReviewActive: false,
    pruneSelection: vi.fn(), currentPreview: () => null, selectedUnits: () => [],
    dragRect: () => null, processEvents: vi.fn(), updateChatter: vi.fn(),
  }) as GameController;
  const advanceSecond = () => { for (let i = 0; i < 40; i++) controller.frame(25); };
  advanceSecond();
  const normalTicks = sim.state.ticks;
  expect(normalTicks).toBeGreaterThanOrEqual(29);
  controller.toggleBattleSpeed();
  expect(speedReadout).toHaveBeenLastCalledWith(2);
  advanceSecond();
  expect(sim.state.ticks - normalTicks).toBeGreaterThanOrEqual(59);
  expect(sim.state.ticks - normalTicks).toBeLessThanOrEqual(61);
  sim.paused = true;
  const pausedAt = sim.state.ticks;
  advanceSecond();
  expect(sim.state.ticks).toBe(pausedAt);
  controller.toggleBattleSpeed();
  expect(speedReadout).toHaveBeenCalledTimes(1);
  sim.paused = false;
  controller.toggleBattleSpeed();
  expect(speedReadout).toHaveBeenLastCalledWith(1);
});
