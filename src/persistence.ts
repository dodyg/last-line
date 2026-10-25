import { ROLE_ABILITIES } from './simulation/role-abilities';
import { MAX_VEHICLE_TRACKS } from './simulation/battle-wear';
import { AMBUSH_ARCS, supportsAmbush } from './simulation/ambush';
import { CONFIG } from './content/config';
import { isCampaignCountry } from './content/campaigns';
import { getContent } from './content/validate';
import type {
  EnemyArchetype,
  BattleRecord,
  BuildingKind,
  FireOrder,
  FriendlyRole,
  SimSnapshot,
  Unit,
  UnitRole,
  SoldierService,
  WeaponUpgradeType,
  WeatherKind,
  WavePhase,
} from './simulation/types';
import { weatherForSeed } from './simulation/terrain';
import { isTreeKind, TREE_HEALTH } from './simulation/tree-damage';
import { isSeason, seasonForSeed } from './simulation/seasons';
import { FIRE_ORDERS, fireOrdersForRole, MAX_GROUND_IMPACTS } from './simulation/types';
import { buildingLevels, positionCapacity } from './simulation/buildings';
import { insidePatrolArea, isPatrolRole, validPatrolArea } from './simulation/patrol';
import type { DemolitionTarget, EnemySapperTeam, EnemyDemolitionCharge, PatrolArea } from './simulation/types';

/**
 * localStorage persistence with a versioned schema, defensive runtime
 * validation, and graceful degradation to an in-memory store. Saves never
 * trust TypeScript assertions - every field is checked at runtime.
 */

export const KEYS = {
  prefs: 'lastline/prefs/v1',
  best: 'lastline/best/v1',
  save: 'lastline/save/v1',
} as const;

export interface Preferences {
  volume: number;
  muted: boolean;
  screenShake: boolean;
  effectsVolume: number;
  voiceVolume: number;
  ambientVolume: number;
  musicVolume: number;
  graphics: 'auto' | 'low' | 'medium' | 'high';
  shadows: boolean;
  particles: boolean;
  weatherEffects: boolean;
  renderScale: number;
  zoomSensitivity: number;
  panSpeed: number;
  edgeScrolling: boolean;
  uiScale: number;
  largeCaptions: boolean;
  reducedMotion: boolean;
  strongOutlines: boolean;
  friendlyColor: string;
  enemyColor: string;
  fadeObstructions: boolean;
  keys: { pause: string; panel: string; resetCamera: string; zoomIn: string; zoomOut: string };
}

export const DEFAULT_PREFS: Preferences = {
  volume: 0.8,
  muted: false,
  screenShake: true,
  effectsVolume: 1, voiceVolume: 1, ambientVolume: 0.35, musicVolume: 0.25,
  graphics: 'auto', shadows: true, particles: true, weatherEffects: true, renderScale: 1,
  zoomSensitivity: 1, panSpeed: 1, edgeScrolling: false,
  uiScale: 1, largeCaptions: false, reducedMotion: false, strongOutlines: true,
  friendlyColor: '#7fa8d8', enemyColor: '#d86a4a', fadeObstructions: true,
  keys: { pause: 'Space', panel: 'KeyC', resetCamera: 'Digit0', zoomIn: 'Equal', zoomOut: 'Minus' },
};

export interface BestRecord {
  bestScore: number;
  victories: number;
}

export type StorageStatus = 'ok' | 'memory';

/** Wrap storage access; falls back to memory when localStorage is unavailable or full. */
export class Storage {
  private memory = new Map<string, string>();
  private memoryNoticePending = false;
  private memoryNoticeShown = false;
  status: StorageStatus = 'ok';

  private available(): boolean {
    try {
      const probe = '__lastline_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  private usable: boolean | null = null;

  get(key: string): string | null {
    if (this.usable === null) this.usable = this.available();
    if (!this.usable) {
      this.status = 'memory';
      return this.memory.get(key) ?? null;
    }
    try {
      return window.localStorage.getItem(key);
    } catch {
      this.usable = false;
      this.status = 'memory';
      return this.memory.get(key) ?? null;
    }
  }

  set(key: string, value: string): boolean {
    if (this.usable === null) this.usable = this.available();
    this.memory.set(key, value); // always keep the memory copy as fallback
    if (!this.usable) {
      this.status = 'memory';
      this.warnOnce();
      return false;
    }
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      // Quota exceeded or blocked: continue in memory.
      this.usable = false;
      this.status = 'memory';
      this.warnOnce();
      return false;
    }
  }

  remove(key: string): void {
    this.memory.delete(key);
    if (this.usable === null) this.usable = this.available();
    if (!this.usable) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      this.usable = false;
      this.status = 'memory';
    }
  }

  private warnOnce(): void {
    if (!this.memoryNoticeShown) this.memoryNoticePending = true;
  }

  consumeMemoryNotice(): boolean {
    if (this.status !== 'memory' || !this.memoryNoticePending) return false;
    this.memoryNoticePending = false;
    this.memoryNoticeShown = true;
    return true;
  }
}

function parseJson(text: string | null): unknown | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- preferences

export function loadPrefs(storage: Storage): Preferences {
  const raw = parseJson(storage.get(KEYS.prefs));
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_PREFS };
  const obj = raw as Record<string, unknown>;
  return {
    ...DEFAULT_PREFS,
    volume: typeof obj.volume === 'number' && obj.volume >= 0 && obj.volume <= 1 ? obj.volume : DEFAULT_PREFS.volume,
    muted: obj.muted === true,
    screenShake: obj.screenShake !== false,
    effectsVolume: prefNumber(obj.effectsVolume, 1, 0, 1),
    voiceVolume: prefNumber(obj.voiceVolume, 1, 0, 1),
    ambientVolume: prefNumber(obj.ambientVolume, .35, 0, 1),
    musicVolume: prefNumber(obj.musicVolume, .25, 0, 1),
    graphics: ['auto', 'low', 'medium', 'high'].includes(String(obj.graphics)) ? obj.graphics as Preferences['graphics'] : 'auto',
    shadows: obj.shadows !== false, particles: obj.particles !== false, weatherEffects: obj.weatherEffects !== false,
    renderScale: prefNumber(obj.renderScale, 1, .5, 1.5),
    zoomSensitivity: prefNumber(obj.zoomSensitivity, 1, .25, 3), panSpeed: prefNumber(obj.panSpeed, 1, .25, 3),
    edgeScrolling: obj.edgeScrolling === true, uiScale: prefNumber(obj.uiScale, 1, .8, 1.5),
    largeCaptions: obj.largeCaptions === true, reducedMotion: obj.reducedMotion === true,
    strongOutlines: obj.strongOutlines !== false, fadeObstructions: obj.fadeObstructions !== false,
    friendlyColor: prefColor(obj.friendlyColor, DEFAULT_PREFS.friendlyColor),
    enemyColor: prefColor(obj.enemyColor, DEFAULT_PREFS.enemyColor),
    keys: prefKeys(obj.keys),
  };
}

function prefNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function prefColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function prefKeys(value: unknown): Preferences['keys'] {
  const keys = { ...DEFAULT_PREFS.keys };
  if (!value || typeof value !== 'object') return keys;
  const used = new Set<string>();
  for (const action of Object.keys(keys) as Array<keyof typeof keys>) {
    const code = (value as Record<string, unknown>)[action];
    if (typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Space|Tab|Equal|Minus|Arrow(Up|Down|Left|Right))$/.test(code) && !used.has(code)) {
      keys[action] = code;
      used.add(code);
    }
  }
  return new Set(Object.values(keys)).size === Object.keys(keys).length ? keys : { ...DEFAULT_PREFS.keys };
}

export function savePrefs(storage: Storage, prefs: Preferences): void {
  storage.set(KEYS.prefs, JSON.stringify(prefs));
}

// ------------------------------------------------------------------- best

export function loadBest(storage: Storage): BestRecord {
  const raw = parseJson(storage.get(KEYS.best));
  if (raw === null || typeof raw !== 'object') return { bestScore: 0, victories: 0 };
  const obj = raw as Record<string, unknown>;
  return {
    bestScore: typeof obj.bestScore === 'number' && Number.isFinite(obj.bestScore) && obj.bestScore >= 0 ? obj.bestScore : 0,
    victories: typeof obj.victories === 'number' && Number.isInteger(obj.victories) && obj.victories >= 0 ? obj.victories : 0,
  };
}

export function saveBest(storage: Storage, best: BestRecord): void {
  storage.set(KEYS.best, JSON.stringify(best));
}

// ------------------------------------------------------------------- saves

const FROZEN_UNITS = 5000;

/**
 * Full runtime validation of a parsed snapshot. Returns null with a reason
 * when the save is corrupt, unsupported, or out of bounds.
 */
export function validateSnapshot(data: unknown): { snap: SimSnapshot } | { error: string } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'Save is not a valid record.' };
  }
  const obj = data as Record<string, unknown>;
  // v2 added laid mines; v3 added the northern march between maps; v4 added
  // destructible buildings; v5 added Axis counter-battery fire; v6 gave the
  // battery its own random stream; v7 made weapon upgrades take time; v8 added
  // capture objectives, smoke, fire orders, and veteran specializations; v9
  // added the pending captured-sector supply choice; v10 added the Forward
  // Observer specialization; v11 added movement and camouflage perks; v12 adds bunkers; v13 adds air support; v14 adds evolving weather; v15 gates it behind three cleared waves.
  // v17 added individually switchable vehicle headlights; v18 adds engineer-built bridges.
  // v19 adds permanent tank subsystem damage; older tanks remain fully operational.
  // v20 adds surviving tank crews and their retreat/fight orders.
  // v21 adds finite bazooka rockets; older anti-tank soldiers resume fully supplied.
  // v22 adds finite mortar bombs; older mortarmen resume fully supplied.
  // v23 adds warned and deployed enemy smoke-screen assaults.
  // v24 adds veteran support-call retry timers; old veterans may call immediately.
  // v25 preserves distinct mortar, artillery, and bomb scars on the current map.
  // v26 preserves bullet and blast damage to individual tree cells.
  // v30 preserves prepared ambush arcs and remaining opening-burst bonuses.
  // v29 preserves sapper missions, enemy demolition fuses, and demolished bridges.
  // v28 preserves barbed wire and enemy cutting progress.
  // v27 preserves planted satchel charges and their remaining fuse time.
  // Older vehicles resume with their lights on and old infantry do not gain vehicle lighting.
  // Each older version loads with the features it knew.
  const supportedVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  if (typeof obj.schemaVersion !== 'number' || !supportedVersions.includes(obj.schemaVersion)) {
    return { error: `Unsupported save version (found ${String(obj.schemaVersion)}).` };
  }
  const fail = (reason: string): { error: string } => ({ error: reason });
  if (obj.campaignCountry !== undefined && !isCampaignCountry(obj.campaignCountry)) return fail('Corrupt campaign country.');

  const seed = obj.seed;
  if (typeof seed !== 'number' || !Number.isFinite(seed) || seed < 0 || seed > 0xffffffff) return fail('Corrupt seed.');

  const rng = obj.rng;
  if (typeof rng !== 'object' || rng === null) return fail('Corrupt random state.');
  const rngS = (rng as Record<string, unknown>).s;
  if (typeof rngS !== 'number' || !Number.isFinite(rngS)) return fail('Corrupt random state.');

  // The Axis battery's stream arrived with schema v6. A save that predates it is
  // left undefined here and derived from the seed when the run resumes.
  let enemyArtilleryRngS: number | undefined;
  if (obj.enemyArtilleryRng !== undefined) {
    const battery = obj.enemyArtilleryRng;
    if (typeof battery !== 'object' || battery === null) return fail('Corrupt enemy artillery random state.');
    const value = (battery as Record<string, unknown>).s;
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail('Corrupt enemy artillery random state.');
    enemyArtilleryRngS = value;
  }

  const ticks = obj.ticks;
  if (typeof ticks !== 'number' || !Number.isInteger(ticks) || ticks < 0 || ticks > 1e9) return fail('Corrupt clock.');

  const nextEntityId = obj.nextEntityId;
  if (typeof nextEntityId !== 'number' || !Number.isInteger(nextEntityId) || nextEntityId < 1) return fail('Corrupt entity ids.');

  const boundedNumber = (v: unknown, min: number, max: number): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

  const weatherRaw = obj.weather;
  const season = obj.season === undefined ? (typeof weatherRaw === 'string' && weatherRaw.toLowerCase().includes('snow') ? 'winter' : seasonForSeed(seed)) : obj.season;
  if (!isSeason(season)) return fail('Corrupt season.');
  const weatherKinds: readonly string[] = ['clear', 'lightRain', 'rain', 'heavyRain', 'lightFog', 'fog', 'heavyFog', 'lightSnow', 'snow', 'heavySnow'];
  const weather = weatherRaw === undefined ? weatherForSeed(seed, isCampaignCountry(obj.campaignCountry) ? obj.campaignCountry : undefined, season) : weatherRaw;
  if (typeof weather !== 'string' || !weatherKinds.includes(weather)) return fail('Corrupt weather.');
  const weatherChangeTick = obj.weatherChangeTick ?? ticks + Math.round(CONFIG.weatherChangeSeconds * CONFIG.tickRate);
  if (!Number.isInteger(weatherChangeTick) || !boundedNumber(weatherChangeTick, ticks, 1e9)) return fail('Corrupt weather change timer.');

  const battleRaw = obj.battleRecord === undefined
    ? { enemyKills: 0, casualties: 0, breakthroughs: 0 }
    : obj.battleRecord;
  if (typeof battleRaw !== 'object' || battleRaw === null || Array.isArray(battleRaw)) return fail('Corrupt battle record.');
  const battleValues = battleRaw as Record<string, unknown>;
  const battleRecord = {} as BattleRecord;
  for (const key of ['enemyKills', 'casualties', 'breakthroughs'] as const) {
    const value = battleValues[key];
    if (!boundedNumber(value, 0, 1e9) || !Number.isInteger(value)) return fail('Corrupt battle record.');
    battleRecord[key] = value as number;
  }

  const legacyUpgradeRaw = obj.weaponUpgrades ?? { accuracy: 0, reload: 0, damage: 0 };
  if (typeof legacyUpgradeRaw !== 'object' || legacyUpgradeRaw === null || Array.isArray(legacyUpgradeRaw)) return fail('Corrupt weapon upgrades.');
  const legacyUpgradeValues = legacyUpgradeRaw as Record<string, unknown>;
  const legacyWeaponUpgrades = {} as Record<WeaponUpgradeType, number>;
  for (const key of ['accuracy', 'reload', 'damage'] as const) {
    const level = legacyUpgradeValues[key];
    if (!boundedNumber(level, 0, CONFIG.weaponUpgrades.maxLevel) || !Number.isInteger(level)) return fail('Corrupt weapon upgrade level.');
    legacyWeaponUpgrades[key] = level as number;
  }

  const unitsRaw = obj.units;
  if (!Array.isArray(unitsRaw) || unitsRaw.length > FROZEN_UNITS) return fail('Corrupt unit list.');
  const content = getContent();
  const friendlyRoles: readonly string[] = Object.keys(content.friendly);
  const enemyRoles: readonly string[] = Object.keys(content.enemy);
  const seenIds = new Set<number>();

  /**
   * Validate one serialized unit. Soldiers waiting north of the map are folded
   * into the same shape as the units still on it, so they go through the same
   * checks rather than a looser second path.
   */
  const readUnits = (list: unknown): Unit[] | { error: string } => {
    if (!Array.isArray(list) || list.length > FROZEN_UNITS) return { error: 'Corrupt unit list.' };
    const parsed: Unit[] = [];
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) return fail('Corrupt unit.');
      const u = raw as Record<string, unknown>;
      if (typeof u.id !== 'number' || !Number.isInteger(u.id) || u.id < 1) return fail('Corrupt unit id.');
      if (seenIds.has(u.id)) return fail('Duplicate unit id.');
      seenIds.add(u.id);
      const team = u.team;
      if (team !== 'friendly' && team !== 'enemy') return fail('Corrupt unit team.');
      const role = u.role;
      if (typeof role !== 'string' || !(team === 'friendly' ? friendlyRoles : enemyRoles).includes(role)) {
        return fail('Unknown unit archetype in save.');
      }
      const pos = u.pos;
      const prevPos = u.prevPos;
      for (const p of [pos, prevPos]) {
        if (typeof p !== 'object' || p === null) return fail('Corrupt unit position.');
        const pp = p as Record<string, unknown>;
        if (!boundedNumber(pp.x, -100, CONFIG.field.width + 100) || !boundedNumber(pp.y, -100, CONFIG.field.height + 100)) {
          return fail('Unit position out of bounds.');
        }
      }
      if (!boundedNumber(u.health, 0, 1e6)) return fail('Corrupt unit health.');
      if (typeof u.dead !== 'boolean') return fail('Corrupt death flag.');
      if (u.heardGunfire !== undefined && (!Array.isArray(u.heardGunfire) || u.heardGunfire.length > 512 || team !== 'friendly')) return fail('Corrupt heard gunfire.');
      const heardSourceIds = new Set<number>();
      for (const rawContact of [...(u.heardGunfire as unknown[] | undefined ?? []), ...(u.gunfirePursuit === undefined ? [] : [u.gunfirePursuit])]) {
        if (typeof rawContact !== 'object' || rawContact === null) return fail('Corrupt heard gunfire.');
        const contact = rawContact as Record<string, unknown>, point = contact.pos as Record<string, unknown> | undefined;
        if (!boundedNumber(contact.sourceId, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(contact.sourceId)) return fail('Corrupt heard gunfire source.');
        if (rawContact !== u.gunfirePursuit) {
          if (heardSourceIds.has(contact.sourceId as number)) return fail('Duplicate heard gunfire source.');
          heardSourceIds.add(contact.sourceId as number);
        }
        if (!point || typeof point !== 'object' || !boundedNumber(point.x, -100, CONFIG.field.width + 100) || !boundedNumber(point.y, -100, CONFIG.field.height + 100)) return fail('Corrupt heard gunfire position.');
        if (!boundedNumber(contact.noticedTick, 0, ticks) || !Number.isInteger(contact.noticedTick)
          || !boundedNumber(contact.expiresTick, (contact.noticedTick as number) + 1, (contact.noticedTick as number) + Math.ceil(CONFIG.gunfireOrder.memorySeconds * CONFIG.tickRate))
          || !Number.isInteger(contact.expiresTick)) return fail('Corrupt heard gunfire clock.');
        if (rawContact === u.gunfirePursuit && (u.fireOrder !== 'seekGunfire' || team !== 'friendly' || !fireOrdersForRole(role as UnitRole).includes('seekGunfire')
          || !boundedNumber(contact.retryTick, 0, ticks + Math.ceil(CONFIG.gunfireOrder.retrySeconds * CONFIG.tickRate)) || !Number.isInteger(contact.retryTick))) return fail('Corrupt gunfire pursuit.');
      }
      if (u.nightContacts !== undefined) {
        if (!Array.isArray(u.nightContacts) || u.nightContacts.length > 512) return fail('Corrupt night contacts.');
        const sourceIds = new Set<number>();
        for (const rawContact of u.nightContacts) {
          if (typeof rawContact !== 'object' || rawContact === null) return fail('Corrupt night contact.');
          const contact = rawContact as Record<string, unknown>, point = contact.pos as Record<string, unknown> | undefined;
          if (!boundedNumber(contact.sourceId, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(contact.sourceId) || sourceIds.has(contact.sourceId as number)) return fail('Corrupt gunfire source.');
          sourceIds.add(contact.sourceId as number);
          if (typeof contact.kind !== 'string' || !['sound', 'muzzleFlash', 'tracer'].includes(contact.kind)) return fail('Corrupt gunfire clue.');
          if (typeof point !== 'object' || point === null || !boundedNumber(point.x, -100, CONFIG.field.width + 100) || !boundedNumber(point.y, -100, CONFIG.field.height + 100)) return fail('Corrupt gunfire position.');
          if (!boundedNumber(contact.height, -100, 10_000)) return fail('Corrupt gunfire height.');
          if (!boundedNumber(contact.noticedTick, 0, ticks) || !Number.isInteger(contact.noticedTick)) return fail('Corrupt gunfire clock.');
          const maxMemory = Math.ceil(Math.max(CONFIG.dayNight.gunfire.soundMemorySeconds, CONFIG.dayNight.gunfire.visualMemorySeconds) * CONFIG.tickRate);
          if (!boundedNumber(contact.expiresTick, (contact.noticedTick as number) + 1, (contact.noticedTick as number) + maxMemory) || !Number.isInteger(contact.expiresTick)) return fail('Corrupt gunfire memory.');
        }
      }
      if (u.terrainCrawling !== undefined && typeof u.terrainCrawling !== 'boolean') return fail('Corrupt slope traversal posture.');
      if (u.movementPace !== undefined && u.movementPace !== 'walk' && u.movementPace !== 'run') return fail('Corrupt movement pace.');
      if (u.stamina !== undefined && !boundedNumber(u.stamina, 0, 1)) return fail('Corrupt stamina.');
      if (u.running !== undefined && typeof u.running !== 'boolean') return fail('Corrupt running state.');
      if (u.dodgingStrike !== undefined && typeof u.dodgingStrike !== 'boolean') return fail('Corrupt shell avoidance state.');
      if (u.patrol !== undefined) {
        if (team !== 'friendly' || !isPatrolRole(role) || typeof u.patrol !== 'object' || u.patrol === null || u.buildingPosition || u.buildingOrder) return fail('Corrupt patrol order.');
        const patrol = u.patrol as Record<string, unknown>;
        const area = patrol.area as PatrolArea | undefined;
        if (!area || typeof area !== 'object' || !area.min || !area.max || !validPatrolArea(area)) return fail('Corrupt patrol area.');
        if (!Array.isArray(patrol.points) || patrol.points.length < 2 || patrol.points.length > 4) return fail('Corrupt patrol stations.');
        for (const point of patrol.points) {
          if (typeof point !== 'object' || point === null || !boundedNumber(point.x, 4, CONFIG.field.width - 4)
            || !boundedNumber(point.y, 4, CONFIG.field.height - 4) || !insidePatrolArea(area, point)) return fail('Corrupt patrol station.');
        }
        if (!Number.isInteger(patrol.nextPoint) || !boundedNumber(patrol.nextPoint, 0, patrol.points.length - 1)
          || !Number.isInteger(patrol.retryTick) || !boundedNumber(patrol.retryTick, 0, Number.MAX_SAFE_INTEGER)) return fail('Corrupt patrol progress.');
      }
      if (u.bridgePosition !== undefined) {
        const bridge = u.bridgePosition as Record<string, unknown> | null;
        if (typeof bridge !== 'object' || bridge === null || typeof bridge.key !== 'string' || bridge.key.length > 150
          || (bridge.level !== 'deck' && bridge.level !== 'under')) return fail('Corrupt bridge passage.');
      }
      if (!boundedNumber(u.suppression, 0, CONFIG.suppression.max)) return fail('Corrupt suppression.');
      const morale = u.morale === undefined ? CONFIG.morale.initial : u.morale;
      if (!boundedNumber(morale, 0, 100)) return fail('Corrupt morale.');
      const unitWeaponUpgrades = team === 'friendly'
        ? { ...legacyWeaponUpgrades }
        : { accuracy: 0, reload: 0, damage: 0 };
      if (u.weaponUpgrades !== undefined) {
        if (typeof u.weaponUpgrades !== 'object' || u.weaponUpgrades === null || Array.isArray(u.weaponUpgrades)) return fail('Corrupt unit weapon upgrades.');
        const savedUpgrades = u.weaponUpgrades as Record<string, unknown>;
        for (const key of ['accuracy', 'reload', 'damage'] as const) {
          const level = savedUpgrades[key];
          if (!boundedNumber(level, 0, CONFIG.weaponUpgrades.maxLevel) || !Number.isInteger(level)) return fail('Corrupt unit weapon upgrade level.');
          unitWeaponUpgrades[key] = level as number;
        }
      }
      if (typeof u.pinned !== 'boolean') return fail('Corrupt pinned flag.');
      // The march-north marker is transient; a save that carries it is accepted
      // but the flag is rebuilt from the two unit lists when the run resumes.
      if (u.crossed !== undefined && typeof u.crossed !== 'boolean') return fail('Corrupt crossing flag.');
      if (!boundedNumber(u.reloadTimer, 0, 1e6) || !boundedNumber(u.burstRemaining, 0, 1e6) || !boundedNumber(u.shotTimer, 0, 1e6)) {
        return fail('Corrupt weapon timers.');
      }
      for (const key of ['secondaryReloadTimer', 'secondaryBurstRemaining', 'secondaryShotTimer'] as const) {
        if (u[key] !== undefined && !boundedNumber(u[key], 0, 1e6)) return fail('Corrupt secondary weapon timers.');
      }
      if (u.tankDamage !== undefined) {
        if (team !== 'enemy' || role !== 'vehicle' || typeof u.tankDamage !== 'object' || u.tankDamage === null || Array.isArray(u.tankDamage)) return fail('Corrupt tank damage.');
        const damage = u.tankDamage as Record<string, unknown>;
        if (Object.keys(damage).length !== 3 || ['tracks', 'turret', 'machineGun'].some((key) => typeof damage[key] !== 'boolean')) return fail('Corrupt tank damage.');
        if (damage.tracks && damage.turret && damage.machineGun && (u.health as number) > 0 && !u.dead) return fail('Corrupt tank damage.');
      }
      if (u.tankCrew !== undefined) {
        if (team !== 'enemy' || role !== 'rifle' || !u.tankCrew || typeof u.tankCrew !== 'object' || Array.isArray(u.tankCrew)) return fail('Corrupt tank crew.');
        const crew = u.tankCrew as Record<string, unknown>, exit = crew.exit as Record<string, unknown> | null;
        if (!Number.isSafeInteger(crew.tankId) || (crew.tankId as number) <= 0 || (crew.tankId as number) >= (u.id as number)
          || (crew.behavior !== 'retreat' && crew.behavior !== 'fight') || !exit || typeof exit !== 'object'
          || !boundedNumber(exit.x, 4, CONFIG.field.width - 4) || !boundedNumber(exit.y, 4, CONFIG.terrain.cell / 2)
          || !Number.isSafeInteger(crew.retryTick) || !boundedNumber(crew.retryTick, 0, ticks + CONFIG.tickRate)
          || !Number.isInteger(crew.bailoutTicks) || !boundedNumber(crew.bailoutTicks, 0, Math.round(CONFIG.armoredVehicle.crew.bailoutSeconds * CONFIG.tickRate))) return fail('Corrupt tank crew.');
      }
      if (u.targetId !== null && (typeof u.targetId !== 'number' || !Number.isInteger(u.targetId))) return fail('Corrupt target.');
      if (!Array.isArray(u.path)) return fail('Corrupt path.');    if (u.path.length > 2000) return fail('Path too long.');
      for (const p of u.path) {
        if (typeof p !== 'object' || p === null) return fail('Corrupt path.');
        const pp = p as Record<string, unknown>;
        if (!boundedNumber(pp.x, -100, CONFIG.field.width + 100) || !boundedNumber(pp.y, -100, CONFIG.field.height + 100)) {
          return fail('Path point out of bounds.');
        }
      }
      if (u.moveGoal !== null && (typeof u.moveGoal !== 'object' || u.moveGoal === null)) return fail('Corrupt move goal.');
      if (!boundedNumber(u.healTimer, 0, 1e6)) return fail('Corrupt heal timer.');
      if (u.medicalTargetId !== undefined && (team !== 'friendly' || role !== 'medic'
        || !Number.isSafeInteger(u.medicalTargetId) || (u.medicalTargetId as number) <= 0)) return fail('Corrupt medical assignment.');
      if (u.supplyTargetId !== undefined && (team !== 'friendly' || role !== 'supply_officer'
        || !Number.isSafeInteger(u.supplyTargetId) || (u.supplyTargetId as number) <= 0)) return fail('Corrupt grenade delivery assignment.');
      if (role === 'troop_transport' || u.transport !== undefined) {
        if (team !== 'enemy' || role !== 'troop_transport' || typeof u.transport !== 'object' || u.transport === null) return fail('Corrupt troop transport.');
        const transport = u.transport as Record<string, unknown>;
        if (transport.passengers !== 0 && transport.passengers !== CONFIG.troopTransport.capacity) return fail('Corrupt transport passenger count.');
        for (const name of ['dropOff', 'exit']) {
          const point = transport[name] as Record<string, unknown> | null;
          if (!point || typeof point !== 'object' || !boundedNumber(point.x, 4, CONFIG.field.width - 4)
            || !boundedNumber(point.y, 4, CONFIG.breakthroughY - 24)) return fail('Corrupt transport destination.');
        }
        if (!Number.isInteger(transport.unloadTicks) || !boundedNumber(transport.unloadTicks, 0, CONFIG.troopTransport.unloadSeconds * CONFIG.tickRate)
          || !Number.isSafeInteger(transport.retryTick) || !boundedNumber(transport.retryTick, 0, Number.MAX_SAFE_INTEGER)) return fail('Corrupt transport progress.');
      }
      const mortarTimer = u.mortarTimer ?? (role === 'mortarman' ? Math.round(CONFIG.mortar.initialDelaySeconds * CONFIG.tickRate) : 0);
      if (!boundedNumber(mortarTimer, 0, 1e6)) return fail('Corrupt mortar timer.');
      // The weapon-upgrade work timer arrived with schema v7; a save from before
      // it resumes with every soldier's weapon already assembled.
      if (u.upgradeTimer !== undefined && !boundedNumber(u.upgradeTimer, 0, 1e6)) {
        return fail('Corrupt weapon upgrade timer.');
      }
      if (!boundedNumber(u.xp, 0, 1e6) || !boundedNumber(u.kills, 0, 1e6)) return fail('Corrupt experience.');
      if (u.ambush !== undefined) {
        if (typeof u.ambush !== 'object' || u.ambush === null || !supportsAmbush({ team, role: role as UnitRole })) return fail('Corrupt ambush order.');
        const ambush = u.ambush as Record<string, unknown>;
        if (!boundedNumber(ambush.facing, -Math.PI, Math.PI) || !boundedNumber(ambush.range, CONFIG.ambush.minRange, CONFIG.ambush.maxRange)
          || !AMBUSH_ARCS.some((arc) => arc === ambush.arcDegrees)
          || !boundedNumber(ambush.prepTicks, 0, CONFIG.ambush.prepareSeconds * CONFIG.tickRate) || !Number.isInteger(ambush.prepTicks)
          || typeof ambush.triggered !== 'boolean' || !boundedNumber(ambush.bonusShots, 0, 20) || !Number.isInteger(ambush.bonusShots)
          || (ambush.triggered ? ambush.prepTicks !== 0 || ambush.bonusShots === 0 : ambush.bonusShots !== 0)) return fail('Corrupt ambush order.');
      }
      if (u.roleCooldown !== undefined && (!boundedNumber(u.roleCooldown, 0, 45 * CONFIG.tickRate) || !Number.isInteger(u.roleCooldown))) return fail('Corrupt role cooldown.');
      if (u.roleDuty !== undefined) {
        const duty = u.roleDuty as Record<string, unknown>;
        const ability = ROLE_ABILITIES[role as UnitRole];
        const point = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && boundedNumber((value as Record<string, unknown>).x, 0, CONFIG.field.width) && boundedNumber((value as Record<string, unknown>).y, 0, CONFIG.field.height);
        if (!duty || typeof duty !== 'object' || Array.isArray(duty) || team !== 'friendly' || !ability || duty.kind !== ability.kind
          || !point(duty.origin) || !boundedNumber(duty.ticksRemaining, 0, (duty.kind === 'rally' ? 12 : duty.kind === 'suppress' ? 10 : 0) * CONFIG.tickRate) || !Number.isInteger(duty.ticksRemaining)
          || !boundedNumber(duty.stock, 0, duty.kind === 'repair' ? 40 : duty.kind === 'supply' ? 12 : 0)
          || (duty.kind === 'supply' && !Number.isInteger(duty.stock))
          || (duty.kind === 'suppress' ? !point(duty.target) : duty.target !== undefined)) return fail('Corrupt role ability.');
      }
      if (u.scoutReports !== undefined) {
        if (team !== 'friendly' || role !== 'scout' || !Array.isArray(u.scoutReports) || u.scoutReports.length > 32) return fail('Corrupt scout reports.');
        for (const raw of u.scoutReports) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Corrupt scout report.');
          const report = raw as Record<string, unknown>, pos = report.pos as Record<string, unknown>;
          if (!boundedNumber(report.unitId, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(report.unitId) || typeof report.role !== 'string' || !(report.role in content.enemy)
            || !pos || !boundedNumber(pos.x, 0, CONFIG.field.width) || !boundedNumber(pos.y, 0, CONFIG.field.height)
            || !boundedNumber(report.tick, 0, ticks) || !Number.isInteger(report.tick)) return fail('Corrupt scout report.');
        }
      }
      const fireOrder = u.fireOrder ?? 'auto';
      if (!FIRE_ORDERS.includes(fireOrder as FireOrder)) return fail('Corrupt fire order.');
      const supportedFireOrder = fireOrdersForRole(role as UnitRole).includes(fireOrder as FireOrder)
        ? fireOrder
        : 'auto';
      const headlightsOn = u.headlightsOn ?? (role === 'vehicle' || role === 'gun_truck' || role === 'troop_transport');
      if (typeof headlightsOn !== 'boolean') return fail('Corrupt vehicle headlight state.');
      const smokeGrenades = u.smokeGrenades ?? (team === 'friendly' && (role === 'rifleman' || role === 'engineer') ? CONFIG.smoke.startingGrenades : 0);
      if (!boundedNumber(smokeGrenades, 0, 20) || !Number.isInteger(smokeGrenades)) return fail('Corrupt smoke ammunition.');
      const rocketCapacity = team === 'friendly' && role === 'at' ? content.friendly.at.rockets ?? 0 : 0;
      const rockets = u.rockets === undefined ? rocketCapacity : u.rockets;
      if (!boundedNumber(rockets, 0, rocketCapacity) || !Number.isInteger(rockets)) return fail('Corrupt bazooka ammunition.');
      const mortarCapacity = team === 'friendly' && role === 'mortarman' ? content.friendly.mortarman.mortarBombs ?? 0 : 0;
      const mortarBombs = u.mortarBombs === undefined ? mortarCapacity : u.mortarBombs;
      if (!boundedNumber(mortarBombs, 0, mortarCapacity) || !Number.isInteger(mortarBombs)) return fail('Corrupt mortar ammunition.');
      for (const timer of [u.autoMedicCallAfter, u.autoSupplyCallAfter]) {
        if (timer !== undefined && (!boundedNumber(timer, 0, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(timer))) return fail('Corrupt automatic support timer.');
      }
      const validSpecializations = ['steadyAim', 'fastReload', 'tankHunter', 'fieldMedic', 'surgeon', 'rapidBuilder', 'heavyCharges', 'spotter', 'forwardObserver', 'signalOfficer', 'suppressor', 'forcedMarch', 'camouflage'];
      if (u.specialization !== undefined && (team !== 'friendly' || typeof u.specialization !== 'string' || !validSpecializations.includes(u.specialization))) return fail('Corrupt veteran specialization.');
      const serviceRaw = u.service === undefined ? { healthRestored: 0, fortificationsBuilt: 0, grenadesThrown: 0 } : u.service;
      if (typeof serviceRaw !== 'object' || serviceRaw === null || Array.isArray(serviceRaw)) return fail('Corrupt soldier service record.');
      const serviceValues = serviceRaw as Record<string, unknown>;
      if (!boundedNumber(serviceValues.healthRestored, 0, 1e9) ||
          !boundedNumber(serviceValues.fortificationsBuilt, 0, 1e9) || !Number.isInteger(serviceValues.fortificationsBuilt)) {
        return fail('Corrupt soldier service record.');
      }
      // grenadesThrown arrived with schema v2; older records simply start at zero.
      const grenadesThrown = serviceValues.grenadesThrown ?? 0;
      if (!boundedNumber(grenadesThrown, 0, 1e9) || !Number.isInteger(grenadesThrown)) {
        return fail('Corrupt soldier service record.');
      }
      const service: SoldierService = {
        healthRestored: serviceValues.healthRestored as number,
        fortificationsBuilt: serviceValues.fortificationsBuilt as number,
        grenadesThrown: grenadesThrown as number,
      };
      if (u.deployment !== undefined) {
        const d = u.deployment as Record<string, unknown>;
        if (!d || !['heavy_mg', 'mg_team', 'at_gun'].includes(role) || !boundedNumber(d.ticks, 0, CONFIG.tickRate * 10)
          || !boundedNumber(d.packingTicks, 0, CONFIG.tickRate * 10) || !boundedNumber(d.facing, -1e9, 1e9)) return fail('Corrupt weapon crew deployment.');
      }
      if (u.aim !== undefined) {
        const a = u.aim as Record<string, unknown>;
        if (!a || role !== 'at_infantry' || !Number.isSafeInteger(a.targetId) || (a.targetId as number) < 1
          || !boundedNumber(a.ticks, 0, CONFIG.tickRate * 10)) return fail('Corrupt anti-tank aim.');
      }
      for (const key of ['revealedUntil', 'detectedUntil']) {
        if (u[key] !== undefined && !boundedNumber(u[key], 0, 1e12)) return fail('Corrupt detection timer.');
      }
      if (u.clearBuilding !== undefined) {
        const c = u.clearBuilding as Record<string, unknown>;
        if (!c || role !== 'assault_infantry' || team !== 'friendly' || !Number.isSafeInteger(c.buildingId) || (c.buildingId as number) < 1
          || !(c.level === 'roof' || c.level === 'balcony' || Number.isInteger(c.level) && boundedNumber(c.level, 0, 20))
          || (c.facing !== undefined && !['north','east','south','west'].includes(c.facing as string))
          || !boundedNumber(c.ticks, 0, CONFIG.tickRate * 10)) return fail('Corrupt building clearing order.');
      }
      const initialSkill = team === 'friendly'
        ? content.friendly[role as FriendlyRole].initialAccuracySkill
        : content.enemy[role as EnemyArchetype].initialAccuracySkill;
      const accuracySkill = u.accuracySkill === undefined ? initialSkill : u.accuracySkill;
      if (!boundedNumber(accuracySkill, 0.4, 1.3)) return fail('Corrupt marksmanship skill.');
      if (!boundedNumber(u.laneX, -100, CONFIG.field.width + 100)) return fail('Corrupt lane.');
      parsed.push({ ...u, fireOrder: supportedFireOrder, headlightsOn, smokeGrenades, rockets, mortarBombs, mortarTimer, accuracySkill, morale, service, weaponUpgrades: unitWeaponUpgrades } as unknown as Unit);
    }
    return parsed;
  };

  const readUnitsResult = readUnits(unitsRaw);
  if ('error' in readUnitsResult) return readUnitsResult;
  const units = readUnitsResult;
  const medicalQueue = obj.medicalQueue === undefined ? units.flatMap((u) => u.medicalTargetId === undefined ? [] : [u.medicalTargetId]) : obj.medicalQueue;
  const grenadeSupplyQueue = obj.grenadeSupplyQueue === undefined ? [] : obj.grenadeSupplyQueue;
  if (!Array.isArray(grenadeSupplyQueue) || grenadeSupplyQueue.length > CONFIG.caps.friendly || new Set(grenadeSupplyQueue).size !== grenadeSupplyQueue.length
    || grenadeSupplyQueue.some((id) => !Number.isSafeInteger(id) || id <= 0)) return fail('Corrupt grenade supply queue.');
  if (!Array.isArray(medicalQueue) || medicalQueue.length > CONFIG.caps.friendly || new Set(medicalQueue).size !== medicalQueue.length
    || medicalQueue.some((id) => !Number.isSafeInteger(id) || id <= 0)) return fail('Corrupt medical request queue.');

  const projectilesRaw = obj.projectiles;
  if (!Array.isArray(projectilesRaw) || projectilesRaw.length > FROZEN_UNITS) return fail('Corrupt projectile list.');
  const projectiles: SimSnapshot['projectiles'] = [];
  for (const raw of projectilesRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt projectile.');
    const p = raw as Record<string, unknown>;
    if (!boundedNumber(p.id, 1, Number.MAX_SAFE_INTEGER)) return fail('Corrupt projectile id.');
    if (p.team !== 'friendly' && p.team !== 'enemy') return fail('Corrupt projectile team.');
    for (const key of ['pos', 'target']) {
      const pt = p[key];
      if (typeof pt !== 'object' || pt === null) return fail('Corrupt projectile position.');
      const pp = pt as Record<string, unknown>;
      if (!boundedNumber(pp.x, -100, CONFIG.field.width + 100) || !boundedNumber(pp.y, -100, CONFIG.field.height + 100)) {
        return fail('Projectile out of bounds.');
      }
    }
    if (!boundedNumber(p.speed, 0, 1e4) || !boundedNumber(p.damage, 0, 1e6) || !boundedNumber(p.splashRadius, 0, 1e4)) {
      return fail('Corrupt projectile stats.');
    }
    if (p.sourceId !== null && typeof p.sourceId !== 'number') return fail('Corrupt projectile source.');
    projectiles.push(p as unknown as SimSnapshot['projectiles'][number]);
  }

  const impactsRaw = obj.groundImpacts ?? [];
  if (!Array.isArray(impactsRaw) || impactsRaw.length > MAX_GROUND_IMPACTS) return fail('Corrupt ground impact list.');
  const groundImpacts: NonNullable<SimSnapshot['groundImpacts']> = [], impactIds = new Set<number>();
  for (const raw of impactsRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt ground impact.');
    const mark = raw as Record<string, unknown>, pos = mark.pos as Record<string, unknown> | null;
    if (!boundedNumber(mark.id, 1, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(mark.id) || impactIds.has(mark.id as number)
      || (mark.kind !== 'mortar' && mark.kind !== 'artillery' && mark.kind !== 'airSupport')
      || !pos || !boundedNumber(pos.x, 0, CONFIG.field.width) || !boundedNumber(pos.y, 0, CONFIG.field.height)
      || !boundedNumber(mark.tick, 0, ticks as number) || !Number.isSafeInteger(mark.tick)) return fail('Corrupt ground impact.');
    impactIds.add(mark.id as number);
    groundImpacts.push({ id: mark.id as number, kind: mark.kind, pos: { x: pos.x as number, y: pos.y as number }, tick: mark.tick as number });
  }

  const tracksRaw = obj.vehicleTracks ?? [];
  if (!Array.isArray(tracksRaw) || tracksRaw.length > MAX_VEHICLE_TRACKS) return fail('Corrupt vehicle track list.');
  const vehicleTracks: NonNullable<SimSnapshot['vehicleTracks']> = [];
  for (const raw of tracksRaw) {
    if (!raw || typeof raw !== 'object') return fail('Corrupt vehicle track.');
    const mark = raw as Record<string, unknown>;
    const from = mark.from as Record<string, unknown> | null, to = mark.to as Record<string, unknown> | null;
    if (!Number.isSafeInteger(mark.unitId) || !boundedNumber(mark.unitId, 1, Number.MAX_SAFE_INTEGER)
      || !Number.isSafeInteger(mark.tick) || !boundedNumber(mark.tick, 0, ticks as number)
      || !from || !to || !boundedNumber(from.x, 0, CONFIG.field.width) || !boundedNumber(from.y, 0, CONFIG.field.height)
      || !boundedNumber(to.x, 0, CONFIG.field.width) || !boundedNumber(to.y, 0, CONFIG.field.height)
      || Math.hypot((to.x as number) - (from.x as number), (to.y as number) - (from.y as number)) > 32) return fail('Corrupt vehicle track.');
    vehicleTracks.push({ unitId: mark.unitId as number, tick: mark.tick as number, from: { x: from.x as number, y: from.y as number }, to: { x: to.x as number, y: to.y as number } });
  }

  const treesRaw = obj.treeDamage ?? [], cells = Math.ceil(CONFIG.field.width / CONFIG.terrain.cell) * Math.ceil(CONFIG.field.height / CONFIG.terrain.cell);
  if (!Array.isArray(treesRaw) || treesRaw.length > cells) return fail('Corrupt tree damage list.');
  const treeDamage: NonNullable<SimSnapshot['treeDamage']> = [], treeCells = new Set<number>();
  for (const raw of treesRaw) {
    if (!raw || typeof raw !== 'object') return fail('Corrupt tree damage.');
    const tree = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(tree.cell) || !boundedNumber(tree.cell, 0, cells - 1) || treeCells.has(tree.cell as number)
      || typeof tree.kind !== 'number' || !isTreeKind(tree.kind) || !boundedNumber(tree.health, 0, TREE_HEALTH) || tree.health === TREE_HEALTH) return fail('Corrupt tree damage.');
    treeCells.add(tree.cell as number); treeDamage.push({ cell: tree.cell as number, kind: tree.kind, health: tree.health as number });
  }

  const smokesRaw = obj.smokes ?? [];
  if (!Array.isArray(smokesRaw) || smokesRaw.length > 200) return fail('Corrupt smoke cloud list.');
  const smokes: NonNullable<SimSnapshot['smokes']> = [];
  for (const raw of smokesRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt smoke cloud.');
    const cloud = raw as Record<string, unknown>;
    const pos = cloud.pos;
    if (!boundedNumber(cloud.id, 1, Number.MAX_SAFE_INTEGER) || typeof pos !== 'object' || pos === null) return fail('Corrupt smoke cloud.');
    const p = pos as Record<string, unknown>;
    if (!boundedNumber(p.x, 0, CONFIG.field.width) || !boundedNumber(p.y, 0, CONFIG.field.height) || !boundedNumber(cloud.radius, 1, 500) || !boundedNumber(cloud.ticksRemaining, 1, 1e6)) return fail('Corrupt smoke cloud.');
    smokes.push({ id: cloud.id as number, pos: { x: p.x as number, y: p.y as number }, radius: cloud.radius as number, ticksRemaining: cloud.ticksRemaining as number });
  }

  const smokeAssaultsRaw = obj.enemySmokeAssaults ?? [];
  if (!Array.isArray(smokeAssaultsRaw) || smokeAssaultsRaw.length > CONFIG.caps.liveEnemies) return fail('Corrupt enemy smoke assaults.');
  const enemySmokeAssaults: NonNullable<SimSnapshot['enemySmokeAssaults']> = [];
  const assaultIds = new Set<number>(), assignedSmokeUnits = new Set<number>();
  for (const raw of smokeAssaultsRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt enemy smoke assault.');
    const plan = raw as Record<string, unknown>, p = plan.pos as Record<string, unknown> | null;
    const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
    if (!validId(plan.id) || assaultIds.has(plan.id) || !validId(plan.leaderId)
      || !Array.isArray(plan.unitIds) || !plan.unitIds.length || plan.unitIds.length > CONFIG.caps.liveEnemies
      || plan.unitIds.some((id) => !validId(id) || assignedSmokeUnits.has(id)) || new Set(plan.unitIds).size !== plan.unitIds.length
      || typeof plan.deployed !== 'boolean' || (!plan.deployed && !plan.unitIds.includes(plan.leaderId))
      || !p || !boundedNumber(p.x, 0, CONFIG.field.width) || !boundedNumber(p.y, 0, CONFIG.field.height)
      || !boundedNumber(plan.deployTick, 0, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(plan.deployTick)
      || !boundedNumber(plan.endTick, 0, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(plan.endTick)
      || (plan.endTick as number) <= (plan.deployTick as number)) return fail('Corrupt enemy smoke assault.');
    assaultIds.add(plan.id); for (const id of plan.unitIds) assignedSmokeUnits.add(id);
    enemySmokeAssaults.push({ id: plan.id, leaderId: plan.leaderId, unitIds: [...plan.unitIds], pos: { x: p.x as number, y: p.y as number },
      deployTick: plan.deployTick as number, endTick: plan.endTick as number, deployed: plan.deployed });
  }

  const campfiresRaw = obj.campfires ?? [];
  if (!Array.isArray(campfiresRaw) || campfiresRaw.length > 200) return fail('Corrupt campfire list.');
  const campfires: NonNullable<SimSnapshot['campfires']> = [];
  const fireOwners = new Set<number>();
  for (const raw of campfiresRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt campfire.');
    const fire = raw as Record<string, unknown>;
    if (!boundedNumber(fire.id, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(fire.id)
      || !boundedNumber(fire.unitId, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(fire.unitId)
      || typeof fire.pos !== 'object' || fire.pos === null) return fail('Corrupt campfire.');
    const pos = fire.pos as Record<string, unknown>;
    if (!boundedNumber(pos.x, 0, CONFIG.field.width) || !boundedNumber(pos.y, 0, CONFIG.field.height)
      || fire.radius !== CONFIG.campfire.radius
      || !boundedNumber(fire.ticksRemaining, 1, CONFIG.campfire.durationSeconds * CONFIG.tickRate)
      || !Number.isInteger(fire.ticksRemaining) || fireOwners.has(fire.unitId as number)) return fail('Corrupt campfire.');
    fireOwners.add(fire.unitId as number);
    campfires.push({ id: fire.id as number, unitId: fire.unitId as number, pos: { x: pos.x as number, y: pos.y as number }, radius: fire.radius as number, ticksRemaining: fire.ticksRemaining as number });
  }

  const validBridgeKey = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > 100) return false;
    const parts = value.split(':');
    return parts.length === 3 && parts[0]!.trim() !== '' && parts[1]!.trim() !== ''
      && boundedNumber(Number(parts[0]), 0, CONFIG.field.width) && boundedNumber(Number(parts[1]), 0, CONFIG.field.height)
      && (parts[2] === 'horizontal' || parts[2] === 'vertical');
  };
  const parseDemolitionTarget = (raw: unknown): DemolitionTarget | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const target = raw as Record<string, unknown>;
    if (target.kind === 'bridge' && validBridgeKey(target.key)) return { kind: 'bridge', key: target.key };
    if ((target.kind === 'building' || target.kind === 'bunker') && Number.isSafeInteger(target.id) && (target.id as number) > 0) {
      return { kind: target.kind, id: target.id as number };
    }
    return null;
  };
  const sapperPoint = (raw: unknown): raw is { x: number; y: number } => {
    if (typeof raw !== 'object' || raw === null) return false;
    const point = raw as Record<string, unknown>;
    return boundedNumber(point.x, 4, CONFIG.field.width - 4) && boundedNumber(point.y, 4, CONFIG.field.height - 4);
  };
  const positiveId = (raw: unknown): raw is number => Number.isSafeInteger(raw) && (raw as number) > 0;
  const teamsRaw = obj.enemySapperTeams ?? [], chargesRaw = obj.enemyDemolitionCharges ?? [];
  if (!Array.isArray(teamsRaw) || teamsRaw.length > 100 || !Array.isArray(chargesRaw) || chargesRaw.length > 200) return fail('Corrupt enemy demolition lists.');
  const enemySapperTeams: EnemySapperTeam[] = [], enemyDemolitionCharges: EnemyDemolitionCharge[] = [];
  const teamIds = new Set<number>(), memberIds = new Set<number>(), chargeIds = new Set<number>();
  for (const raw of teamsRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt sapper team.');
    const team = raw as Record<string, unknown>;
    const target = team.target === null ? null : parseDemolitionTarget(team.target);
    if (!positiveId(team.id) || teamIds.has(team.id) || !positiveId(team.sapperId) || memberIds.has(team.sapperId)
      || !Array.isArray(team.escortIds) || team.escortIds.length !== 2 || team.escortIds.some((id) => !positiveId(id) || memberIds.has(id) || id === team.sapperId)
      || team.escortIds[0] === team.escortIds[1] || (team.target !== null && target === null)
      || (team.plantPos !== null && !sapperPoint(team.plantPos)) || (team.target === null) !== (team.plantPos === null)
      || !boundedNumber(team.plantTicks, 0, CONFIG.enemySappers.plantSeconds * CONFIG.tickRate) || !Number.isInteger(team.plantTicks)
      || (team.target === null && team.plantTicks !== 0)
      || !boundedNumber(team.nextPlanTick, 0, ticks + CONFIG.tickRate * 2) || !Number.isSafeInteger(team.nextPlanTick)
      || (team.chargeId !== null && !positiveId(team.chargeId))) return fail('Corrupt sapper team.');
    const sapper = units.find((unit) => unit.id === team.sapperId);
    if (sapper && (sapper.team !== 'enemy' || sapper.role !== 'sapper')) return fail('Corrupt sapper leader.');
    for (const id of team.escortIds) {
      const escort = units.find((unit) => unit.id === id);
      if (escort && (escort.team !== 'enemy' || escort.role !== 'rifle')) return fail('Corrupt sapper escort.');
      memberIds.add(id as number);
    }
    teamIds.add(team.id); memberIds.add(team.sapperId);
    enemySapperTeams.push({ id: team.id, sapperId: team.sapperId, escortIds: [...team.escortIds] as number[], target,
      plantPos: team.plantPos === null ? null : { ...team.plantPos as { x: number; y: number } }, plantTicks: team.plantTicks as number,
      nextPlanTick: team.nextPlanTick as number, chargeId: team.chargeId as number | null });
  }
  for (const raw of chargesRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt enemy demolition charge.');
    const charge = raw as Record<string, unknown>, target = parseDemolitionTarget(charge.target);
    if (!positiveId(charge.id) || chargeIds.has(charge.id) || !positiveId(charge.unitId) || !target || !sapperPoint(charge.pos)
      || !boundedNumber(charge.ticksRemaining, 1, CONFIG.enemySappers.fuseSeconds * CONFIG.tickRate)
      || !Number.isInteger(charge.ticksRemaining)) return fail('Corrupt enemy demolition charge.');
    chargeIds.add(charge.id);
    enemyDemolitionCharges.push({ id: charge.id, unitId: charge.unitId, target, pos: { ...charge.pos }, ticksRemaining: charge.ticksRemaining as number });
  }
  const destroyedBridgeKeys = obj.destroyedBridgeKeys ?? [];
  if (!Array.isArray(destroyedBridgeKeys) || destroyedBridgeKeys.length > 100 || destroyedBridgeKeys.some((key) => !validBridgeKey(key))
    || new Set(destroyedBridgeKeys).size !== destroyedBridgeKeys.length) return fail('Corrupt destroyed bridge list.');

  const satchelsRaw = obj.satchelCharges ?? [];
  if (!Array.isArray(satchelsRaw) || satchelsRaw.length > 200) return fail('Corrupt satchel charge list.');
  const satchelCharges: NonNullable<SimSnapshot['satchelCharges']> = [];
  const satchelIds = new Set<number>(), satchelOwners = new Set<number>();
  for (const raw of satchelsRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt satchel charge.');
    const charge = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(charge.id) || (charge.id as number) < 1
      || !Number.isSafeInteger(charge.unitId) || (charge.unitId as number) < 1
      || typeof charge.pos !== 'object' || charge.pos === null) return fail('Corrupt satchel charge.');
    const pos = charge.pos as Record<string, unknown>;
    if (!boundedNumber(pos.x, 4, CONFIG.field.width - 4) || !boundedNumber(pos.y, 4, CONFIG.field.height - 4)
      || !boundedNumber(charge.ticksRemaining, 1, CONFIG.satchel.fuseSeconds * CONFIG.tickRate)
      || !Number.isInteger(charge.ticksRemaining) || satchelIds.has(charge.id as number)
      || satchelOwners.has(charge.unitId as number)) return fail('Corrupt satchel charge.');
    satchelIds.add(charge.id as number); satchelOwners.add(charge.unitId as number);
    satchelCharges.push({ id: charge.id as number, unitId: charge.unitId as number, pos: { x: pos.x as number, y: pos.y as number }, ticksRemaining: charge.ticksRemaining as number });
  }

  const flaresRaw = obj.flares ?? [];
  if (!Array.isArray(flaresRaw) || flaresRaw.length > 100) return fail('Corrupt flare list.');
  const flares: NonNullable<SimSnapshot['flares']> = [];
  for (const raw of flaresRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt flare.');
    const flare = raw as Record<string, unknown>;
    const pos = flare.pos;
    if (!boundedNumber(flare.id, 1, Number.MAX_SAFE_INTEGER) || typeof pos !== 'object' || pos === null) return fail('Corrupt flare.');
    const p = pos as Record<string, unknown>;
    const pendingTicksRemaining = flare.pendingTicksRemaining ?? 0;
    if (!boundedNumber(p.x, 0, CONFIG.field.width) || !boundedNumber(p.y, 0, CONFIG.field.height) || flare.radius !== CONFIG.flare.radius || !boundedNumber(flare.ticksRemaining, 1, CONFIG.flare.durationSeconds * CONFIG.tickRate) || !boundedNumber(pendingTicksRemaining, 0, CONFIG.flare.deploymentDelaySeconds * CONFIG.tickRate)) return fail('Corrupt flare.');
    flares.push({ id: flare.id as number, pos: { x: p.x as number, y: p.y as number }, radius: flare.radius as number, pendingTicksRemaining: pendingTicksRemaining as number, ticksRemaining: flare.ticksRemaining as number });
  }

  const strikesRaw = obj.strikes;
  if (!Array.isArray(strikesRaw) || strikesRaw.length > 1000) return fail('Corrupt strike list.');
  const strikes: SimSnapshot['strikes'] = [];
  for (const raw of strikesRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt strike.');
    const k = raw as Record<string, unknown>;
    if (!boundedNumber(k.id, 1, Number.MAX_SAFE_INTEGER)) return fail('Corrupt strike id.');
    const pos = k.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt strike position.');
    const pp = pos as Record<string, unknown>;
    if (!boundedNumber(pp.x, 0, CONFIG.field.width) || !boundedNumber(pp.y, 0, CONFIG.field.height)) return fail('Strike out of bounds.');
    if (!boundedNumber(k.landTick, 0, 1e9) || !boundedNumber(k.radius, 1, 1e4) || !boundedNumber(k.damage, 0, 1e6) || !boundedNumber(k.suppressionAmount, 0, 1e4)) {
      return fail('Corrupt strike stats.');
    }
    // The firing side arrived with schema v5; earlier shells were all the
    // player's own, so an absent source reads as friendly.
    if (k.source !== undefined && k.source !== 'friendly' && k.source !== 'enemy') return fail('Corrupt strike source.');
    if (k.delivery !== undefined && k.delivery !== 'artillery' && k.delivery !== 'airSupport' && k.delivery !== 'mortar') return fail('Corrupt strike delivery.');
    if (k.sourceId !== undefined && (!boundedNumber(k.sourceId, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(k.sourceId))) return fail('Corrupt strike source unit.');
    strikes.push(k as unknown as SimSnapshot['strikes'][number]);
  }

  const sandbagsRaw = obj.sandbags;
  if (!Array.isArray(sandbagsRaw) || sandbagsRaw.length > 500) return fail('Corrupt sandbag list.');
  const sandbags: SimSnapshot['sandbags'] = [];
  for (const raw of sandbagsRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt sandbag.');
    const b = raw as Record<string, unknown>;
    if (!boundedNumber(b.id, 1, Number.MAX_SAFE_INTEGER)) return fail('Corrupt sandbag id.');
    const pos = b.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt sandbag position.');
    const pp = pos as Record<string, unknown>;
    if (!boundedNumber(pp.x, 0, CONFIG.field.width) || !boundedNumber(pp.y, 0, CONFIG.field.height)) return fail('Sandbag out of bounds.');
    sandbags.push(b as unknown as SimSnapshot['sandbags'][number]);
  }

  // Trenches were added after the original save schema shipped. Older saves
  // omit this field, so restore them as battles with no trenches built yet.
  const trenchesRaw = obj.trenches ?? [];
  if (!Array.isArray(trenchesRaw) || trenchesRaw.length > 500) return fail('Corrupt trench list.');
  const trenches: SimSnapshot['trenches'] = [];
  for (const raw of trenchesRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt trench.');
    const trench = raw as Record<string, unknown>;
    if (!boundedNumber(trench.id, 1, Number.MAX_SAFE_INTEGER)) return fail('Corrupt trench id.');
    const pos = trench.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt trench position.');
    const pp = pos as Record<string, unknown>;
    if (!boundedNumber(pp.x, 0, CONFIG.field.width) || !boundedNumber(pp.y, 0, CONFIG.field.height)) return fail('Trench out of bounds.');
    trenches.push(trench as unknown as SimSnapshot['trenches'][number]);
  }

  const bunkersRaw = obj.bunkers ?? [];
  if (!Array.isArray(bunkersRaw) || bunkersRaw.length > 500) return fail('Corrupt bunker list.');
  const bunkers: NonNullable<SimSnapshot['bunkers']> = [];
  for (const raw of bunkersRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt bunker.');
    const bunker = raw as Record<string, unknown>;
    if (!boundedNumber(bunker.id, 1, Number.MAX_SAFE_INTEGER)) return fail('Corrupt bunker id.');
    const pos = bunker.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt bunker position.');
    const p = pos as Record<string, unknown>;
    if (!boundedNumber(p.x, 0, CONFIG.field.width) || !boundedNumber(p.y, 0, CONFIG.field.height)) return fail('Bunker out of bounds.');
    bunkers.push({ id: bunker.id as number, pos: { x: p.x as number, y: p.y as number } });
  }

  const barbedWireRaw = obj.barbedWire ?? [];
  if (!Array.isArray(barbedWireRaw) || barbedWireRaw.length > 500) return fail('Corrupt barbed wire list.');
  const barbedWire: NonNullable<SimSnapshot['barbedWire']> = [];
  const wireIds = new Set<number>();
  for (const raw of barbedWireRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt barbed wire.');
    const wire = raw as Record<string, unknown>, p = wire.pos as Record<string, unknown> | undefined;
    if (!boundedNumber(wire.id, 1, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(wire.id)
      || wireIds.has(wire.id as number)) return fail('Corrupt barbed wire id.');
    if (!p || typeof p !== 'object' || !boundedNumber(p.x, CONFIG.barbedWire.halfLength, CONFIG.field.width - CONFIG.barbedWire.halfLength)
      || !boundedNumber(p.y, CONFIG.barbedWire.halfDepth, CONFIG.field.height - CONFIG.barbedWire.halfDepth)) return fail('Barbed wire out of bounds.');
    if (!boundedNumber(wire.cutTicks, 0, CONFIG.barbedWire.cutSeconds * CONFIG.tickRate - 1)
      || !Number.isInteger(wire.cutTicks)) return fail('Corrupt wire cutting progress.');
    wireIds.add(wire.id as number);
    barbedWire.push({ id: wire.id as number, pos: { x: p.x as number, y: p.y as number }, cutTicks: wire.cutTicks as number });
  }

  const mortarPitsRaw = obj.mortarPits ?? [];
  if (!Array.isArray(mortarPitsRaw) || mortarPitsRaw.length > 500) return fail('Corrupt mortar pit list.');
  const mortarPits: NonNullable<SimSnapshot['mortarPits']> = [];
  for (const raw of mortarPitsRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt mortar pit.');
    const pit = raw as Record<string, unknown>;
    if (!boundedNumber(pit.id, 1, Number.MAX_SAFE_INTEGER)) return fail('Corrupt mortar pit id.');
    const pos = pit.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt mortar pit position.');
    const p = pos as Record<string, unknown>;
    if (!boundedNumber(p.x, 0, CONFIG.field.width) || !boundedNumber(p.y, 0, CONFIG.field.height)) return fail('Mortar pit out of bounds.');
    mortarPits.push({ id: pit.id as number, pos: { x: p.x as number, y: p.y as number } });
  }

  // Mines arrived with schema v2; older saves carry none.
  const minesRaw = obj.mines ?? [];
  if (!Array.isArray(minesRaw) || minesRaw.length > 500) return fail('Corrupt mine list.');
  const mines: SimSnapshot['mines'] = [];
  for (const raw of minesRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt mine.');
    const laid = raw as Record<string, unknown>;
    if (!boundedNumber(laid.id, 1, Number.MAX_SAFE_INTEGER)) return fail('Corrupt mine id.');
    const pos = laid.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt mine position.');
    const mp = pos as Record<string, unknown>;
    if (!boundedNumber(mp.x, 0, CONFIG.field.width) || !boundedNumber(mp.y, 0, CONFIG.field.height)) {
      return fail('Mine out of bounds.');
    }
    if (typeof laid.armed !== 'boolean') return fail('Corrupt mine arming state.');
    // Older saves predate typed mines; they were all anti-personnel.
    const kind = laid.kind ?? 'ap';
    if (kind !== 'ap' && kind !== 'at') return fail('Unknown mine type.');
    const damageMult = laid.damageMult;
    if (damageMult !== undefined && !boundedNumber(damageMult, 1, 2)) return fail('Corrupt mine damage multiplier.');
    mines.push({ id: laid.id as number, pos: { x: mp.x as number, y: mp.y as number }, kind, armed: laid.armed, ...(damageMult === undefined ? {} : { damageMult: damageMult as number }) });
  }

  const constructionRaw = obj.constructionSites ?? [];  if (!Array.isArray(constructionRaw) || constructionRaw.length > 100) return fail('Corrupt construction site list.');
  const constructionSites: SimSnapshot['constructionSites'] = [];
  for (const raw of constructionRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt construction site.');
    const site = raw as Record<string, unknown>;
    if (!boundedNumber(site.id, 1, Number.MAX_SAFE_INTEGER) || !boundedNumber(site.builderId, 1, Number.MAX_SAFE_INTEGER)) {
      return fail('Corrupt construction site id.');
    }
    if (site.kind !== 'sandbag' && site.kind !== 'trench' && site.kind !== 'mine' && site.kind !== 'bunker' && site.kind !== 'mortarPit' && site.kind !== 'bridge' && site.kind !== 'barbedWire') return fail('Unknown construction kind.');
    if (site.kind === 'mine' && site.mineKind !== undefined && site.mineKind !== 'ap' && site.mineKind !== 'at') return fail('Unknown construction mine type.');
    if (site.bridgeAxis !== undefined && site.bridgeAxis !== 'horizontal' && site.bridgeAxis !== 'vertical') return fail('Corrupt construction bridge axis.');
    if (site.bridgeHalfWidth !== undefined && !boundedNumber(site.bridgeHalfWidth, 5, 100)) return fail('Corrupt construction bridge width.');
    if (site.bridgeHalfLength !== undefined && !boundedNumber(site.bridgeHalfLength, 5, 200)) return fail('Corrupt construction bridge length.');
    const pos = site.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt construction position.');
    const p = pos as Record<string, unknown>;
    if (!boundedNumber(p.x, 0, CONFIG.field.width) || !boundedNumber(p.y, 0, CONFIG.field.height)) return fail('Construction site out of bounds.');
    if (site.kind === 'barbedWire' && (!boundedNumber(p.x, CONFIG.barbedWire.halfLength, CONFIG.field.width - CONFIG.barbedWire.halfLength)
      || !boundedNumber(p.y, CONFIG.barbedWire.halfDepth, CONFIG.field.height - CONFIG.barbedWire.halfDepth))) return fail('Wire construction out of bounds.');
    if (!boundedNumber(site.totalTicks, 1, 1e6) || !boundedNumber(site.ticksRemaining, 0, site.totalTicks as number)) {
      return fail('Corrupt construction timer.');
    }
    constructionSites.push(site as unknown as SimSnapshot['constructionSites'][number]);
  }

  const builtBridgesRaw = obj.builtBridges ?? [];
  if (!Array.isArray(builtBridgesRaw) || builtBridgesRaw.length > 100) return fail('Corrupt built bridge list.');
  const builtBridges: NonNullable<SimSnapshot['builtBridges']> = [];
  for (const raw of builtBridgesRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt built bridge.');
    const bridge = raw as Record<string, unknown>;
    const pos = bridge.pos;
    if (!boundedNumber(bridge.id, 1, Number.MAX_SAFE_INTEGER) || typeof pos !== 'object' || pos === null) return fail('Corrupt built bridge.');
    const p = pos as Record<string, unknown>;
    if (!boundedNumber(p.x, 0, CONFIG.field.width) || !boundedNumber(p.y, 0, CONFIG.field.height)) return fail('Built bridge out of bounds.');
    if (bridge.axis !== 'horizontal' && bridge.axis !== 'vertical') return fail('Corrupt bridge axis.');
    if (!boundedNumber(bridge.halfWidth, 5, 100) || !boundedNumber(bridge.halfLength, 5, 200)) return fail('Corrupt bridge dimensions.');
    builtBridges.push({ id: bridge.id as number, pos: { x: p.x as number, y: p.y as number }, axis: bridge.axis, halfWidth: bridge.halfWidth as number, halfLength: bridge.halfLength as number });
  }

  // Buildings arrived with schema v4. Older saves have none, and restoring one
  // generates its map without any structures so the record stays consistent.
  const buildingsRaw = obj.buildings ?? [];
  const terrainLayoutVersion = obj.terrainLayoutVersion ?? 1;
  if (terrainLayoutVersion !== 1 && terrainLayoutVersion !== 2 && terrainLayoutVersion !== 3 && terrainLayoutVersion !== 4) return fail('Unknown terrain layout version.');
  if (obj.campaignCountry !== undefined && terrainLayoutVersion === 1) return fail('Country campaigns require the current terrain layout.');
  if (!Array.isArray(buildingsRaw) || buildingsRaw.length > 200) return fail('Corrupt building list.');
  const buildings: SimSnapshot['buildings'] = [];
  const buildingKinds: readonly string[] = ['church', 'castle', 'house', 'hospital', 'school', 'restaurant', 'bakery', 'clinic', 'generalStore', 'bar', 'barn'];
  const seenBuildingIds = new Set<number>();
  for (const raw of buildingsRaw) {
    if (typeof raw !== 'object' || raw === null) return fail('Corrupt building.');
    const b = raw as Record<string, unknown>;
    if (!boundedNumber(b.id, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(b.id)) return fail('Corrupt building id.');
    if (seenBuildingIds.has(b.id as number)) return fail('Duplicate building id.');
    seenBuildingIds.add(b.id as number);
    if (typeof b.kind !== 'string' || !buildingKinds.includes(b.kind)) return fail('Unknown building kind.');
    if (typeof b.name !== 'string' || b.name.length === 0 || b.name.length > 80) return fail('Corrupt building name.');
    const pos = b.pos;
    if (typeof pos !== 'object' || pos === null) return fail('Corrupt building position.');
    const bp = pos as Record<string, unknown>;
    if (!boundedNumber(bp.x, 0, CONFIG.field.width) || !boundedNumber(bp.y, 0, CONFIG.field.height)) {
      return fail('Building out of bounds.');
    }
    const footprint = CONFIG.buildings.footprints[b.kind as BuildingKind];
    if (!boundedNumber(b.cols, 1, 12) || !Number.isInteger(b.cols) || b.cols !== footprint.cols) return fail('Corrupt building footprint.');
    if (!boundedNumber(b.rows, 1, 12) || !Number.isInteger(b.rows) || b.rows !== footprint.rows) return fail('Corrupt building footprint.');
    const maxHealth = CONFIG.buildings.health[b.kind as BuildingKind];
    if (!boundedNumber(b.maxHealth, 1, 1e7) || b.maxHealth !== maxHealth) return fail('Corrupt building health.');
    if (!boundedNumber(b.health, 0, b.maxHealth as number)) return fail('Corrupt building health.');
    if (typeof b.destroyed !== 'boolean') return fail('Corrupt building state.');
    if (b.floors !== undefined && (!boundedNumber(b.floors, 1, 5) || !Number.isInteger(b.floors))) return fail('Corrupt building floors.');
    if (b.roofStyle !== undefined && b.roofStyle !== 'flat' && b.roofStyle !== 'pitched') return fail('Corrupt roof style.');
    if (b.rooftopAccess !== undefined && typeof b.rooftopAccess !== 'boolean') return fail('Corrupt rooftop access.');
    if (b.rooftopAccess === true && b.roofStyle === 'pitched') return fail('Pitched roof cannot be occupied.');
    if (b.balcony !== undefined && typeof b.balcony !== 'boolean') return fail('Corrupt balcony.');
    // A standing building cannot have zero health; a ruin cannot have any.
    if (b.destroyed === (b.health !== 0)) return fail('Building state contradicts its health.');
    buildings.push(b as unknown as SimSnapshot['buildings'][number]);
  }

  if (!boundedNumber(obj.points, 0, 1e6)) return fail('Corrupt points.');
  if (!boundedNumber(obj.integrity, 0, CONFIG.start.integrity)) return fail('Corrupt integrity.');
  if (!boundedNumber(obj.score, 0, 1e9)) return fail('Corrupt score.');
  if (!boundedNumber(obj.artilleryCooldown, 0, 1e6)) return fail('Corrupt cooldown.');
  const airSupportCooldown = obj.airSupportCooldown ?? 0;
  if (!boundedNumber(airSupportCooldown, 0, 1e6)) return fail('Corrupt air support cooldown.');
  const flareCooldown = obj.flareCooldown ?? 0;
  if (!boundedNumber(flareCooldown, 0, 1e6)) return fail('Corrupt flare cooldown.');
  // Axis counter-battery fire arrived with schema v5; older saves resume with a
  // battery that is ready, exactly as they would with a cooldown of zero.
  const enemyArtilleryCooldown = obj.enemyArtilleryCooldown ?? 0;
  if (!boundedNumber(enemyArtilleryCooldown, 0, 1e6)) return fail('Corrupt enemy artillery cooldown.');
  const foodSupplyCooldown = obj.foodSupplyCooldown ?? 0;
  if (!boundedNumber(foodSupplyCooldown, 0, 1e6)) return fail('Corrupt food supply cooldown.');
  if (typeof obj.endless !== 'boolean') return fail('Corrupt endless flag.');
  if (obj.phase !== 'running' && obj.phase !== 'victory' && obj.phase !== 'defeat') return fail('Corrupt phase.');

  // The northern march arrived with schema v3. Older saves are, by definition,
  // still on their first map with nobody across the edge.
  const mapNumber = obj.mapNumber ?? 1;
  if (!boundedNumber(mapNumber, 1, 1e6) || !Number.isInteger(mapNumber)) return fail('Corrupt map number.');
  const mapsCleared = obj.mapsCleared ?? Math.max(0, (mapNumber as number) - 1);
  if (!boundedNumber(mapsCleared, 0, 1e6) || !Number.isInteger(mapsCleared)) return fail('Corrupt maps cleared.');
  const captureTicks = obj.captureTicks ?? 0;
  if (!boundedNumber(captureTicks, 0, CONFIG.crossing.captureSeconds * CONFIG.tickRate)) return fail('Corrupt capture objective progress.');
  if (obj.sectorCaptured !== undefined && typeof obj.sectorCaptured !== 'boolean') return fail('Corrupt capture objective state.');
  if (obj.sectorSupplyPending !== undefined && typeof obj.sectorSupplyPending !== 'boolean') return fail('Corrupt sector supply state.');
  const baseTerrainSeed = obj.baseTerrainSeed ?? seed;
  if (!boundedNumber(baseTerrainSeed, 0, 0xffffffff)) return fail('Corrupt base terrain seed.');

  const crossedRaw = obj.crossedUnits ?? [];
  if (!Array.isArray(crossedRaw)) return fail('Corrupt crossed-soldier list.');
  const crossedUnits = readUnits(crossedRaw);
  if ('error' in crossedUnits) return { error: `Crossed soldiers: ${crossedUnits.error}` };
  const occupiedSlots = new Set<string>();
  const buildingTeams = new Map<number, string>();
  for (const unit of [...units, ...crossedUnits]) {
    if (unit.buildingCooldown !== undefined && !boundedNumber(unit.buildingCooldown, 0, 1e6)) return fail('Corrupt building cooldown.');
    for (const key of ['buildingPosition', 'buildingOrder'] as const) {
      const position = unit[key];
      if (position === undefined) continue;
      if (typeof position !== 'object' || position === null || crossedUnits.includes(unit) || unit.role === 'vehicle' || unit.role === 'gun_truck' || unit.role === 'troop_transport') return fail('Corrupt building occupant.');
      const building = buildings.find((b) => b.id === position.buildingId && !b.destroyed);
      if (!building || !buildingLevels(building).includes(position.level)) return fail('Unavailable building position.');
      if (!Number.isInteger(position.slot) || position.slot < 0 || position.slot >= positionCapacity(position.level)) return fail('Corrupt firing slot.');
      if (key === 'buildingOrder' && (!boundedNumber(unit.buildingOrder!.climbTicks, 0, 1e6) || !Number.isInteger(unit.buildingOrder!.climbTicks))) return fail('Corrupt stair movement.');
      const slot = `${position.buildingId}:${position.level}:${position.slot}`;
      const sameUnit = unit.buildingPosition && unit.buildingOrder && unit.buildingPosition.buildingId === position.buildingId && unit.buildingPosition.level === position.level && unit.buildingPosition.slot === position.slot;
      if (occupiedSlots.has(slot) && !(key === 'buildingOrder' && sameUnit)) return fail('Duplicate firing slot.');
      occupiedSlots.add(slot);
      if (buildingTeams.has(building.id) && buildingTeams.get(building.id) !== unit.team) return fail('Opposing building occupants.');
      buildingTeams.set(building.id, unit.team);
    }
  }
  // A soldier cannot be both on the map and off it: the ids were checked for
  // duplicates across both lists by the shared reader.
  for (const unit of crossedUnits) {
    if (unit.team !== 'friendly') return fail('Only Allied soldiers can cross the north edge.');
  }

  const schedRaw = obj.scheduler;
  if (typeof schedRaw !== 'object' || schedRaw === null) return fail('Corrupt scheduler.');
  const sched = schedRaw as Record<string, unknown>;
  if (!boundedNumber(sched.waveIndex, 0, 1e6)) return fail('Corrupt wave index.');
  const phase = sched.phase;
  const wavePhases: readonly string[] = ['prep', 'spawning', 'active', 'advance', 'crossing'];
  if (typeof phase !== 'string' || !wavePhases.includes(phase)) return fail('Corrupt wave phase.');
  if (!boundedNumber(sched.prepTicksLeft, 0, 1e6)) return fail('Corrupt prep timer.');
  if (!Array.isArray(sched.spawnQueue)) return fail('Corrupt spawn queue.');
  if (sched.spawnQueue.length > 1000) return fail('Spawn queue too long.');
  for (const a of sched.spawnQueue) {
    if (typeof a !== 'string' || !enemyRoles.includes(a)) return fail('Unknown archetype in spawn queue.');
  }
  if (!boundedNumber(sched.spawnTimer, 0, 1e6)) return fail('Corrupt spawn timer.');
  if (typeof sched.rewardGranted !== 'boolean') return fail('Corrupt reward flag.');
  const endlessWavesCleared = sched.endlessWavesCleared ?? 0;
  if (!boundedNumber(endlessWavesCleared, 0, 1e6) || !Number.isInteger(endlessWavesCleared)) {
    return fail('Corrupt endless wave counter.');
  }
  const inferredWavesCompleted = Math.max(
    sched.waveIndex as number,
    (endlessWavesCleared as number) + (sched.waveIndex as number),
    (mapsCleared as number) * CONFIG.crossing.captureAfterWaves + (sched.waveIndex as number),
  );
  const wavesCompleted = obj.wavesCompleted ?? inferredWavesCompleted;
  if (!boundedNumber(wavesCompleted, 0, 1e6) || !Number.isInteger(wavesCompleted)) return fail('Corrupt completed wave count.');
  let dayNightStartTick: number | null;
  if (obj.dayNightStartTick === undefined) {
    // Legacy saves have no cycle start tick. Once three clears are known, begin
    // the new clock on resume rather than applying night before the unlock.
    dayNightStartTick = (wavesCompleted as number) >= CONFIG.dayNight.startAfterWaves ? ticks as number : null;
  } else if (obj.dayNightStartTick === null) {
    dayNightStartTick = null;
  } else if (boundedNumber(obj.dayNightStartTick, 0, ticks as number) && Number.isInteger(obj.dayNightStartTick)) {
    dayNightStartTick = obj.dayNightStartTick as number;
  } else {
    return fail('Corrupt day/night start tick.');
  }
  if ((wavesCompleted as number) < CONFIG.dayNight.startAfterWaves && dayNightStartTick !== null) {
    return fail('Day/night started before its wave requirement.');
  }
  if ((wavesCompleted as number) >= CONFIG.dayNight.startAfterWaves && dayNightStartTick === null) {
    return fail('Day/night clock is missing after its wave requirement.');
  }

  const snap: SimSnapshot = {
    schemaVersion: 30,
    season,
    ...(isCampaignCountry(obj.campaignCountry) ? { campaignCountry: obj.campaignCountry } : {}),
    seed: seed as number,
    weather: weather as WeatherKind,
    weatherChangeTick: weatherChangeTick as number,
    wavesCompleted: wavesCompleted as number,
    dayNightStartTick,
    rng: { s: rngS as number },
    // Absent on a pre-v6 save; the simulation derives it from the seed on resume.
    enemyArtilleryRng: enemyArtilleryRngS === undefined ? undefined : { s: enemyArtilleryRngS },
    ticks: ticks as number,
    nextEntityId: nextEntityId as number,
    units,
    battleRecord,
    projectiles: projectiles as SimSnapshot['projectiles'],
    smokes,
    enemySmokeAssaults,
    enemySapperTeams,
    enemyDemolitionCharges,
    destroyedBridgeKeys: destroyedBridgeKeys as string[],
    flares,
    campfires,
    satchelCharges,
    strikes: strikes as SimSnapshot['strikes'],
    groundImpacts,
    vehicleTracks,
    treeDamage,
    sandbags: sandbags as SimSnapshot['sandbags'],
    trenches,
    bunkers,
    mortarPits,
    barbedWire,
    mines,
    builtBridges,
    constructionSites,
    buildings,
    points: obj.points as number,
    integrity: obj.integrity as number,
    score: obj.score as number,
    scheduler: {
      waveIndex: sched.waveIndex as number,
      phase: phase as WavePhase,
      prepTicksLeft: sched.prepTicksLeft as number,
      spawnQueue: (sched.spawnQueue as EnemyArchetype[]).slice(),
      spawnTimer: sched.spawnTimer as number,
      rewardGranted: sched.rewardGranted as boolean,
      endlessWavesCleared: endlessWavesCleared as number,
    },
    artilleryCooldown: obj.artilleryCooldown as number,
    airSupportCooldown: airSupportCooldown as number,
    flareCooldown: flareCooldown as number,
    enemyArtilleryCooldown: enemyArtilleryCooldown as number,
    foodSupplyCooldown: foodSupplyCooldown as number,
    endless: obj.endless as boolean,
    phase: obj.phase as SimSnapshot['phase'],
    mapNumber: mapNumber as number,
    mapsCleared: mapsCleared as number,
    captureTicks: captureTicks as number,
    sectorCaptured: obj.sectorCaptured === true,
    sectorSupplyPending: obj.sectorSupplyPending === true,
    baseTerrainSeed: baseTerrainSeed as number,
    crossedUnits,
    medicalQueue: [...medicalQueue],
    grenadeSupplyQueue: [...grenadeSupplyQueue],
    // Older saves never had buildings; v4 and later always do, even an empty list.
    terrainHasBuildings: obj.terrainHasBuildings !== false && (obj.schemaVersion as number) >= 4,
    terrainLayoutVersion,
  };
  return { snap };
}

/** Read and validate the autosave; returns a descriptive error when unusable. */
export function loadSnapshot(storage: Storage): { snap: SimSnapshot } | { error: string } | null {
  const text = storage.get(KEYS.save);
  if (text === null) return null; // no save present
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { error: 'Save is not valid JSON.' };
  }
  return validateSnapshot(raw);
}

export function saveSnapshot(storage: Storage, snap: SimSnapshot): boolean {
  return storage.set(KEYS.save, JSON.stringify(snap));
}

export function clearSnapshot(storage: Storage): void {
  storage.remove(KEYS.save);
}
