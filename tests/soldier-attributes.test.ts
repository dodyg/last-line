import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { updateStamina } from '../src/simulation/movement';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import { generateSoldierAttributes, SOLDIER_ATTRIBUTES, soldierAttributeMultiplier, trainSoldierAttributes } from '../src/simulation/soldiers';

function openField() {
  const data = generateTerrain(42, false, 2);
  data.kinds.fill(0); data.terrain.blocked.fill(0);
  data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.terrain.elevation = undefined;
  data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(42, undefined, data, false);
  const unit = sim.state.units[0]!;
  sim.state.units = [unit]; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  unit.pos = { x: 132, y: 132 }; unit.prevPos = { ...unit.pos };
  unit.grenades = 0; unit.reloadTimer = 100_000;
  return { sim, unit };
}

describe('individual soldier attributes', () => {
  function clearWave(sim: Simulation) {
    sim.state.scheduler.phase = 'active';
    sim.state.scheduler.rewardGranted = false;
    expect(sim.step().some((event) => event.type === 'waveCleared')).toBe(true);
  }

  it('improves all attributes slowly over cleared waves, even after the XP rank cap', () => {
    const { sim, unit } = openField();
    unit.xp = 100;
    const original = { ...unit.attributes! };
    clearWave(sim);
    clearWave(sim);
    expect(unit.attributes).toEqual(original);
    expect(unit.attributeTrainingWaves).toBe(2);
    // Waiting between attacks cannot award more training.
    for (let tick = 0; tick < 10; tick++) sim.step();
    expect(unit.attributeTrainingWaves).toBe(2);
    clearWave(sim);
    for (const { key } of SOLDIER_ATTRIBUTES) expect(unit.attributes![key]).toBe(original[key] + 1);
    expect(unit.attributeTrainingWaves).toBe(0);
    for (let wave = 0; wave < 3; wave++) clearWave(sim);
    for (const { key } of SOLDIER_ATTRIBUTES) expect(unit.attributes![key]).toBe(original[key] + 2);
  });

  it('trains support infantry, excludes casualties, enemies, vehicles and evacuated soldiers, and caps ratings', () => {
    const base = openField().unit;
    for (const role of ['medic', 'engineer', 'supply_officer', 'rifleman'] as const) {
      const unit = structuredClone(base);
      unit.role = role;
      unit.attributeTrainingWaves = 2;
      for (const { key } of SOLDIER_ATTRIBUTES) unit.attributes![key] = key === 'strength' ? 100 : 99;
      trainSoldierAttributes(unit);
      for (const rating of Object.values(unit.attributes!)) expect(rating).toBe(100);
    }
    for (const overrides of [{ dead: true }, { health: 0 }, { crossed: true }, { team: 'enemy' }, { role: 'gun_truck' }, { role: 'vehicle' }, { role: 'troop_transport' }] as const) {
      const unit = { ...structuredClone(base), ...overrides };
      const before = structuredClone(unit);
      trainSoldierAttributes(unit);
      expect(unit).toEqual(before);
    }
  });

  it('preserves partial training through save/Continue and the next campaign map', () => {
    const sim = new Simulation(2026);
    const original = { ...sim.state.units[0]!.attributes! };
    clearWave(sim); clearWave(sim);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const restored = Simulation.fromSnapshot(checked.snap);
    expect(restored.state.units[0]!.attributeTrainingWaves).toBe(2);
    restored.state.sectorCaptured = true;
    for (const unit of restored.state.units) {
      unit.pos.y = CONFIG.crossing.thresholdY;
      unit.prevPos = { ...unit.pos }; unit.path = [];
    }
    for (let tick = 0; tick < 200 && restored.state.mapNumber === 1; tick++) restored.step();
    expect(restored.state.mapNumber).toBe(2);
    expect(restored.state.units[0]!.attributeTrainingWaves).toBe(2);
    clearWave(restored);
    for (const { key } of SOLDIER_ATTRIBUTES) expect(restored.state.units[0]!.attributes![key]).toBe(original[key] + 1);
    const grown = validateSnapshot(JSON.parse(JSON.stringify(restored.snapshot())));
    if ('error' in grown) throw new Error(grown.error);
    expect(Simulation.fromSnapshot(grown.snap).state.units[0]!.attributes).toEqual(restored.state.units[0]!.attributes);
  });

  it('starts legacy training at zero without rerolling attributes and rejects corrupt training progress', () => {
    const { sim, unit } = openField();
    delete unit.attributes;
    clearWave(sim); clearWave(sim);
    expect(unit.attributes).toBeUndefined();
    clearWave(sim);
    for (const rating of Object.values(unit.attributes!)) expect(rating).toBe(51);
    for (const bad of [-1, 3, 0.5, null, '2', NaN, Infinity]) {
      const snapshot = sim.snapshot();
      (snapshot.units[0] as unknown as Record<string, unknown>).attributeTrainingWaves = bad;
      expect(validateSnapshot(snapshot)).toHaveProperty('error');
    }
  });

  it('rolls a separate profile whenever a new soldier is issued', () => {
    const { sim } = openField();
    sim.state.points = 100;
    const original = structuredClone(sim.state.units[0]!.attributes);
    const recruits = [];
    for (let index = 0; index < 4; index++) {
      expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 300 + index * 60, y: 660 } }).ok).toBe(true);
      recruits.push(sim.state.units.at(-1)!);
    }
    expect(new Set(recruits.map((unit) => JSON.stringify(unit.attributes))).size).toBe(4);
    for (const unit of recruits) {
      expect(Object.keys(unit.attributes!)).toHaveLength(SOLDIER_ATTRIBUTES.length);
      for (const rating of Object.values(unit.attributes!)) expect(rating >= 25 && rating <= 75 && Number.isInteger(rating)).toBe(true);
    }
    expect(sim.state.units[0]!.attributes).toEqual(original);
    expect(recruits[0]!.attributes).not.toBe(recruits[1]!.attributes);
  });

  it('keeps issued ratings on load and rolls the next recruit consistently after resuming', () => {
    const { sim } = openField();
    sim.state.points = 100;
    const order = { type: 'recruit', role: 'rifleman', pos: { x: 400, y: 660 } } as const;
    expect(sim.command(order).ok).toBe(true);
    const issued = structuredClone(sim.state.units.at(-1)!.attributes);
    const checked = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in checked) throw new Error(checked.error);
    const resumed = Simulation.fromSnapshot(checked.snap);
    expect(resumed.state.units.at(-1)!.attributes).toEqual(issued);
    for (const run of [sim, resumed]) expect(run.command(order).ok).toBe(true);
    expect(resumed.state.units.at(-1)!.attributes).toEqual(sim.state.units.at(-1)!.attributes);
    expect(resumed.state.units.at(-1)!.attributes).not.toEqual(issued);
  });

  it('moves faster and recovers suppression faster with higher speed and resolve', () => {
    const low = openField(), high = openField();
    for (const [fixture, rating] of [[low, 1], [high, 100]] as const) {
      fixture.unit.attributes!.speed = rating; fixture.unit.attributes!.resolve = rating;
      fixture.unit.path = [{ x: 232, y: 132 }]; fixture.unit.moveGoal = { x: 232, y: 132 };
      fixture.sim.step();
    }
    expect(high.unit.pos.x).toBeGreaterThan(low.unit.pos.x);
    low.unit.suppression = high.unit.suppression = 20;
    low.sim.step(); high.sim.step();
    expect(high.unit.suppression).toBeLessThan(low.unit.suppression);
  });

  it('conceals stealthy infantry near the detection limit until they are revealed', () => {
    const { sim, unit } = openField();
    sim.spawnEnemy('rifle', { x: 392, y: 132 });
    const enemy = sim.state.units.at(-1)!;
    enemy.reloadTimer = 100_000; enemy.pinned = true; enemy.suppression = 100;
    enemy.attributes!.stealth = 1;
    sim.step(); expect(unit.targetId).toBe(enemy.id);
    enemy.attributes!.stealth = 100;
    sim.step(); expect(unit.targetId).toBeNull();
    enemy.revealedUntil = sim.state.ticks + 100;
    sim.step(); expect(unit.targetId).toBe(enemy.id);
  });

  it('makes better marksmen land more hits with the same role, training, and random sequence', () => {
    const trial = (rating: number) => {
      const { sim, unit } = openField();
      unit.attributes!.marksmanship = rating;
      sim.spawnEnemy('rifle', { x: 252, y: 132 });
      const target = sim.state.units.at(-1)!;
      target.health = 100_000;
      target.attributes!.stealth = 50;
      for (let shot = 0; shot < 300; shot++) sim.fireShot(unit, target, sim.weaponOf(unit)!);
      return 100_000 - target.health;
    };
    expect(trial(100)).toBeGreaterThan(trial(1));
  });

  it('assigns varied, reproducible profiles without consuming combat randomness', () => {
    const sim = new Simulation(42);
    const rng = { ...sim.state.rng };
    const profiles = sim.state.units.map((u) => generateSoldierAttributes(42, u.id));
    expect(profiles).toEqual(sim.state.units.map((u) => u.attributes));
    expect(new Set(profiles.map((p) => JSON.stringify(p))).size).toBe(profiles.length);
    expect(sim.state.rng).toEqual(rng);
    for (let id = 1; id <= 100; id++) for (const value of Object.values(generateSoldierAttributes(42, id))) {
      expect(Number.isInteger(value) && value >= 25 && value <= 75).toBe(true);
    }
  });

  it('preserves profiles and deterministic outcomes through a detached save', () => {
    const sim = new Simulation(42);
    const snapshot = sim.snapshot();
    const validated = validateSnapshot(JSON.parse(JSON.stringify(snapshot)));
    if ('error' in validated) throw new Error(validated.error);
    const restored = Simulation.fromSnapshot(validated.snap);
    for (let tick = 0; tick < 90; tick++) { sim.step(); restored.step(); }
    expect(restored.snapshot()).toEqual(sim.snapshot());
    restored.state.units[0]!.attributes!.strength = 100;
    expect(snapshot.units[0]!.attributes!.strength).not.toBe(100);
  });

  it('keeps legacy soldiers neutral and rejects malformed ratings', () => {
    const legacy = new Simulation(42).snapshot();
    legacy.units.forEach((u) => { delete u.attributes; });
    const result = validateSnapshot(legacy);
    if ('error' in result) throw new Error(result.error);
    const unit = Simulation.fromSnapshot(result.snap).state.units[0]!;
    for (const { key } of SOLDIER_ATTRIBUTES) expect(soldierAttributeMultiplier(unit, key)).toBe(1);
    for (const bad of [null, [], {}, { strength: 50 }, ...[-1, 0, 101, 50.5, NaN, Infinity, '50'].map((strength) => ({ ...generateSoldierAttributes(42, 1), strength }))]) {
      const snapshot = new Simulation(42).snapshot();
      (snapshot.units[0] as unknown as Record<string, unknown>).attributes = bad;
      expect(validateSnapshot(snapshot)).toHaveProperty('error');
    }
  });

  it('lets agile infantry reload faster without changing vehicle performance', () => {
    const sim = new Simulation(42);
    const unit = sim.state.units[0]!;
    const weapon = sim.weaponOf(unit)!;
    unit.attributes!.agility = 1;
    const slow = sim.reloadTicksFor(unit, weapon);
    unit.attributes!.agility = 100;
    expect(sim.reloadTicksFor(unit, weapon)).toBeLessThan(slow);
    unit.role = 'gun_truck';
    for (const { key } of SOLDIER_ATTRIBUTES) expect(soldierAttributeMultiplier(unit, key)).toBe(1);
  });

  it('uses endurance for running duration and strength for stamina recovery', () => {
    const base = new Simulation(42).state.units[0]!;
    const low = structuredClone(base), high = structuredClone(base);
    low.attributes!.endurance = 1; high.attributes!.endurance = 100;
    for (const unit of [low, high]) {
      unit.running = true; unit.path = [{ x: unit.pos.x + 100, y: unit.pos.y }];
      unit.prevPos = { x: unit.pos.x - 1, y: unit.pos.y };
      updateStamina(unit);
    }
    expect(high.stamina!).toBeGreaterThan(low.stamina!);
    low.attributes!.strength = 1; high.attributes!.strength = 100;
    for (const unit of [low, high]) {
      unit.running = false; unit.stamina = .5; unit.prevPos = { ...unit.pos };
      updateStamina(unit);
    }
    expect(high.stamina!).toBeGreaterThan(low.stamina!);
  });
});
