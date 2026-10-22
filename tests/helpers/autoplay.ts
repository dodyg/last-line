import { Simulation, waveTelegraph } from '../../src/simulation/simulation';
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
  victory: boolean;
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
/** Soldiers stand near the cell row centered at y=612: 16px south of the bags. */
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

export function autoplay(seed: number, maxTicks = 60 * 30 * 60): AutoplayResult {
  const sim = new Simulation(seed);
  let recruitCounter = 0;
  let bagCounter = 0;
  let movedIn = false;
  let kills = 0;
  let breakthroughs = 0;
  let enemyShots = 0;
  let friendlyShots = 0;
  let enemiesSpawned = 0;
  const enemiesThatFired = new Set<number>();

  for (let t = 0; t < maxTicks; t++) {
    if (sim.state.phase !== 'running') break;
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
    if (bagCounter < BAG_XS.length && s.points >= CONFIG.costs.sandbag) {
      if (sim.command({ type: 'sandbag', pos: { x: BAG_XS[bagCounter] as number, y: BAG_Y } }).ok) bagCounter++;
    }

    // Once the line exists, bring the starting squad onto it (once).
    if (!movedIn && bagCounter === BAG_XS.length) {
      let settled = true;
      for (const u of friendlies) {
        if (Math.abs(u.pos.y - LINE_Y) > 8) {
          settled = false;
          sim.command({ type: 'move', unitId: u.id, pos: { x: u.pos.x, y: LINE_Y } });
        }
      }
      if (settled) movedIn = true;
    }

    // Continuous recruitment from the first prep through combat, with no
    // hoarding. Fortifications and artillery are gated behind dedicated roles,
    // so those come first; after that the priority branch buys anti-armor the
    // moment it is needed, a medic once the squad can spare one (two in a big
    // squad), an occasional machine gun, and riflemen as the backbone.
    if (friendlies.length < CONFIG.caps.friendly) {
      const medicsAlive = friendlies.filter((u) => u.role === 'medic').length;
      const mgAlive = friendlies.filter((u) => u.role === 'mg').length;
      const radioAlive = friendlies.filter((u) => u.role === 'radio_engineer').length;
      const engineerAlive = friendlies.filter((u) => u.role === 'engineer').length;

      let want: FriendlyRole = 'rifleman';
      if (radioAlive === 0) want = 'radio_engineer';
      else if (engineerAlive === 0) want = 'engineer';
      else if (armorComing && atAlive < AT_TARGET) want = 'at';
      else if ((medicsAlive === 0 && friendlies.length >= 6) || (medicsAlive === 1 && friendlies.length >= 10)) want = 'medic';
      else if (recruitCounter % 4 === 3 && mgAlive < 3) want = 'mg';

      const cost = CONFIG.costs.recruit[want];
      if (s.points >= cost) {
        const slot = SLOT_XS[recruitCounter % SLOT_XS.length] as number;
        const pos = { x: slot + ((recruitCounter % 3) - 1) * 16, y: LINE_Y + (recruitCounter % 2) * 8 };
        if (sim.command({ type: 'recruit', role: want, pos }).ok) recruitCounter++;
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
        if (bestCount >= (wave >= 8 ? 3 : 4)) sim.command({ type: 'artillery', pos: { x: best.pos.x, y: best.pos.y } });
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
      if (ev.type === 'unitDied' && ev.team === 'enemy') kills++;
      if (ev.type === 'breakthrough') breakthroughs++;
    }
  }

  const s = sim.state;
  return {
    victory: s.phase === 'victory',
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
    if (sim.state.phase !== 'running') break;
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
    victory: s.phase === 'victory',
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
