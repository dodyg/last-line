import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { Simulation } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';

function fixture(enemy = false) {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length);
  data.kinds.fill(0); data.buildings = []; data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  let unit = sim.state.units[0]!;
  sim.state.units = [unit];
  if (enemy) { sim.spawnEnemy('rifle', { x: 36, y: 600 }); unit = sim.state.units.at(-1)!; sim.state.units = [unit]; }
  unit.pos = { x: 36, y: 600 }; unit.prevPos = { ...unit.pos };
  unit.grenades = 0; unit.reloadTimer = 100_000; unit.buildingCooldown = 100_000; unit.morale = 100;
  sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const move = () => { unit.path = [{ x: 924, y: 600 }]; unit.moveGoal = { x: 924, y: 600 }; };
  const run = () => sim.command({ type: 'pace', unitIds: [unit.id], pace: 'run' });
  const tick = (n: number) => { for (let i = 0; i < n; i++) sim.step(); };
  return { sim, unit, move, run, tick, data };
}

describe('walking and limited running', () => {
  it.each([false, true])('normally walks at the reduced role speed without spending stamina, enemy=%s', (enemy) => {
    const { sim, unit, move, tick } = fixture(enemy);
    move(); tick(CONFIG.tickRate);
    expect(unit.running).toBe(false);
    expect(unit.movementPace).toBe('walk');
    expect(unit.stamina).toBe(1);
    const speed = enemy ? sim.content.enemy.rifle.speed : sim.content.friendly.rifleman.speed;
    expect(unit.pos.x - 36).toBeCloseTo(speed * CONFIG.infantryMovement.walkSpeedMult);
  });

  it('runs distinctly faster than walking and spends only actual running time', () => {
    const walking = fixture(), running = fixture();
    expect(running.run().ok).toBe(true);
    running.tick(30); // A queued run at rest does not consume endurance.
    expect(running.unit.stamina).toBe(1);
    expect(running.unit.running).toBe(false);
    walking.move(); running.move(); walking.tick(30); running.tick(30);
    expect((running.unit.pos.x - 36) / (walking.unit.pos.x - 36)).toBeCloseTo(CONFIG.infantryMovement.runSpeedMult);
    expect(running.unit.running).toBe(true);
    expect(running.unit.stamina).toBeCloseTo(1 - 1 / CONFIG.infantryMovement.runSeconds);
  });

  it('exhausts after eight seconds, then keeps walking as stamina recovers', () => {
    const { unit, move, run, tick } = fixture();
    move(); run(); tick(CONFIG.infantryMovement.runSeconds * CONFIG.tickRate);
    expect(unit.stamina).toBe(0);
    expect(unit.running).toBe(false); expect(unit.movementPace).toBe('walk');
    const before = unit.pos.x;
    tick(60);
    expect(unit.pos.x).toBeGreaterThan(before);
    expect(unit.running).toBe(false); expect(unit.movementPace).toBe('walk');
    expect(unit.stamina).toBeCloseTo(2 / CONFIG.infantryMovement.walkingRecoverySeconds);
  });

  it('recovers faster at rest and needs a minimum reserve before another run', () => {
    const walking = fixture(), resting = fixture();
    walking.unit.stamina = resting.unit.stamina = 0;
    expect(walking.run().ok).toBe(false);
    walking.move(); walking.tick(60); resting.tick(60);
    expect(walking.unit.stamina).toBeCloseTo(2 / CONFIG.infantryMovement.walkingRecoverySeconds);
    expect(resting.unit.stamina).toBeCloseTo(2 / CONFIG.infantryMovement.restingRecoverySeconds);
    expect(walking.run().ok).toBe(false);
    resting.tick(30); expect(resting.run().ok).toBe(true);
  });

  it('returns to walking on arrival and on a manual walk order', () => {
    const { sim, unit, move, run, tick } = fixture();
    unit.path = [{ x: 40, y: 600 }]; unit.moveGoal = { x: 40, y: 600 };
    run(); tick(8); expect(unit.path).toEqual([]); expect(unit.movementPace).toBe('walk');
    move(); run(); tick(1); expect(unit.running).toBe(true);
    expect(sim.command({ type: 'pace', unitIds: [unit.id], pace: 'walk' }).ok).toBe(true);
    tick(1); expect(unit.running).toBe(false);
  });

  it('runs upright, cancels on lower posture or pinning, and respects steep ground', () => {
    const { sim, unit, move, run, tick } = fixture();
    unit.stance = 'prone'; unit.crawling = true;
    run(); expect(unit.stance).toBe('standing'); expect(unit.crawling).toBe(false);
    move(); tick(1); expect(unit.running).toBe(true);
    sim.command({ type: 'posture', unitIds: [unit.id], stance: 'crouching', crawling: false });
    tick(1); expect(unit.movementPace).toBe('walk'); expect(unit.running).toBe(false);
    run(); unit.suppression = CONFIG.suppression.max;
    const pinnedAt = { ...unit.pos }; tick(1);
    expect(unit.pinned).toBe(true); expect(unit.pos).toEqual(pinnedAt);
    expect(unit.movementPace).toBe('walk'); expect(run().ok).toBe(false);
    unit.pinned = false; unit.suppression = 0; unit.stance = 'standing'; unit.crawling = false;
    sim.state.terrain.elevation = { cell: 12, cols: 81, rows: 61, heights: Float32Array.from({ length: 81 * 61 }, (_, i) => i % 81 * 12 * .75) };
    unit.terrainCrawling = false; run(); tick(1);
    expect(unit.terrainCrawling).toBe(true); expect(unit.running).toBe(false);
    expect(run().ok).toBe(false);
  });

  it('changes only eligible group members and never applies running to vehicles', () => {
    const { sim, unit, run } = fixture();
    const pinned = structuredClone(unit); pinned.id = sim.state.nextEntityId++; pinned.pinned = true;
    const truck = structuredClone(unit); truck.id = sim.state.nextEntityId++; truck.role = 'gun_truck';
    sim.state.units.push(pinned, truck);
    expect(sim.command({ type: 'pace', unitIds: [unit.id, pinned.id, truck.id], pace: 'run' }).ok).toBe(true);
    expect(unit.movementPace).toBe('run'); expect(pinned.movementPace).toBe('walk'); expect(truck.movementPace).toBe('walk');
    unit.role = 'gun_truck'; expect(run().ok).toBe(false);
  });

  it('keeps vehicle travel speed unchanged', () => {
    const { sim, unit, move, tick } = fixture();
    unit.role = 'gun_truck';
    move(); tick(CONFIG.tickRate);
    expect(unit.pos.x - 36).toBeCloseTo(sim.content.friendly.gun_truck.speed);
  });

  it.each([
    { enemy: false, surface: 'dirt' as const },
    { enemy: false, surface: 'cobble' as const },
    { enemy: true, surface: 'dirt' as const },
    { enemy: true, surface: 'cobble' as const },
  ])('drives trucks twice as fast on $surface roads and returns to normal speed off road, enemy=$enemy', ({ enemy, surface }) => {
    const { sim, unit, move, tick, data } = fixture(enemy);
    unit.role = 'gun_truck';
    data.zones.roads = [{ points: [{ x: 0, y: 600 }, { x: 960, y: 600 }], halfWidth: 10, surface }];
    const baseSpeed = enemy ? sim.content.enemy.gun_truck.speed : sim.content.friendly.gun_truck.speed;
    move(); tick(CONFIG.tickRate);
    expect(unit.pos.x - 36).toBeCloseTo(baseSpeed * 2);
    expect(sim.terrainEffectsFor(unit).speedMult).toBe(2);
    data.zones.roads = [];
    const before = unit.pos.x;
    tick(CONFIG.tickRate);
    expect(unit.pos.x - before).toBeCloseTo(baseSpeed);
    expect(sim.terrainEffectsFor(unit).speedMult).toBe(1);
  });

  it('retains the ordinary road bonus for infantry', () => {
    const { sim, unit, move, tick, data } = fixture();
    data.zones.roads = [{ points: [{ x: 0, y: 600 }, { x: 960, y: 600 }], halfWidth: 10, surface: 'dirt' }];
    move(); tick(CONFIG.tickRate);
    expect(unit.pos.x - 36).toBeCloseTo(sim.content.friendly.rifleman.speed * CONFIG.infantryMovement.walkSpeedMult * 1.1);
  });

  it('restores an interrupted order only after a real shell dodge, including through save/restore', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    sim.state.units = [unit]; sim.state.scheduler.prepTicksLeft = 100_000;
    sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
    unit.pos = { x: 360, y: 600 }; unit.prevPos = { ...unit.pos }; unit.grenades = 0;
    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 900, y: 600 } }).ok).toBe(true);
    const goal = { ...unit.moveGoal! };
    sim.state.strikes = [{ id: sim.state.nextEntityId++, pos: { ...unit.pos }, landTick: 30,
      radius: 42, damage: 0, suppressionAmount: 0, source: 'enemy', delivery: 'artillery' }];
    for (let i = 0; i < 5; i++) sim.step();
    expect(unit.dodgingStrike).toBe(true);
    const parsed = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in parsed) throw new Error(parsed.error);
    const restored = Simulation.fromSnapshot(parsed.snap);
    expect(restored.state.units[0]!.dodgingStrike).toBe(true);
    for (let i = 0; i < 40; i++) expect(restored.step()).toEqual(sim.step());
    expect(unit.dodgingStrike).toBeUndefined(); expect(unit.moveGoal).toEqual(goal);
    expect(unit.path.at(-1)).toEqual(goal);
    expect(restored.snapshot()).toEqual(sim.snapshot());
  });

  it('lets a fresh player move replace a shell detour', () => {
    const { sim, unit } = fixture();
    unit.dodgingStrike = true; unit.path = [{ x: 36, y: 500 }];
    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 500, y: 600 } }).ok).toBe(true);
    expect(unit.dodgingStrike).toBeUndefined();
    expect(unit.path.at(-1)).toEqual(unit.moveGoal);
  });

  it.each([
    { enemy: false, delivery: 'artillery' as const, seconds: 1 },
    { enemy: false, delivery: 'mortar' as const, seconds: .6 },
    { enemy: true, delivery: 'artillery' as const, seconds: 1 },
    { enemy: true, delivery: 'mortar' as const, seconds: .6 },
  ])('waits until $seconds seconds before $delivery impact to evade, enemy=$enemy', ({ enemy, delivery, seconds }) => {
    const { sim, unit, move, tick } = fixture(enemy);
    const origin = { ...unit.pos };
    if (enemy) move();
    sim.state.strikes = [{ id: sim.state.nextEntityId++, pos: origin, landTick: 90,
      radius: 85, damage: 0, suppressionAmount: 0, source: enemy ? 'friendly' : 'enemy', delivery }];
    tick(90 - seconds * CONFIG.tickRate - 1);
    expect(unit.running).toBe(false);
    if (!enemy) { expect(unit.pos).toEqual(origin); expect(unit.path).toEqual([]); }
    const before = { ...unit.pos };
    tick(1);
    expect(unit.path.length).toBeGreaterThan(0);
    expect(unit.pos).not.toEqual(before);
    expect(unit.running).toBe(enemy);
  });

  it('limits enemy runs under fire and makes them walk while recovering', () => {
    const { sim, unit, move } = fixture(true);
    move();
    for (let tick = 0; tick < CONFIG.tickRate * CONFIG.infantryMovement.runSeconds; tick++) {
      unit.suppression = CONFIG.suppression.recoverThreshold + 1;
      sim.step();
    }
    expect(unit.stamina).toBe(0); expect(unit.movementPace).toBe('walk');
    const before = unit.pos.x;
    for (let tick = 0; tick < 30; tick++) { unit.suppression = CONFIG.suppression.recoverThreshold + 1; sim.step(); }
    expect(unit.pos.x).toBeGreaterThan(before); expect(unit.running).toBe(false);
    expect(unit.stamina).toBeGreaterThan(0);
  });

  it.each(['rifle', 'assault', 'observer'] as const)('keeps %s sprints within player rifleman speed and the same endurance budget', (role) => {
    const player = fixture(), enemy = fixture(true);
    enemy.unit.role = role;
    player.move(); enemy.move(); expect(player.run().ok).toBe(true);
    const tickBoth = (ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        // Keep the AI running under fire without pinning it or adding combatants.
        enemy.unit.suppression = CONFIG.suppression.recoverThreshold + 1;
        player.sim.step(); enemy.sim.step();
      }
    };
    tickBoth(CONFIG.tickRate);
    expect(player.unit.running).toBe(true); expect(enemy.unit.running).toBe(true);
    expect(enemy.unit.pos.x - 36).toBeLessThanOrEqual(player.unit.pos.x - 36 + 1e-9);
    expect(enemy.unit.stamina).toBeCloseTo(player.unit.stamina!);
    tickBoth((CONFIG.infantryMovement.runSeconds - 1) * CONFIG.tickRate);
    for (const { unit } of [player, enemy]) {
      expect(unit.stamina).toBe(0); expect(unit.running).toBe(false); expect(unit.movementPace).toBe('walk');
    }
    // Persistent danger cannot restart the AI's sprint before its reserve recovers.
    const recoveringSeconds = CONFIG.infantryMovement.walkingRecoverySeconds * CONFIG.infantryMovement.enemyRunStamina - 1;
    tickBoth(recoveringSeconds * CONFIG.tickRate);
    for (const { unit } of [player, enemy]) {
      expect(unit.running).toBe(false); expect(unit.movementPace).toBe('walk');
      expect(unit.stamina).toBeCloseTo(recoveringSeconds / CONFIG.infantryMovement.walkingRecoverySeconds);
    }
  });

  it('preserves remaining endurance and exhaustion through save/restore and accepts older saves', () => {
    const sim = new Simulation(2026), unit = sim.state.units[0]!;
    sim.state.units = [unit]; sim.state.scheduler.prepTicksLeft = 100_000;
    unit.pos = { x: 360, y: 600 }; unit.prevPos = { ...unit.pos };
    sim.command({ type: 'move', unitId: unit.id, pos: { x: 900, y: 600 } });
    sim.command({ type: 'pace', unitIds: [unit.id], pace: 'run' });
    for (let tick = 0; tick < 50; tick++) sim.step();
    const saved = validateSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    if ('error' in saved) throw new Error(saved.error);
    const resumed = Simulation.fromSnapshot(saved.snap);
    for (let tick = 0; tick < 250; tick++) expect(resumed.step()).toEqual(sim.step());
    expect(resumed.snapshot()).toEqual(sim.snapshot());
    const legacy = sim.snapshot();
    delete legacy.units[0]!.stamina; delete legacy.units[0]!.movementPace; delete legacy.units[0]!.running;
    const old = validateSnapshot(JSON.parse(JSON.stringify(legacy)));
    if ('error' in old) throw new Error(old.error);
    const restored = Simulation.fromSnapshot(old.snap); restored.step();
    expect(restored.state.units[0]!.stamina).toBe(1); expect(restored.state.units[0]!.running).toBe(false);
  });

  it.each([-1, 1.01, null, 'full'])('rejects corrupt stamina: %s', (value) => {
    const snap = JSON.parse(JSON.stringify(new Simulation(2026).snapshot()));
    snap.units[0].stamina = value;
    expect(validateSnapshot(snap)).toMatchObject({ error: 'Corrupt stamina.' });
  });
});
