import { CONFIG } from './config';
import type { EnemyArchetype, FriendlyRole, Team, UnitRole, WeaponStats, WaveDef } from '../simulation/types';
import unitsData from './units.json';
import weaponsData from './weapons.json';
import wavesData from './waves.json';

function sec2ticks(seconds: number): number {
  return Math.max(1, Math.round(seconds * CONFIG.tickRate));
}

/**
 * Runtime validation of imported content. Importing JSON through TypeScript
 * is not validation: fail loudly with a clear message before the game boots
 * if the content files are malformed.
 */

export interface FriendlyUnitDef {
  label: string;
  blurb: string;
  health: number;
  speed: number;
  weapon: string | null;
  radius: number;
  initialAccuracySkill: number;
  /**
   * Prioritisation weight used by enemy target selection. Ships in unit data so
   * a designer can change which roles the Axis consider dangerous without
   * touching AI code. Omitted entries fall back to an ordinary rifleman.
   */
  threat?: number;
  /** Grenades carried into the battle; absent means the role carries none. */
  grenades?: number;
  /** Starting bazooka rockets; only anti-tank soldiers use this ammunition. */
  rockets?: number;
  /** Starting mortar bombs; only mortarmen use this ammunition. */
  mortarBombs?: number;
  heal?: { amount: number; range: number; cooldownSeconds: number; seekRange: number };
}

export interface EnemyUnitDef {
  label: string;
  health: number;
  speed: number;
  weapon: string | null;
  radius: number;
  initialAccuracySkill: number;
  killValue: number;
  breakthroughDamage: number;
  immuneToSuppression?: boolean;
  threat?: number;
}

export interface Content {
  friendly: Record<FriendlyRole, FriendlyUnitDef>;
  enemy: Record<EnemyArchetype, EnemyUnitDef>;
  weapons: Record<string, WeaponStats>;
  waves: WaveDef[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Content validation failed: ${message}`);
}

function num(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `${label} must be a finite number in [${min}, ${max}]`);
  return value;
}

const FRIENDLY_ROLES: readonly FriendlyRole[] = ['rifleman', 'mg', 'medic', 'supply_officer', 'at', 'sniper', 'engineer', 'radio_engineer', 'officer', 'mortarman', 'gun_truck', 'scout', 'heavy_mg', 'assault_infantry', 'at_gun'];
const ENEMY_ARCHETYPES: readonly EnemyArchetype[] = ['rifle', 'assault', 'vehicle', 'observer', 'gun_truck', 'troop_transport', 'sapper', 'mg_team', 'sharpshooter', 'field_officer', 'at_infantry', 'infiltrator'];

function validateFriendlyDef(role: string, raw: unknown): FriendlyUnitDef {
  assert(isObject(raw), `friendly unit ${role} must be an object`);
  assert(typeof raw.label === 'string' && raw.label.length > 0, `friendly ${role}.label`);
  assert(typeof raw.blurb === 'string', `friendly ${role}.blurb`);
    const heal =
      raw.heal === undefined
        ? undefined
        : (() => {
            assert(isObject(raw.heal), `friendly ${role}.heal`);
            return {
              amount: num(raw.heal.amount, `friendly ${role}.heal.amount`, 1),
              range: num(raw.heal.range, `friendly ${role}.heal.range`, 1),
              cooldownSeconds: num(raw.heal.cooldownSeconds, `friendly ${role}.heal.cooldownSeconds`, 0),
              seekRange: num(raw.heal.seekRange, `friendly ${role}.heal.seekRange`, 1),
            };
          })();
  if (raw.rockets !== undefined) assert(role === 'at' && Number.isInteger(raw.rockets), `friendly ${role}.rockets must be an integer on the anti-tank role`);
  if (raw.mortarBombs !== undefined) assert(role === 'mortarman' && Number.isInteger(raw.mortarBombs), `friendly ${role}.mortarBombs must be an integer on the mortarman role`);
  return {
    label: raw.label,
    blurb: raw.blurb,
    health: num(raw.health, `friendly ${role}.health`, 1, 100000),
    speed: num(raw.speed, `friendly ${role}.speed`, 0, 1000),
    radius: num(raw.radius, `friendly ${role}.radius`, 1, 100),
    initialAccuracySkill: num(raw.initialAccuracySkill, `friendly ${role}.initialAccuracySkill`, 0.4, 1.3),
    threat: raw.threat === undefined ? undefined : num(raw.threat, `friendly ${role}.threat`, 0.1, 100),
    grenades: raw.grenades === undefined ? undefined : num(raw.grenades, `friendly ${role}.grenades`, 0, 20),
    rockets: raw.rockets === undefined ? undefined : num(raw.rockets, `friendly ${role}.rockets`, 0, 20),
    mortarBombs: raw.mortarBombs === undefined ? undefined : num(raw.mortarBombs, `friendly ${role}.mortarBombs`, 0, 20),
    weapon: raw.weapon === null ? null : (assert(typeof raw.weapon === 'string', `friendly ${role}.weapon`), raw.weapon),
    heal,
  };
}

function validateEnemyDef(role: string, raw: unknown): EnemyUnitDef {
  assert(isObject(raw), `enemy unit ${role} must be an object`);
  assert(typeof raw.label === 'string' && raw.label.length > 0, `enemy ${role}.label`);
  return {
    label: raw.label,
    health: num(raw.health, `enemy ${role}.health`, 1, 100000),
    speed: num(raw.speed, `enemy ${role}.speed`, 0, 1000),
    radius: num(raw.radius, `enemy ${role}.radius`, 1, 100),
    initialAccuracySkill: num(raw.initialAccuracySkill, `enemy ${role}.initialAccuracySkill`, 0.4, 1.3),
    weapon: raw.weapon === null ? null : (assert(typeof raw.weapon === 'string', `enemy ${role}.weapon`), raw.weapon),
    killValue: num(raw.killValue, `enemy ${role}.killValue`, 0, 100000),
    breakthroughDamage: num(raw.breakthroughDamage, `enemy ${role}.breakthroughDamage`, 1, 100),
    immuneToSuppression: raw.immuneToSuppression === true,
    threat: raw.threat === undefined ? undefined : num(raw.threat, `enemy ${role}.threat`, 0.1, 100),
  };
}

function validateWeapon(id: string, raw: unknown): WeaponStats {
  assert(isObject(raw), `weapon ${id} must be an object`);
  const kind = raw.kind;
  assert(kind === 'hitscan' || kind === 'explosive', `weapon ${id}.kind`);
  if (kind === 'explosive') {
    num(raw.projectileSpeed, `weapon ${id}.projectileSpeed`, 1);
  }
  return {
    name: (assert(typeof raw.name === 'string' && raw.name.length > 0, `weapon ${id}.name`), raw.name),
    damage: num(raw.damage, `weapon ${id}.damage`, 0),
    range: num(raw.range, `weapon ${id}.range`, 1),
    accuracy: num(raw.accuracy, `weapon ${id}.accuracy`, 0.01, 1),
    reloadTicks: sec2ticks(num(raw.reloadSeconds, `weapon ${id}.reloadSeconds`, 0)),
    burstShots: num(raw.burstShots, `weapon ${id}.burstShots`, 1),
    shotIntervalTicks: sec2ticks(raw.shotIntervalSeconds === undefined ? 0 : num(raw.shotIntervalSeconds, `weapon ${id}.shotIntervalSeconds`, 0)),
    kind,
    projectileSpeed: raw.projectileSpeed === undefined ? 0 : num(raw.projectileSpeed, `weapon ${id}.projectileSpeed`, 0),
    splashRadius: raw.splashRadius === undefined ? 0 : num(raw.splashRadius, `weapon ${id}.splashRadius`, 0),
    armorMult: raw.armorMult === undefined ? 1 : num(raw.armorMult, `weapon ${id}.armorMult`, 0),
    suppressionAmount: raw.suppressionAmount === undefined ? 0 : num(raw.suppressionAmount, `weapon ${id}.suppressionAmount`, 0),
    suppressionRadius: raw.suppressionRadius === undefined ? 0 : num(raw.suppressionRadius, `weapon ${id}.suppressionRadius`, 0),
  };
}

let cached: Content | null = null;

/** Validated content singleton (parsed and checked once per process). */
export function getContent(): Content {
  if (cached === null) cached = buildContent();
  return cached;
}

/** Test hook: force revalidation. */
export function resetContentCache(): void {
  cached = null;
}

/** Validate arbitrary raw content; exported for tests and tooling. */
export function validateRawContent(rawUnits: unknown, rawWeapons: unknown, rawWaves: unknown): Content {
  return buildFrom(rawUnits, rawWeapons, rawWaves);
}

function buildContent(): Content {
  return buildFrom(unitsData as unknown, weaponsData as unknown, wavesData as unknown);
}

function buildFrom(rawUnits: unknown, rawWeapons: unknown, rawWaves: unknown): Content {
  assert(isObject(rawUnits), 'units root');
  assert(isObject(rawUnits.friendly), 'units.friendly');
  assert(isObject(rawUnits.enemy), 'units.enemy');
  assert(isObject(rawWeapons), 'weapons root');

  const friendly = {} as Record<FriendlyRole, FriendlyUnitDef>;
  for (const role of FRIENDLY_ROLES) {
    assert(role in rawUnits.friendly, `missing friendly unit ${role}`);
    friendly[role] = validateFriendlyDef(role, rawUnits.friendly[role]);
  }

  const enemy = {} as Record<EnemyArchetype, EnemyUnitDef>;
  for (const role of ENEMY_ARCHETYPES) {
    assert(role in rawUnits.enemy, `missing enemy unit ${role}`);
    enemy[role] = validateEnemyDef(role, rawUnits.enemy[role]);
  }

  const weapons = {} as Record<string, WeaponStats>;
  for (const [id, raw] of Object.entries(rawWeapons)) {
    weapons[id] = validateWeapon(id, raw);
  }

  // Threat weighting drives enemy target selection, so require it explicitly
  // rather than letting a typo silently demote a role to cannon fodder.
  for (const role of FRIENDLY_ROLES) {
    assert(friendly[role].threat !== undefined, `friendly ${role}.threat is required`);
  }
  for (const role of ENEMY_ARCHETYPES) {
    assert(enemy[role].threat !== undefined, `enemy ${role}.threat is required`);
  }

  // Every referenced weapon and role mapping must exist.
  for (const role of FRIENDLY_ROLES) {
    const w = friendly[role].weapon;
    if (w !== null) assert(w in weapons, `friendly ${role} references unknown weapon ${w}`);
  }
  for (const role of ENEMY_ARCHETYPES) {
    const weapon = enemy[role].weapon;
    if (weapon !== null) assert(weapon in weapons, `enemy ${role} references unknown weapon ${weapon}`);
  }
  assert(isObject(rawWaves), 'waves root');
  assert(Array.isArray(rawWaves.waves) && rawWaves.waves.length === 15, 'waves must contain exactly 15 entries');
  const waves: WaveDef[] = rawWaves.waves.map((raw: unknown, i: number) => {
    assert(isObject(raw), `wave ${i} must be an object`);
    assert(Array.isArray(raw.composition) && raw.composition.length > 0, `wave ${i}.composition`);
    const composition = raw.composition.map((c, j) => {
      assert(isObject(c), `wave ${i} composition ${j}`);
      const archetype = c.archetype;
      assert(typeof archetype === 'string' && (ENEMY_ARCHETYPES as readonly string[]).includes(archetype), `wave ${i} composition ${j}.archetype`);
      return { archetype: archetype as EnemyArchetype, count: num(c.count, `wave ${i} composition ${j}.count`, 1, 200) };
    });
    return {
      label: (assert(typeof raw.label === 'string' && raw.label.length > 0, `wave ${i}.label`), raw.label),
      composition,
      spawnIntervalSeconds: num(raw.spawnIntervalSeconds, `wave ${i}.spawnIntervalSeconds`, 0.1),
      telegraph: typeof raw.telegraph === 'string' ? raw.telegraph : undefined,
    };
  });

  return { friendly, enemy, weapons, waves };
}

export function unitDef(content: Content, role: UnitRole, team?: Team): FriendlyUnitDef | EnemyUnitDef {
  if (team === 'friendly') return content.friendly[role as FriendlyRole];
  if (team === 'enemy') return content.enemy[role as EnemyArchetype];
  const friendly = role in content.friendly;
  const enemy = role in content.enemy;
  if (friendly && enemy) throw new Error(`Unit role ${role} exists on both teams; specify its team.`);
  return friendly ? content.friendly[role as FriendlyRole] : content.enemy[role as EnemyArchetype];
}

/** Target-prioritisation weight for any role, defaulting to an ordinary soldier. */
export function threatOf(content: Content, unit: { team: 'friendly' | 'enemy'; role: UnitRole }): number {
  const def = unit.team === 'friendly'
    ? content.friendly[unit.role as FriendlyRole]
    : content.enemy[unit.role as EnemyArchetype];
  return def?.threat ?? 1;
}
