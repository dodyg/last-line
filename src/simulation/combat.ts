import type { Content } from '../content/validate';
import { CONFIG } from '../content/config';
import { threatOf } from '../content/validate';
import type { Bunker, EnemyArchetype, FireOrder, FriendlyRole, GameConfig, Sandbag, SmokeCloud, Team, Terrain, Trench, TrenchRoleBonus, Unit, Vec2, WeaponStats } from './types';
import { hasLineOfSight, TERRAIN_KIND } from './terrain';
import { unitEyeHeight } from './buildings';
import { elevationLineOfSight } from './elevation';

/**
 * Combat math: hit probability, directional cover, suppression, and damage
 * application. All functions are pure with respect to their inputs; the
 * simulation owns any randomness.
 */

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isVehicle(_content: Content, unit: Unit): boolean {
  return unit.role === 'vehicle' || unit.role === 'gun_truck' || unit.role === 'troop_transport';
}

export function unitRadius(content: Content, unit: Unit): number {
  if (unit.team === 'friendly') return content.friendly[unit.role as keyof Content['friendly']].radius;
  return content.enemy[unit.role as keyof Content['enemy']].radius;
}

/**
 * Directional fortification cover: units benefit when they are close behind
 * a sandbag or trench and the attacker is north of the defensive position.
 */
export function hasTrenchCover(trenches: readonly Trench[], target: Vec2, attacker: Vec2, config: GameConfig): boolean {
  return trenches.some((trench) => {
    const dy = target.y - trench.pos.y;
    return (
      dy >= config.cover.minSouthOffset &&
      dy <= config.trench.coverDepth &&
      Math.abs(target.x - trench.pos.x) <= config.trench.coverRadius &&
      attacker.y < trench.pos.y
    );
  });
}

/** Bunkers protect friendly occupants from direct fire from every direction. */
export function hasBunkerCover(bunkers: readonly Bunker[], target: Unit, config: GameConfig): boolean {
  return target.team === 'friendly' && bunkers.some((bunker) => dist(bunker.pos, target.pos) <= config.bunker.occupyRadius);
}

export function hasDirectionalCover(
  sandbags: readonly Sandbag[],
  target: Vec2,
  attacker: Vec2,
  config: GameConfig,
  trenches: readonly Trench[] = [],
  terrain?: Terrain,
): boolean {
  if (hasTrenchCover(trenches, target, attacker, config)) return true;
  for (const bag of sandbags) {
    const dy = target.y - bag.pos.y;
    if (dy < config.cover.minSouthOffset) continue;
    if (Math.abs(target.x - bag.pos.x) > config.cover.radius) continue;
    if (dy > config.cover.radius) continue;
    if (attacker.y >= bag.pos.y) continue;
    return true;
  }
  // Low stone fences shelter troops on either side when fire crosses the fence.
  if (terrain?.kinds !== undefined) {
    const minCol = Math.max(0, Math.floor((target.x - config.cover.radius) / terrain.cell));
    const maxCol = Math.min(terrain.cols - 1, Math.floor((target.x + config.cover.radius) / terrain.cell));
    const minRow = Math.max(0, Math.floor((target.y - config.cover.radius) / terrain.cell));
    const maxRow = Math.min(terrain.rows - 1, Math.floor((target.y + config.cover.radius) / terrain.cell));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        if (terrain.kinds[row * terrain.cols + col] !== TERRAIN_KIND.stoneFence) continue;
        const fenceX = (col + 0.5) * terrain.cell;
        const fenceY = (row + 0.5) * terrain.cell;
        const dy = target.y - fenceY;
        const closeEnough = Math.abs(target.x - fenceX) <= config.cover.radius && Math.abs(dy) <= config.cover.radius;
        const shelteredSide = (dy >= config.cover.minSouthOffset && attacker.y < fenceY)
          || (dy <= -config.cover.minSouthOffset && attacker.y > fenceY);
        if (closeEnough && shelteredSide) return true;
      }
    }
  }
  return false;
}

export interface HitContext {
  weapon: WeaponStats;
  distance: number;
  attackerXp: number;
  attackerAccuracySkill?: number;
  attackerMorale?: number;
  attackerSuppression: number;
  targetInCover: boolean;
  targetInTrench?: boolean;
  targetInBunker?: boolean;
  targetInMortarPit?: boolean;
  /** Lower silhouettes are harder to hit in the open. */
  targetStance?: Unit['stance'];
  targetInFoliage?: boolean;
  /** Accuracy multiplier for each foliage tile between shooter and target. */
  lineFoliageCount?: number;
  /** Multiplier from fighting out of a prepared position, e.g. a trench. */
  attackerPositionAccuracyMult?: number;
  /**
   * Multiplier from the ground the attacker is standing on. Wading a river or
   * bogged in mud means firing with wet, unsteady footing, which is why soft
   * ground is worth avoiding rather than merely slow to cross.
   */
  attackerGroundAccuracyMult?: number;
  config: GameConfig;
}

export function hitChance(ctx: HitContext): number {
  const { weapon, distance, config } = ctx;
  // Linear falloff from full accuracy at point blank to ~35% at max range.
  const rangeFactor = 1 - 0.65 * Math.min(1, distance / weapon.range);
  const xpLevel = Math.min(ctx.attackerXp, config.xp.maxLevel);
  const xpFactor = 1 + xpLevel * config.xp.accuracyPerLevel;
  const skillFactor = ctx.attackerAccuracySkill ?? 1;
  const positionFactor = ctx.attackerPositionAccuracyMult ?? 1;
  const groundFactor = ctx.attackerGroundAccuracyMult ?? 1;
  const moraleRatio = Math.max(0, Math.min(100, ctx.attackerMorale ?? 100)) / 100;
  const moraleFactor = config.morale.aimMin + (config.morale.aimMax - config.morale.aimMin) * moraleRatio;
  const suppFactor = 1 - 0.6 * Math.min(1, ctx.attackerSuppression / config.suppression.pinThreshold);
  const coverFactor = ctx.targetInMortarPit ? config.mortarPit.accuracyMult : ctx.targetInBunker ? config.bunker.accuracyMult : ctx.targetInTrench ? config.trench.accuracyMult : ctx.targetInCover ? config.cover.accuracyMult : 1;
  const stanceFactor = ctx.targetInMortarPit || ctx.targetInBunker ? 1 : ctx.targetStance === 'prone' ? 0.72 : ctx.targetStance === 'crouching' ? 0.88 : 1;
  const foliageTargetFactor = ctx.targetInFoliage ? config.treeCover.targetAccuracyMult : 1;
  const foliageLineFactor = config.treeCover.lineAccuracyMult ** Math.min(8, ctx.lineFoliageCount ?? 0);
  const chance = weapon.accuracy * rangeFactor * skillFactor * positionFactor * groundFactor * moraleFactor * xpFactor * suppFactor * coverFactor * stanceFactor * foliageTargetFactor * foliageLineFactor;
  return Math.min(0.95, Math.max(0.03, chance));
}

/**
 * The bonus a unit gets for firing from a trench it is standing in. Only roles
 * with a configured bonus gain anything beyond the cover every occupant gets.
 */
export function trenchBonusFor(
  unit: Unit,
  trenches: readonly Trench[],
  config: GameConfig,
): TrenchRoleBonus | null {
  if (unit.team !== 'friendly') return null;
  const bonus = config.trench.roleBonus[unit.role as FriendlyRole];
  if (bonus === undefined) return null;
  return isInTrench(trenches, unit.pos, config) ? bonus : null;
}

/**
 * Whether a position counts as standing in the earthwork itself. Direction is
 * deliberately not considered: firing *from* cover must not depend on which way
 * the enemy is, and this only ever grants the occupant its own bonuses.
 */
export function isInTrench(trenches: readonly Trench[], pos: Vec2, config: GameConfig): boolean {
  return trenches.some((trench) =>
    Math.abs(pos.y - trench.pos.y) <= config.trench.occupyHalfDepth &&
    Math.abs(pos.x - trench.pos.x) <= config.trench.occupyHalfLength,
  );
}

export function targetIsValid(
  _content: Content,
  terrain: Terrain,
  sandbags: readonly Sandbag[],
  shooter: Unit,
  target: Unit,
  weapon: WeaponStats,
  config: GameConfig,
  trenches: readonly Trench[] = [],
  smokes: readonly SmokeCloud[] = [],
  visibilityRangeMult: number | ((target: Unit) => number) = 1,
): boolean {
  if (target.dead || target.health <= 0) return false;
  if (target.team === shooter.team) return false;
  const d = dist(shooter.pos, target.pos);
  const rangeMultiplier = typeof visibilityRangeMult === 'function' ? visibilityRangeMult(target) : visibilityRangeMult;
  if (d > weapon.range * rangeMultiplier) return false;
  // Small arms may not strike through solid rock; splash weapons can arc over.
  const ownBuildings = [shooter.buildingPosition?.buildingId, target.buildingPosition?.buildingId].filter((id): id is number => id !== undefined);
  if (weapon.kind === 'hitscan' && !elevationLineOfSight(terrain, shooter.pos, target.pos, unitEyeHeight(terrain, shooter), unitEyeHeight(terrain, target))) return false;
  if (weapon.kind === 'hitscan' && !hasLineOfSight(terrain, shooter.pos, target.pos, unitEyeHeight(terrain, shooter), unitEyeHeight(terrain, target), ownBuildings)) {
    // Except: a covered defender may still be engaged point-blank over cover.
    if (!hasDirectionalCover(sandbags, target.pos, shooter.pos, config, trenches, terrain) || d > config.cover.radius * 2.5) {
      return false;
    }
  }
  if (weapon.kind === 'hitscan' && smokes.some((cloud) => pointSegmentDistance(cloud.pos, shooter.pos, target.pos) <= cloud.radius)) return false;
  return true;
}

function pointSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return dist(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

/**
 * Grenade targeting. Deliberately does not use `targetIsValid`, because a
 * grenade's whole purpose is to reach a position that is safe from rifle fire:
 * it arcs over cover and ignores line of sight. Only range matters.
 */
export function grenadeTargets(
  shooter: Unit,
  candidates: readonly Unit[],
  config: GameConfig,
): Unit[] {
  const grenade = config.grenade;
  return candidates.filter((cand) => {
    if (cand.dead || cand.health <= 0 || cand.team === shooter.team) return false;
    return dist(shooter.pos, cand.pos) <= grenade.range;
  });
}

/**
 * Whether a unit is sheltered from fire arriving from `attacker`: solid terrain
 * in the way, or a fortification it is standing behind. This is the condition a
 * grenade exists to answer, so it is worth naming directly.
 */
export function isShelteredFrom(
  terrain: Terrain,
  sandbags: readonly Sandbag[],
  trenches: readonly Trench[],
  target: Vec2,
  attacker: Vec2,
  config: GameConfig,
): boolean {
  if (!hasLineOfSight(terrain, attacker, target)) return true;
  return hasDirectionalCover(sandbags, target, attacker, config, trenches, terrain);
}

/**
 * Whether a grenade is worth throwing: either several hostiles share the blast,
 * or the target is one that rifle fire cannot reach. Returns the target to aim
 * at, or null when the soldier should keep shooting instead.
 */
export function chooseGrenadeTarget(
  terrain: Terrain,
  sandbags: readonly Sandbag[],
  shooter: Unit,
  candidates: readonly Unit[],
  config: GameConfig,
  trenches: readonly Trench[] = [],
): Unit | null {
  if (shooter.grenades <= 0 || shooter.grenadeTimer > 0 || shooter.pinned) return null;
  const inRange = grenadeTargets(shooter, candidates, config);
  if (inRange.length === 0) return null;

  // Cluster value: the best single blast available, ties broken by proximity.
  const clusterAt = (centre: Unit): number => inRange.filter((o) => dist(o.pos, centre.pos) <= config.grenade.radius).length;
  const ranked = [...inRange].sort((a, b) => clusterAt(b) - clusterAt(a) || dist(shooter.pos, a.pos) - dist(shooter.pos, b.pos) || a.id - b.id);
  const best = ranked[0]!;
  if (clusterAt(best) >= config.grenade.clusterThreshold) return best;

  // A single target is only worth a grenade if gunfire cannot reach it anyway.
  if (config.grenade.throwAtCoveredTargets) {
    const sheltered = inRange
      .filter((cand) => isShelteredFrom(terrain, sandbags, trenches, cand.pos, shooter.pos, config))
      .sort((a, b) => dist(shooter.pos, a.pos) - dist(shooter.pos, b.pos) || a.id - b.id)[0];
    if (sheltered !== undefined) return sheltered;
  }
  return null;
}

/** Pick a new target: eligible by validity, then threat-weighted distance. */export function acquireTarget(
  content: Content,
  terrain: Terrain,
  sandbags: readonly Sandbag[],
  shooter: Unit,
  candidates: readonly Unit[],
  weapon: WeaponStats,
  config: GameConfig,
  trenches: readonly Trench[] = [],
  fireOrder: FireOrder = 'auto',
  smokes: readonly SmokeCloud[] = [],
  visibilityRangeMult: number | ((target: Unit) => number) = 1,
  revealedByGunfire: (target: Unit) => boolean = () => false,
): Unit | null {
  let best: Unit | null = null;
  let bestScore = Infinity;
  for (const cand of candidates) {
    if (!canAcquireTarget(content, terrain, sandbags, shooter, cand, weapon, config, trenches, smokes, visibilityRangeMult, revealedByGunfire)) continue;
    const d = dist(shooter.pos, cand.pos);
    const score = targetScoreForOrder(content, cand, d, config, fireOrder);
    if (score < bestScore || (score === bestScore && best !== null && cand.id < best.id)) {
      best = cand;
      bestScore = score;
    }
  }
  // Among targets of comparable priority, prefer one already hurt enough to
  // finish, so the Axis convert damage into casualties instead of spreading it.
  const wounded = candidates
    .filter((cand) => cand.health > 0 && cand.health < maxHealthFor(content, cand) * config.enemy.targetPriority.damagedHealthFraction)
    .filter((cand) => canAcquireTarget(content, terrain, sandbags, shooter, cand, weapon, config, trenches, smokes, visibilityRangeMult, revealedByGunfire))
    .filter((cand) => {
      const d = dist(shooter.pos, cand.pos);
      return targetScoreForOrder(content, cand, d, config, fireOrder) <= bestScore * (1 + config.enemy.targetPriority.preferDamagedBonus);
    })
    .sort((a, b) => a.health / maxHealthFor(content, a) - b.health / maxHealthFor(content, b) || a.id - b.id)[0];
  return wounded ?? best;
}

function canAcquireTarget(
  content: Content,
  terrain: Terrain,
  sandbags: readonly Sandbag[],
  shooter: Unit,
  target: Unit,
  weapon: WeaponStats,
  config: GameConfig,
  trenches: readonly Trench[],
  smokes: readonly SmokeCloud[],
  visibilityRangeMult: number | ((target: Unit) => number),
  revealedByGunfire: (target: Unit) => boolean,
): boolean {
  if (!targetIsValid(content, terrain, sandbags, shooter, target, weapon, config, trenches, smokes, visibilityRangeMult)) return false;
  // Camouflage delays first contact; once an enemy has acquired the soldier,
  // normal target retention applies until the target breaks contact or dies.
  if (shooter.team === 'enemy' && target.team === 'friendly' && target.specialization === 'camouflage' && !revealedByGunfire(target)) {
    return dist(shooter.pos, target.pos) <= weapon.range * config.specialization.camouflageRangeMult;
  }
  return true;
}

function targetScoreForOrder(content: Content, target: Unit, distance: number, config: GameConfig, order: FireOrder): number {
  let score = targetScore(content, target, distance, config);
  if (order === 'antiArmor') score *= isVehicle(content, target) ? 0.15 : 1.6;
  if (order === 'stopBreakthrough') score *= 1.7 - 0.8 * target.pos.y / config.field.height;
  return score;
}

/**
 * Lower is better. Distance is discounted by how dangerous the target is, so the
 * Axis engage a machine-gun nest or a radio operator over a nearer rifleman.
 * Both terms are scaled by the target's own health pool, so the result does not
 * depend on the absolute size of that pool.
 */
export function targetScore(content: Content, candidate: Unit, distance: number, config: GameConfig): number {
  const maxHealth = maxHealthFor(content, candidate);
  const healthFraction = Math.max(0, Math.min(1, candidate.health / maxHealth));
  const woundDiscount = (1 - healthFraction) * config.enemy.targetPriority.woundedDistanceBonus;
  return Math.max(0, distance - woundDiscount) / Math.max(0.1, threatOf(content, candidate));
}

function maxHealthFor(content: Content, unit: Unit): number {
  if (unit.tankCrew) return CONFIG.armoredVehicle.crew.health;
  const def = unit.team === 'friendly'
    ? content.friendly[unit.role as keyof Content['friendly']]
    : content.enemy[unit.role as keyof Content['enemy']];
  return def?.health ?? 100;
}

/**
 * The distance at which an archetype stops advancing and trades fire. Attackers
 * choose this rather than freezing wherever they first saw a target.
 */
export function engageDistance(weapon: WeaponStats, role: Unit['role'], config: GameConfig): number {
  const mult = config.enemy.engageRangeMult[role as EnemyArchetype] ?? 1;
  return weapon.range * mult;
}

export function xpLevelOf(unit: Unit, config: GameConfig): number {
  return Math.min(unit.xp, config.xp.maxLevel);
}

/**
 * Reload duration in ticks from combat experience alone. Personal weapon
 * upgrades are applied on top by the simulation, which owns that state.
 */
export function effectiveReloadTicks(unit: Unit, weapon: WeaponStats, config: GameConfig): number {
  const level = xpLevelOf(unit, config);
  const factor = 1 - Math.min(0.5, level * config.xp.reloadReductionPerLevel);
  return Math.max(1, Math.round(weapon.reloadTicks * factor));
}

export interface DamageApplication {
  killed: boolean;
  damageDealt: number;
}

/**
 * Apply damage with the vehicle armor multiplier. Caller is responsible for
 * death events, kill credit, and score - this function only mutates health.
 */
export function applyDamageToUnit(_content: Content, target: Unit, rawDamage: number, weaponArmorMult: number): DamageApplication {
  // The machine-gun truck is an open utility vehicle. It counts as a vehicle
  // for movement and mines, but takes full damage from ordinary weapons.
  const armored = target.team === 'enemy' && target.role === 'vehicle';
  const mult = armored ? weaponArmorMult : 1;
  const dealt = rawDamage * mult;
  target.health = Math.max(0, target.health - dealt);
  return { killed: target.health <= 0, damageDealt: dealt };
}

/** Apply suppression to a unit from a hostile noise/impact near it. */
export function applySuppression(unit: Unit, amount: number, config: GameConfig): void {
  if (unit.team === 'enemy' && unit.role === 'vehicle') return; // vehicles ignore suppression
  unit.suppression = Math.min(config.suppression.max, unit.suppression + amount);
}

export function teamOf(opposite: Team): Team {
  return opposite === 'friendly' ? 'enemy' : 'friendly';
}

/**
 * Suppress every unit of the victim team near the impact/shell point.
 * `victimTeam` is the team being shot at; only its members gain suppression.
 */
export function suppressNear(
  units: readonly Unit[],
  victimTeam: Team,
  pos: Vec2,
  radius: number,
  amount: number,
  config: GameConfig,
): void {
  for (const unit of units) {
    if (unit.team !== victimTeam || unit.health <= 0) continue;
    if (dist(unit.pos, pos) <= radius) {
      applySuppression(unit, amount, config);
    }
  }
}
