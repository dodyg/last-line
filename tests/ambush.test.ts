import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/content/config';
import { validateSnapshot } from '../src/persistence';
import { ambushShape, insideAmbushArc } from '../src/simulation/ambush';
import { hitChance } from '../src/simulation/combat';
import { dayNightAtTick } from '../src/simulation/daynight';
import { rngNext } from '../src/simulation/rng';
import { Simulation, sec } from '../src/simulation/simulation';
import { generateTerrain } from '../src/simulation/terrain';
import type { FriendlyRole, SimEvent, Vec2 } from '../src/simulation/types';

function fixture(role: FriendlyRole = 'rifleman') {
  const data = generateTerrain(2026, false, 2);
  data.terrain.blocked.fill(0); data.terrain.baseBlocked = new Uint8Array(data.terrain.blocked.length); data.kinds.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  const sim = new Simulation(2026, undefined, data, false);
  sim.state.units = []; sim.state.scheduler.prepTicksLeft = 100_000;
  sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
  const unit = sim.spawnFriendly(role, { x: 492, y: 612 });
  const aim = { x: 492, y: 492 };
  const arm = () => sim.command({ type: 'ambush', unitIds: [unit.id], aim, arcDegrees: 90 });
  const tick = (n: number) => Array.from({ length: n }, () => sim.step()).flat();
  const enemy = (pos: Vec2 = { x: 492, y: 540 }) => {
    sim.spawnEnemy('rifle', pos);
    const target = sim.state.units.at(-1)!;
    target.pinned = true; target.suppression = CONFIG.suppression.max; target.reloadTimer = 100_000;
    return target;
  };
  const shots = (events: SimEvent[]) => events.filter((event) => event.type === 'shot' && event.shooterId === unit.id);
  return { sim, unit, aim, arm, tick, enemy, shots };
}

describe('prepared ambush orders', () => {
  it('holds guns and grenades for three seconds, then springs on a visible enemy in the arc', () => {
    const { unit, arm, tick, enemy, shots } = fixture(); enemy(); enemy({ x: 510, y: 540 });
    expect(arm()).toEqual({ ok: true });
    expect(shots(tick(89))).toEqual([]); expect(unit.grenades).toBe(4);
    const events = tick(1);
    expect(events.filter((event) => event.type === 'ambushTriggered')).toHaveLength(1);
    expect(shots(events)).toHaveLength(1); expect(unit.grenades).toBe(4);
    expect(unit.ambush).toBeUndefined();
  });

  it('ignores visible flanking and distant enemies without retaining an old target outside the arc', () => {
    const { unit, arm, enemy, tick, shots } = fixture();
    const flank = enemy({ x: 612, y: 612 }); enemy({ x: 492, y: 400 }); unit.targetId = flank.id;
    arm(); expect(shots(tick(180))).toEqual([]); expect(unit.targetId).toBeNull();
    flank.pos = { x: 492, y: 540 };
    expect(shots(tick(1))).toHaveLength(1);
  });

  it('keeps holding through smoke and blocked sight, then fires when the lane clears', () => {
    const { sim, arm, tick, enemy, shots } = fixture(); enemy(); arm();
    sim.state.smokes.push({ id: sim.state.nextEntityId++, pos: { x: 492, y: 576 }, radius: 20, ticksRemaining: 1000 });
    expect(shots(tick(120))).toEqual([]);
    sim.state.smokes = [];
    const cell = Math.floor(576 / 24) * sim.state.terrain.cols + Math.floor(492 / 24);
    sim.state.terrain.blocked[cell] = 1;
    expect(shots(tick(30))).toEqual([]);
    sim.state.terrain.blocked[cell] = 0;
    expect(shots(tick(1))).toHaveLength(1);
  });

  it('does not trigger on a sound contact beyond night sighting range', () => {
    const { sim, unit, arm, enemy, tick, shots } = fixture();
    const weapon = sim.weaponOf(unit)!;
    const target = enemy({ x: 492, y: 612 - weapon.range * .85 });
    sim.state.dayNightStartTick = 0;
    sim.state.ticks = Array.from({ length: sec(CONFIG.dayNight.cycleSeconds) }, (_, i) => i).find((i) => dayNightAtTick(i, 0).night)!;
    expect(sim.state.ticks).toBeDefined();
    arm(); unit.ambush!.range = Math.min(CONFIG.ambush.maxRange, weapon.range); unit.ambush!.prepTicks = 0;
    unit.reloadTimer = 0;
    unit.nightContacts = [{ sourceId: target.id, kind: 'sound', pos: { ...target.pos }, height: 0,
      noticedTick: sim.state.ticks, expiresTick: sim.state.ticks + 60 }];
    expect(shots(tick(1))).toEqual([]); expect(unit.ambush!.triggered).toBe(false);
  });

  it('pauses preparation under pinning and while the game is paused', () => {
    const { sim, unit, arm, tick } = fixture(); arm(); tick(30);
    expect(unit.ambush!.prepTicks).toBe(60);
    unit.pinned = true; unit.suppression = CONFIG.suppression.max; tick(10); expect(unit.ambush!.prepTicks).toBe(60);
    sim.paused = true; tick(100); expect(unit.ambush!.prepTicks).toBe(60);
    sim.paused = false; unit.pinned = false; unit.suppression = 0; tick(60); expect(unit.ambush!.prepTicks).toBe(0);
  });

  it.each(['medic', 'mortarman', 'vehicle', 'enemy', 'dead', 'crossed', 'pinned', 'busy', 'climbing', 'upgrading', 'nan', 'bounds', 'near'] as const)('rejects %s orders atomically', (condition) => {
    const { sim, unit, aim, arm } = fixture();
    if (condition === 'medic') unit.role = 'medic';
    if (condition === 'mortarman') unit.role = 'mortarman';
    if (condition === 'vehicle') unit.role = 'gun_truck';
    if (condition === 'enemy') unit.team = 'enemy';
    if (condition === 'dead') unit.dead = true;
    if (condition === 'crossed') unit.crossed = true;
    if (condition === 'pinned') unit.pinned = true;
    if (condition === 'busy') sim.state.constructionSites.push({ id: 999, kind: 'trench', pos: aim, builderId: unit.id, ticksRemaining: 1, totalTicks: 1 });
    if (condition === 'climbing') unit.buildingOrder = { buildingId: 999, level: 0, slot: 0, climbTicks: 5 };
    if (condition === 'upgrading') unit.upgradeTimer = 30;
    if (condition === 'nan') aim.x = NaN;
    if (condition === 'bounds') aim.y = -1;
    if (condition === 'near') Object.assign(aim, unit.pos);
    const before = sim.snapshot(); expect(arm().ok).toBe(false); expect(sim.snapshot()).toEqual(before);
  });

  it('chooses per-soldier facing and range for a group, clamps to weapon reach, and rejects unsupported arcs', () => {
    const { sim, unit, aim } = fixture();
    const sniper = sim.spawnFriendly('sniper', { x: 612, y: 612 });
    expect(sim.command({ type: 'ambush', unitIds: [unit.id, sniper.id, unit.id], aim, arcDegrees: 45 }).ok).toBe(true);
    expect(unit.ambush!.facing).toBeCloseTo(-Math.PI / 2); expect(unit.ambush!.range).toBe(120);
    expect(sniper.ambush!.facing).toBeCloseTo(-Math.PI * .75); expect(sniper.ambush!.range).toBeCloseTo(Math.hypot(120, 120));
    expect(sim.command({ type: 'ambush', unitIds: [unit.id], aim, arcDegrees: 360 }).ok).toBe(false);
    expect(ambushShape(unit.pos, { x: 492, y: 0 }, 120, 90).range).toBe(120);
    expect(ambushShape(unit.pos, { x: 492, y: 0 }, 900, 90).range).toBe(CONFIG.ambush.maxRange);
    expect(ambushShape(unit.pos, { x: 502, y: 612 }, 900, 90).range).toBe(CONFIG.ambush.minRange);
    expect(insideAmbushArc(unit.pos, unit.ambush!, aim)).toBe(true);
  });

  it('makes a shot hit that the same random roll misses without the opening accuracy bonus', () => {
    const a = fixture(), b = fixture(); const targetA = a.enemy(a.aim), targetB = b.enemy(b.aim);
    // Keep the roll calculation focused on the ambush bonus alone.
    delete a.unit.attributes; delete b.unit.attributes;
    targetA.suppression = targetB.suppression = 0; a.unit.reloadTimer = b.unit.reloadTimer = 0;
    const weapon = a.sim.weaponOf(a.unit)!;
    const context = { weapon, distance: 120, attackerXp: 0, attackerAccuracySkill: a.unit.accuracySkill,
      attackerMorale: a.unit.morale, attackerSuppression: 0, targetInCover: false, config: CONFIG };
    const base = hitChance(context), bonus = hitChance({ ...context, attackerPositionAccuracyMult: CONFIG.ambush.accuracyMult });
    const seed = Array.from({ length: 5000 }, (_, i) => i + 1).find((i) => { const roll = rngNext({ s: i }); return roll > base && roll < bonus; })!;
    expect(seed).toBeDefined(); a.sim.state.rng.s = b.sim.state.rng.s = seed;
    a.arm(); a.unit.ambush!.prepTicks = 0;
    expect(a.sim.fireShot(a.unit, targetA, weapon)).toBe(true); expect(b.sim.fireShot(b.unit, targetB, weapon)).toBe(true);
    expect(targetA.health).toBeLessThan(70); expect(targetB.health).toBe(70);
  });

  it('doubles opening suppression, then returns subsequent shots to normal', () => {
    const a = fixture(), b = fixture(); const ta = a.enemy(), tb = b.enemy();
    ta.suppression = tb.suppression = 0; a.unit.reloadTimer = b.unit.reloadTimer = 0;
    // The same high roll misses both shots, isolating the suppression multiplier.
    const seed = Array.from({ length: 5000 }, (_, i) => i + 1).find((i) => rngNext({ s: i }) > .95)!;
    a.sim.state.rng.s = b.sim.state.rng.s = seed;
    a.arm(); a.unit.ambush!.prepTicks = 0;
    a.sim.fireShot(a.unit, ta, a.sim.weaponOf(a.unit)!); b.sim.fireShot(b.unit, tb, b.sim.weaponOf(b.unit)!);
    expect(ta.suppression).toBeCloseTo(tb.suppression * CONFIG.ambush.suppressionMult);
    expect(a.unit.ambush).toBeUndefined();
    ta.suppression = tb.suppression = 0; a.sim.state.rng.s = b.sim.state.rng.s = seed;
    a.sim.fireShot(a.unit, ta, a.sim.weaponOf(a.unit)!); b.sim.fireShot(b.unit, tb, b.sim.weaponOf(b.unit)!);
    expect(ta.suppression).toBeCloseTo(tb.suppression);
  });

  it('limits a BAR opening bonus to its first burst and breaks the bonus if pinned', () => {
    const { sim, unit, arm, enemy, tick, shots } = fixture('mg'); const target = enemy(); target.health = 1000;
    arm(); const first = tick(90); expect(shots(first)).toHaveLength(1);
    expect(unit.ambush!.bonusShots).toBe(sim.weaponOf(unit)!.burstShots - 1);
    const rest = tick(sim.weaponOf(unit)!.shotIntervalTicks * (sim.weaponOf(unit)!.burstShots - 1));
    expect(shots(rest)).toHaveLength(sim.weaponOf(unit)!.burstShots - 1); expect(unit.ambush).toBeUndefined();
    arm(); unit.reloadTimer = 0; tick(90); expect(unit.ambush?.triggered).toBe(true);
    unit.pinned = true; unit.suppression = CONFIG.suppression.max; tick(1); expect(unit.ambush).toBeUndefined();
  });

  it.each(['move', 'fire order', 'patrol', 'cancel'] as const)('cancels on %s and requires preparation when rearmed', (command) => {
    const { sim, unit, arm, tick } = fixture(); arm(); tick(90);
    if (command === 'move') expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 612, y: 612 } }).ok).toBe(true);
    if (command === 'fire order') expect(sim.command({ type: 'fireOrder', unitIds: [unit.id], order: 'antiArmor' }).ok).toBe(true);
    if (command === 'patrol') expect(sim.command({ type: 'patrol', unitIds: [unit.id], from: { x: 400, y: 500 }, to: { x: 600, y: 650 } }).ok).toBe(true);
    if (command === 'cancel') expect(sim.command({ type: 'cancelAmbush', unitIds: [unit.id] }).ok).toBe(true);
    expect(unit.ambush).toBeUndefined(); arm(); expect(unit.ambush!.prepTicks).toBe(90);
  });

  it('does not spend rockets, draw randomness, or fire through smoke while an anti-tank ambush waits', () => {
    const { sim, unit, arm, enemy } = fixture('at'); const target = enemy(); arm(); unit.reloadTimer = 0;
    const before = sim.snapshot(); expect(sim.fireShot(unit, target, sim.weaponOf(unit)!)).toBe(false);
    expect(sim.snapshot()).toEqual(before);
    unit.ambush!.prepTicks = 0;
    sim.state.smokes.push({ id: sim.state.nextEntityId++, pos: { x: 492, y: 576 }, radius: 24, ticksRemaining: 240 });
    expect(sim.fireShot(unit, target, sim.weaponOf(unit)!)).toBe(false); expect(unit.rockets).toBe(4);
  });

  it('does not bank an unfinished opening bonus when no targets remain', () => {
    const { unit, arm, enemy, tick } = fixture('mg');
    const target = enemy(); arm(); tick(90);
    expect(unit.ambush?.triggered).toBe(true);
    target.health = 0; target.dead = true; tick(1);
    expect(unit.ambush).toBeUndefined();
  });

  it('detaches saved preparation and opening-burst state and resumes deterministically', () => {
    const { sim, unit, arm, tick, enemy } = fixture('mg'); arm(); tick(45);
    const partial = validateSnapshot(sim.snapshot()); if ('error' in partial) throw new Error(partial.error);
    const restored = Simulation.fromSnapshot(partial.snap); expect(restored.state.units[0]!.ambush!.prepTicks).toBe(45);
    tick(45); enemy(); tick(1);
    const burst = validateSnapshot(sim.snapshot()); if ('error' in burst) throw new Error(burst.error);
    expect(unit.ambush?.triggered).toBe(true);
    const a = Simulation.fromSnapshot(burst.snap), b = Simulation.fromSnapshot(JSON.parse(JSON.stringify(burst.snap)));
    for (let i = 0; i < 90; i++) expect(a.step()).toEqual(b.step());
    expect(a.snapshot()).toEqual(b.snapshot()); expect(partial.snap.units[0]!.ambush!.prepTicks).toBe(45);
  });

  it('migrates v29 without ambushes and rejects corrupt arcs, timers, bonuses, and unsupported roles', () => {
    const { sim, unit, arm } = fixture(); const old = sim.snapshot(); old.schemaVersion = 29;
    const migrated = validateSnapshot(old); if ('error' in migrated) throw new Error(migrated.error);
    expect(migrated.snap.schemaVersion).toBe(30); expect(migrated.snap.units[0]!.ambush).toBeUndefined();
    arm();
    for (const change of [{ facing: NaN }, { facing: 4 }, { range: 361 }, { range: 0 }, { arcDegrees: 360 }, { prepTicks: 91 }, { prepTicks: .5 }, { bonusShots: 1 }, { triggered: true }]) {
      const bad = sim.snapshot(); Object.assign(bad.units[0]!.ambush!, change);
      expect('error' in validateSnapshot(bad), JSON.stringify(change)).toBe(true);
    }
    unit.role = 'medic'; expect('error' in validateSnapshot(sim.snapshot())).toBe(true);
  });

  it('clears the old firing position when marching to the next map', () => {
    const { sim, unit, arm, tick } = fixture(); arm(); unit.pos.y = CONFIG.crossing.thresholdY; tick(1);
    expect(sim.state.mapNumber).toBe(2); expect(unit.ambush).toBeUndefined();
  });
});
