import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/simulation';
import { validateSnapshot } from '../src/persistence';
import { CONFIG } from '../src/content/config';
import { campaignGoal, operationSector, operationTarget, sectorWaves } from '../src/content/operations';

function operation(seed = 2026): Simulation {
  const sim = new Simulation(seed);
  sim.state.runMode = 'operation';
  return sim;
}

function clearLastWave(sim: Simulation): void {
  sim.state.units = sim.state.units.filter((unit) => unit.team === 'friendly');
  sim.state.scheduler = { ...sim.state.scheduler, phase: 'active', waveIndex: sectorWaves(sim.state) - 1,
    spawnQueue: [], rewardGranted: false };
  sim.step();
}

function occupy(sim: Simulation): void {
  const soldier = sim.state.units.find((unit) => unit.team === 'friendly')!;
  soldier.pos = { ...operationTarget(sim.state) };
  soldier.prevPos = { ...soldier.pos }; soldier.path = []; soldier.moveGoal = null;
  soldier.pinned = false; soldier.suppression = 0;
}

function march(sim: Simulation): void {
  for (const soldier of sim.state.units.filter((unit) => unit.team === 'friendly')) {
    soldier.pos.y = CONFIG.crossing.thresholdY - 1; soldier.prevPos = { ...soldier.pos };
    soldier.path = []; soldier.pinned = false; soldier.suppression = 0;
  }
  for (let tick = 0, map = sim.state.mapNumber; tick < 60 && sim.state.mapNumber === map; tick++) sim.step();
}

describe('three-sector operations', () => {
  it.each([1, 17, 91, 2026, 9999])('places a full separated garrison on generated terrain (seed %i)', (seed) => {
    for (let sector = 0; sector < 3; sector++) {
      const sim = new Simulation(seed);
      sim.state.runMode = 'assault'; sim.state.mapsCleared = sector;
      sim.setupAssault();
      const defenders = sim.state.units.filter((unit) => unit.team === 'enemy');
      expect(defenders).toHaveLength([8, 12, 16][sector]!);
      for (const [index, unit] of defenders.entries()) {
        const col = Math.floor(unit.pos.x / sim.state.terrain.cell), row = Math.floor(unit.pos.y / sim.state.terrain.cell);
        expect(sim.state.terrain.blocked[row * sim.state.terrain.cols + col]).toBeFalsy();
        for (const other of defenders.slice(index + 1)) expect(Math.hypot(unit.pos.x - other.pos.x, unit.pos.y - other.pos.y)).toBeGreaterThanOrEqual(24);
      }
    }
  });
  it('sets up and preserves assault garrisons across three fortified sectors', () => {
    const sim = new Simulation(2026);
    sim.state.runMode = 'assault';
    sim.setupAssault();
    for (let sector = 0; sector < 3; sector++) {
      const defenders = sim.state.units.filter((unit) => unit.team === 'enemy');
      expect(defenders.length).toBe([8, 12, 16][sector]);
      expect(sim.state.bunkers).toHaveLength(sector + 2);
      expect(defenders.some((unit) => unit.role === 'mg_team')).toBe(true);
      expect(defenders.some((unit) => unit.role === 'assault')).toBe(true);
      for (const [index, unit] of defenders.entries()) {
        for (const other of defenders.slice(index + 1)) expect(Math.hypot(unit.pos.x - other.pos.x, unit.pos.y - other.pos.y)).toBeGreaterThanOrEqual(24);
      }
      const positions = defenders.map((unit) => ({ ...unit.pos }));
      sim.step();
      expect(defenders.map((unit) => unit.pos)).toEqual(positions);
      const parsed = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
      if ('error' in parsed) throw new Error(parsed.error);
      const restored = Simulation.fromSnapshot(parsed.snap);
      expect(restored.state.runMode).toBe('assault');
      expect(restored.state.bunkers).toHaveLength(sector + 2);
      expect(restored.state.units.filter((unit) => unit.team === 'enemy').map((unit) => unit.role)).toEqual(defenders.map((unit) => unit.role));
      sim.state.units = sim.state.units.filter((unit) => unit.team === 'friendly');
      sim.step();
      expect(sim.state.scheduler.phase).toBe('advance');
      expect(sim.state.sectorCaptured).toBe(false);
      occupy(sim);
      for (let tick = 0; tick < operationSector(sim.state).holdSeconds * CONFIG.tickRate; tick++) sim.step();
      expect(sim.state.sectorCaptured).toBe(true);
      march(sim);
      if (sim.state.sectorSupplyPending) expect(sim.claimSectorSupply('points').ok).toBe(true);
    }
    expect(sim.state.phase).toBe('victory');
  });
  it('requires capture after the first two defenses and wins after the final extraction', () => {
    const sim = operation();
    const originalIds = sim.state.units.map((unit) => unit.id);
    for (let sector = 0; sector < 3; sector++) {
      expect(sim.state.mapsCleared).toBe(sector);
      clearLastWave(sim);
      expect(sim.state.scheduler.phase).toBe('advance');
      const hold = operationSector(sim.state).holdSeconds;
      expect(sim.state.sectorCaptured).toBe(hold === 0);
      if (hold) {
        occupy(sim);
        for (let tick = 0; tick < hold * CONFIG.tickRate - 1; tick++) sim.step();
        expect(sim.state.sectorCaptured).toBe(false);
        sim.step(); expect(sim.state.sectorCaptured).toBe(true);
      }
      march(sim);
      expect(sim.state.mapsCleared).toBe(sector + 1);
      expect(sim.state.units.map((unit) => unit.id)).toEqual(originalIds);
      expect(sim.state.phase).toBe(sector === 2 ? 'victory' : 'running');
      if (sim.state.sectorSupplyPending) expect(sim.claimSectorSupply('points').ok).toBe(true);
    }
    expect(campaignGoal(sim.state)).toBe(3);
    expect(sim.continueEndless()).toBe(true);
  });

  it('saves capture progress beyond the old eight-second limit and resets it when vacated', () => {
    const sim = operation(); clearLastWave(sim); occupy(sim);
    for (let tick = 0; tick < 9 * CONFIG.tickRate; tick++) sim.step();
    const parsed = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in parsed) throw new Error(parsed.error);
    const restored = Simulation.fromSnapshot(parsed.snap);
    expect(restored.state.runMode).toBe('operation');
    expect(restored.state.captureTicks).toBe(9 * CONFIG.tickRate);
    expect(operationTarget(restored.state)).toEqual(operationTarget(sim.state));
    for (const unit of restored.state.units) { unit.pos = { x: 100, y: 600 }; unit.prevPos = { ...unit.pos }; }
    restored.step(); expect(restored.state.captureTicks).toBe(0);
    expect(restored.state.sectorCaptured).toBe(false);
  });

  it('does not award progress for an early evacuation and preserves legacy campaign length', () => {
    const sim = operation(); march(sim);
    expect(sim.state.mapsCleared).toBe(0);
    expect(sim.state.mapNumber).toBe(2);
    expect(sim.state.sectorSupplyPending).toBe(false);
    const legacy = new Simulation(11).snapshot();
    expect(campaignGoal(legacy)).toBe(CONFIG.crossing.campaignMaps);
    expect(validateSnapshot({ ...legacy, runMode: 'invalid' })).toHaveProperty('error');
    const explicitCampaign = validateSnapshot({ ...legacy, runMode: 'campaign' });
    if ('error' in explicitCampaign) throw new Error(explicitCampaign.error);
    expect(explicitCampaign.snap.runMode).toBe('campaign');
  });

  it('resets capture when the objective is contested', () => {
    const sim = operation(); clearLastWave(sim); occupy(sim);
    const soldier = sim.state.units[0]!; soldier.grenades = 0; soldier.reloadTimer = 100_000;
    sim.step(); expect(sim.state.captureTicks).toBeGreaterThan(0);
    const target = operationTarget(sim.state);
    sim.spawnEnemy('rifle', target);
    const enemy = sim.state.units.at(-1)!; enemy.grenades = 0; enemy.reloadTimer = 100_000;
    sim.step();
    expect(sim.state.captureTicks).toBe(0);
    expect(sim.state.sectorCaptured).toBe(false);
  });
});
