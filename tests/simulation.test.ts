import { describe, expect, it } from 'vitest';
import { Simulation, mapTerrainSeed, sec } from '../src/simulation/simulation';
import { CONFIG } from '../src/content/config';
import { getContent } from '../src/content/validate';
import { applyDamageToUnit, engageDistance, hasDirectionalCover, hasTrenchCover, hitChance, targetIsValid, trenchBonusFor } from '../src/simulation/combat';
import { hasLineOfSight, foliageAlongLine, generateTerrain, isFoliageKind, isRiverAt, terrainEffectsAt, TERRAIN_KIND } from '../src/simulation/terrain';
import { findPath } from '../src/simulation/navigation';
import type { Building, SimEvent, SimSnapshot, Terrain, Unit, Vec2 } from '../src/simulation/types';

/** Isolated rule fixtures must not inherit seeded water, buildings or cover. */
function openField(seed: number): Simulation {
  const data = generateTerrain(seed, false, 2);
  data.kinds.fill(TERRAIN_KIND.open);
  data.terrain.blocked.fill(0);
  data.terrain.baseBlocked?.fill(0);
  data.zones = { river: null, bridges: [], rapids: [], mud: [] };
  data.terrain.bridges = [];
  return new Simulation(seed, undefined, data, false);
}

interface ScriptAction {
  tick: number;
  run(sim: Simulation): void;
}

/** Drive a run deterministically: actions fire just before their tick's step. */
function scriptedRun(seed: number, totalTicks: number, actions: ScriptAction[], batchSize = 1): Simulation {
  const sim = new Simulation(seed);
  let tick = 0;
  let actionIdx = 0;
  while (tick < totalTicks) {
    for (let b = 0; b < batchSize && tick < totalTicks; b++) {
      tick++;
      while (actionIdx < actions.length && actions[actionIdx]!.tick === tick) {
        actions[actionIdx]!.run(sim);
        actionIdx++;
      }
      sim.step();
    }
  }
  return sim;
}

const BASIC_ACTIONS: ScriptAction[] = [
  { tick: 5, run: (s) => void s.command({ type: 'recruit', role: 'mg', pos: { x: 480, y: 660 } }) },
  { tick: 30, run: (s) => void s.command({ type: 'move', unitId: 1, pos: { x: 300, y: 650 } }) },
  { tick: 60, run: (s) => void s.command({ type: 'sandbag', pos: { x: 480, y: 520 } }) },
];

describe('deterministic simulation', () => {
  it('produces identical state for the same seed and commands', () => {
    const a = scriptedRun(1234, 300, BASIC_ACTIONS);
    const b = scriptedRun(1234, 300, BASIC_ACTIONS);
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('is independent of frame-time batching for the same total ticks', () => {
    const single = scriptedRun(99, 240, BASIC_ACTIONS, 1);
    const chunked = scriptedRun(99, 240, BASIC_ACTIONS, 6);
    expect(single.snapshot()).toEqual(chunked.snapshot());
  });

  it('survives a JSON round-trip of the snapshot', () => {
    const sim = scriptedRun(1234, 120, BASIC_ACTIONS);
    const json = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    expect(Simulation.fromSnapshot(json).snapshot()).toEqual(sim.snapshot());
  });

  it('persists its rng in a canonical form that survives a reload', () => {
    // The rng is a uint32 held in a signed int32, so it is normally negative. If
    // the snapshot kept the signed value, a reloaded run would be behaviourally
    // identical yet never compare equal to the state it was saved from.
    for (const seed of [1, 2, 3, 71, 1234]) {
      const sim = scriptedRun(seed, 200, BASIC_ACTIONS);
      const snap = sim.snapshot();
      expect(snap.rng.s).toBeGreaterThanOrEqual(0);
      expect(snap.rng.s).toBeLessThanOrEqual(0xffffffff);
      const reloaded = Simulation.fromSnapshot(JSON.parse(JSON.stringify(snap)) as SimSnapshot);
      expect(reloaded.snapshot()).toEqual(snap);
      // And the restarted run stays in lockstep with the original.
      for (let i = 0; i < 120; i++) { sim.step(); reloaded.step(); }
      expect(reloaded.snapshot()).toEqual(sim.snapshot());
    }
  });

  it('accepts a caller-supplied battlefield and behaves identically', () => {
    // newRun() generates the terrain once and hands it over; the simulation must
    // use it rather than silently generating a second, divergent copy.
    const explicit = generateTerrain(4321);
    const supplied = new Simulation(4321, undefined, explicit);
    const selfGenerated = new Simulation(4321);
    expect(supplied.state.terrain.blocked).toBe(explicit.terrain.blocked);
    expect(supplied.state.terrain.blocked).toEqual(selfGenerated.state.terrain.blocked);
    expect(supplied.snapshot()).toEqual(selfGenerated.snapshot());
    for (let i = 0; i < 200; i++) { supplied.step(); selfGenerated.step(); }
    expect(supplied.snapshot()).toEqual(selfGenerated.snapshot());
  });
});

describe('enemy movement policy', () => {
  /**
   * One attacker on an open field facing an unarmed medic. A medic is used
   * deliberately: observers that can shoot would suppress the attacker and stop
   * it moving, which would mask the movement policy under test.
   */
  function arena(seed: number, role: 'rifle' | 'assault' | 'vehicle', enemyY = 60) {
    const sim = openField(seed);
    sim.state.points = 0;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000; // hold off wave spawning
    // Park every friendly in one cluster; a medic is unarmed, so it never
    // suppresses the attacker and the movement policy is measured cleanly.
    // The second observer sits just short of the breakthrough line, so an
    // attacker has to stop and fight it rather than stride past to its death.
    const units = sim.state.units.filter((u) => u.team === 'friendly');
    const spots = [{ x: 60, y: 690 }, { x: 480, y: 690 }, { x: 900, y: 690 }, { x: 40, y: 680 }];
    units.forEach((u, i) => { u.role = 'medic'; u.health = 1_000_000; u.pos = spots[i] ?? { x: 40, y: 680 }; });
    sim.spawnEnemy(role, { x: 480, y: enemyY });
    const enemy = sim.state.units[sim.state.units.length - 1]!;
    return { sim, enemy, observer: units[1]! };
  }

  it('closes to its intended engagement distance and opens fire there', () => {
    const { sim, enemy, observer } = arena(21, 'rifle');
    const weapon = getContent().weapons['enemy_rifle']!;
    const intended = engageDistance(weapon, 'rifle', CONFIG);
    // The whole point of the policy: tighter than the weapon's maximum reach.
    expect(intended).toBeLessThan(weapon.range);
    // A wall well south of the fallback walk keeps the attacker from simply
    // marching past the position it is meant to fight from, without disturbing
    // the straight-south fallback step.
    for (let col = 0; col < sim.state.terrain.cols; col++) {
      sim.state.terrain.blocked[32 * sim.state.terrain.cols + col] = 1;
    }

    let engagedAtTick = -1;
    let firstContactDistance = Infinity;
    let closestApproach = Infinity;
    let firedWhileStationary = false;
    let movedAfterContact = 0;
    let prevY = enemy.pos.y;
    for (let t = 1; t <= 30 * 200; t++) {
      const events = sim.step();
      const d = dist(enemy.pos, observer.pos);
      if (enemy.targetId !== null && engagedAtTick === -1) { engagedAtTick = t; firstContactDistance = d; }
      if (enemy.targetId !== null) {
        const moved = Math.abs(enemy.pos.y - prevY) > 0.01;
        if (moved) movedAfterContact++;
        else if (events.some((e) => e.type === 'shot' && e.shooterId === enemy.id)) firedWhileStationary = true;
      }
      closestApproach = Math.min(closestApproach, d);
      prevY = enemy.pos.y;
      if (enemy.dead) break;
    }
    expect(engagedAtTick).toBeGreaterThan(0); // it acquired a target
    expect(movedAfterContact).toBeGreaterThan(20); // and pressed on after contact
    // It keeps closing past the old freeze point instead of stopping at max range.
    expect(closestApproach).toBeLessThan(firstContactDistance);
    // It gets to its chosen distance rather than stalling short of it.
    expect(closestApproach).toBeLessThanOrEqual(intended + 6);
    // And it actually shoots from that position, not just walks through.
    expect(firedWhileStationary).toBe(true);
  });

  /**
   * Regression: an attacker used to bound only once it had already closed to its
   * engagement distance, so the whole approach was made in silence while the
   * defenders' longer-ranged rifles shot it to pieces. The great majority of Axis
   * infantry died without ever firing a round.
   */
  it('returns fire on contact instead of walking its approach in silence', () => {
    const { sim, enemy, observer } = arena(23, 'rifle');
    const weapon = getContent().weapons['enemy_rifle']!;
    const hold = engageDistance(weapon, 'rifle', CONFIG);
    let engagedTick = -1;
    let firstShotTick = -1;
    let shotsBeyondHold = 0;
    for (let t = 1; t <= 30 * 200; t++) {
      const events = sim.step();
      if (enemy.targetId !== null && engagedTick === -1) engagedTick = t;
      if (events.some((e) => e.type === 'shot' && e.shooterId === enemy.id)) {
        if (firstShotTick === -1) firstShotTick = t;
        if (dist(enemy.pos, observer.pos) > hold) shotsBeyondHold++;
      }
      if (enemy.dead) break;
    }
    expect(engagedTick).toBeGreaterThan(0); // it acquired a target at all
    // Contact is answered promptly, not whenever the bound cycle happens to turn.
    // A full bound is long enough for a prepared line to kill an attacker twice.
    expect(firstShotTick - engagedTick).toBeLessThanOrEqual(CONFIG.enemy.bounding.windowTicks);
    // And it is still shooting back on the way in, not only once in position.
    expect(shotsBeyondHold).toBeGreaterThan(0);
  });

  /**
   * Regression: light suppression used to force movement, so an attacker under
   * fire was marched forward and never allowed to halt and shoot back - which is
   * precisely when it should be shooting. Only pinning should silence it.
   */
  it('keeps shooting back while suppressed, and only pinning silences it', () => {
    const { sim, enemy } = arena(29, 'rifle');
    const threshold = CONFIG.suppression.recoverThreshold;
    let suppressedShots = 0;
    let peakSuppression = 0;
    for (let t = 1; t <= 30 * 200; t++) {
      // Hold it in the "under fire but not pinned" band for the whole run.
      if (enemy.suppression < threshold + 1) enemy.suppression = threshold + 1;
      const events = sim.step();
      peakSuppression = Math.max(peakSuppression, enemy.suppression);
      if (enemy.suppression > threshold && events.some((e) => e.type === 'shot' && e.shooterId === enemy.id)) {
        suppressedShots++;
      }
      if (enemy.dead) break;
    }
    // The scenario really did keep it suppressed without ever pinning it.
    expect(peakSuppression).toBeGreaterThan(threshold);
    expect(peakSuppression).toBeLessThan(CONFIG.suppression.pinThreshold);
    expect(suppressedShots).toBeGreaterThan(0);
  });

  it('prescribes a distinct engage distance per archetype', () => {
    const content = getContent();
    const rifleHold = engageDistance(content.weapons['enemy_rifle']!, 'rifle', CONFIG);
    const assaultHold = engageDistance(content.weapons['smg']!, 'assault', CONFIG);
    const vehicleHold = engageDistance(content.weapons['shell']!, 'vehicle', CONFIG);
    // Assault troops press in to make their SMGs count; riflemen trade fire from
    // further out; armour uses its full reach.
    expect(assaultHold).toBeLessThan(rifleHold);
    expect(rifleHold).toBeLessThan(vehicleHold);
    expect(vehicleHold).toBe(content.weapons['shell']!.range);
    // Every archetype's stop line is inside its own weapon's maximum reach, which
    // is what stops an attacker freezing wherever a target first appears.
    for (const [weapon, role] of [
      [content.weapons['enemy_rifle']!, 'rifle'],
      [content.weapons['smg']!, 'assault'],
      [content.weapons['shell']!, 'vehicle'],
    ] as const) {
      expect(engageDistance(weapon, role, CONFIG)).toBeLessThanOrEqual(weapon.range);
    }
  });

  it('never lets armour freeze: it keeps rolling and still fires', () => {
    // Start the vehicle already inside its stopping distance so it must decide
    // between pausing to shoot and rolling on, rather than only approaching.
    const { sim, enemy, observer } = arena(24, 'vehicle', 540);
    const weapon = getContent().weapons['shell']!;
    const stopAt = weapon.range * CONFIG.enemy.vehicleHoldRangeMult;
    expect(dist(enemy.pos, observer.pos)).toBeLessThan(stopAt); // begins in range
    let firedAtAll = false;
    let movesAfterFiring = 0;
    let hadFired = false;
    let prevY = enemy.pos.y;
    for (let t = 1; t <= 30 * 300; t++) {
      const events = sim.step();
      if (events.some((e) => e.type === 'shot' && e.shooterId === enemy.id)) { firedAtAll = true; hadFired = true; }
      if (hadFired && enemy.pos.y - prevY > 0.01) movesAfterFiring++;
      prevY = enemy.pos.y;
      if (enemy.dead || enemy.pos.y >= CONFIG.breakthroughY) break;
    }
    expect(firedAtAll).toBe(true); // it shoots during its pauses
    // ...and the pause is bounded, so it resumes rolling instead of parking.
    expect(movesAfterFiring).toBeGreaterThan(0);
    expect(enemy.dead || enemy.pos.y >= CONFIG.breakthroughY).toBe(true);
  });

  it('does not wedge two vehicles advancing together (regression)', () => {
    const sim = new Simulation(377);
    sim.state.terrain.blocked.fill(0);
    sim.state.points = 0;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    const observers = sim.state.units.filter((u) => u.team === 'friendly');
    // Unarmed, so nothing shoots the vehicles and the test measures movement only.
    const spots = [{ x: 100, y: 700 }, { x: 860, y: 700 }, { x: 200, y: 690 }, { x: 700, y: 690 }];
    observers.forEach((o, i) => { o.role = 'medic'; o.health = 1_000_000; o.pos = spots[i] ?? { x: 40, y: 690 }; });
    // Same start cell and the same lane: exactly the geometry that deadlocked.
    sim.spawnEnemy('vehicle', { x: 480, y: 60 });
    sim.spawnEnemy('vehicle', { x: 480, y: 60 });
    const vehicles = sim.state.units.filter((u) => u.role === 'vehicle');
    expect(vehicles).toHaveLength(2);
    const startY = vehicles[0]!.pos.y;
    for (let t = 0; t < 30 * 600; t++) {
      sim.step();
      if (sim.state.battleRecord.breakthroughs >= 2) break;
    }
    for (const v of vehicles) {
      if (v.pos.y <= startY + 100) {
        throw new Error(`vehicle wedged: id=${v.id} y=${v.pos.y.toFixed(1)} startY=${startY.toFixed(1)} path=${v.path.length} tgt=${v.targetId ?? '-'} x=${v.pos.x.toFixed(1)}`);
      }
      expect(v.pos.y).toBeGreaterThan(startY + 100);
    }
    expect(sim.state.battleRecord.breakthroughs).toBe(2);
  });

  it('alternates which half of a force advances once in contact', () => {
    const sim = new Simulation(31);
    sim.state.points = 0;
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    const front = sim.state.units.filter((u) => u.team === 'friendly');
    for (let i = 0; i < front.length; i++) {
      front[i]!.pos = { x: 200 + i * 120, y: 640 };
      front[i]!.health = 1_000_000;
    }
    // A spread line of attackers converges; some are in contact, some are not.
    for (let i = 0; i < 10; i++) sim.spawnEnemy('rifle', { x: 180 + i * 70, y: 660 });
    let sawAdvancing = 0;
    let sawHolding = 0;
    for (let t = 0; t < 30 * 60; t++) {
      sim.step();
      const engaged = sim.state.units.filter((u) => u.team === 'enemy' && u.targetId !== null && !u.pinned);
      sawAdvancing = Math.max(sawAdvancing, engaged.filter((u) => u.advance).length);
      sawHolding = Math.max(sawHolding, engaged.filter((u) => !u.advance).length);
    }
    // Both roles have to exist, or nothing is actually bounding.
    expect(sawAdvancing).toBeGreaterThan(0);
    expect(sawHolding).toBeGreaterThan(0);
  });
});

describe('trench emplacement', () => {
  const TRENCH = { id: 900, pos: { x: 480, y: 600 } };

  it('grants its firing bonus to the machine gun and to no other role', () => {
    const sim = new Simulation(51);
    sim.state.trenches.push({ ...TRENCH });
    const gunner = sim.state.units[0]!;
    gunner.role = 'mg';
    gunner.pos = { ...TRENCH.pos };
    const rifleman = sim.state.units[1]!;
    rifleman.role = 'rifleman';
    rifleman.pos = { ...TRENCH.pos };
    const bonus = trenchBonusFor(gunner, sim.state.trenches, CONFIG);
    expect(bonus).not.toBeNull();
    expect(bonus!.suppressionMult).toBeGreaterThan(1);
    expect(bonus!.suppressionRadiusMult).toBeGreaterThan(1);
    expect(bonus!.accuracyMult).toBeGreaterThan(1);
    // The trench is an emplacement, not a blanket accuracy buff.
    expect(trenchBonusFor(rifleman, sim.state.trenches, CONFIG)).toBeNull();
  });

  it('applies only while the gunner is actually standing in the trench', () => {
    const sim = new Simulation(52);
    sim.state.trenches.push({ ...TRENCH });
    const gunner = sim.state.units[0]!;
    gunner.role = 'mg';
    gunner.pos = { ...TRENCH.pos };
    expect(trenchBonusFor(gunner, sim.state.trenches, CONFIG)).not.toBeNull();
    // A step beyond the parapet gives up the emplacement.
    gunner.pos = { x: TRENCH.pos.x, y: TRENCH.pos.y + CONFIG.trench.occupyHalfDepth + 10 };
    expect(trenchBonusFor(gunner, sim.state.trenches, CONFIG)).toBeNull();
    // So does standing beside the earthwork.
    gunner.pos = { x: TRENCH.pos.x + CONFIG.trench.occupyHalfLength + 10, y: TRENCH.pos.y };
    expect(trenchBonusFor(gunner, sim.state.trenches, CONFIG)).toBeNull();
    // It is dug in, not standing in the cover shadow behind the line.
    gunner.pos = { x: TRENCH.pos.x, y: TRENCH.pos.y + CONFIG.trench.coverDepth };
    expect(trenchBonusFor(gunner, sim.state.trenches, CONFIG)).toBeNull();
  });

  it('lays down a wider, denser beaten zone from the emplacement', () => {
    /**
     * Fires one real shot from an MG across a line of Axis troops and totals the
     * suppression that lands. Suppression arrives whether or not the shot hits,
     * so this is deterministic despite the hit roll consuming the rng.
     */
    const suppressionFrom = (dugIn: boolean): { total: number; affected: number } => {
      const sim = new Simulation(53);
      sim.state.terrain.blocked.fill(0);
      sim.state.points = 0;
      sim.state.scheduler.phase = 'prep';
      sim.state.scheduler.prepTicksLeft = 1_000_000;
      sim.state.units = [];
      const gunner = sim.spawnFriendly('mg', dugIn ? { x: TRENCH.pos.x, y: TRENCH.pos.y + 2 } : { x: TRENCH.pos.x, y: 300 });
      if (dugIn) sim.state.trenches.push({ ...TRENCH });
      const targets: Unit[] = [];
      for (let dx = -70; dx <= 70; dx += 20) {
        sim.spawnEnemy('rifle', { x: TRENCH.pos.x + dx, y: 460 });
        targets.push(sim.state.units[sim.state.units.length - 1]!);
      }
      for (const t of targets) t.suppression = 0;
      const primary = targets[Math.floor(targets.length / 2)]!;
      sim.fireShot(gunner, primary, getContent().weapons['mg']!);
      return {
        total: targets.reduce((sum, t) => sum + t.suppression, 0),
        affected: targets.filter((t) => t.suppression > 0).length,
      };
    };

    const open = suppressionFrom(false);
    const dugIn = suppressionFrom(true);
    // The emplacement must genuinely beat the same gun in the open...
    expect(dugIn.total).toBeGreaterThan(open.total * 1.5);
    // ...and reach further, not merely hit the same troops harder.
    expect(dugIn.affected).toBeGreaterThan(open.affected);

    // And the bonus is conditional on occupying a trench that actually exists.
    const sim = new Simulation(55);
    const gunner = sim.state.units[0]!;
    gunner.role = 'mg';
    gunner.pos = { ...TRENCH.pos };
    expect(trenchBonusFor(gunner, sim.state.trenches, CONFIG)).toBeNull(); // none built
    sim.state.trenches.push({ ...TRENCH });
    expect(trenchBonusFor(gunner, sim.state.trenches, CONFIG)).not.toBeNull();
  });

  it('reduces incoming fire far more than a sandbag does', () => {
    const sim = new Simulation(54);
    sim.state.trenches.push({ ...TRENCH });
    const shooter = sim.state.units[0]!;
    shooter.role = 'rifleman';
    shooter.pos = { x: 480, y: 400 };
    const inTrench = sim.state.units[1]!;
    inTrench.role = 'rifleman';
    inTrench.pos = { ...TRENCH.pos };
    const behindBags = sim.state.units[2]!;
    behindBags.role = 'rifleman';
    const bags = [{ id: 901, pos: { x: 200, y: 600 } }];
    behindBags.pos = { x: 200, y: 612 };
    const weapon = getContent().weapons['rifle']!;
    const base = { weapon, distance: 200, attackerXp: 0, attackerSuppression: 0, config: CONFIG };
    // Direction matters for sandbags: the attacker must be north of them.
    const trenchChance = hitChance({
      ...base,
      distance: dist(shooter.pos, inTrench.pos),
      targetInCover: hasTrenchCover(sim.state.trenches, inTrench.pos, shooter.pos, CONFIG),
      targetInTrench: true,
    });
    const bagChance = hitChance({
      ...base,
      distance: dist(shooter.pos, behindBags.pos),
      targetInCover: hasDirectionalCover(bags, behindBags.pos, shooter.pos, CONFIG),
      targetInTrench: false,
    });
    const openChance = hitChance({ ...base, targetInCover: false, targetInTrench: false });
    expect(bagChance).toBeLessThan(openChance);
    expect(trenchChance).toBeLessThan(bagChance);
  });
});

describe('mines', () => {
  /** A simulation with a loaded engineer standing at the front. */
  function withEngineer(seed = 71, points = 40) {
    const sim = new Simulation(seed);
    sim.state.points = points;
    const engineer = sim.state.units[0]!;
    engineer.role = 'engineer';
    engineer.pos = { x: 480, y: 480 };
    return sim;
  }

  /** An armed mine of the given type, with no waves and nothing else in play. */
  function minedField(seed: number, kind: 'ap' | 'at', at = { x: 480, y: 300 }) {
    const sim = new Simulation(seed);
    sim.state.points = 0;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    sim.state.mines.push({ id: 900, pos: { ...at }, kind, armed: true });
    return sim;
  }

  const LAY_AT = { x: 480, y: 420 };

  it('requires a nearby engineer, points, and ground ahead of the line', () => {
    const noEngineer = new Simulation(72);
    noEngineer.state.points = 40;
    expect(noEngineer.command({ type: 'mine', kind: 'ap', pos: LAY_AT }).ok).toBe(false);

    const sim = withEngineer();
    const before = sim.state.points;
    expect(sim.command({ type: 'mine', kind: 'ap', pos: LAY_AT }).ok).toBe(true);
    expect(sim.state.points).toBe(before - CONFIG.mineKinds.ap.cost);

    // Behind the line is where the defenders stand, so it is refused.
    expect(sim.command({ type: 'mine', kind: 'ap', pos: { x: 300, y: CONFIG.mine.maxLayY + 20 } }).ok).toBe(false);
    // Too close to the mine already being laid.
    expect(sim.command({ type: 'mine', kind: 'ap', pos: { x: LAY_AT.x + 4, y: LAY_AT.y } }).ok).toBe(false);
    // Without the points it is refused and nothing is queued.
    sim.state.points = CONFIG.mineKinds.ap.cost - 1;
    const queued = sim.state.constructionSites.length;
    expect(sim.command({ type: 'mine', kind: 'ap', pos: { x: 520, y: 420 } }).ok).toBe(false);
    expect(sim.state.constructionSites).toHaveLength(queued);
  });

  it('charges its own price and lay time per type', () => {
    const ap = withEngineer(73, 40);
    ap.command({ type: 'mine', kind: 'ap', pos: LAY_AT });
    const at = withEngineer(73, 40);
    at.command({ type: 'mine', kind: 'at', pos: LAY_AT });
    expect(ap.state.points).toBe(40 - CONFIG.mineKinds.ap.cost);
    expect(at.state.points).toBe(40 - CONFIG.mineKinds.at.cost);
    // A heavy anti-tank charge costs more and takes longer to site.
    expect(CONFIG.mineKinds.at.cost).toBeGreaterThan(CONFIG.mineKinds.ap.cost);
    expect(CONFIG.mineKinds.at.laySeconds).toBeGreaterThan(CONFIG.mineKinds.ap.laySeconds);
    expect(ap.state.constructionSites[0]!.totalTicks).toBe(sec(CONFIG.mineKinds.ap.laySeconds));
    expect(at.state.constructionSites[0]!.totalTicks).toBe(sec(CONFIG.mineKinds.at.laySeconds));
  });

  it('arms only once the engineer has finished laying it, keeping its type', () => {
    const sim = withEngineer();
    const engineer = sim.state.units[0]!;
    expect(sim.command({ type: 'mine', kind: 'at', pos: LAY_AT }).ok).toBe(true);
    expect(sim.state.mines).toHaveLength(0);
    for (let i = 0; i <= sec(CONFIG.mineKinds.at.laySeconds); i++) sim.step();
    expect(engineer.service.fortificationsBuilt).toBe(1);
    expect(sim.state.mines).toHaveLength(1);
    expect(sim.state.mines[0]!.armed).toBe(true);
    expect(sim.state.mines[0]!.kind).toBe('at');
    // Laid at the requested spot, and it counts as a completed work.
    expect(dist(sim.state.mines[0]!.pos, LAY_AT)).toBeLessThan(1);
  });

  it('detonates for the target it is designed for, and not the other', () => {
    // Anti-personnel: infantry fire it, armour does not.
    const apInfantry = minedField(74, 'ap');
    apInfantry.spawnEnemy('rifle', { x: 480, y: 300 });
    expect(apInfantry.step().some((e) => e.type === 'mineTriggered')).toBe(true);

    const apArmour = minedField(74, 'ap');
    apArmour.spawnEnemy('vehicle', { x: 480, y: 300 });
    expect(apArmour.step().some((e) => e.type === 'mineTriggered')).toBe(false);
    expect(apArmour.state.mines).toHaveLength(1);

    // Anti-tank: the reverse.
    const atArmour = minedField(74, 'at');
    atArmour.spawnEnemy('vehicle', { x: 480, y: 300 });
    expect(atArmour.step().some((e) => e.type === 'mineTriggered')).toBe(true);

    const atInfantry = minedField(74, 'at');
    atInfantry.spawnEnemy('rifle', { x: 480, y: 300 });
    expect(atInfantry.step().some((e) => e.type === 'mineTriggered')).toBe(false);
    expect(atInfantry.state.mines).toHaveLength(1);
  });

  it('reports which type went off', () => {
    const sim = minedField(75, 'at');
    sim.spawnEnemy('vehicle', { x: 480, y: 300 });
    const event = sim.step().find((e) => e.type === 'mineTriggered');
    expect(event).toMatchObject({ type: 'mineTriggered', kind: 'at' });
  });

  it('is a threat to armour only in the anti-tank variety', () => {
    const content = getContent();
    const vehicleHp = content.enemy.vehicle.health;
    // An anti-personnel charge is a nuisance to a tank; an anti-tank charge is not.
    const apDamage = CONFIG.mineKinds.ap.damage * CONFIG.mineKinds.ap.armorMult;
    const atDamage = CONFIG.mineKinds.at.damage * CONFIG.mineKinds.at.armorMult;
    expect(apDamage).toBeLessThan(vehicleHp * 0.15);
    expect(atDamage).toBeGreaterThan(vehicleHp * 0.5);
    // And both are lethal to infantry, the AP one outright.
    expect(CONFIG.mineKinds.ap.damage).toBeGreaterThan(content.enemy.rifle.health);
  });

  it('trips on a hostile that steps on it, and destroys itself doing so', () => {
    const sim = minedField(76, 'ap');
    sim.spawnEnemy('rifle', { x: 480, y: 300 });
    const enemy = sim.state.units.find((u) => u.team === 'enemy')!;
    const events = sim.step();
    expect(events.filter((e) => e.type === 'mineTriggered')).toHaveLength(1);
    // A direct hit from an anti-personnel charge is fatal.
    expect(enemy.health).toBeLessThan(getContent().enemy['rifle'].health);
    // It fires once and is gone.
    expect(sim.state.mines).toHaveLength(0);
    for (let i = 0; i < 60; i++) {
      expect(sim.step().filter((e) => e.type === 'mineTriggered')).toHaveLength(0);
    }
  });

  it('does nothing at all unless a hostile comes within the trigger radius', () => {
    const def = CONFIG.mineKinds.ap;
    const sim = minedField(77, 'ap');
    // Well outside the reach of any unit type: a mine is not an area weapon.
    sim.spawnEnemy('rifle', { x: 480, y: 300 + def.triggerRadius + getContent().enemy.vehicle.radius + 12 });
    const enemy = sim.state.units.find((u) => u.team === 'enemy')!;
    enemy.reloadTimer = 100000;
    const health = enemy.health;
    for (let i = 0; i < 20; i++) sim.step();
    expect(sim.state.mines).toHaveLength(1);
    expect(enemy.health).toBe(health);
  });

  it('is tripped by armour driving over an anti-tank mine', () => {
    // Regression: the trigger used to measure centre-to-centre against a radius
    // no larger than a vehicle's own collision radius. Terrain routes movement
    // along cell centres, so a tank could roll down a mined lane and clear the
    // charge by a pixel or two without ever setting it off.
    const sim = minedField(78, 'at');
    // Defenders parked out of the way so the tank is not engaged first.
    for (const u of sim.state.units) u.pos = { x: 20, y: 700 };
    sim.spawnEnemy('vehicle', { x: 480, y: 60 });
    const tank = sim.state.units.find((u) => u.role === 'vehicle')!;
    const startHealth = tank.health;

    let tripped = false;
    for (let t = 1; t <= 30 * 300; t++) {
      const events = sim.step();
      if (events.some((e) => e.type === 'mineTriggered')) { tripped = true; break; }
      if (tank.dead || tank.pos.y >= CONFIG.breakthroughY) break;
    }
    expect(tripped).toBe(true);
    expect(sim.state.mines).toHaveLength(0);
    // The blast has to be worth noticing, or the trigger is academic.
    expect(startHealth - tank.health).toBeGreaterThan(100);
  });

  it('triggers from the target edge, so cell-centre routes still set it off', () => {
    const sim = minedField(79, 'at');
    // A tank sitting exactly on the nearest cell centre: 12px off in x, which the
    // old centre-to-centre test barely tolerated and a vehicle could overshoot.
    const vehicleRadius = getContent().enemy.vehicle.radius;
    const cellCentreOffset = sim.state.terrain.cell / 2;
    sim.spawnEnemy('vehicle', { x: 480 + cellCentreOffset, y: 300 });
    const events = sim.step();
    expect(events.some((e) => e.type === 'mineTriggered')).toBe(true);
    expect(cellCentreOffset).toBeLessThan(CONFIG.mineKinds.at.triggerRadius + vehicleRadius);
  });

  it('cannot be laid so close that a friendly beside it sets it off', () => {
    // The gap between two mines must exceed the widest trigger, or an engineer
    // standing at the next site would detonate the mine next to them.
    for (const kind of ['ap', 'at'] as const) {
      const def = CONFIG.mineKinds[kind];
      const widestReach = def.triggerRadius + getContent().enemy.vehicle.radius;
      expect(def.minSpacing).toBeGreaterThan(widestReach);
    }
  });

  it('is not set off by the defenders walking over it', () => {
    const sim = minedField(80, 'ap');
    const friendly = sim.state.units[0]!;
    friendly.pos = { x: 480, y: 300 };
    for (let i = 0; i < 30; i++) sim.step();
    // Only the Axis trip them, or a mined lane would be unusable.
    expect(sim.state.mines).toHaveLength(1);
    expect(friendly.health).toBe(getContent().friendly.rifleman.health);
  });

  it('still harms friendlies caught in a blast that was tripped by an enemy', () => {
    const sim = minedField(81, 'ap');
    sim.spawnEnemy('rifle', { x: 480, y: 300 });
    const bystander = sim.state.units[0]!;
    bystander.pos = { x: 480, y: 300 + CONFIG.mineKinds.ap.radius - 6 };
    const health = bystander.health;
    sim.step();
    expect(sim.state.mines).toHaveLength(0);
    // The blast does not care whose uniform you are wearing.
    expect(bystander.health).toBeLessThan(health);
  });

  it('survives a save round-trip, including type and armed state', () => {
    const sim = withEngineer();
    sim.command({ type: 'mine', kind: 'at', pos: LAY_AT });
    for (let i = 0; i <= sec(CONFIG.mineKinds.at.laySeconds); i++) sim.step();
    sim.state.mines.push({ id: 999, pos: { x: 200, y: 300 }, kind: 'ap', armed: false });
    const snap = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    const restored = Simulation.fromSnapshot(snap);
    expect(restored.state.mines).toEqual(sim.state.mines);
    expect(restored.state.mines.map((m) => m.kind)).toContain('at');
    expect(restored.snapshot()).toEqual(sim.snapshot());
  });
});

/**
 * Work sites in progress. A site whose engineer is merely pinned, busy or out of
 * position is paused and resumable; a site nobody can ever finish - because the
 * squad has no engineer left - is abandoned, so the half-built marker does not
 * sit on the field and in the HUD for the rest of the run.
 */
describe('work sites in progress', () => {
  const LAY = { x: 480, y: 420 };

  /** A simulation whose whole squad is one engineer, standing at the front. */
  function loneEngineer(seed = 81, points = 40) {
    const sim = openField(seed);
    sim.state.points = points;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    const engineer = sim.state.units[0]!;
    engineer.role = 'engineer';
    engineer.pos = { x: 480, y: 480 };
    // Keep only the one soldier, so "no engineer left" is unambiguous.
    sim.state.units = [engineer];
    return { sim, engineer };
  }

  it('abandons a mine the engineer dies during, and refunds it', () => {
    const { sim, engineer } = loneEngineer();
    expect(sim.command({ type: 'mine', kind: 'at', pos: LAY }).ok).toBe(true);
    const spent = 40 - sim.state.points;
    expect(spent).toBe(CONFIG.mineKinds.at.cost);
    // Part-way through laying, not finished.
    for (let i = 0; i < sec(CONFIG.mineKinds.at.laySeconds) - 5; i++) sim.step();
    expect(sim.state.constructionSites).toHaveLength(1);
    expect(sim.state.constructionSites[0]!.ticksRemaining).toBeGreaterThan(0);

    // The engineer is killed where he stands.
    engineer.health = 0;
    engineer.dead = true;
    const events = sim.step();

    // The site is gone, so nothing draws its progress bar or lists it in the HUD.
    expect(sim.state.constructionSites).toEqual([]);
    expect(sim.state.mines).toEqual([]);
    expect(events.some((e) => e.type === 'constructionAbandoned')).toBe(true);
    // And the points are returned: the squad lost the man, not the decision.
    expect(sim.state.points).toBe(40);
  });

  it('abandons sandbags and trenches the same way', () => {
    for (const build of [
      { run: (sim: Simulation, pos: Vec2) => sim.command({ type: 'sandbag', pos }), cost: CONFIG.costs.sandbag, at: { x: 480, y: 500 } },
      { run: (sim: Simulation, pos: Vec2) => sim.command({ type: 'trench', pos }), cost: CONFIG.costs.trench, at: { x: 480, y: 500 } },
    ]) {
      const { sim, engineer } = loneEngineer();
      expect(build.run(sim, build.at).ok).toBe(true);
      expect(sim.state.points).toBe(40 - build.cost);
      sim.step();
      expect(sim.state.constructionSites).toHaveLength(1);

      engineer.health = 0;
      engineer.dead = true;
      sim.step();
      expect(sim.state.constructionSites).toEqual([]);
      expect(sim.state.points).toBe(40);
    }
  });

  it('hands a site over to another engineer when one is still available', () => {
    const { sim, engineer } = loneEngineer(82, 40);
    // A second engineer, standing well inside range of the work.
    const second = sim.spawnFriendly('engineer', { x: 500, y: 470 });
    expect(sim.command({ type: 'mine', kind: 'ap', pos: LAY }).ok).toBe(true);
    sim.step();
    // The nearest engineer took it, which may be either of them.
    expect(sim.state.constructionSites).toHaveLength(1);

    // Kill whichever engineer is actually building it.
    const builderId = sim.state.constructionSites[0]!.builderId;
    const builder = sim.state.units.find((u) => u.id === builderId)!;
    builder.health = 0;
    builder.dead = true;
    sim.step();

    // The site survives, because the other engineer can still finish it.
    expect(sim.state.constructionSites).toHaveLength(1);
    expect(sim.state.constructionSites[0]!.builderId).not.toBe(builderId);
    const other = builderId === engineer.id ? second : engineer;
    expect(sim.state.constructionSites[0]!.builderId).toBe(other.id);

    // And it does get finished, into an armed mine.
    for (let i = 0; i <= sec(CONFIG.mineKinds.ap.laySeconds); i++) sim.step();
    expect(sim.state.constructionSites).toEqual([]);
    expect(sim.state.mines).toHaveLength(1);
    expect(sim.state.mines[0]!.armed).toBe(true);
  });

  it('pauses rather than abandons while an engineer is merely out of position', () => {
    const { sim, engineer } = loneEngineer(83, 40);
    expect(sim.command({ type: 'mine', kind: 'ap', pos: LAY }).ok).toBe(true);
    sim.step();
    const progress = sim.state.constructionSites[0]!.ticksRemaining;

    // The engineer walks well out of range: the work waits for him.
    engineer.pos = { x: 120, y: 640 };
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.state.constructionSites).toHaveLength(1);
    expect(sim.state.constructionSites[0]!.ticksRemaining).toBe(progress);
    expect(sim.state.points).toBe(40 - CONFIG.mineKinds.ap.cost);

    // He comes back and it resumes.
    engineer.pos = { x: 480, y: 480 };
    for (let i = 0; i <= sec(CONFIG.mineKinds.ap.laySeconds); i++) sim.step();
    expect(sim.state.constructionSites).toEqual([]);
    expect(sim.state.mines).toHaveLength(1);
  });

  it('keeps a paused site through a save and reload', () => {
    const { sim, engineer } = loneEngineer(84, 40);
    expect(sim.command({ type: 'mine', kind: 'at', pos: LAY }).ok).toBe(true);
    sim.step();
    engineer.pos = { x: 120, y: 640 };
    sim.step();
    const snap = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    expect(snap.constructionSites).toHaveLength(1);
    const restored = Simulation.fromSnapshot(snap);
    expect(restored.state.constructionSites).toEqual(sim.state.constructionSites);
  });
});

describe('grenades', () => {
  /** Open field with no waves, one friendly soldier, and a clean slate. */
  function grenadeArena(seed: number) {
    const sim = new Simulation(seed);
    sim.state.terrain.blocked.fill(0);
    sim.state.points = 0;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    sim.state.units = [];
    return sim;
  }

  const throwCount = (events: readonly SimEvent[]): number => events.filter((e) => e.type === 'grenadeThrown').length;

  it('is carried by riflemen and combat engineers only', () => {
    const sim = grenadeArena(111);
    const carried: Record<string, number> = {};
    for (const role of ['rifleman', 'engineer', 'mg', 'medic', 'at', 'sniper', 'radio_engineer'] as const) {
      carried[role] = sim.spawnFriendly(role, { x: 100, y: 600 }).grenades;
    }
    expect(carried['rifleman']).toBe(4);
    expect(carried['engineer']).toBe(4);
    for (const role of ['mg', 'medic', 'at', 'sniper', 'radio_engineer']) {
      expect(carried[role]).toBe(0);
    }
  });

  it('reaches an enemy that rifle fire cannot, by arcing over cover', () => {
    const sim = grenadeArena(112);
    const shooter = sim.spawnFriendly('rifleman', { x: 480, y: 620 });
    // A solid wall across the lane, with the enemy tucked in behind it.
    const wallRow = 23;
    for (let col = 0; col < sim.state.terrain.cols; col++) {
      sim.state.terrain.blocked[wallRow * sim.state.terrain.cols + col] = 1;
    }
    const enemyY = wallRow * sim.state.terrain.cell - 14;
    sim.spawnEnemy('rifle', { x: 480, y: enemyY });
    const enemy = sim.state.units.find((u) => u.team === 'enemy')!;
    const rifle = getContent().weapons['rifle']!;

    // Preconditions: the target is out of sight, inside throwing range, and no
    // rifle shot could legitimately reach it.
    expect(hasLineOfSight(sim.state.terrain, shooter.pos, enemy.pos)).toBe(false);
    expect(dist(shooter.pos, enemy.pos)).toBeLessThanOrEqual(CONFIG.grenade.range);
    expect(dist(shooter.pos, enemy.pos)).toBeLessThanOrEqual(rifle.range);
    expect(targetIsValid(getContent(), sim.state.terrain, sim.state.sandbags, shooter, enemy, rifle, CONFIG, sim.state.trenches)).toBe(false);

    let thrown = 0;
    for (let t = 1; t <= 30 * 80; t++) {
      thrown += throwCount(sim.step());
      if (thrown > 0) break;
    }
    expect(thrown).toBeGreaterThan(0);
    // And the charge does its job on a target guns could not touch.
    for (let t = 1; t <= 30 * 20; t++) sim.step();
    expect(enemy.health).toBeLessThan(getContent().enemy['rifle'].health);
  });

  it('is spent: a soldier runs out and never reloads', () => {
    const sim = grenadeArena(113);
    const shooter = sim.spawnFriendly('rifleman', { x: 480, y: 620 });
    const carried = shooter.grenades;
    expect(carried).toBeGreaterThan(0);
    // An endless supply of fresh targets so there is always something to throw at.
    let thrown = 0;
    for (let t = 1; t <= 30 * 120; t++) {
      if (t % 60 === 0 && sim.state.units.filter((u) => u.team === 'enemy').length < 2) {
        sim.spawnEnemy('rifle', { x: 480, y: 500 });
        sim.spawnEnemy('rifle', { x: 500, y: 505 });
      }
      thrown += throwCount(sim.step());
    }
    expect(thrown).toBe(carried);
    expect(shooter.grenades).toBe(0);
    expect(shooter.service.grenadesThrown).toBe(carried);
  });

  it('waits out its cooldown between throws', () => {
    const sim = grenadeArena(114);
    const shooter = sim.spawnFriendly('rifleman', { x: 480, y: 620 });
    shooter.grenades = 5;
    let firstThrowTick = -1;
    let secondThrowTick = -1;
    for (let t = 1; t <= 30 * 120; t++) {
      if (t % 30 === 0 && sim.state.units.filter((u) => u.team === 'enemy').length < 2) {
        sim.spawnEnemy('rifle', { x: 480, y: 500 });
        sim.spawnEnemy('rifle', { x: 500, y: 505 });
      }
      if (throwCount(sim.step()) > 0) {
        if (firstThrowTick === -1) firstThrowTick = t;
        else if (secondThrowTick === -1) { secondThrowTick = t; break; }
      }
    }
    expect(firstThrowTick).toBeGreaterThan(0);
    expect(secondThrowTick).toBeGreaterThan(0);
    // Consecutive throws cannot be closer together than the cooldown allows.
    expect(secondThrowTick - firstThrowTick).toBeGreaterThanOrEqual(CONFIG.grenade.cooldownTicks);
  });

  it('does not throw at a lone target standing in the open', () => {
    const sim = grenadeArena(115);
    const shooter = sim.spawnFriendly('rifleman', { x: 480, y: 620 });
    // One enemy, close range, but nothing blocking the shot and no company.
    sim.spawnEnemy('rifle', { x: 480, y: 520 });
    let thrown = 0;
    for (let t = 1; t <= 30 * 60; t++) thrown += throwCount(sim.step());
    // A grenade is for clustered or sheltered targets, not a routine opening shot.
    expect(thrown).toBe(0);
    expect(shooter.grenades).toBeGreaterThan(0);
  });

  it('keeps its remaining count and service record across a save', () => {
    const sim = grenadeArena(116);
    const shooter = sim.spawnFriendly('rifleman', { x: 480, y: 620 });
    shooter.grenades = 1;
    shooter.service.grenadesThrown = 1;
    const snap = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    const restored = Simulation.fromSnapshot(snap);
    const back = restored.state.units.find((u) => u.id === shooter.id)!;
    expect(back.grenades).toBe(1);
    expect(back.service.grenadesThrown).toBe(1);
    expect(restored.snapshot()).toEqual(sim.snapshot());
  });
});

describe('enemy target selection', () => {
  it('prefers the more dangerous role over a nearer ordinary one', () => {
    const sim = new Simulation(41);
    sim.state.terrain.blocked.fill(0);
    // This isolates threat weighting: both targets must have unobstructed sight.
    delete sim.state.terrain.elevation;
    sim.state.points = 0;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    const units = sim.state.units.filter((u) => u.team === 'friendly');
    for (const u of units) { u.health = 1_000_000; u.pos = { x: 40, y: 700 }; }
    units[0]!.role = 'rifleman';
    units[0]!.pos = { x: 480, y: 380 };
    units[1]!.role = 'radio_engineer';
    units[1]!.pos = { x: 480, y: 440 }; // the more dangerous role, further away
    sim.spawnEnemy('rifle', { x: 480, y: 250 });
    const enemy = sim.state.units[sim.state.units.length - 1]!;
    // Both are inside the 200px enemy rifle range and neither is wounded, so
    // threat weighting is the only thing that can decide between them.
    const weapon = getContent().weapons['enemy_rifle']!;
    expect(dist(enemy.pos, units[0]!.pos)).toBeLessThan(dist(enemy.pos, units[1]!.pos));
    expect(dist(enemy.pos, units[1]!.pos)).toBeLessThanOrEqual(weapon.range);
    sim.step();
    // Threat weighting beats proximity.
    expect(enemy.targetId).toBe(units[1]!.id);
  });

  it('finishes a wounded soldier rather than only ever engaging the closest', () => {
    const sim = new Simulation(42);
    sim.state.terrain.blocked.fill(0);
    sim.state.points = 0;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    const units = sim.state.units.filter((u) => u.team === 'friendly');
    for (const u of units) { u.health = 200; u.pos = { x: 40, y: 700 }; }
    units[0]!.role = 'rifleman';
    units[0]!.pos = { x: 480, y: 340 }; // closer, and healthy
    units[1]!.role = 'rifleman';
    units[1]!.pos = { x: 620, y: 340 };
    units[1]!.health = 40; // further away, but nearly finished
    sim.spawnEnemy('rifle', { x: 480, y: 200 });
    const enemy = sim.state.units[sim.state.units.length - 1]!;
    expect(dist(enemy.pos, units[0]!.pos)).toBeLessThan(dist(enemy.pos, units[1]!.pos));
    sim.step();
    // Converting a wounded soldier into a casualty is worth closing the extra gap.
    expect(enemy.targetId).toBe(units[1]!.id);
  });
});

describe('command validation', () => {
  it('rejects out-of-bounds and unreachable orders without side effects', () => {
    const sim = new Simulation(7);
    const unit = sim.state.units[0]!;
    const pathBefore = unit.path.length;

    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 5000, y: 100 } }).ok).toBe(false);
    expect(unit.path.length).toBe(pathBefore);

    sim.state.terrain.blocked.fill(1); // no passable ground anywhere
    expect(sim.command({ type: 'move', unitId: unit.id, pos: { x: 400, y: 400 } }).ok).toBe(false);
    expect(unit.path.length).toBe(pathBefore);

    expect(sim.command({ type: 'move', unitId: 9999, pos: { x: 400, y: 640 } }).ok).toBe(false);
  });

  it('rejects unaffordable, out-of-zone, and over-cap purchases without consuming points', () => {
    const sim = new Simulation(7);
    const startFriendlies = sim.state.units.filter((u) => u.team === 'friendly').length;

    sim.state.points = 0;
    expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 400, y: 650 } }).ok).toBe(false);
    expect(sim.state.points).toBe(0);
    expect(sim.state.units.filter((u) => u.team === 'friendly').length).toBe(startFriendlies);

    sim.state.points = 50;
    expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 400, y: 100 } }).ok).toBe(false);
    expect(sim.state.points).toBe(50);

    // Fill the squad to the cap, then expect rejection.
    sim.state.points = 100;
    for (let i = 0; i < CONFIG.caps.friendly - startFriendlies; i++) {
      expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 150 + i * 60, y: 650 } }).ok).toBe(true);
    }
    const full = sim.state.points;
    expect(sim.command({ type: 'recruit', role: 'rifleman', pos: { x: 480, y: 650 } }).ok).toBe(false);
    expect(sim.state.points).toBe(full);

    // Sandbag spacing.
    // This squad is full; use two existing soldiers as the required specialists.
    const engineer = sim.state.units[0]!;
    engineer.role = 'engineer';
    engineer.pos = { x: 400, y: 420 };
    sim.state.units[1]!.role = 'radio_engineer';
    sim.state.points = 50;
    expect(sim.command({ type: 'sandbag', pos: { x: 400, y: 400 } }).ok).toBe(true);
    const afterBag = sim.state.points;
    expect(sim.command({ type: 'sandbag', pos: { x: 405, y: 400 } }).ok).toBe(false);
    expect(sim.state.points).toBe(afterBag);

    // Artillery cooldown rejects a second call.
    sim.state.points = 50;
    expect(sim.command({ type: 'artillery', pos: { x: 480, y: 300 } }).ok).toBe(true);
    const afterFire = sim.state.points;
    expect(sim.command({ type: 'artillery', pos: { x: 480, y: 300 } }).ok).toBe(false);
    expect(sim.state.points).toBe(afterFire);
  });
});

describe('group move', () => {
  /** A settled squad with waves held off, so orders are the only thing moving. */
  function squad(seed: number) {
    const sim = new Simulation(seed);
    sim.state.terrain.blocked.fill(0);
    sim.state.points = 0;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 1_000_000;
    const units = sim.state.units.filter((u) => u.team === 'friendly');
    units.forEach((u, i) => {
      u.pos = { x: 200 + i * 70, y: 640 };
      u.prevPos = { ...u.pos };
    });
    return { sim, units };
  }

  it('gives every soldier its own destination instead of one shared point', () => {
    const { sim, units } = squad(41);
    const order = { x: 480, y: 400 };
    expect(sim.command({ type: 'moveGroup', unitIds: units.map((u) => u.id), pos: order }).ok).toBe(true);

    const goals = units.map((u) => u.moveGoal);
    expect(goals.every((g) => g !== null)).toBe(true);
    // Four soldiers on one tile would spend the next seconds shoving each other
    // off it, which is the whole reason the order resolves to a formation.
    const keys = new Set(goals.map((g) => `${Math.round(g!.x)},${Math.round(g!.y)}`));
    expect(keys.size).toBe(units.length);
    for (const u of units) expect(u.path.length).toBeGreaterThan(0);
  });

  it('spaces the formation around the ordered point, not away from it', () => {
    const { sim, units } = squad(42);
    const order = { x: 480, y: 400 };
    sim.command({ type: 'moveGroup', unitIds: units.map((u) => u.id), pos: order });
    const spacing = CONFIG.formation.spacing;
    const goals = units.map((u) => u.moveGoal!);
    // The squad lands as a tight block centred on the order rather than strung
    // out along the route, and no two soldiers are sent to the same tile.
    for (const g of goals) {
      expect(Math.hypot(g.x - order.x, g.y - order.y)).toBeLessThanOrEqual(spacing * 3);
    }
    for (let i = 0; i < goals.length; i++) {
      for (let j = i + 1; j < goals.length; j++) {
        const a = goals[i] as { x: number; y: number };
        const b = goals[j] as { x: number; y: number };
        // At least half a slot apart: comfortably clear of the separation radius,
        // so the squad does not immediately push itself out of formation.
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(spacing * 0.5);
      }
    }
  });

  it('routes every soldier to its own slot and actually arrives', () => {
    const { sim, units } = squad(43);
    const order = { x: 480, y: 400 };
    sim.command({ type: 'moveGroup', unitIds: units.map((u) => u.id), pos: order });
    const startDistance = units.map((u) => Math.hypot(u.pos.x - order.x, u.pos.y - order.y));
    for (let t = 0; t < 30 * 120; t++) sim.step();
    units.forEach((u, i) => {
      expect(u.health).toBeGreaterThan(0);
      // It covered the ground and ended up on its slot. A stopped soldier can be
      // nudged off exact centre by a comrade still filing past, so this allows
      // less than one slot of jostle rather than demanding pixel precision.
      const remaining = Math.hypot(u.pos.x - u.moveGoal!.x, u.pos.y - u.moveGoal!.y);
      expect(remaining).toBeLessThan(CONFIG.formation.spacing);
      expect(remaining).toBeLessThan(startDistance[i] as number);
    });
    // And they are standing apart, not stacked on one tile.
    const keys = new Set(units.map((u) => `${Math.round(u.pos.x / 12)},${Math.round(u.pos.y / 12)}`));
    expect(keys.size).toBe(units.length);
  });

  it('leaves out the pinned and the dead rather than failing the whole order', () => {
    const { sim, units } = squad(44);
    const pinned = units[0]!;
    pinned.pinned = true;
    pinned.suppression = CONFIG.suppression.pinThreshold + 1;
    const gone = units[1]!;
    gone.health = 0;

    const movable = units.slice(2).map((u) => u.id);
    const result = sim.command({ type: 'moveGroup', unitIds: units.map((u) => u.id), pos: { x: 480, y: 400 } });
    expect(result.ok).toBe(true);
    // The pinned soldier keeps its position but the rest still get their order.
    expect(pinned.moveGoal).toBeNull();
    for (const id of movable) expect(sim.state.units.find((u) => u.id === id)!.moveGoal).not.toBeNull();
  });

  it('rejects an empty selection and an out-of-bounds order without moving anyone', () => {
    const { sim, units } = squad(45);
    expect(sim.command({ type: 'moveGroup', unitIds: [], pos: { x: 480, y: 400 } }).ok).toBe(false);
    expect(sim.command({ type: 'moveGroup', unitIds: [9999], pos: { x: 480, y: 400 } }).ok).toBe(false);
    expect(sim.command({ type: 'moveGroup', unitIds: units.map((u) => u.id), pos: { x: 5000, y: 100 } }).ok).toBe(false);
    for (const u of units) {
      expect(u.path).toHaveLength(0);
      expect(u.moveGoal).toBeNull();
    }
  });

  it('resolves the same order identically for the same seed', () => {
    const goals = (seed: number): string[] => {
      const { sim, units } = squad(seed);
      sim.command({ type: 'moveGroup', unitIds: units.map((u) => u.id), pos: { x: 480, y: 400 } });
      return units.map((u) => `${Math.round(u.moveGoal!.x)},${Math.round(u.moveGoal!.y)}`);
    };
    expect(goals(46)).toEqual(goals(46));
    // Distinct soldiers take distinct slots, so no slot is handed out twice.
    const first = goals(46);
    expect(new Set(first).size).toBe(first.length);
  });

  it('keeps the formation inside the battlefield when ordered into a corner', () => {
    const { sim, units } = squad(47);
    sim.command({ type: 'moveGroup', unitIds: units.map((u) => u.id), pos: { x: 12, y: 12 } });
    for (const u of units) {
      const g = u.moveGoal!;
      expect(g.x).toBeGreaterThanOrEqual(6);
      expect(g.y).toBeGreaterThanOrEqual(6);
      expect(g.x).toBeLessThanOrEqual(CONFIG.field.width - 6);
      expect(g.y).toBeLessThanOrEqual(CONFIG.field.height - 6);
    }
  });
});

describe('range, terrain, and cover', () => {
  it('lets infantry cross tree lines while foliage conceals targets and softens shots', () => {
    const sim = new Simulation(2026);
    const map = sim.terrainData();
    const treeIndex = map.kinds.findIndex(isFoliageKind);
    expect(treeIndex).toBeGreaterThanOrEqual(0);
    expect(map.terrain.blocked[treeIndex]).toBe(0);
    const soldier = sim.state.units.find((unit) => unit.team === 'friendly')!;
    const treeCol = treeIndex % map.terrain.cols;
    const treeRow = Math.floor(treeIndex / map.terrain.cols);
    soldier.pos = { x: (treeCol + 0.5) * map.terrain.cell, y: (treeRow + 0.5) * map.terrain.cell };
    expect(sim.terrainEffectsFor(soldier).speedMult).toBeLessThanOrEqual(CONFIG.treeCover.movementSpeedMult);

    const terrain: Terrain = { cell: 24, cols: 6, rows: 3, blocked: new Uint8Array(18) };
    const kinds = new Uint8Array(18);
    terrain.blocked.fill(1);
    for (const [col, kind] of [[2, TERRAIN_KIND.oak], [3, TERRAIN_KIND.beech], [4, TERRAIN_KIND.pine]] as const) {
      terrain.blocked[terrain.cols + col] = 0;
      kinds[terrain.cols + col] = kind;
    }
    terrain.blocked[terrain.cols + 1] = 0;
    terrain.blocked[terrain.cols + 5] = 0;
    const start = { x: 36, y: 36 };
    const end = { x: 132, y: 36 };
    expect(findPath(terrain, start, end).reachable).toBe(true);
    expect(hasLineOfSight(terrain, start, end)).toBe(true);
    expect(foliageAlongLine(terrain, kinds, start, end)).toBe(3);

    const weapon = getContent().weapons.rifle!;
    const clearShot = hitChance({ weapon, distance: 100, attackerXp: 0, attackerSuppression: 0, targetInCover: false, config: CONFIG });
    const throughTrees = hitChance({ weapon, distance: 100, attackerXp: 0, attackerSuppression: 0, targetInCover: false, lineFoliageCount: 3, config: CONFIG });
    const targetUnderTree = hitChance({ weapon, distance: 100, attackerXp: 0, attackerSuppression: 0, targetInCover: false, targetInFoliage: true, config: CONFIG });
    expect(throughTrees).toBeLessThan(clearShot);
    expect(targetUnderTree).toBeLessThan(clearShot);
  });

  it('cannot hit targets out of range or behind solid terrain', () => {
    const sim = new Simulation(3);
    sim.spawnEnemy('rifle', { x: 100, y: 20 });
    const shooter = sim.state.units[0]!;
    const enemy = sim.state.units.find((u) => u.team === 'enemy')!;
    const rifle = getContent().weapons['rifle']!;
    const far = dist(shooter.pos, enemy.pos);
    expect(far).toBeGreaterThan(rifle.range);
    // The simulation must not target or fire: run ticks and check no shots at that unit.
    const events: SimEvent[] = [];
    for (let i = 0; i < 90; i++) events.push(...sim.step());
    expect(events.filter((e) => e.type === 'shot' && e.targetId === enemy.id)).toHaveLength(0);
    expect(enemy.health).toBe(getContent().enemy['rifle'].health);

    // Blocker terrain test at the combat helper level (row-major grid).
    const terrain: Terrain = { cell: 24, cols: 6, rows: 6, blocked: new Uint8Array(36) };
    expect(hasLineOfSight(terrain, { x: 24, y: 24 }, { x: 132, y: 24 })).toBe(true);
    terrain.blocked[1 * 6 + 3] = 1; // wall cell between the two points
    expect(hasLineOfSight(terrain, { x: 24, y: 24 }, { x: 132, y: 24 })).toBe(false);
  });

  it('applies directional sandbag cover only from the correct side', () => {
    const bags = [{ id: 1, pos: { x: 480, y: 400 } }];
    expect(hasDirectionalCover(bags, { x: 482, y: 412 }, { x: 470, y: 200 }, CONFIG)).toBe(true);
    expect(hasDirectionalCover(bags, { x: 482, y: 412 }, { x: 470, y: 600 }, CONFIG)).toBe(false);
    expect(hasDirectionalCover(bags, { x: 482, y: 390 }, { x: 470, y: 200 }, CONFIG)).toBe(false);
    expect(hasDirectionalCover(bags, { x: 700, y: 412 }, { x: 470, y: 200 }, CONFIG)).toBe(false);

    const weapon = getContent().weapons['rifle']!;
    const covered = hitChance({ weapon, distance: 100, attackerXp: 0, attackerSuppression: 0, targetInCover: true, config: CONFIG });
    const exposed = hitChance({ weapon, distance: 100, attackerXp: 0, attackerSuppression: 0, targetInCover: false, config: CONFIG });
    expect(covered).toBeLessThan(exposed);
    const far = hitChance({ weapon, distance: 190, attackerXp: 0, attackerSuppression: 0, targetInCover: false, config: CONFIG });
    expect(far).toBeLessThan(exposed);
    // Soft ground spoils the shot on top of everything else.
    const bogged = hitChance({
      weapon, distance: 100, attackerXp: 0, attackerSuppression: 0, targetInCover: false,
      attackerGroundAccuracyMult: CONFIG.terrain.effects.mud.accuracyMult, config: CONFIG,
    });
    expect(bogged).toBeLessThan(exposed);
  });
});

/**
 * Soft ground: a wadeable river and mud patches. Both are passable everywhere
 * and block nothing, so they are the cost of the ground rather than its shape.
 */
describe('river and mud', () => {
  /** The first unblocked cell of a given kind, or null when the map has none. */
  function findCell(seed: number, kind: number): { x: number; y: number } | null {
    const data = generateTerrain(seed);
    const { terrain, kinds } = data;
    // Keep movement fixtures beyond the exit band, where stepping starts a new map.
    const firstRow = Math.floor(CONFIG.crossing.thresholdY / terrain.cell) + 1;
    for (let row = firstRow; row < terrain.rows; row++) {
      for (let col = 0; col < terrain.cols; col++) {
        const idx = row * terrain.cols + col;
        if (kinds[idx] === kind && terrain.blocked[idx] === 0) {
          return { x: col * terrain.cell + terrain.cell / 2, y: row * terrain.cell + terrain.cell / 2 };
        }
      }
    }
    return null;
  }

  /** Cells on firm ground, found rather than assumed: the water moves per seed. */
  function firmCells(seed: number, maxRadiusCells = 3): { x: number; y: number }[] {
    const data = generateTerrain(seed);
    const { terrain, kinds } = data;
    const out: { x: number; y: number }[] = [];
    for (let row = maxRadiusCells; row < terrain.rows - maxRadiusCells; row++) {
      for (let col = maxRadiusCells; col < terrain.cols - maxRadiusCells; col++) {
        const idx = row * terrain.cols + col;
        if (terrain.blocked[idx] !== 0) continue;
        if (isFoliageKind(kinds[idx]!)) continue;
        const pos = { x: col * terrain.cell + terrain.cell / 2, y: row * terrain.cell + terrain.cell / 2 };
        // Painted cells can overlap roads, bridges, or the edge of a soft-ground zone.
        const effects = terrainEffectsAt(data.zones, seed, pos);
        if (effects.speedMult !== 1 || effects.accuracyMult !== 1 || effects.reloadMult !== 1) continue;
        out.push(pos);
      }
    }
    return out;
  }

  /** A seed whose map has a river, and one that does not. */
  function findSeedWithRiver(wantRiver: boolean): number {
    for (let seed = 1; seed <= 400; seed++) {
      if ((generateTerrain(seed).zones.river !== null) === wantRiver) return seed;
    }
    throw new Error(`no seed with river=${wantRiver} in range`);
  }

  /**
   * The centre of the map's largest mud patch. A cell picked by scanning can sit
   * right on a patch edge, where a soldier walking away is back on firm ground
   * within a few ticks; the centre of the biggest patch cannot be left quickly.
   */
  function deepestMud(seed: number): { x: number; y: number } {
    const zones = generateTerrain(seed).zones;
    if (zones.mud.length === 0) throw new Error(`seed ${seed} has no mud`);
    const widest = zones.mud.reduce((best, patch) => (patch.halfWidth > best.halfWidth ? patch : best));
    return { x: widest.cx, y: widest.cy };
  }

  /** One soldier, alone on the map, standing where it was put. */
  function loneSoldier(seed: number, at: { x: number; y: number }): { sim: Simulation; soldier: Unit } {
    const sim = new Simulation(seed);
    // Isolate the base ground tuning from the additional wet-ground penalty.
    sim.state.weather = 'clear'; sim.state.weatherChangeTick = 100_000;
    const soldier = sim.state.units[0]!;
    // Interference from the rest of the squad - separation shoves and suppressive
    // fire aimed at someone else - would make a movement measurement noisy.
    sim.state.units = [soldier];
    soldier.pos = { x: at.x, y: at.y };
    soldier.prevPos = { ...soldier.pos };
    soldier.path = [];
    soldier.moveGoal = null;
    soldier.morale = 100;
    return { sim, soldier };
  }

  it('gives some maps a river and some maps none, always with mud either way', () => {
    let withRiver = 0;
    let dry = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const data = generateTerrain(seed);
      const { terrain, kinds, zones } = data;
      let riverCells = 0;
      let mudCells = 0;
      for (let idx = 0; idx < kinds.length; idx++) {
        const kind = kinds[idx]!;
        if (kind === TERRAIN_KIND.river) riverCells++;
        if (kind === TERRAIN_KIND.mud) mudCells++;
        if (kind !== TERRAIN_KIND.river && kind !== TERRAIN_KIND.mud) continue;
        // Soft ground is passable by definition: an obstacle on it would turn a
        // hazard into the wall the design explicitly rules out.
        expect(terrain.blocked[idx]).toBe(0);
      }
      // The zone and the painted cells agree: a river is either fully present or
      // fully absent, never declared and then not drawn.
      if (zones.river === null) {
        dry++;
        expect(riverCells).toBe(0);
      } else {
        withRiver++;
        expect(riverCells).toBeGreaterThan(0);
        expect(zones.river.halfWidth).toBeGreaterThan(0);
      }
      // Every battlefield has some soft ground: mud is not optional, so a dry map
      // is still ground worth reading rather than a plain field.
      expect(zones.mud.length).toBeGreaterThan(0);
      expect(mudCells).toBeGreaterThan(0);
    }
    // Both outcomes have to actually occur, or this is not randomisation.
    expect(withRiver).toBeGreaterThan(0);
    expect(dry).toBeGreaterThan(0);
    // And roughly in the configured proportion.
    const share = withRiver / 120;
    expect(share).toBeGreaterThan(CONFIG.terrain.river.presenceChance - 0.2);
    expect(share).toBeLessThan(CONFIG.terrain.river.presenceChance + 0.2);
  }, 120_000); // Keep all 120 landscapes in the sweep under parallel load.

  it('never marks a blocked cell as water or mud', () => {
    for (const seed of [11, 88, 777]) {
      const data = generateTerrain(seed);
      for (let idx = 0; idx < data.kinds.length; idx++) {
        if (data.terrain.blocked[idx] !== 1) continue;
        expect(data.kinds[idx]).not.toBe(TERRAIN_KIND.river);
        expect(data.kinds[idx]).not.toBe(TERRAIN_KIND.mud);
      }
    }
  });

  it('reports the configured penalty for the ground a position is on', () => {
    const seed = findSeedWithRiver(true);
    const river = findCell(seed, TERRAIN_KIND.river);
    const mud = findCell(seed, TERRAIN_KIND.mud);
    const firm = firmCells(seed)[0];
    expect(river).not.toBeNull();
    expect(mud).not.toBeNull();
    expect(firm).toBeDefined();
    const zones = generateTerrain(seed).zones;

    expect(terrainEffectsAt(zones, seed, river!)).toEqual(CONFIG.terrain.effects.river);
    expect(terrainEffectsAt(zones, seed, mud!)).toEqual(CONFIG.terrain.effects.mud);
    expect(terrainEffectsAt(zones, seed, firm!)).toEqual({ speedMult: 1, accuracyMult: 1, reloadMult: 1 });

    // Deep mud is the worse ground of the two.
    expect(CONFIG.terrain.effects.mud.speedMult).toBeLessThan(CONFIG.terrain.effects.river.speedMult);
    expect(CONFIG.terrain.effects.mud.reloadMult).toBeGreaterThan(CONFIG.terrain.effects.river.reloadMult);
  });

  it('keeps maps without rivers dry and ordinary firm ground unmodified', () => {
    const seed = findSeedWithRiver(false);
    const data = generateTerrain(seed);
    expect(data.zones.river).toBeNull();
    // Nothing in the kinds grid claims to be water, and no position reports the
    // river penalty, so a dry map really is dry.
    for (const kind of data.kinds) expect(kind).not.toBe(TERRAIN_KIND.river);
    for (const cell of firmCells(seed).slice(0, 40)) {
      expect(terrainEffectsAt(data.zones, seed, cell)).toEqual({ speedMult: 1, accuracyMult: 1, reloadMult: 1 });
    }
  });

  it('slows a soldier who wades and bogs down one in mud, in proportion to the tuning', () => {
    const seed = findSeedWithRiver(true);
    const river = findCell(seed, TERRAIN_KIND.river);
    const mud = deepestMud(seed);
    const firm = firmCells(seed)[0];
    expect(river).not.toBeNull();
    expect(firm).toBeDefined();

    /**
     * How far a lone soldier walks in a fixed number of ticks from a starting
     * point. Distance rather than time-to-arrive, because an order is snapped to
     * a cell centre and a soldier rightly stops exactly there.
     */
    const distanceIn = (from: { x: number; y: number }, ticks: number): number => {
      const { sim, soldier } = loneSoldier(seed, from);
      const order = sim.command({ type: 'move', unitId: soldier.id, pos: { x: from.x, y: from.y + 200 } });
      expect(order.ok).toBe(true);
      // Measure actual travel, including diagonal steps around terrain. A new
      // layout must not change a speed assertion through its path direction.
      let travelled = 0;
      for (let i = 0; i < ticks; i++) {
        const before = { ...soldier.pos };
        sim.step();
        travelled += Math.hypot(soldier.pos.x - before.x, soldier.pos.y - before.y);
      }
      return travelled;
    };

    // A short window, so the soldier stays inside the soft ground it started in
    // and the measurement is of that ground rather than of leaving it.
    const window = 15;
    const waterMoved = distanceIn(river!, window);
    const mudMoved = distanceIn(mud!, window);
    const firmMoved = distanceIn(firm!, window);
    expect(firmMoved).toBeGreaterThan(0);
    expect(waterMoved).toBeGreaterThan(0);
    expect(mudMoved).toBeGreaterThan(0);

    // Firm ground is the baseline; both soft grounds cost distance, in the ratio
    // the tuning asks for.
    expect(waterMoved / firmMoved).toBeCloseTo(CONFIG.terrain.effects.river.speedMult, 1);
    expect(mudMoved / firmMoved).toBeCloseTo(CONFIG.terrain.effects.mud.speedMult, 1);
    expect(mudMoved).toBeLessThan(waterMoved);
  });

  it('applies the soft-ground penalty to reload as well as movement', () => {
    const seed = findSeedWithRiver(true);
    const river = findCell(seed, TERRAIN_KIND.river);
    const mud = findCell(seed, TERRAIN_KIND.mud);
    const firm = firmCells(seed)[0];
    expect(river).not.toBeNull();
    expect(mud).not.toBeNull();
    expect(firm).toBeDefined();
    const weapon = getContent().weapons['rifle']!;

    const reloadAt = (at: { x: number; y: number }): number => {
      const { sim, soldier } = loneSoldier(seed, at);
      return sim.reloadTicksFor(soldier, weapon);
    };

    const firmReload = reloadAt(firm!);
    expect(reloadAt(river!)).toBeGreaterThan(firmReload);
    expect(reloadAt(mud!)).toBeGreaterThan(reloadAt(river!));
    // The multiplier is applied to the weapon's own reload, not invented.
    expect(reloadAt(river!)).toBe(Math.round(firmReload * CONFIG.terrain.effects.river.reloadMult));
  });

  it('spoils the aim of a soldier standing in soft ground', () => {
    const seed = findSeedWithRiver(true);
    const mud = findCell(seed, TERRAIN_KIND.mud);
    const firm = firmCells(seed)[0];
    expect(mud).not.toBeNull();
    expect(firm).toBeDefined();
    const weapon = getContent().weapons['rifle']!;

    const chanceAt = (at: { x: number; y: number }): number => {
      const { sim, soldier } = loneSoldier(seed, at);
      return hitChance({
        weapon,
        distance: 120,
        attackerXp: soldier.xp,
        attackerAccuracySkill: soldier.accuracySkill,
        attackerMorale: soldier.morale,
        attackerSuppression: soldier.suppression,
        targetInCover: false,
        attackerGroundAccuracyMult: sim.terrainEffectsFor(soldier).accuracyMult,
        config: CONFIG,
      });
    };

    // Same soldier, same range, same target: only the ground differs.
    expect(chanceAt(mud!)).toBeLessThan(chanceAt(firm!));
  });
});

describe('suppression and pausing', () => {
  it('pins units and recovers through the configured hysteresis', () => {
    const sim = new Simulation(11);
    const unit = sim.state.units[0]!;
    // Check the base hysteresis independently of personal resolve.
    delete unit.attributes;
    // Decay runs before the pin check, so pre-arm above the threshold.
    unit.suppression = CONFIG.suppression.pinThreshold + CONFIG.suppression.decayPerTick;
    sim.step();
    expect(unit.pinned).toBe(true);

    // Pinned units neither move nor keep movement orders.
    unit.path = [{ x: unit.pos.x + 60, y: unit.pos.y }];
    const pos = { ...unit.pos };
    sim.step();
    expect(unit.pos.x).toBeCloseTo(pos.x);
    expect(unit.path).toHaveLength(0);

    // Recovery requires dropping below the lower threshold.
    const ticksToRecover = Math.ceil((CONFIG.suppression.pinThreshold - CONFIG.suppression.recoverThreshold) / CONFIG.suppression.decayPerTick) + 2;
    for (let i = 0; i < ticksToRecover; i++) sim.step();
    expect(unit.pinned).toBe(false);

    // Between the two thresholds the unit stays unpinned (hysteresis).
    unit.suppression = (CONFIG.suppression.recoverThreshold + CONFIG.suppression.pinThreshold) / 2;
    sim.step();
    expect(unit.pinned).toBe(false);
    unit.suppression = CONFIG.suppression.pinThreshold + CONFIG.suppression.decayPerTick;
    sim.step();
    expect(unit.pinned).toBe(true);
  });

  it('freezes all gameplay clocks while paused', () => {
    const sim = new Simulation(11);
    sim.state.scheduler.prepTicksLeft = 100;
    sim.paused = true;
    const ticks = sim.state.ticks;
    expect(sim.step()).toEqual([]);
    expect(sim.state.ticks).toBe(ticks);
    expect(sim.state.scheduler.prepTicksLeft).toBe(100);
    // Orders are rejected while paused.
    expect(sim.command({ type: 'move', unitId: 1, pos: { x: 400, y: 650 } }).ok).toBe(false);
  });
});

describe('medic', () => {
  it('heals within range, respects cooldown and max health, and ignores the dead', () => {
    const sim = new Simulation(5);
    expect(sim.command({ type: 'recruit', role: 'medic', pos: { x: 400, y: 650 } }).ok).toBe(true);
    const medic = sim.state.units[sim.state.units.length - 1]!;
    const wounded = sim.state.units[0]!;
    wounded.pos = { x: medic.pos.x + 25, y: medic.pos.y };
    wounded.health = 50;

    sim.step();
    expect(wounded.health).toBe(75);
    expect(medic.healTimer).toBeGreaterThan(0);

    // Cooldown blocks an immediate second heal.
    sim.step();
    expect(wounded.health).toBe(75);

    // Max health is clamped.
    medic.healTimer = 0;
    wounded.health = 95;
    sim.step();
    expect(wounded.health).toBe(100);

    // Dead friendlies are never healed.
    medic.healTimer = 0;
    wounded.health = 0;
    sim.step();
    expect(wounded.health).toBe(0);
  });

  it('moves toward wounded soldiers within seek range', () => {
    const sim = new Simulation(5);
    expect(sim.command({ type: 'recruit', role: 'medic', pos: { x: 400, y: 650 } }).ok).toBe(true);
    const medic = sim.state.units[sim.state.units.length - 1]!;
    const wounded = sim.state.units[0]!;
    wounded.pos = { x: medic.pos.x + 120, y: medic.pos.y };
    wounded.health = 40;
    const startDist = Math.abs(wounded.pos.x - medic.pos.x);
    for (let i = 0; i < 60; i++) sim.step();
    const endDist = Math.hypot(wounded.pos.x - medic.pos.x, wounded.pos.y - medic.pos.y);
    expect(endDist).toBeLessThan(startDist);
  });
});

describe('armor and splash', () => {
  it('differentiates anti-armor damage from small arms against vehicles', () => {
    const content = getContent();
    const sim = new Simulation(2);
    sim.spawnEnemy('vehicle', { x: 480, y: 300 });
    const vehicle = sim.state.units.find((u) => u.role === 'vehicle')!;
    const rifle = content.weapons['rifle']!;
    const at = content.weapons['at']!;

    const rifleHit = applyDamageToUnit(content, vehicle, rifle.damage, rifle.armorMult);
    expect(rifleHit.damageDealt).toBeCloseTo(rifle.damage * rifle.armorMult, 5);
    const atHit = applyDamageToUnit(content, vehicle, at.damage, at.armorMult);
    expect(atHit.damageDealt).toBeGreaterThan(rifleHit.damageDealt * 5);
  });

  it('applies splash to both sides exactly once per impact', () => {
    const sim = new Simulation(2);
    sim.spawnEnemy('rifle', { x: 480, y: 430 });
    const friendly = sim.state.units[0]!;
    friendly.pos = { x: 480, y: 400 };
    const enemy = sim.state.units.find((u) => u.team === 'enemy')!;
    enemy.reloadTimer = 500; // keep the enemy from firing during the test
    const hpF = friendly.health;
    const hpE = enemy.health;

    sim.state.strikes.push({
      id: 999,
      pos: { x: 480, y: 415 },
      landTick: sim.state.ticks + 1,
      radius: 60,
      damage: 40,
      suppressionAmount: 10,
    });

    sim.step();
    expect(friendly.health).toBe(hpF - 40);
    expect(enemy.health).toBe(hpE - 40);

    sim.step();
    expect(friendly.health).toBe(hpF - 40);
    expect(enemy.health).toBe(hpE - 40);
  });
});

describe('Axis artillery', () => {
  /**
   * Put the run on a named wave with the fight under way, so a battery is
   * eligible to fire. The Axis have to be on the field: a wave in preparation is
   * deliberately not a barrage window.
   */
  const atWave = (sim: Simulation, waveIndex: number): void => {
    sim.state.scheduler.waveIndex = waveIndex;
    sim.state.scheduler.phase = 'spawning';
    sim.state.scheduler.spawnQueue = ['rifle'];
    sim.state.scheduler.spawnTimer = 100_000;
    sim.spawnEnemy('rifle', { x: 480, y: 40 });
    // Late-wave counter-battery missions require a living observer with sight
    // of the defended line.
    sim.spawnEnemy('observer', { x: 480, y: 500 });
    sim.state.units.find((unit) => unit.team === 'enemy' && unit.role === 'observer')!.health = 100_000;
    // This fixture measures the wave gate: keep its observer eligible rather
    // than letting a particular map's cover or the friendly squad pin him.
    sim.state.weather = 'clear';
    for (const unit of sim.state.units) unit.reloadTimer = 100_000;
    for (let row = 19; row < sim.state.terrain.rows; row++) {
      for (let col = 18; col <= 23; col++) sim.state.terrain.blocked[row * sim.state.terrain.cols + col] = 0;
    }
  };

  /** The wave gate is a per-map counter, so the first eligible wave is the configured one. */
  const firstWave = CONFIG.enemyArtillery.firstWaveWithBarrage;

  it('stays silent until the configured wave, then opens fire under way', () => {
    const early = new Simulation(3);
    atWave(early, firstWave - 2);
    let earlyIncoming = 0;
    for (let t = 0; t < 3000; t++) {
      early.state.units.find((unit) => unit.role === 'observer')!.pos = { x: 480, y: 500 };
      early.state.weather = 'clear';
      earlyIncoming += early.step().filter((ev) => ev.type === 'enemyBarrageIncoming').length;
    }
    expect(earlyIncoming).toBe(0);
    expect(early.state.strikes).toEqual([]);
    expect(early.state.enemyArtilleryCooldown).toBe(0);

    const late = new Simulation(3);
    atWave(late, firstWave - 1);
    let incoming: SimEvent | null = null;
    for (let t = 0; t < 3000 && incoming === null; t++) {
      late.state.units.find((unit) => unit.role === 'observer')!.pos = { x: 480, y: 500 };
      late.state.weather = 'clear';
      incoming = late.step().find((ev) => ev.type === 'enemyBarrageIncoming') ?? null;
    }
    expect(incoming).not.toBeNull();
    const shells = incoming!.type === 'enemyBarrageIncoming' ? incoming!.shells : 0;
    expect(shells).toBeGreaterThanOrEqual(CONFIG.enemyArtillery.shellsMin);
    expect(late.state.strikes.length).toBe(shells);
    // Every shell is an Axis shell and still in the air.
    for (const strike of late.state.strikes) {
      expect(strike.source).toBe('enemy');
      expect(strike.landTick).toBeGreaterThan(late.state.ticks);
      expect(strike.damage).toBe(CONFIG.artillery.damage);
      expect(strike.radius).toBe(CONFIG.artillery.radius);
    }
  });

  it('never fires in the preparation period of its own wave', () => {
    const sim = new Simulation(3);
    sim.state.scheduler.waveIndex = firstWave - 1;
    sim.state.scheduler.phase = 'prep';
    sim.state.scheduler.prepTicksLeft = 100_000;
    sim.state.enemyArtilleryCooldown = 0;
    for (let t = 0; t < 3000; t++) sim.step();
    expect(sim.state.strikes).toEqual([]);
  });

  it('reloads for the configured time after a mission instead of firing at will', () => {
    const sim = new Simulation(3);
    atWave(sim, 14);
    const aim = sim.state.units.find((u) => u.team === 'friendly')!;
    const orderedAt = sim.state.ticks;
    const strikes = sim.fireEnemyBarrage(aim, 15);
    const spacing = sec(CONFIG.enemyArtillery.shellSpacingSeconds);
    strikes.forEach((strike, index) => {
      expect(strike.landTick).toBe(orderedAt + sec(CONFIG.artillery.delaySeconds) + index * spacing);
    });
    expect(sim.state.enemyArtilleryCooldown).toBeGreaterThanOrEqual(sec(CONFIG.enemyArtillery.cooldownSecondsMin));
    expect(sim.state.enemyArtilleryCooldown).toBeLessThanOrEqual(sec(CONFIG.enemyArtillery.cooldownSecondsMax));

    // The battery is spent: over the whole reload nothing else is scheduled,
    // however long the wave drags on, and the counter runs down a tick at a time.
    const isEnemyBarrage = (s: SimSnapshot['strikes'][number]): boolean => s.source === 'enemy';
    const inFlight = sim.state.strikes.filter(isEnemyBarrage).length;
    const cooldown = sim.state.enemyArtilleryCooldown;
    for (let t = 1; t < cooldown; t++) {
      const before = sim.state.strikes.filter(isEnemyBarrage).length;
      sim.step();
      // Shells may land, but none may be added: a new mission would appear here.
      expect(sim.state.strikes.filter(isEnemyBarrage).length).toBeLessThanOrEqual(before);
      expect(sim.state.enemyArtilleryCooldown).toBe(cooldown - t);
    }
    expect(inFlight).toBeGreaterThan(0);
  });

  it('aims at the squad and tightens as the campaign goes on', () => {
    const sim = new Simulation(11);
    atWave(sim, 1);
    const aim = sim.state.units.find((u) => u.team === 'friendly')!;
    const tuning = CONFIG.enemyArtillery;
    // The wave gate is the caller's job, so the geometry can be sampled across
    // the whole curve here: aim tightens from the loosest to the tightest value.
    const reaches = (wave: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 200; i++) {
        for (const strike of sim.fireEnemyBarrage(aim, wave, 1)) out.push(dist(strike.pos, aim.pos));
      }
      return out;
    };
    const first = reaches(firstWave);
    const last = reaches(tuning.scatterWave);
    expect(Math.max(...first)).toBeGreaterThan(Math.max(...last));
    expect(Math.max(...first)).toBeLessThanOrEqual(tuning.scatterAtFirstWave + 1);
    expect(Math.min(...first)).toBeGreaterThanOrEqual(tuning.scatterAtFirstWave * 0.35 - 1);
    expect(Math.max(...last)).toBeLessThanOrEqual(tuning.scatterAtLastWave + 1);
    // Never walked onto the Axis' own approach.
    for (const strike of sim.state.strikes) expect(strike.pos.y).toBeGreaterThanOrEqual(tuning.minLandY);
  });

  it('grows the fire mission with the wave, within its caps', () => {
    const sim = new Simulation(5);
    atWave(sim, 1);
    const aim = sim.state.units.find((u) => u.team === 'friendly')!;
    const tuning = CONFIG.enemyArtillery;
    /** The largest mission the configuration allows on a given wave. */
    const ceiling = (wave: number): number => Math.min(
      tuning.maxShells,
      tuning.shellsMax + Math.floor(Math.max(0, wave - firstWave) / tuning.shellGrowthEveryWaves),
    );
    for (const wave of [firstWave, 12, 15, 40]) {
      const allowed = ceiling(wave);
      let observed = 0;
      for (let i = 0; i < 200; i++) {
        const shells = sim.fireEnemyBarrage(aim, wave).length;
        expect(shells).toBeGreaterThanOrEqual(tuning.shellsMin);
        expect(shells).toBeLessThanOrEqual(allowed);
        observed = Math.max(observed, shells);
      }
      // The ceiling is reached rather than being a cap that is never approached.
      expect(observed).toBe(allowed);
    }
  });

  it('hits both sides, because a shell does not care whose guns fired it', () => {
    const sim = new Simulation(7);
    atWave(sim, 1);
    const friendly = sim.state.units.find((u) => u.team === 'friendly')!;
    const hostile = sim.state.units.find((u) => u.team === 'enemy')!;
    // Everything within the blast stands together, so one shell catches both.
    friendly.pos = { x: 480, y: 400 };
    hostile.pos = { x: 490, y: 404 };
    hostile.reloadTimer = 100_000;
    const friendlyHealth = friendly.health;
    const hostileHealth = hostile.health;

    const [strike] = sim.fireEnemyBarrage(friendly, firstWave, 1);
    strike!.pos = { x: 485, y: 402 };
    strike!.landTick = sim.state.ticks + 1;
    const events = sim.step();
    expect(events.some((ev) => ev.type === 'artilleryImpact')).toBe(true);
    expect(friendly.health).toBeLessThan(friendlyHealth);
    expect(hostile.health).toBeLessThan(hostileHealth);
    // The shell is gone, so it cannot apply its damage twice.
    sim.step();
    expect(sim.state.strikes.some((s) => s.id === strike!.id)).toBe(false);
  });

  it('survives a save and a reload, cooldown and shells in flight included', () => {
    const sim = new Simulation(21);
    atWave(sim, 14);
    const aim = sim.state.units.find((u) => u.team === 'friendly')!;
    sim.fireEnemyBarrage(aim, 15);

    const snap = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    expect(snap.enemyArtilleryCooldown).toBe(sim.state.enemyArtilleryCooldown);
    expect(snap.strikes.some((s) => s.source === 'enemy')).toBe(true);
    const restored = Simulation.fromSnapshot(snap);
    expect(restored.state.enemyArtilleryCooldown).toBe(sim.state.enemyArtilleryCooldown);
    expect(restored.snapshot()).toEqual(sim.snapshot());
  });
});

describe('weapon upgrade time', () => {
  const upgradeSeconds = CONFIG.weaponUpgrades.upgradeSeconds;

  /** A soldier and a hostile standing close together in open ground. */
  const duel = (seed = 5): { sim: Simulation; soldier: Unit; enemy: Unit } => {
    const sim = new Simulation(seed);
    const soldier = sim.state.units[0]!;
    soldier.pos = { x: 480, y: 600 };
    soldier.prevPos = { x: 480, y: 600 };
    sim.spawnEnemy('rifle', { x: 480, y: 470 });
    const enemy = sim.state.units.find((u) => u.team === 'enemy')!;
    enemy.health = 100_000; // the target must survive until the upgrade finishes
    enemy.reloadTimer = 1e6; // keep him from answering, so the test is one-sided
    return { sim, soldier, enemy };
  };

  /** Run a handful of ticks and report how many rounds the named soldier fired. */
  const shotsBy = (sim: Simulation, id: number, ticks = 45): number => {
    let fired = 0;
    for (let t = 0; t < ticks; t++) {
      const enemy = sim.state.units.find((u) => u.team === 'enemy');
      if (enemy !== undefined) {
        enemy.reloadTimer = 1e6;
        enemy.pos = { x: 480, y: 470 }; // hold him still, so range is constant
        enemy.path = [];
      }
      for (const ev of sim.step()) {
        if (ev.type === 'shot' && ev.shooterId === id) fired++;
      }
    }
    return fired;
  };

  it('starts every soldier with a weapon in one piece and no work pending', () => {
    const { sim, soldier } = duel();
    expect(sim.upgradeTicksLeft(soldier)).toBe(0);
  });

  it('puts the weapon out of action for the configured time when an upgrade is bought', () => {
    const { sim, soldier } = duel();
    sim.state.points = 100;
    const result = sim.purchaseWeaponUpgrade(soldier.id, 'accuracy');
    expect(result.ok).toBe(true);
    // The benefit is banked at once; only the weapon is out of action.
    expect(soldier.weaponUpgrades.accuracy).toBe(1);
    expect(sim.upgradeTicksLeft(soldier)).toBe(sec(upgradeSeconds));

    // And the work is announced, so the coming silence is explained.
    sim.state.points = 100;
    const again = sim.purchaseWeaponUpgrade(soldier.id, 'damage');
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/working on his weapon/);
    expect(soldier.weaponUpgrades.damage).toBe(0); // nothing bought, nothing spent
    expect(sim.state.points).toBe(100);
  });

  it('holds fire while the weapon is in pieces, then shoots again once it is together', () => {
    const { sim, soldier } = duel();
    sim.state.points = 100;

    // Baseline: he engages normally.
    expect(shotsBy(sim, soldier.id)).toBeGreaterThan(0);

    // Now with a weapon in pieces: the same setup produces no fire at all.
    soldier.reloadTimer = 0;
    soldier.burstRemaining = 0;
    soldier.shotTimer = 0;
    expect(sim.purchaseWeaponUpgrade(soldier.id, 'reload').ok).toBe(true);
    const window = sim.upgradeTicksLeft(soldier);
    expect(shotsBy(sim, soldier.id, window - 1)).toBe(0);
    // Before that last tick the weapon is still in pieces, so the silence holds;
    // the tick that finishes the work is also the tick he may shoot again.
    expect(sim.upgradeTicksLeft(soldier)).toBe(1);
    const resumeTick = shotsBy(sim, soldier.id, 1);
    expect(sim.upgradeTicksLeft(soldier)).toBe(0);
    // And from there he keeps firing like any other rifleman.
    expect(resumeTick + shotsBy(sim, soldier.id, 45)).toBeGreaterThan(0);
  });

  it('can still be walked behind cover while the upgrade is being fitted', () => {
    const { sim, soldier } = duel();
    sim.state.points = 100;
    expect(sim.purchaseWeaponUpgrade(soldier.id, 'accuracy').ok).toBe(true);

    // Movement is deliberately untouched: a soldier caught upgrading in the open
    // can be pulled back, he just cannot shoot on the way.
    const order = sim.command({ type: 'move', unitId: soldier.id, pos: { x: 300, y: 650 } });
    expect(order.ok).toBe(true);
    for (let t = 0; t < 20; t++) sim.step();
    expect(soldier.pos.x).toBeLessThan(480);
  });

  it('does not throw grenades either, because it is the same two hands', () => {
    const sim = new Simulation(5);
    const soldier = sim.state.units[0]!;
    soldier.pos = { x: 480, y: 600 };
    soldier.prevPos = { x: 480, y: 600 };
    // A cluster inside grenade range is exactly what a grenade is for.
    sim.spawnEnemy('rifle', { x: 470, y: 480 });
    sim.spawnEnemy('rifle', { x: 520, y: 486 });
    for (const unit of sim.state.units) {
      if (unit.team !== 'enemy') continue;
      unit.reloadTimer = 1e6;
      unit.path = [];
    }
    const thrown = (ticks: number): number => {
      let count = 0;
      for (let t = 0; t < ticks; t++) {
        for (const unit of sim.state.units) {
          if (unit.team !== 'enemy') continue;
          unit.reloadTimer = 1e6;
          unit.path = [];
        }
        for (const ev of sim.step()) {
          if (ev.type === 'grenadeThrown' && ev.unitId === soldier.id) count++;
        }
      }
      return count;
    };

    sim.state.points = 100;
    expect(sim.purchaseWeaponUpgrade(soldier.id, 'accuracy').ok).toBe(true);
    const grenades = soldier.grenades;
    expect(grenades).toBeGreaterThan(0);
    const window = sim.upgradeTicksLeft(soldier);
    expect(thrown(window - 1)).toBe(0);
    // The grenades are all still there: nothing was thrown, so nothing was spent.
    expect(soldier.grenades).toBe(grenades);
    expect(sim.upgradeTicksLeft(soldier)).toBe(1);
  });

  it('freezes the work while paused, and carries it through a save', () => {
    const { sim, soldier } = duel();
    sim.state.points = 100;
    expect(sim.purchaseWeaponUpgrade(soldier.id, 'accuracy').ok).toBe(true);
    const left = sim.upgradeTicksLeft(soldier);

    sim.paused = true;
    for (let t = 0; t < 30; t++) sim.step();
    expect(sim.upgradeTicksLeft(soldier)).toBe(left);
    sim.paused = false;

    // A reload mid-upgrade resumes with the same time still to serve.
    sim.step();
    const snap = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    expect(snap.units.find((u) => u.id === soldier.id)!.upgradeTimer).toBe(left - 1);
    const restored = Simulation.fromSnapshot(snap);
    expect(restored.upgradeTicksLeft(restored.state.units.find((u) => u.id === soldier.id)!)).toBe(left - 1);
  });

  it('has the weapon together again by the time the squad reaches the next map', () => {
    const sim = new Simulation(31);
    sim.state.points = 100;
    const squad = sim.state.units.filter((u) => u.team === 'friendly');
    expect(sim.purchaseWeaponUpgrade(squad[0]!.id, 'accuracy').ok).toBe(true);
    expect(sim.upgradeTicksLeft(squad[0]!)).toBeGreaterThan(0);

    // Walk the whole squad off the north edge; the upgrade timer must not march.
    for (const unit of squad) {
      unit.pos = { x: 300, y: CONFIG.crossing.thresholdY - 2 };
      unit.path = [];
    }
    for (let t = 0; t < 30 && sim.state.mapNumber === 1; t++) sim.step();
    expect(sim.state.mapNumber).toBe(2);
    for (const unit of sim.state.units) {
      expect(sim.upgradeTicksLeft(unit)).toBe(0);
    }
  });
});

describe('one-time transitions', () => {
  it('removes a breakthrough unit and damages integrity exactly once', () => {
    const sim = new Simulation(3);
    sim.spawnEnemy('rifle', { x: 480, y: CONFIG.breakthroughY + 1 });
    sim.step();
    expect(sim.state.integrity).toBe(CONFIG.start.integrity - 1);
    expect(sim.state.units.filter((u) => u.team === 'enemy')).toHaveLength(0);
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.state.integrity).toBe(CONFIG.start.integrity - 1);

    // Vehicles cost more integrity.
    sim.spawnEnemy('vehicle', { x: 480, y: CONFIG.breakthroughY + 1 });
    sim.step();
    expect(sim.state.integrity).toBe(CONFIG.start.integrity - 1 - 3);
  });

  it('ends the run on zero integrity exactly once', () => {
    const sim = new Simulation(3);
    sim.state.integrity = 1;
    sim.spawnEnemy('rifle', { x: 480, y: CONFIG.breakthroughY + 1 });
    const defeatEvents: SimEvent[] = [];
    defeatEvents.push(...sim.step());
    expect(sim.state.phase).toBe('defeat');
    expect(defeatEvents.filter((e) => e.type === 'defeat')).toHaveLength(1);
    // Further ticks stay frozen and must not re-announce the defeat.
    for (let i = 0; i < 3; i++) defeatEvents.push(...sim.step());
    expect(defeatEvents.filter((e) => e.type === 'defeat')).toHaveLength(1);
    expect(sim.step()).toEqual([]);
  });

  it('grants the wave-clear reward exactly once and can reach victory', () => {
    const sim = new Simulation(4);
    sim.state.scheduler.phase = 'active';
    sim.state.scheduler.spawnQueue = [];
    const points = sim.state.points;
    const score = sim.state.score;
    sim.step();
    expect(sim.state.points).toBe(points + CONFIG.rewards.waveClearBase + Math.floor(1 / CONFIG.rewards.waveClearPerLevels));
    expect(sim.state.score).toBe(score + CONFIG.rewards.waveClearBonusScore);
    expect(sim.state.scheduler.phase).toBe('prep');
    expect(sim.state.scheduler.waveIndex).toBe(1);

    // No double award while the next wave preps.
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.state.points).toBe(points + CONFIG.rewards.waveClearBase);

    // Clearing the last wave completes a sector; campaign victory comes from
    // marching the final captured sector clear.
    sim.state.scheduler.waveIndex = 14;
    sim.state.scheduler.phase = 'active';
    sim.state.scheduler.spawnQueue = [];
    sim.step();
    expect(sim.state.phase).toBe('running');
    sim.state.mapsCleared = CONFIG.crossing.campaignMaps - 1;
    sim.state.sectorCaptured = true;
    for (const unit of sim.state.units) if (unit.team === 'friendly') unit.pos.y = CONFIG.crossing.thresholdY;
    sim.step();
    expect(sim.state.phase).toBe('victory');
    expect(sim.step()).toEqual([]);
  });
});

describe('snapshot restore equivalence', () => {
  it('matches the uninterrupted run, including pending strikes and rng state', () => {
    const seed = 42;
    const early: ScriptAction[] = [
      { tick: 1, run: (s) => { s.state.units[0]!.role = 'radio_engineer'; } },
      { tick: 5, run: (s) => void s.command({ type: 'recruit', role: 'mg', pos: { x: 480, y: 660 } }) },
      { tick: 30, run: (s) => void s.command({ type: 'move', unitId: 1, pos: { x: 300, y: 650 } }) },
      { tick: 60, run: (s) => void s.command({ type: 'sandbag', pos: { x: 480, y: 520 } }) },
      { tick: 99, run: (s) => void (s.state.points += 20) },
      { tick: 100, run: (s) => void s.command({ type: 'artillery', pos: { x: 480, y: 300 } }) },
    ];
    const splitTick = 120;
    const laterActions: ScriptAction[] = [
      { tick: splitTick + 60, run: (s) => void s.command({ type: 'move', unitId: 1, pos: { x: 600, y: 650 } }) },
      { tick: splitTick + 120, run: (s) => void s.command({ type: 'sandbag', pos: { x: 640, y: 540 } }) },
    ];

    const full = scriptedRun(seed, splitTick + 200, [...early, ...laterActions]);

    const partial = scriptedRun(seed, splitTick, early);
    const midState = JSON.parse(JSON.stringify(partial.snapshot())) as SimSnapshot;
    expect(midState.strikes.length).toBeGreaterThan(0); // artillery shell in flight

    const resumed = Simulation.fromSnapshot(midState);
    let actionIdx = 0;
    for (let tick = splitTick + 1; tick <= splitTick + 200; tick++) {
      while (actionIdx < laterActions.length && laterActions[actionIdx]!.tick === tick) {
        laterActions[actionIdx]!.run(resumed);
        actionIdx++;
      }
      resumed.step();
    }

    expect(resumed.snapshot()).toEqual(full.snapshot());
  });
});

describe('endless continuation', () => {
  it('generates bounded waves past the authored list after victory', () => {
    const sim = new Simulation(8);
    // Finish the campaign before requesting endless continuation.
    sim.state.scheduler.waveIndex = 14;
    sim.state.scheduler.phase = 'active';
    sim.state.scheduler.spawnQueue = [];
    sim.step();
    sim.state.mapsCleared = CONFIG.crossing.campaignMaps - 1;
    sim.state.sectorCaptured = true;
    for (const unit of sim.state.units) if (unit.team === 'friendly') unit.pos.y = CONFIG.crossing.thresholdY;
    sim.step();
    expect(sim.state.phase).toBe('victory');

    expect(sim.continueEndless()).toBe(true);
    expect(sim.state.endless).toBe(true);
    expect(sim.state.phase).toBe('running');

    // Clear enemies independently of combat balance so this measures bounded
    // endless generation and progression on any landscape.
    let seenQueues: number[] = [];
    let lastWaveIndex = 14;
    let spawnedThisWave = 0;
    for (let t = 0; t < 60 * 30 * 30 && seenQueues.length < 3; t++) {
      if (sim.state.phase !== 'running') break;
      const s = sim.state;
      if (s.scheduler.phase === 'prep' && s.units.filter((u) => u.team === 'friendly').length < 12) {
        s.points = Math.max(s.points, 40);
        const atCount = s.units.filter((u) => u.role === 'at').length;
        const role: 'rifleman' | 'at' = atCount < 4 ? 'at' : 'rifleman';
        sim.command({ type: 'recruit', role, pos: { x: 300 + (t % 20) * 15, y: 630 } });
      }
      for (const unit of s.units) {
        if (unit.team === 'enemy') unit.health = 0;
        else unit.health = 100_000;
      }
      sim.step();
      const waveIndex = s.scheduler.waveIndex;
      if (waveIndex !== lastWaveIndex) {
        seenQueues.push(s.scheduler.spawnQueue.length);
        lastWaveIndex = waveIndex;
        spawnedThisWave = 0;
      }
      spawnedThisWave = Math.max(spawnedThisWave, s.units.filter((u) => u.team === 'enemy').length);
      expect(s.units.length).toBeLessThan(200);
    }
    expect(seenQueues.length).toBeGreaterThanOrEqual(2);
    for (const q of seenQueues) expect(q).toBeLessThanOrEqual(42); // 3 archetypes x endless cap 14
  }, 120_000);
});

/**
 * Marching north: the squad walks off the top edge, and the whole battle is
 * re-sited on a fresh battlefield with the wave counter back at 1. The player's
 * progress is the thing that survives; what was dug into the ground does not.
 */
describe('marching north to the next map', () => {
  /** Put a soldier on the exit strip so the next step carries it across. */
  function sendToEdge(sim: Simulation, unitId: number): void {
    const unit = sim.state.units.find((u) => u.id === unitId);
    if (unit === undefined) throw new Error(`no unit ${unitId}`);
    const { x } = unit.pos;
    unit.pos = { x, y: CONFIG.crossing.thresholdY };
    unit.prevPos = { x, y: CONFIG.crossing.thresholdY };
    unit.path = [];
    unit.moveGoal = null;
    unit.pinned = false;
  }

  function friendlies(sim: Simulation): Unit[] {
    return sim.state.units.filter((u) => u.team === 'friendly' && u.crossed !== true);
  }

  it('takes a soldier off the map when it reaches the northern edge', () => {
    const sim = new Simulation(31);
    const soldier = friendlies(sim)[0]!;
    expect(sim.crossedCount).toBe(0);

    sendToEdge(sim, soldier.id);
    const events = sim.step();

    // One tick, start to finish: the soldier leaves the field, so it can no
    // longer be shot at, ordered, or counted as a garrison.
    expect(events.some((e) => e.type === 'crossingBegan')).toBe(true);
    expect(events.filter((e) => e.type === 'unitCrossed')).toHaveLength(1);
    expect(sim.crossedCount).toBe(1);
    expect(sim.crossingCount).toBe(1);
    expect(sim.state.battleRecord.casualties).toBe(0);
    expect(sim.state.units.map((u) => u.id)).not.toContain(soldier.id);
    expect(sim.state.crossedUnits.map((u) => u.id)).toEqual([soldier.id]);
    expect(sim.state.crossedUnits[0]!.dead).toBe(false);
    expect(sim.state.crossedUnits[0]!.health).toBeGreaterThan(0);
    expect(sim.state.crossedUnits[0]!.pos.y).toBeLessThan(CONFIG.crossing.thresholdY);
  });

  it.each([false, true])('restocks hand grenades only on arrival at a new map (save/resume: %s)', (resume) => {
    let sim = new Simulation(31);
    sim.state.units = [];
    const roles = ['rifleman', 'engineer', 'mg', 'medic', 'at', 'sniper', 'radio_engineer'] as const;
    const loadouts = roles.map((role, index) => {
      const soldier = sim.spawnFriendly(role, { x: 200 + index * 60, y: 600 });
      const startingGrenades = soldier.grenades;
      soldier.grenades = role === 'engineer' ? 1 : 0;
      soldier.grenadeTimer = 100;
      soldier.service.grenadesThrown = startingGrenades - soldier.grenades;
      return { id: soldier.id, startingGrenades, grenadesThrown: soldier.service.grenadesThrown };
    });
    sim.step();
    expect(sim.state.units.find((unit) => unit.role === 'engineer')!.grenades).toBe(1);
    expect(sim.state.units.find((unit) => unit.role === 'rifleman')!.grenades).toBe(0);

    sendToEdge(sim, loadouts[0]!.id);
    sim.step();
    expect(sim.state.mapNumber).toBe(1);
    expect(sim.state.crossedUnits[0]!.grenades).toBe(0);
    if (resume) sim = Simulation.fromSnapshot(JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot);

    for (const soldier of friendlies(sim)) sendToEdge(sim, soldier.id);
    sim.step();
    expect(sim.state.mapNumber).toBe(2);
    for (const loadout of loadouts) {
      const soldier = sim.state.units.find((unit) => unit.id === loadout.id)!;
      expect(soldier.grenades).toBe(loadout.startingGrenades);
      expect(soldier.grenadeTimer).toBe(0);
      expect(soldier.service.grenadesThrown).toBe(loadout.grenadesThrown);
    }
  });

  it.each([1, 3])('keeps all soldiers when %s pinned marchers are still at the exit', (pinnedCount) => {
    const sim = new Simulation(31);
    const squad = friendlies(sim);
    const ids = squad.map((unit) => unit.id);
    for (const soldier of squad) sendToEdge(sim, soldier.id);
    for (const soldier of squad.slice(0, pinnedCount)) {
      soldier.pinned = true;
      soldier.suppression = CONFIG.suppression.max;
      soldier.health = 60;
      soldier.xp = 4;
      soldier.kills = 7;
      soldier.weaponUpgrades.damage = 2;
      soldier.service.grenadesThrown = 3;
    }

    expect(sim.step().some((event) => event.type === 'mapCleared')).toBe(false);
    expect(sim.state.mapNumber).toBe(1);
    expect(sim.state.units.filter((unit) => unit.crossed)).toHaveLength(pinnedCount);
    expect(sim.crossedCount).toBe(ids.length - pinnedCount);

    let arrivals = 0;
    for (let tick = 0; tick < 300 && sim.state.mapNumber === 1; tick++) {
      arrivals += sim.step().filter((event) => event.type === 'mapCleared').length;
    }
    expect(arrivals).toBe(1);
    expect(sim.state.mapNumber).toBe(2);
    expect(friendlies(sim).map((unit) => unit.id).sort((a, b) => a - b)).toEqual(ids);
    expect(sim.state.crossedUnits).toEqual([]);
    expect(sim.state.battleRecord.casualties).toBe(0);
    for (const soldier of squad.slice(0, pinnedCount)) {
      expect(friendlies(sim).find((unit) => unit.id === soldier.id)).toMatchObject({
        health: 60, xp: 4, kills: 7, weaponUpgrades: { damage: 2 },
        service: { grenadesThrown: 3 }, dead: false, crossed: false,
      });
    }
  });

  it('holds the abandoned map once a soldier has crossed', () => {
    const sim = new Simulation(32);
    sendToEdge(sim, friendlies(sim)[0]!.id);
    sim.step();

    // The wave scheduler freezes where it stood, so the map can no longer start a
    // wave, pay a clear reward, or count toward the campaign.
    expect(sim.state.scheduler.phase).toBe('crossing');
    expect(sim.state.scheduler.spawnQueue).toEqual([]);

    const points = sim.state.points;
    const waveIndex = sim.state.scheduler.waveIndex;
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.state.scheduler.waveIndex).toBe(waveIndex);
    expect(sim.state.points).toBe(points);
  });

  it('generates a new battlefield and resets the wave counter once the whole squad is across', () => {
    const sim = new Simulation(2026);
    sim.state.sectorCaptured = true;
    // Ten waves of progress, points earned, and a veteran soldier to carry over.
    sim.state.scheduler.waveIndex = 9;
    sim.state.points = 41;
    sim.state.score = 300;
    sim.state.integrity = 13;
    const veteran = friendlies(sim)[0]!;
    veteran.xp = 4;
    veteran.kills = 7;
    veteran.weaponUpgrades.damage = 2;
    veteran.service.grenadesThrown = 3;
    veteran.health = 60;
    sim.state.sandbags.push({ id: 900, pos: { x: 300, y: 520 } });
    sim.state.trenches.push({ id: 901, pos: { x: 500, y: 500 } });
    sim.spawnEnemy('rifle', { x: 400, y: 200 });
    const oldSeed = sim.state.seed;
    const oldTerrain = Array.from(sim.state.terrain.blocked).join('');

    const ids = friendlies(sim).map((u) => u.id);
    for (const id of ids.slice(0, -1)) sendToEdge(sim, id);
    // The last soldier is still south of the exit band and has to be ordered in,
    // so the map only changes once the whole squad has actually walked out.
    const last = friendlies(sim).find((u) => u.id === ids[ids.length - 1]!)!;
    expect(last.pos.y).toBeGreaterThan(CONFIG.crossing.thresholdY);

    let sawMapCleared = false;
    for (let i = 0; i < 900 && !sawMapCleared; i++) {
      if (i % 40 === 0) {
        sim.command({ type: 'move', unitId: last.id, pos: { x: last.pos.x, y: CONFIG.crossing.thresholdY - 12 } });
      }
      sawMapCleared = sim.step().some((e) => e.type === 'mapCleared');
    }
    expect(sawMapCleared).toBe(true);

    const s = sim.state;
    // New map, wave 1, fresh battlefield.
    expect(s.mapNumber).toBe(2);
    expect(s.mapsCleared).toBe(1);
    expect(s.seed).not.toBe(oldSeed);
    expect(Array.from(s.terrain.blocked).join('')).not.toBe(oldTerrain);
    expect(s.scheduler.waveIndex).toBe(0);
    expect(s.scheduler.phase).toBe('prep');
    // The arrival window may already have ticked once on the transition tick,
    // depending on when the last soldier stepped off the map.
    expect(s.scheduler.prepTicksLeft).toBeGreaterThanOrEqual(sec(CONFIG.crossing.arrivalSeconds) - 1);
    expect(s.scheduler.prepTicksLeft).toBeLessThanOrEqual(sec(CONFIG.crossing.arrivalSeconds));

    // Player progress survives: soldiers, points, score, integrity.
    expect(s.points).toBe(41);
    expect(s.score).toBe(300);
    expect(s.integrity).toBe(13);
    const carried = friendlies(sim);
    expect(carried).toHaveLength(ids.length);
    const carriedVeteran = carried.find((u) => u.id === veteran.id)!;
    expect(carriedVeteran.xp).toBe(4);
    expect(carriedVeteran.kills).toBe(7);
    expect(carriedVeteran.weaponUpgrades.damage).toBe(2);
    expect(carriedVeteran.service.grenadesThrown).toBe(3);
    expect(carriedVeteran.health).toBe(60);

    // Everything dug into the old map, and the enemy holding it, is left behind.
    expect(s.sandbags).toEqual([]);
    expect(s.trenches).toEqual([]);
    expect(s.units.filter((u) => u.team === 'enemy')).toEqual([]);
    expect(s.crossedUnits).toEqual([]);

    // The squad arrives in the south, in the assembly area above the deployment
    // zone, on open ground and inside the field.
    for (const soldier of carried) {
      expect(soldier.pos.y).toBeLessThanOrEqual(CONFIG.assembly.endY);
      expect(soldier.pos.y).toBeGreaterThanOrEqual(CONFIG.assembly.startY - 1);
      expect(soldier.pos.x).toBeGreaterThan(0);
      expect(soldier.pos.x).toBeLessThan(CONFIG.field.width);
      expect(soldier.dead).toBe(false);
    }
    // Distinct arrival slots, so the squad does not re-form in one heap.
    expect(new Set(carried.map((u) => `${Math.round(u.pos.x)},${Math.round(u.pos.y)}`)).size).toBe(carried.length);
  });

  it('wins the campaign after the configured number of maps', () => {
    const sim = new Simulation(77);
    const goals = CONFIG.crossing.campaignMaps;
    for (let map = 1; map <= goals; map++) {
      expect(sim.state.mapNumber).toBe(map);
      sim.state.sectorCaptured = true;
      const ids = friendlies(sim).map((u) => u.id);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) sendToEdge(sim, id);
      // A whole squad reaching the edge is walked out and resolves to exactly one
      // completed map, never two in a single transition.
      let cleared = 0;
      let victory = false;
      let ticks = 0;
      while (cleared === 0 && ticks < 600) {
        const events = sim.step();
        cleared += events.filter((e) => e.type === 'mapCleared').length;
        victory = victory || events.some((e) => e.type === 'victory');
        ticks++;
      }
      expect(cleared).toBe(1);
      expect(sim.state.mapsCleared).toBe(map);
      if (map < goals) {
        expect(victory).toBe(false);
        expect(sim.state.phase).toBe('running');
      } else {
        expect(victory).toBe(true);
        expect(sim.state.phase).toBe('victory');
        expect(sim.state.mapsCleared).toBe(goals);
      }
    }
    // The line is only ever won by marching, so the run is over and frozen.
    expect(sim.step()).toEqual([]);
  });

  it('survives a snapshot round-trip with a squad split across two maps', () => {
    const sim = new Simulation(88);
    // Three soldiers march out; the fourth is still on the old map, so the save
    // has to carry a crossing in progress.
    const ids = friendlies(sim).map((u) => u.id);
    for (const id of ids.slice(0, -1)) sendToEdge(sim, id);
    const last = friendlies(sim).find((u) => u.id === ids[ids.length - 1]!)!;
    expect(last.pos.y).toBeGreaterThan(CONFIG.crossing.thresholdY);
    sim.step();
    expect(sim.crossedCount).toBe(3);
    expect(sim.state.mapNumber).toBe(1);
    expect(sim.state.scheduler.phase).toBe('crossing');

    const json = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    const restored = Simulation.fromSnapshot(json);
    expect(restored.snapshot()).toEqual(sim.snapshot());
    expect(restored.crossedCount).toBe(3);
    // The restored run stands on the same map and the same battlefield.
    expect(restored.state.mapNumber).toBe(1);
    expect(restored.state.seed).toBe(sim.state.seed);
    expect(restored.terrainData().settingId).toBe(sim.terrainData().settingId);
    expect(Array.from(restored.state.terrain.blocked)).toEqual(Array.from(sim.state.terrain.blocked));

    // Finishing the march produces the same next map as an uninterrupted run.
    const uninterrupted = Simulation.fromSnapshot(JSON.parse(JSON.stringify(json)) as SimSnapshot);
    for (const instance of [restored, uninterrupted]) {
      let steps = 0;
      while (instance.state.mapNumber === 1 && steps < 900) {
        // Order whoever is left to the exit band, exactly as a player would.
        if (steps % 40 === 0) {
          const straggler = instance.state.units.find((u) => u.team === 'friendly' && u.crossed !== true);
          if (straggler !== undefined) {
            instance.command({ type: 'move', unitId: straggler.id, pos: { x: straggler.pos.x, y: CONFIG.crossing.thresholdY - 12 } });
          }
        }
        instance.step();
        steps++;
      }
    }
    expect(restored.state.mapNumber).toBe(2);
    expect(restored.snapshot()).toEqual(uninterrupted.snapshot());
  });

  it('derives a distinct, stable battlefield seed for every map of a run', () => {
    const base = 4242;
    // Map 1 is the run seed itself, so a fresh run and a restored one agree.
    expect(mapTerrainSeed(base, 1)).toBe(base);
    const seeds = [1, 2, 3, 4, 5].map((n) => mapTerrainSeed(base, n));
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const seed of seeds) {
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(seed)).toBe(true);
    }
    // Deterministic: the same run seed always produces the same maps.
    expect(mapTerrainSeed(base, 3)).toBe(mapTerrainSeed(base, 3));
    // A different run seed does not collide on the same map index.
    expect(mapTerrainSeed(base + 1, 2)).not.toBe(mapTerrainSeed(base, 2));
  });
});

/**
 * Buildings: the only destructible terrain. Solid - movement, sight, and bullets -
 * while they stand, and a walkable, open ruin once they are brought down.
 */
describe('buildings', () => {
  const CELL = CONFIG.terrain.cell;

  function footprintOf(building: { pos: Vec2; cols: number; rows: number }): { x: number; y: number; w: number; h: number } {
    return { x: building.pos.x, y: building.pos.y, w: building.cols * CELL, h: building.rows * CELL };
  }

  /** Two points on opposite sides of a building, level with its middle. */
  function eitherSideOf(building: { pos: Vec2; cols: number; rows: number }): { left: Vec2; right: Vec2 } {
    const box = footprintOf(building);
    const midY = box.y + box.h / 2;
    return { left: { x: box.x - 50, y: midY }, right: { x: box.x + box.w + 50, y: midY } };
  }

  /**
   * A building with open ground either side of it inside the field. A footprint
   * against the east or west edge has no "other side" to order anyone to.
   */
  function buildingWithRoom(sim: Simulation): Building {
    const found = sim.state.buildings.find((b) => {
      const box = footprintOf(b);
      if (box.x <= 90 || box.x + box.w >= CONFIG.field.width - 90 || box.y <= 90) return false;
      const { left, right } = eitherSideOf(b);
      if (sim.buildingOnSegment(left, right)?.id !== b.id) return false;
      // The destroyed footprint should reopen an otherwise clear sightline;
      // keep unrelated rocks and buildings out of this fixture's firing lane.
      const terrain = { ...sim.state.terrain, blocked: sim.state.terrain.blocked.slice() };
      for (let row = Math.floor(b.pos.y / CELL); row < Math.floor(b.pos.y / CELL) + b.rows; row++) {
        for (let col = Math.floor(b.pos.x / CELL); col < Math.floor(b.pos.x / CELL) + b.cols; col++) {
          terrain.blocked[row * terrain.cols + col] = 0;
        }
      }
      return hasLineOfSight(terrain, left, right);
    });
    if (found === undefined) throw new Error('no building with room on both sides');
    return found;
  }

  it('places buildings clear of each other, the deployment zone and the water', () => {
    let mapsWithBuildings = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const data = generateTerrain(seed);
      if (data.buildings.length > 0) mapsWithBuildings++;
      const cell = data.terrain.cell;
      for (const building of data.buildings) {
        const box = { x: building.col * cell, y: building.row * cell, w: building.cols * cell, h: building.rows * cell };
        // Never on the player's start line: buildings are the contested middle.
        expect(box.y + box.h).toBeLessThan(CONFIG.deploymentZone.yMin);
        // Sample the whole footprint against the actual meandering channel and
        // tributaries, including vertical and diagonal rivers.
        if (data.zones.river !== null) {
          for (let y = box.y; y <= box.y + box.h; y += 6) {
            for (let x = box.x; x <= box.x + box.w; x += 6) {
              expect(isRiverAt(data.zones, seed, x, y), `building in water on seed ${seed} at ${x},${y}`).toBe(false);
            }
          }
        }
        // Every footprint cell is marked solid and typed as a building.
        for (let r = building.row; r < building.row + building.rows; r++) {
          for (let c = building.col; c < building.col + building.cols; c++) {
            const idx = r * data.terrain.cols + c;
            expect(data.terrain.blocked[idx]).toBe(1);
            expect(data.kinds[idx]).toBe(TERRAIN_KIND.building);
          }
        }
        // And no two footprints touch.
        for (const other of data.buildings) {
          if (other === building) continue;
          const overlaps = building.col < other.col + other.cols && building.col + building.cols > other.col
            && building.row < other.row + other.rows && building.row + building.rows > other.row;
          expect(overlaps).toBe(false);
        }
      }
    }
    // A built-up battlefield is the norm, not a rarity.
    expect(mapsWithBuildings).toBe(80);
  });

  it('starts every building intact with a name and the health its kind declares', () => {
    const sim = new Simulation(2026);
    expect(sim.state.buildings.length).toBeGreaterThan(0);
    for (const building of sim.state.buildings) {
      expect(building.name.length).toBeGreaterThan(0);
      expect(building.destroyed).toBe(false);
      expect(building.maxHealth).toBe(CONFIG.buildings.health[building.kind]);
      expect(building.health).toBe(building.maxHealth);
      expect(building.cols).toBe(CONFIG.buildings.footprints[building.kind].cols);
      expect(building.rows).toBe(CONFIG.buildings.footprints[building.kind].rows);
    }
    // Every kind does turn up across the campaign, or a whole building type would
    // be content the player never sees.
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) {
      for (const building of generateTerrain(seed).buildings) kinds.add(building.kind);
    }
    expect([...kinds].sort()).toEqual(['bakery', 'bar', 'barn', 'church', 'clinic', 'generalStore', 'hospital', 'house', 'restaurant', 'school']);
  });

  it('blocks line of sight and stops bullets while it stands', () => {
    const sim = new Simulation(2026);
    const building = buildingWithRoom(sim);
    const { left, right } = eitherSideOf(building);

    expect(hasLineOfSight(sim.state.terrain, left, right)).toBe(false);
    expect(sim.buildingOnSegment(left, right)?.id).toBe(building.id);
    // A shot that stops short of the building is not stopped by it.
    const justShort: Vec2 = { x: building.pos.x - 4, y: left.y };
    expect(sim.buildingOnSegment(left, justShort)).toBeNull();
  });

  it('reopens the ground, the sightline and the bullet path when destroyed', () => {
    const sim = new Simulation(2026);
    const building = buildingWithRoom(sim);
    const { left, right } = eitherSideOf(building);
    const blockedBefore = sim.state.terrain.blocked.reduce((n, v) => n + v, 0);

    sim.damageBuilding(building, CONFIG.buildings.health[building.kind]);
    expect(building.destroyed).toBe(true);
    expect(building.health).toBe(0);

    // The whole footprint is walkable again, and nothing else changed.
    const blockedAfter = sim.state.terrain.blocked.reduce((n, v) => n + v, 0);
    expect(blockedAfter).toBe(blockedBefore - building.cols * building.rows);
    for (let r = 0; r < building.rows; r++) {
      for (let c = 0; c < building.cols; c++) {
        const idx = Math.floor(building.pos.y / CELL + r) * sim.state.terrain.cols + Math.floor(building.pos.x / CELL + c);
        expect(sim.state.terrain.blocked[idx]).toBe(0);
      }
    }
    expect(hasLineOfSight(sim.state.terrain, left, right)).toBe(true);
    expect(sim.buildingOnSegment(left, right)?.id).not.toBe(building.id);
    // The ruin stays on the map, so the field still reads as built-up.
    expect(sim.state.buildings).toContain(building);
  });

  it('barely notices small arms and comes down under artillery', () => {
    const sim = new Simulation(2026);
    const house = sim.state.buildings.find((b) => b.kind === 'house')!;
    const rifle = getContent().weapons['rifle']!;

    // One rifle round: a scratch, not a demolition.
    sim.damageBuilding(house, 10 * CONFIG.buildings.smallArmsDamageMult);
    expect(house.destroyed).toBe(false);
    const afterRifle = house.health;
    expect(afterRifle).toBeGreaterThan(house.maxHealth - 20);
    expect(rifle.damage).toBeGreaterThan(0);

    // A direct artillery shell is a different proposition.
    sim.damageBuilding(house, CONFIG.artillery.damage);
    expect(house.health).toBeLessThan(afterRifle);
    // Two shells level a house; a church shrugs one off.
    const church = new Simulation(2026).state.buildings.find((b) => b.kind === 'church')!;
    expect(church.maxHealth).toBeGreaterThan(house.maxHealth);
  });

  it('lets a blast damage a structure it lands on, and only one it reaches', () => {
    const sim = new Simulation(2026);
    const building = buildingWithRoom(sim);
    const box = footprintOf(building);
    const far = { x: Math.min(CONFIG.field.width - 20, box.x + box.w + CONFIG.artillery.radius + 80), y: box.y + box.h / 2 };
    const before = building.health;

    // Out of reach: untouched. The strike lands on the next tick.
    sim.artilleryStrikeFor(1, far);
    sim.step();
    expect(building.health).toBe(before);

    // On target: damaged.
    sim.artilleryStrikeFor(1, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
    sim.step();
    expect(building.health).toBeLessThan(before);
  });

  it('forces a path around a standing building and straight through a ruin', () => {
    const sim = new Simulation(2026);
    const building = buildingWithRoom(sim);
    const { left, right } = eitherSideOf(building);
    const soldier = sim.state.units[0]!;
    sim.state.units = [soldier];
    soldier.pos = { ...left };
    soldier.prevPos = { ...left };
    soldier.path = [];
    soldier.moveGoal = null;

    const order = sim.command({ type: 'move', unitId: soldier.id, pos: right });
    expect(order.ok).toBe(true);
    // Walk it: the soldier has to get there without ever standing in a wall.
    const box = footprintOf(building);
    let arrived = false;
    for (let i = 0; i < 900 && !arrived; i++) {
      sim.step();
      const inside = soldier.pos.x > box.x && soldier.pos.x < box.x + box.w
        && soldier.pos.y > box.y && soldier.pos.y < box.y + box.h;
      expect(inside).toBe(false);
      arrived = Math.abs(soldier.pos.x - right.x) < 30;
    }
    expect(arrived).toBe(true);

    // Level it and the same ground is a straight walk.
    sim.damageBuilding(building, building.maxHealth);
    const again = sim.command({ type: 'move', unitId: soldier.id, pos: { x: box.x + box.w / 2, y: box.y + box.h / 2 } });
    expect(again.ok).toBe(true);
  });

  it('round-trips standing and ruined buildings through a snapshot', () => {
    const sim = new Simulation(2026);
    const [first, second] = sim.state.buildings;
    sim.damageBuilding(first!, 30);
    sim.damageBuilding(second!, second!.maxHealth);

    const json = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    expect(json.terrainHasBuildings).toBe(true);
    expect(json.buildings).toHaveLength(sim.state.buildings.length);
    expect(json.buildings.filter((b) => b.destroyed)).toHaveLength(1);

    const restored = Simulation.fromSnapshot(json);
    expect(restored.snapshot()).toEqual(sim.snapshot());
    // Crucially the reopened ground survives too, not just the health numbers.
    expect(Array.from(restored.state.terrain.blocked)).toEqual(Array.from(sim.state.terrain.blocked));
  });

  it('regenerates a legacy save with no buildings at all', () => {
    const sim = new Simulation(2026);
    const json = JSON.parse(JSON.stringify(sim.snapshot())) as SimSnapshot;
    // A save from before buildings existed: no list, and the flag says so.
    const legacy = { ...json, buildings: [], terrainHasBuildings: false } as SimSnapshot;
    const restored = Simulation.fromSnapshot(legacy);
    expect(restored.state.buildings).toEqual([]);
    expect(restored.state.terrainHasBuildings).toBe(false);
    // The map is still playable and carries no building footprints at all.
    for (const kind of restored.terrainData().kinds) expect(kind).not.toBe(TERRAIN_KIND.building);
    expect(restored.snapshot()).toEqual(legacy);
  });
});

describe('air support fire', () => {
  it('damages enemies without harming friendlies in the bomb run', () => {
    const sim = new Simulation(904);
    sim.state.points = CONFIG.costs.airSupport;
    const operator = sim.spawnFriendly('radio_engineer', { x: 100, y: 700 });
    const defender = sim.spawnFriendly('rifleman', { x: 480, y: 400 });
    const enemyHealth = getContent().enemy['rifle'].health;
    sim.spawnEnemy('rifle', { x: 480, y: 400 });
    const enemy = sim.state.units.find((unit) => unit.team === 'enemy')!;

    expect(sim.command({ type: 'airSupport', pos: { x: 480, y: 400 } }).ok).toBe(true);
    const firstBomb = sim.state.strikes.find((strike) => strike.delivery === 'airSupport')!;
    defender.pos = { ...firstBomb.pos };
    enemy.pos = { ...firstBomb.pos };
    defender.pinned = true;
    enemy.pinned = true;
    defender.suppression = 10_000;
    enemy.suppression = 10_000;
    defender.reloadTimer = 10_000;
    enemy.reloadTimer = 10_000;
    while (sim.state.ticks < firstBomb.landTick) sim.step();

    expect(enemy.health).toBeLessThan(enemyHealth);
    expect(defender.health).toBe(getContent().friendly.rifleman.health);
    expect(sim.state.units).toContain(operator);
  });
});

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
