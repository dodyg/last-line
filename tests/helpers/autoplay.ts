import { Simulation, waveTelegraph } from '../../src/simulation/simulation';
import { getContent } from '../../src/content/validate';
import { CONFIG } from '../../src/content/config';
import type { FriendlyRole } from '../../src/simulation/types';

/**
 * Heuristic autoplay used by the balance smoke checks. It plays like a
 * sensible but unremarkable player: dig in behind sandbags on a wide line,
 * keep recruiting during combat, answer armor telegraphs with anti-armor
 * soldiers, heal with a medic, and drop artillery on clumps. This is a
 * balance probe, not a bot tournament entry.
 */

export interface AutoplayResult {
  sectorSecured: boolean;
  score: number;
  waveReached: number;
  friendlies: number;
  integrity: number;
  ticks: number;
  kills: number;
  breakthroughs: number;
  /** Shots resolved by each side over the whole run. */
  enemyShots: number;
  friendlyShots: number;
  /** Axis infantry that spawned, and how many of them ever got a shot away. */
  enemiesSpawned: number;
  enemiesThatFired: number;
}

/** Sandbag row. Units 3-22px south of a bag (and attackers north of it) get cover. */
const BAG_Y = 596;
/** Center-out build order, wide enough that flank spawns stay in rifle range. */
const BAG_XS = [400, 520, 280, 640, 160, 800] as const;
/** The cell-center firing line is just south of the bags. */
const LINE_Y = 610;
/**
 * Spread firing-line slots. Distinct x positions keep the squad from stacking in
 * one lane, so a single enemy push cannot overrun the whole line at once.
 */
const SLOT_XS = [340, 400, 460, 520, 580, 640, 280, 700, 220, 760, 160, 820, 460, 580] as const;
/** Anti-armor depth: enough to answer a three-vehicle wave, not the whole squad. */
const AT_TARGET = 3;

/**
 * Wave preparation telegraphs describe the *next* wave. They mention armor with
 * wording like "armored vehicle", "Two armored vehicles" and "Three vehicles",
 * so match the concept rather than one literal spelling.
 */
function telegraphWarnsOfArmor(telegraph: string): boolean {
  return /\b(armor|armour|armored|armoured|vehicle|vehicles|tank|tanks|panzer)/i.test(telegraph);
}

export function autoplay(seed: number, maxTicks = 40 * 30 * 60, indirectSupport = true): AutoplayResult {
  const sim = new Simulation(seed);
  let recruitCounter = 0;
  let bagCounter = 0;
  let movedIn = false;
  let lastKillTick = 0;
  const evadeHomes = new Map<number, { x: number; y: number }>();
  const cleanupHomes = new Map<number, { x: number; y: number }>();
  let kills = 0;
  let breakthroughs = 0;
  let enemyShots = 0;
  let friendlyShots = 0;
  let enemiesSpawned = 0;
  const enemiesThatFired = new Set<number>();

  for (let t = 0; t < maxTicks; t++) {
    if (sim.state.phase !== 'running' || sim.state.sectorCaptured) break;
    const s = sim.state;
    const wave = s.scheduler.waveIndex + 1;
    const friendlies = s.units.filter((u) => u.team === 'friendly');
    const upcoming = waveTelegraph(s.scheduler.waveIndex) ?? '';
    /**
     * Armor is expected from wave 6 onward even without a telegraph, and any
     * telegraph that names armor pulls the requirement forward. Both the current
     * and the next wave are considered, so a warning raised during the break is
     * acted on before that wave spawns.
     */
    const armorComing = telegraphWarnsOfArmor(upcoming) || telegraphWarnsOfArmor(waveTelegraph(s.scheduler.waveIndex + 1) ?? '') || wave >= 6;
    const atAlive = friendlies.filter((u) => u.role === 'at').length;

    // Dig in immediately: sandbags just north of the firing line.
    if (bagCounter < BAG_XS.length && s.points >= CONFIG.costs.sandbag + (indirectSupport ? 10 : 0)) {
      if (sim.command({ type: 'sandbag', pos: { x: BAG_XS[bagCounter] as number, y: BAG_Y } }).ok) bagCounter++;
    }

    // Form up immediately; a distant unavailable build site must not block deployment.
    if (!movedIn && (indirectSupport || bagCounter === BAG_XS.length)) {
      let settled = true;
      for (const u of friendlies) {
        if (Math.abs(u.pos.y - LINE_Y) > 8) {
          settled = false;
          sim.command({ type: 'move', unitId: u.id, pos: { x: u.pos.x, y: LINE_Y } });
        }
      }
      if (settled) movedIn = true;
    }

    // Sustain indirect fire against covered stragglers, keep green troops
    // supplied, then buy specialists and respond to the armor warning.
    // The direct-fire probe skips mortars to measure infantry exchanges.
    if (friendlies.length < CONFIG.caps.friendly) {
      const medicsAlive = friendlies.filter((u) => u.role === 'medic').length;
      const mgAlive = friendlies.filter((u) => u.role === 'mg').length;
      const radioAlive = friendlies.filter((u) => u.role === 'radio_engineer').length;
      const engineerAlive = friendlies.filter((u) => u.role === 'engineer').length;

      let want: FriendlyRole = 'rifleman';
      if (indirectSupport && !friendlies.some((unit) => unit.role === 'mortarman')) want = 'mortarman';
      else if (indirectSupport && !friendlies.some((unit) => unit.role === 'supply_officer')) want = 'supply_officer';
      else if (indirectSupport && medicsAlive === 0) want = 'medic';
      else if (indirectSupport && armorComing && atAlive < AT_TARGET) want = 'at';
      else if (indirectSupport && friendlies.filter((unit) => unit.role === 'mortarman').length < 3) want = 'mortarman';
      else if (engineerAlive === 0) want = 'engineer';
      else if (radioAlive === 0) want = 'radio_engineer';
      else if (armorComing && atAlive < AT_TARGET) want = 'at';
      else if ((medicsAlive === 0 && friendlies.length >= 6) || (medicsAlive === 1 && friendlies.length >= 10)) want = 'medic';
      else if (recruitCounter % 4 === 3 && mgAlive < 3) want = 'mg';

      const cost = CONFIG.costs.recruit[want];
      if (s.points >= cost) {
        const slot = want === 'at' && indirectSupport ? [96, 480, 864][atAlive % 3]! : SLOT_XS[recruitCounter % SLOT_XS.length] as number;
        const pos = { x: slot + ((recruitCounter % 3) - 1) * 16, y: 610 + (recruitCounter % 2) * 8 };
        if (sim.command({ type: 'recruit', role: want, pos }).ok) {
          const recruit = s.units.filter((unit) => unit.team === 'friendly').at(-1)!;
          sim.command({ type: 'move', unitId: recruit.id, pos: { x: pos.x, y: want === 'at' && indirectSupport ? 540 : LINE_Y } });
          recruitCounter++;
        }
      }
    }

    // Green troops need explicit support requests until veteran automation unlocks.
    if (t % CONFIG.tickRate === 0) for (const unit of friendlies) {
      if (unit.role === 'mortarman' && (unit.mortarBombs ?? 0) <= 1) sim.command({ type: 'callMortarSupplies', unitId: unit.id });
      if (unit.role === 'at' && (unit.rockets ?? 0) <= 1) sim.command({ type: 'callRocketSupplies', unitId: unit.id });
      if (unit.health < getContent().friendly[unit.role as FriendlyRole].health && !s.strikes.some((strike) => strike.source === 'enemy')) sim.command({ type: 'callMedic', unitId: unit.id });
    }

    if (indirectSupport && s.scheduler.phase === 'prep' && cleanupHomes.size) {
      for (const [id, home] of cleanupHomes) sim.command({ type: 'move', unitId: id, pos: home });
      cleanupHomes.clear();
    }
    // Cover and disabled armor can survive outside a static line's sight.
    // An active commander sends a small cleanup party, then reforms for the next wave.
    if (indirectSupport && t - lastKillTick > 60 * CONFIG.tickRate && t % (5 * CONFIG.tickRate) === 0
      && s.scheduler.phase === 'active' && s.scheduler.spawnQueue.length === 0) {
      const enemy = s.units.find((unit) => unit.team === 'enemy');
      if (enemy) {
        const armored = enemy.role === 'vehicle' || enemy.role === 'gun_truck';
        const party = friendlies.filter((unit) => !unit.pinned && (armored ? unit.role === 'at' : unit.role === 'rifleman' || unit.role === 'mg'))
          .sort((a, b) => Math.hypot(a.pos.x - enemy.pos.x, a.pos.y - enemy.pos.y) - Math.hypot(b.pos.x - enemy.pos.x, b.pos.y - enemy.pos.y)).slice(0, 2);
        for (const [index, unit] of party.entries()) {
          const home = { ...unit.pos };
          const target = { x: Math.max(48, Math.min(CONFIG.field.width - 48, enemy.pos.x + (index ? 64 : -64))),
            y: Math.max(128, Math.min(620, enemy.pos.y + 64)) };
          if (sim.command({ type: 'move', unitId: unit.id, pos: target }).ok && !cleanupHomes.has(unit.id)) cleanupHomes.set(unit.id, home);
        }
      }
    }

    // Artillery on the largest enemy cluster once it pays for itself. In big
    // later waves, fire from the ready state rather than hoarding points.
    if (s.artilleryCooldown === 0 && s.points >= CONFIG.costs.artillery) {
      const enemies = s.units.filter((u) => u.team === 'enemy');
      if (enemies.length >= (wave >= 8 ? 3 : 4)) {
        let best = enemies[0]!;
        let bestCount = 0;
        for (const e of enemies) {
          const count = enemies.filter((o) => Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y) < 90).length;
          if (count > bestCount) {
            bestCount = count;
            best = e;
          }
        }
        if (bestCount >= (wave >= 8 ? 3 : 4) && friendlies.every((unit) => Math.hypot(unit.pos.x - best.pos.x, unit.pos.y - best.pos.y) > CONFIG.artillery.radius + 16)) sim.command({ type: 'artillery', pos: { x: best.pos.x, y: best.pos.y } });
      }
    }

    if (indirectSupport) {
      const hazards = s.strikes.filter((strike) => strike.landTick > s.ticks);
      if (!hazards.length && evadeHomes.size) {
        for (const [id, home] of evadeHomes) sim.command({ type: 'move', unitId: id, pos: home });
        evadeHomes.clear();
      }
      for (const unit of friendlies) {
        const threat = hazards.find((strike) => Math.hypot(unit.pos.x - strike.pos.x, unit.pos.y - strike.pos.y) <= strike.radius + 12);
        if (!threat || unit.pinned) continue;
        if (unit.path.length && unit.moveGoal && hazards.every((strike) => Math.hypot(unit.moveGoal!.x - strike.pos.x, unit.moveGoal!.y - strike.pos.y) > strike.radius + 12)) continue;
        const candidates = Array.from({ length: 16 }, (_, index) => {
          const angle = index * Math.PI / 8;
          return { x: threat.pos.x + Math.cos(angle) * (threat.radius + 30), y: threat.pos.y + Math.sin(angle) * (threat.radius + 30) };
        }).filter((pos) => pos.x >= 24 && pos.x <= CONFIG.field.width - 24 && pos.y >= 128 && pos.y <= CONFIG.field.height - 24
          && hazards.every((strike) => Math.hypot(pos.x - strike.pos.x, pos.y - strike.pos.y) > strike.radius + 16))
          .sort((a, b) => Math.hypot(a.x - unit.pos.x, a.y - unit.pos.y) - Math.hypot(b.x - unit.pos.x, b.y - unit.pos.y));
        const home = { ...unit.pos };
        for (const pos of candidates) if (sim.command({ type: 'move', unitId: unit.id, pos }).ok) {
          if (!evadeHomes.has(unit.id)) evadeHomes.set(unit.id, home);
          sim.command({ type: 'pace', unitIds: [unit.id], pace: 'run' });
          break;
        }
      }
    }

    const events = sim.step();
    for (const ev of events) {
      if (ev.type === 'unitSpawned' && ev.team === 'enemy') enemiesSpawned++;
      if (ev.type === 'shot') {
        if (ev.shooterTeam === 'enemy') {
          enemyShots++;
          enemiesThatFired.add(ev.shooterId);
        } else friendlyShots++;
      }
      if (ev.type === 'unitDied' && ev.team === 'enemy') { kills++; lastKillTick = t; }
      if (ev.type === 'breakthrough') breakthroughs++;
    }
  }

  const s = sim.state;
  return {
    sectorSecured: s.sectorCaptured,
    score: s.score,
    waveReached: s.scheduler.waveIndex + 1,
    friendlies: s.units.filter((u) => u.team === 'friendly').length,
    integrity: s.integrity,
    ticks: s.ticks,
    kills,
    breakthroughs,
    enemyShots,
    friendlyShots,
    enemiesSpawned,
    enemiesThatFired: enemiesThatFired.size,
  };
}

/** No orders at all: four riflemen standing in the open. */
export function passiveRun(seed: number, maxTicks = 60 * 30 * 60): AutoplayResult {
  const sim = new Simulation(seed);
  let kills = 0;
  let breakthroughs = 0;
  let enemyShots = 0;
  let friendlyShots = 0;
  let enemiesSpawned = 0;
  const enemiesThatFired = new Set<number>();
  for (let t = 0; t < maxTicks; t++) {
    if (sim.state.phase !== 'running' || sim.state.sectorCaptured) break;
    const events = sim.step();
    for (const ev of events) {
      if (ev.type === 'unitSpawned' && ev.team === 'enemy') enemiesSpawned++;
      if (ev.type === 'shot') {
        if (ev.shooterTeam === 'enemy') {
          enemyShots++;
          enemiesThatFired.add(ev.shooterId);
        } else friendlyShots++;
      }
      if (ev.type === 'unitDied' && ev.team === 'enemy') kills++;
      if (ev.type === 'breakthrough') breakthroughs++;
    }
  }
  const s = sim.state;
  return {
    sectorSecured: s.sectorCaptured,
    score: s.score,
    waveReached: s.scheduler.waveIndex + 1,
    friendlies: s.units.filter((u) => u.team === 'friendly').length,
    integrity: s.integrity,
    ticks: s.ticks,
    kills,
    breakthroughs,
    enemyShots,
    friendlyShots,
    enemiesSpawned,
    enemiesThatFired: enemiesThatFired.size,
  };
}
