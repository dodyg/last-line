import type { VehicleTrack } from './battle-wear';
/** Shared simulation types. Plain data only - JSON-serializable except terrain, which is regenerated from the seed. */

export interface Vec2 {
  x: number;
  y: number;
}

export interface PatrolArea { min: Vec2; max: Vec2 }
export interface PatrolOrder {
  area: PatrolArea;
  points: Vec2[];
  nextPoint: number;
  /** Retry a temporarily blocked leg at most once a second. */
  retryTick: number;
}

export type Team = 'friendly' | 'enemy';
export type CampaignCountry = 'france' | 'belgium' | 'italy' | 'germany' | 'luxembourg' | 'netherlands';
export type SoldierStance = 'standing' | 'crouching' | 'prone';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
/** `rain` is the steady, medium intensity retained for older saves. */
export type WeatherKind = 'clear' | 'lightRain' | 'rain' | 'heavyRain' | 'lightFog' | 'fog' | 'heavyFog' | 'lightSnow' | 'snow' | 'heavySnow';

export type FriendlyRole = 'rifleman' | 'mg' | 'medic' | 'supply_officer' | 'at' | 'sniper' | 'engineer' | 'radio_engineer' | 'officer' | 'mortarman' | 'gun_truck' | 'scout' | 'heavy_mg' | 'assault_infantry' | 'at_gun' | 'grenadier' | 'flamethrower';
export type EnemyArchetype = 'mortar_team' | 'rifle' | 'assault' | 'vehicle' | 'observer' | 'gun_truck' | 'troop_transport' | 'sapper' | 'mg_team' | 'sharpshooter' | 'field_officer' | 'at_infantry' | 'infiltrator';
export type UnitRole = FriendlyRole | EnemyArchetype;
export type WeaponUpgradeType = 'accuracy' | 'reload' | 'damage';
export type TankComponent = 'tracks' | 'turret' | 'machineGun';
export type TankDamage = Record<TankComponent, boolean>;

export interface NightContact {
  sourceId: number;
  kind: 'sound' | 'muzzleFlash' | 'tracer';
  pos: Vec2;
  /** Absolute height in simulation pixels at the time of firing. */
  height: number;
  noticedTick: number;
  expiresTick: number;
}

export interface HeardGunfire {
  sourceId: number;
  pos: Vec2;
  noticedTick: number;
  expiresTick: number;
}

export interface AmbushOrder {
  facing: number;
  range: number;
  arcDegrees: number;
  prepTicks: number;
  triggered: boolean;
  /** Remaining shots in the opening burst; zero while waiting for a trigger. */
  bonusShots: number;
}

export interface Unit {
  /** Individually issued firearm; absent means the role's original equipment. */
  assignedWeaponId?: string;
  /** Personal ratings, 1–100, improved by field experience. Older saves default to 50. */
  attributes?: SoldierAttributes;
  /** Cleared waves toward the next attribute gain; persists between maps. */
  attributeTrainingWaves?: number;
  /** Weapon crews pack, turn and deploy before firing. Angles use simulation XY. */
  deployment?: { ticks: number; facing: number; packingTicks: number };
  aim?: { targetId: number; ticks: number };
  revealedUntil?: number;
  detectedUntil?: number;
  clearBuilding?: { buildingId: number; level: BuildingLevel; facing?: BuildingFacing; ticks: number };

  /** Surviving tank crew remain ordinary infantry for targeting and wave counts. */
  tankCrew?: { tankId: number; behavior: 'retreat' | 'fight'; exit: Vec2; retryTick: number; bailoutTicks: number };
  /** Permanent subsystem failures on enemy tanks; absent means fully operational. */
  tankDamage?: TankDamage;
  /** Passengers remain aboard until the whole squad dismounts together. */
  transport?: { passengers: number; dropOff: Vec2; exit: Vec2; unloadTicks: number; retryTick: number };
  /** Personal audible enemy shots, during daylight as well as at night. */
  heardGunfire?: HeardGunfire[];
  /** Last heard position being investigated, never a hidden live position. */
  gunfirePursuit?: HeardGunfire & { retryTick: number };
  /** A hostile shell temporarily replaced this friendly's movement route. */
  dodgingStrike?: boolean;
  /** Repeating area patrol; direct movement and building orders replace it. */
  patrol?: PatrolOrder;
  roleDuty?: RoleDuty;
  roleCooldown?: number;
  scoutReports?: ScoutReport[];
  /** Independent upper/lower route while within a bridge footprint. */
  bridgePosition?: BridgePosition;
  /** Personal last-known firing positions; silence and movement break contact. */
  nightContacts?: NightContact[];
  /** A window, balcony, or roof firing position; absent while on open ground. */
  buildingPosition?: BuildingPosition;
  /** Route to an entrance, followed by a timed climb to the chosen position. */
  buildingOrder?: BuildingPosition & { climbTicks: number };
  buildingCooldown?: number;
  id: number;
  team: Team;
  role: UnitRole;
  pos: Vec2;
  /** Position at the start of the current tick; used by the renderer for interpolation. Not gameplay-relevant. */
  prevPos: Vec2;
  health: number;
  /** Set once on death; guards one-time death effects. Dead units are removed at the end of the tick. */
  dead: boolean;
  suppression: number;
  pinned: boolean;
  /** Infantry posture; omitted by saves written before posture orders existed. */
  stance?: SoldierStance;
  /** Crawl orders keep infantry low and slow while following a movement path. */
  crawling?: boolean;
  /** Automatic low posture on steep ground; the player's posture order is retained. */
  terrainCrawling?: boolean;
  /** Walking is the default; a run order lasts until arrival or exhaustion. */
  movementPace?: 'walk' | 'run';
  /** Fraction of running endurance remaining. Older saves start fully rested. */
  stamina?: number;
  /** True only while actually running this simulation tick. */
  running?: boolean;
  /** Combat confidence from 0 (rattled) to 100 (steady). */
  morale: number;
  /** Personal weapon improvements; new recruits begin at level zero. */
  weaponUpgrades: Record<WeaponUpgradeType, number>;
  /** Ticks until the weapon is reloaded and a new burst may start. */
  reloadTimer: number;
  /** Shots left in the current burst. */
  burstRemaining: number;
  /** Ticks until the next shot within a burst. */
  shotTimer: number;
  /** Independent hull MG firing state; absent on saves from before tank MGs. */
  secondaryReloadTimer?: number;
  secondaryBurstRemaining?: number;
  secondaryShotTimer?: number;
  targetId: number | null;
  /** Remaining waypoints toward moveGoal; empty means stationary. */
  path: Vec2[];
  moveGoal: Vec2 | null;
  /**
   * Enemy movement policy for the current tick; recomputed each step from the
   * unit id and the clock, so it never needs saving. True means this unit walks
   * this tick, which also means it holds fire; the half of the bounding pair that
   * is not walking is the half shooting.
   */
  advance: boolean;
  /**
   * Which half of the bounding pair this unit belongs to; the halves take turns
   * advancing. Recomputed each step from the unit id, so it is not persisted.
   */
  advanceFlip: boolean;
  /**
   * Ticks of a deliberate stop-and-shoot pause. Armour has no bounding partner to
   * keep it moving, so it needs a bounded pause instead of a permanent stop.
   */
  firePauseTicks: number;
  /** One-way gate: true when armour may start a fresh pause. */
  firePauseGate: boolean;
  /** Ticks until the medic may heal again. */
  healTimer: number;
  /** Casualty assigned by Call medic; absent during automatic treatment. */
  medicalTargetId?: number;
  /** Soldier awaiting ammunition from this Supply Officer. */
  supplyTargetId?: number;
  /** Weapon and ammunition requested for delivery; charged at handover. */
  pendingWeaponId?: string;
  /** Ticks until this mortarman may fire again; omitted in older saves. */
  mortarTimer?: number;
  /** Absolute ticks keep tactical maneuvers deterministic across Continue. */
  nextTacticTick?: number;
  flankUntilTick?: number;
  /** Grenades left to throw; 0 for roles that carry none. */
  grenades: number;
  /** Bazooka rockets remaining; older saves start with a full loadout. */
  rockets?: number;
  /** Mortar bombs remaining; older saves start with a full loadout. */
  mortarBombs?: number;
  /** Rifle grenades or fuel bursts remaining. */
  specialistAmmo?: number;
  /** Ticks until this unit may throw another grenade. */
  grenadeTimer: number;
  xp: number;
  /** Earliest tick for another automatic support call; also respects cancelled dispatches. */
  autoMedicCallAfter?: number;
  autoSupplyCallAfter?: number;
  /** Individual marksmanship multiplier rolled around the role's starting skill. */
  accuracySkill: number;
  /**
   * Ticks left before this soldier's weapon is back together after a personal
   * upgrade. A soldier fitting a new sight or barrel cannot shoot and cannot
   * throw while the work is in hand; movement and everything else are unaffected.
   * Optional so saves written before upgrades took time still load.
   */
  upgradeTimer?: number;
  kills: number;
  service: SoldierService;
  /** Enemy spawn lane; used to re-path toward the line. */
  laneX: number;
  /**
   * Set once this soldier has reached the northern exit strip and is walking off
   * the map, which is what takes it out of the squad's order of battle. The flag
   * is transient - it is only ever set by the march north and is dropped on
   * arrival at the next map - and anything reading the squad must skip these
   * units: they are neither available for orders nor worth shooting at.
   */
  crossed?: boolean;
  /** Fire-control mode chosen by the player. Older saves default to automatic. */
  fireOrder?: FireOrder;
  ambush?: AmbushOrder;
  /** Smoke grenades remaining. */
  smokeGrenades?: number;
  smokeTimer?: number;
  /** One chosen veteran perk, available after the rank milestone. */
  specialization?: string;
  /** Vehicle headlamps can be switched off for concealment at night. */
  headlightsOn?: boolean;
}

export interface RoleDuty { kind: 'rally' | 'observe' | 'supply' | 'repair' | 'suppress'; origin: Vec2; ticksRemaining: number; stock: number; target?: Vec2 }
export interface SoldierAttributes {
  strength: number;
  agility: number;
  speed: number;
  stealth: number;
  marksmanship: number;
  endurance: number;
  resolve: number;
}
export interface ScoutReport { unitId: number; role: UnitRole; pos: Vec2; tick: number }

export type FireOrder = 'auto' | 'antiArmor' | 'stopBreakthrough' | 'holdGrenades' | 'seekGunfire';
export const FIRE_ORDERS: readonly FireOrder[] = ['auto', 'antiArmor', 'stopBreakthrough', 'holdGrenades', 'seekGunfire'];
export function fireOrdersForRole(role: UnitRole): readonly FireOrder[] {
  if (role === 'gun_truck' || role === 'vehicle' || role === 'troop_transport') return ['auto', 'antiArmor', 'stopBreakthrough'];
  return role === 'medic' || role === 'mortarman' || role === 'heavy_mg' || role === 'at_gun' ? FIRE_ORDERS.filter((order) => order !== 'seekGunfire') : FIRE_ORDERS;
}
export type Specialization = 'steadyAim' | 'fastReload' | 'tankHunter' | 'fieldMedic' | 'surgeon' | 'rapidBuilder' | 'heavyCharges' | 'spotter' | 'forwardObserver' | 'signalOfficer' | 'suppressor' | 'forcedMarch' | 'camouflage';

export interface SmokeCloud {
  id: number;
  pos: Vec2;
  radius: number;
  ticksRemaining: number;
}

/** A telegraphed squad push; deployed screens remain after their thrower dies. */
export interface EnemySmokeAssault {
  id: number;
  leaderId: number;
  unitIds: number[];
  pos: Vec2;
  deployTick: number;
  endTick: number;
  deployed: boolean;
}

/** A small, stationary fire lit by an infantry soldier. */
export interface Campfire {
  id: number;
  unitId: number;
  pos: Vec2;
  radius: number;
  ticksRemaining: number;
}

/** A planted demolition charge; its fuse keeps burning without its engineer. */
export interface SatchelCharge {
  id: number;
  unitId: number;
  pos: Vec2;
  ticksRemaining: number;
}

/** Radioed illumination over the battlefield. */
export interface Flare {
  id: number;
  pos: Vec2;
  radius: number;
  /** Ticks until the flare reaches its marked target and begins illuminating. */
  pendingTicksRemaining?: number;
  ticksRemaining: number;
}

export interface Projectile {
  id: number;
  team: Team;
  /** Unit that fired the round; used to credit explosive kills. Null for artillery. */
  sourceId: number | null;
  pos: Vec2;
  target: Vec2;
  /** Pixels per tick. */
  speed: number;
  damage: number;
  splashRadius: number;
  /** Damage multiplier against vehicles. */
  armorMult: number;
  suppressionAmount: number;
  suppressionRadius: number;
  /**
   * Thrown rather than fired: arcs over cover and ignores line of sight, which is
   * what lets a grenade reach a position that is safe from rifle fire.
   */
  arc: boolean;
}

export interface SoldierService {
  healthRestored: number;
  fortificationsBuilt: number;
  grenadesThrown: number;
}

export interface BattleRecord {
  enemyKills: number;
  casualties: number;
  breakthroughs: number;
}

/**
 * Whose guns a shell came from. Used for feedback only - the blast itself is
 * indifferent - so an incoming enemy barrage can be warned about and marked
 * differently from the player's own fire mission.
 */
export type StrikeSource = 'friendly' | 'enemy';
export type GroundImpactKind = 'artillery' | 'airSupport' | 'mortar';
/** Only damaged trees are stored. A cell keeps its identity after its crown is gone. */
export interface TreeDamage { cell: number; kind: number; health: number; }
export const MAX_GROUND_IMPACTS = 256;

/** Persistent presentation history. These marks do not change combat or navigation. */
export interface GroundImpact {
  id: number;
  kind: GroundImpactKind;
  pos: Vec2;
  tick: number;
}

export interface Strike {
  id: number;
  pos: Vec2;
  /** Tick on which the shell lands. */
  landTick: number;
  radius: number;
  damage: number;
  suppressionAmount: number;
  /**
   * Which side called it in. Optional so saves written before enemy artillery
   * existed still load; an absent source means the player's own battery.
   */
  source?: StrikeSource;
  /** Mortar and bombing-run impacts share blast resolution but use separate markers. */
  delivery?: GroundImpactKind;
  /** Optional killer credit for crew-served attacks. */
  sourceId?: number;
}

export interface Sandbag {
  id: number;
  pos: Vec2;
}

export interface Trench {
  id: number;
  pos: Vec2;
}

/** A compact, all-round defensive position built by a Combat Support Engineer. */
export interface Bunker {
  id: number;
  pos: Vec2;
}

/** A small, roofed firing pit sized for one mortarman and his weapon. */
export interface MortarPit {
  id: number;
  pos: Vec2;
}

/**
 * A laid mine. Armed once its engineer finishes laying it, then triggered by the
 * first matching hostile to come within `kind`'s trigger radius.
 */
export interface Mine {
  id: number;
  pos: Vec2;
  kind: MineKind;
  /** False while the engineer is still laying it. */
  armed: boolean;
  damageMult?: number;
}

/**
 * Anti-personnel and anti-tank mines are different weapons, not one weapon with a
 * damage modifier: they cost differently, are triggered by different targets, and
 * neither one substitutes for the other.
 */
export type MineKind = 'ap' | 'at';

/** Per-type mine data. Shared placement rules live in `GameConfig.mine`. */
export interface MineKindDef {
  label: string;
  cost: number;
  /** Ticks the engineer spends laying it. */
  laySeconds: number;
  damage: number;
  /** Blast radius; also the radius suppression lands in. */
  radius: number;
  suppression: number;
  suppressionRadius: number;
  /**
   * Measured from the target's edge, not its centre: terrain routes movement
   * along cell centres, so a centre-only test misses most vehicles entirely.
   */
  triggerRadius: number;
  /** Multiplier against vehicles; a mine type can be near-useless against them. */
  armorMult: number;
  /** Whether this type detonates for infantry. */
  triggersOnInfantry: boolean;
  /** Whether this type detonates for vehicles. */
  triggersOnVehicles: boolean;
  /** Minimum gap to another mine of the same type. */
  minSpacing: number;
  /** Colour drawn on the battlefield. */
  color: number;
  /** Outline colour, for a distinct silhouette at a glance. */
  edge: number;
}

/** A temporary engineer-built pontoon crossing; permanent bridges belong to the terrain. */
export interface BuiltBridge {
  id: number;
  pos: Vec2;
  axis: 'horizontal' | 'vertical';
  halfWidth: number;
  halfLength: number;
}

export interface BarbedWire {
  id: number;
  pos: Vec2;
  /** Work already done by enemy cutters; pinning or killing them pauses it. */
  cutTicks: number;
}

export type DemolitionTarget = { kind: 'bunker'; id: number } | { kind: 'building'; id: number } | { kind: 'bridge'; key: string };

export interface EnemySapperTeam {
  id: number;
  sapperId: number;
  escortIds: number[];
  target: DemolitionTarget | null;
  plantPos: Vec2 | null;
  plantTicks: number;
  nextPlanTick: number;
  chargeId: number | null;
}

export interface EnemyDemolitionCharge {
  id: number;
  unitId: number;
  target: DemolitionTarget;
  pos: Vec2;
  ticksRemaining: number;
}

export interface ConstructionSite {
  id: number;
  kind: 'sandbag' | 'trench' | 'mine' | 'bunker' | 'mortarPit' | 'bridge' | 'barbedWire';
  /** Which mine type, when `kind` is 'mine'. */
  mineKind?: MineKind;
  bridgeAxis?: 'horizontal' | 'vertical';
  bridgeHalfWidth?: number;
  bridgeHalfLength?: number;
  pos: Vec2;
  builderId: number;
  ticksRemaining: number;
  totalTicks: number;
}

/**
 * A building on the battlefield. Unlike the
 * terrain it stands on, a building is a thing that can be shot at and destroyed.
 * Standing walls block ordinary routes and shots. Infantry enter through
 * entrance orders and occupy windows, balconies, or accessible roofs.
 * Once it is reduced to zero health it becomes a ruin: the
 * ground is walkable again, sight passes over it, and nothing stops a bullet.
 */
export type BuildingKind = 'church' | 'castle' | 'house' | 'hospital' | 'school' | 'restaurant' | 'bakery' | 'clinic' | 'generalStore' | 'bar' | 'barn';

/** Floors are zero based; the UI calls them Floor 1, Floor 2, etc. */
export type BuildingLevel = number | 'roof' | 'balcony';
export type BuildingFacing = 'north' | 'east' | 'south' | 'west';
export interface BuildingPosition {
  buildingId: number;
  level: BuildingLevel;
  slot: number;
}

export interface Building {
  floors?: number;
  roofStyle?: 'pitched' | 'flat';
  rooftopAccess?: boolean;
  balcony?: boolean;
  id: number;
  kind: BuildingKind;
  /** Top-left corner of the footprint, in world pixels. */
  pos: Vec2;
  /** Footprint in terrain cells. */
  cols: number;
  rows: number;
  /** Display name, e.g. "Église Saint-Michel", so the player can tell them apart. */
  name: string;
  health: number;
  maxHealth: number;
  /** Set once on destruction; a ruin no longer blocks anything. */
  destroyed: boolean;
}

/** Multiplicative bonuses granted for occupying a trench; 1 means no change. */
export interface TrenchRoleBonus {
  /** Multiplier on the weapon's own accuracy. */
  accuracyMult: number;
  /** Multiplier on the suppression the weapon puts out. */
  suppressionMult: number;
  /** Multiplier on the radius over which that suppression lands. */
  suppressionRadiusMult: number;
}

export interface Terrain {
  /** Runtime reference to generated and engineer-built crossings. */
  bridges?: readonly BridgeSurface[];
  /** Runtime reference shared with state; excluded from persistence. */
  buildings?: readonly Building[];
  cell: number;
  cols: number;
  rows: number;
  /** Row-major; 1 = solid for movement. Most solid cells also block sight. */
  blocked: Uint8Array;
  /** Per-cell visual kind, used to distinguish low fences from sight-blocking walls. */
  kinds?: Uint8Array;
  /**
   * Row-major floor plan of the map as generated: the same blocked layout with
   * every building treated as a ruin. Buildings are destructible, so the live
   * `blocked` grid is rebuilt from this plus whichever buildings still stand;
   * without the floor plan, destroying a building could not reopen its ground.
   */
  baseBlocked?: Uint8Array;
  /** Regular vertex grid; heights and spacing use simulation pixels. Regenerated from seed. */
  elevation?: { cols: number; rows: number; cell: number; heights: Float32Array };
}

/**
 * What soft ground does to whoever is standing in it. A river is wadeable
 * everywhere, so it is never a wall: it is a hazard that costs speed to cross
 * and buys the far bank a moment's advantage. Mud bogs a unit down outright.
 */
export interface TerrainEffects {
  /** Multiplier on movement speed; 1 means firm ground. */
  speedMult: number;
  /** Multiplier on the chance to hit; 1 means firm ground. */
  accuracyMult: number;
  /** Multiplier on weapon reload time; higher is slower. */
  reloadMult: number;
}

export interface BridgeSurface {
  x: number;
  y: number;
  axis: 'horizontal' | 'vertical';
  type: 'timber' | 'stone' | 'bailey' | 'pontoon';
  halfWidth: number;
  halfLength: number;
  junction?: boolean;
}

export interface BridgePosition {
  key: string;
  level: 'deck' | 'under';
}

/**
 * `advance` waits after the last campaign wave for the player to order a march
 * north. `crossing` is the march itself; neither phase starts another wave.
 */
export type WavePhase = 'prep' | 'spawning' | 'active' | 'advance' | 'crossing';

export interface WaveScheduler {
  /** Clean-defense tracking is optional for saves made before initiative rewards. */
  cleanStreak?: number;
  startCasualties?: number;
  startBreakthroughs?: number;
  /** Initiative rewards require choosing to skip preparation for this wave. */
  calledEarly?: boolean;
  /** 0-based index into the wave list; >= list length means endless. */
  waveIndex: number;
  phase: WavePhase;
  /** Ticks left in the current preparation period (prep phase only). */
  prepTicksLeft: number;
  /** Archetypes still to spawn this wave, in order. */
  spawnQueue: EnemyArchetype[];
  /** Ticks until the next scheduled spawn (spawning phase only). */
  spawnTimer: number;
  /** True once the wave's clear reward has been granted. */
  rewardGranted: boolean;
  /**
   * Endless waves cleared before the current one, counted across maps. The wave
   * counter restarts at 1 on every new map, so this is what keeps endless
   * difficulty and labels climbing instead of resetting with it.
   */
  endlessWavesCleared: number;
}

export type RunPhase = 'running' | 'victory' | 'defeat';

/**
 * JSON-safe persistence shape: everything needed to resume the same outcome.
 * Terrain is excluded and regenerated from the seed; selection, particles,
 * sprites, and audio never appear here.
 */
export interface SimSnapshot {
  runMode?: import('../content/operations').RunMode;
  /** Fixed for this map; missing on saves written before seasons were introduced. */
  season?: Season;
  /** Absent on older saves, which retain their original landscape generator. */
  campaignCountry?: CampaignCountry;
  /** Missing on older saves, which retain the original terrain generator. */
  terrainLayoutVersion?: 1 | 2 | 3 | 4;
  battleRecord: BattleRecord;
  schemaVersion: number;
  seed: number;
  rng: { s: number };
  /**
   * Independent random stream for the Axis battery. It is seeded from the run
   * seed rather than sharing the combat stream, so the enemy's fire plan is a
   * fixed property of the run and tuning it does not reshuffle every shot,
   * scatter and spawn lane in the battle. Optional so saves written before the
   * battery existed still load; an absent stream is derived from the seed.
   */
  enemyArtilleryRng?: { s: number };
  ticks: number;
  nextEntityId: number;
  units: Unit[];
  /** Requested casualties, oldest first, including those currently being treated. */
  medicalQueue?: number[];
  /** Ammunition requests, oldest first, including active deliveries. Legacy key shared by grenades, rockets, and mortar bombs. */
  grenadeSupplyQueue?: number[];
  projectiles: Projectile[];
  smokes?: SmokeCloud[];
  enemySmokeAssaults?: EnemySmokeAssault[];
  enemySapperTeams?: EnemySapperTeam[];
  enemyDemolitionCharges?: EnemyDemolitionCharge[];
  destroyedBridgeKeys?: string[];
  strikes: Strike[];
  groundImpacts?: GroundImpact[];
  vehicleTracks?: VehicleTrack[];
  treeDamage?: TreeDamage[];
  demolishedFenceCells?: number[];
  sandbags: Sandbag[];
  trenches: Trench[];
  bunkers?: Bunker[];
  mortarPits?: MortarPit[];
  barbedWire?: BarbedWire[];
  mines: Mine[];
  builtBridges?: BuiltBridge[];
  constructionSites: ConstructionSite[];
  /** Standing and ruined buildings. Ruins are kept so the map still reads as built-up. */
  buildings: Building[];
  points: number;
  integrity: number;
  score: number;
  scheduler: WaveScheduler;
  artilleryCooldown: number;
  airSupportCooldown?: number;
  flareCooldown?: number;
  flares?: Flare[];
  campfires?: Campfire[];
  satchelCharges?: SatchelCharge[];
  weather?: WeatherKind;
  weatherChangeTick?: number;
  /** Total cleared waves across the run; used to unlock day/night after the opening. */
  wavesCompleted?: number;
  /** Simulation tick when the day/night clock began, or null until unlocked. */
  dayNightStartTick?: number | null;
  /**
   * Ticks until the Axis battery may shell the line again. The enemy buys
   * nothing, so this is the whole of their fire plan: it is decremented whatever
   * else happens and gates the next barrage.
   */
  enemyArtilleryCooldown: number;
  foodSupplyCooldown: number;
  endless: boolean;
  phase: RunPhase;
  /** Which map of the campaign is being fought; 1 on a new run. */
  mapNumber: number;
  /** Maps the squad has already marched clear. */
  mapsCleared: number;
  /** Time accumulated toward the current map's capture objective. */
  captureTicks?: number;
  /** True once the map's campaign waves are cleared or captured traditionally. */
  sectorCaptured?: boolean;
  /** A captured-sector reward waiting to be chosen on the next map. */
  sectorSupplyPending?: boolean;
  /** Original run seed; map N's terrain seed is derived from it, so it survives save/restore. */
  baseTerrainSeed: number;
  /** Soldiers who have reached the north edge and are off this map's order of battle. */
  crossedUnits: Unit[];
  /**
   * Whether this map was generated with buildings. False only for saves made
   * before buildings existed, which have no record of them: on restore the map is
   * generated without any, so a legacy run cannot end up with invisible walls.
   */
  terrainHasBuildings: boolean;
}

export interface SimState {
  runMode?: import('../content/operations').RunMode;
  season?: Season;
  campaignCountry?: CampaignCountry;
  battleRecord: BattleRecord;
  schemaVersion: number;
  seed: number;
  rng: { s: number };
  /** Independent stream for the Axis battery; see `SimSnapshot`. */
  enemyArtilleryRng: { s: number };
  ticks: number;
  nextEntityId: number;
  units: Unit[];
  /** Requested casualties, oldest first, including those currently being treated. */
  medicalQueue?: number[];
  /** Ammunition requests, oldest first, including active deliveries. Legacy key shared by grenades, rockets, and mortar bombs. */
  grenadeSupplyQueue?: number[];
  projectiles: Projectile[];
  smokes: SmokeCloud[];
  enemySmokeAssaults?: EnemySmokeAssault[];
  enemySapperTeams: EnemySapperTeam[];
  enemyDemolitionCharges: EnemyDemolitionCharge[];
  destroyedBridgeKeys: string[];
  strikes: Strike[];
  groundImpacts?: GroundImpact[];
  vehicleTracks?: VehicleTrack[];
  treeDamage?: TreeDamage[];
  demolishedFenceCells?: number[];
  sandbags: Sandbag[];
  trenches: Trench[];
  bunkers: Bunker[];
  mortarPits: MortarPit[];
  barbedWire: BarbedWire[];
  /** Laid mines; armed mines detonate on the first hostile to step on them. */
  mines: Mine[];
  /** Timber crossings built by combat engineers on the current map. */
  builtBridges: BuiltBridge[];
  constructionSites: ConstructionSite[];
  /** Buildings on this map: solid while they stand, ruined once destroyed. */
  buildings: Building[];
  /** Present at runtime; stripped from snapshots and regenerated from seed on restore. */
  terrain: Terrain;
  points: number;
  integrity: number;
  score: number;
  scheduler: WaveScheduler;
  /** Ticks until artillery may be called again. */
  artilleryCooldown: number;
  airSupportCooldown: number;
  flareCooldown: number;
  flares: Flare[];
  campfires: Campfire[];
  satchelCharges: SatchelCharge[];
  weather: WeatherKind;
  weatherChangeTick: number;
  wavesCompleted: number;
  dayNightStartTick: number | null;
  /** Ticks until the Axis battery may shell the line again. */
  enemyArtilleryCooldown: number;
  /** Ticks until another radioed food supply delivery can be requested. */
  foodSupplyCooldown: number;
  /** True when the run continues past the authored wave list. */
  endless: boolean;
  phase: RunPhase;
  /** Which map of the campaign is being fought; 1 on a new run. */
  mapNumber: number;
  /** Maps the squad has already marched clear. */
  mapsCleared: number;
  captureTicks: number;
  sectorCaptured: boolean;
  /** A captured-sector reward waiting to be chosen on the next map. */
  sectorSupplyPending?: boolean;
  /** Original run seed; map N's terrain seed is derived from it. */
  baseTerrainSeed: number;
  /**
   * Soldiers who have walked off the north edge and are waiting for the next
   * map. They keep their identity, wounds, experience, and personal weapon
   * upgrades; they are simply not on this battlefield any more.
   */
  crossedUnits: Unit[];
  /**
   * Whether this map was generated with buildings. False only for saves made
   * before buildings existed, which have no record of them: on restore the map is
   * generated without any, so a legacy run cannot end up with invisible walls.
   */
  terrainHasBuildings: boolean;
}

export type SimEvent =
  | { type: 'roleAbilityStarted'; unitId: number; kind: RoleDuty['kind']; pos: Vec2 }
  | { type: 'scoutContact'; unitId: number; role: UnitRole; pos: Vec2 }
  | { type: 'tankCrewBailedOut'; tankId: number; crewIds: number[]; retreating: number; fighting: number; pos: Vec2 }
  | { type: 'tankCrewEscaped'; unitId: number; tankId: number; pos: Vec2 }
  | { type: 'tankComponentDisabled'; unitId: number; component: TankComponent; pos: Vec2 }
  | { type: 'transportUnloaded'; unitId: number; count: number; pos: Vec2 }
  | { type: 'transportPassengersKilled'; unitId: number; count: number; pos: Vec2 }
  | { type: 'specialistResupplied'; officerId: number; targetId: number; amount: number }
  | { type: 'grenadesResupplied'; officerId: number; targetId: number; amount: number }
  | { type: 'rocketsResupplied'; officerId: number; targetId: number; amount: number }
  | { type: 'mortarBombsResupplied'; officerId: number; targetId: number; amount: number }
  | { type: 'shot'; shooterId: number; shooterTeam: Team; from: Vec2; to: Vec2; hit: boolean; weapon: string; targetId: number | null }
  | { type: 'unitSpawned'; unitId: number; team: Team; role: UnitRole; pos: Vec2 }
  | { type: 'unitDied'; unitId: number; team: Team; role: UnitRole; pos: Vec2; killerId: number | null }
  | { type: 'breakthrough'; unitId: number; role: UnitRole; pos: Vec2; damage: number; integrityAfter: number }
  | { type: 'explosion'; pos: Vec2; radius: number }
  | { type: 'groundImpact'; impact: GroundImpact; blastRadius: number }
  | { type: 'treeHit'; cell: number; pos: Vec2; health: number; blast: boolean }
  | { type: 'artilleryOrdered'; pos: Vec2; landTick: number }
  | { type: 'airSupportOrdered'; pos: Vec2; bombs: number; landTick: number }
  | { type: 'mortarFired'; unitId: number; from: Vec2; pos: Vec2; landTick: number; radius: number }
  | { type: 'flareOrdered'; pos: Vec2; landTick: number }
  | { type: 'weatherChanged'; weather: WeatherKind }
  | { type: 'dayNightStarted' }
  | { type: 'dayNightChanged'; night: boolean; phase: 'day' | 'dusk' | 'night' | 'dawn' }
  | { type: 'artilleryImpact'; pos: Vec2; radius: number; delivery?: 'artillery' | 'airSupport' }
  /**
   * The Axis have located the line and are about to shell it. Emitted when the
   * first shell of a fire mission is scheduled, so the player gets the same
   * countdown warning they get before their own rounds land.
   */
  | { type: 'enemyBarrageIncoming'; pos: Vec2; shells: number; landTick: number }
  | { type: 'foodSupplies'; points: number }
  | { type: 'healed'; medicId: number; targetId: number; pos: Vec2; amount: number }
  | { type: 'grenadeThrown'; unitId: number; team: Team; from: Vec2; to: Vec2; remaining: number }
  | { type: 'smokeDeployed'; unitId: number; pos: Vec2; ticks: number }
  | { type: 'automaticSupportRequested'; unitId: number; kind: 'medic' | 'grenades' | 'rockets' | 'mortarBombs' | 'specialistAmmo' }
  | { type: 'enemySmokeAssaultWarned'; unitId: number; pos: Vec2; deployTick: number }
  | { type: 'enemySmokeAssaultDeployed'; unitId: number; pos: Vec2; ticks: number }
  | { type: 'enemySmokeAssaultCancelled'; unitId: number }
  | { type: 'campfireLit'; unitId: number; pos: Vec2 }
  | { type: 'satchelPlanted'; unitId: number; pos: Vec2 }
  | { type: 'fenceDemolished'; unitId: number; cell: number; pos: Vec2 }
  | { type: 'satchelDetonated'; pos: Vec2; radius: number; victims: number }
  | { type: 'flareDeployed'; pos: Vec2; radius: number; ticks: number }
  | { type: 'sectorCaptureProgress'; ticks: number; total: number }
  | { type: 'sectorCaptured' }
  | { type: 'ambushSet'; unitId: number }
  | { type: 'ambushTriggered'; unitId: number; pos: Vec2 }
  | { type: 'fireOrderChanged'; unitId: number; order: FireOrder }
  | { type: 'specializationChosen'; unitId: number; specialization: Specialization }
  /**
   * A personal weapon upgrade was bought. The soldier is now working on his
   * weapon for `ticks`, during which he cannot fire or throw.
   */
  | { type: 'weaponUpgraded'; unitId: number; upgrade: WeaponUpgradeType; level: number; ticks: number }
  | { type: 'wavePhase'; wave: number; phase: WavePhase; prepTicksLeft: number; endless: boolean }
  | { type: 'waveCalledEarly'; reward: number }
  | { type: 'waveCleared'; wave: number; reward: number; cleanBonus?: number; streak?: number }
  | { type: 'advanceAvailable' }
  | { type: 'crossingBegan' }
  | { type: 'unitCrossed'; unitId: number; remaining: number }
  | { type: 'mapCleared'; mapsCleared: number; mapNumber: number; squad: number; goal: number; credited: boolean }
  | { type: 'victory' }
  | { type: 'defeat' }
  | { type: 'sapperTeamInbound'; unitIds: number[]; pos: Vec2 }
  | { type: 'sapperTargeted'; teamId: number; label: string; pos: Vec2 }
  | { type: 'enemyChargePlanted'; unitId: number; pos: Vec2 }
  | { type: 'enemyChargeDetonated'; pos: Vec2; radius: number; victims: number }
  | { type: 'structureDemolished'; kind: 'bunker' | 'bridge'; pos: Vec2 }
  | { type: 'wireCutStarted'; unitId: number; wireId: number; pos: Vec2 }
  | { type: 'wireConstructionStarted'; pos: Vec2 }
  | { type: 'wireBreached'; unitId: number; wireId: number; pos: Vec2 }
  | { type: 'sandbagPlaced'; pos: Vec2 }
  | { type: 'trenchBuilt'; pos: Vec2 }
  | { type: 'mineLaid'; kind: MineKind; pos: Vec2 }
  | { type: 'mineTriggered'; kind: MineKind; pos: Vec2; radius: number; victims: number }
  | { type: 'constructionCompleted'; kind: 'sandbag' | 'trench' | 'mine' | 'bunker' | 'mortarPit' | 'bridge' | 'barbedWire'; pos: Vec2 }
  /**
   * A work site nobody can finish, because the squad has no engineer left. Emitted
   * so the field and the HUD drop the half-built marker instead of showing one
   * that will never move again.
   */
  | { type: 'constructionAbandoned'; kind: 'sandbag' | 'trench' | 'mine' | 'bunker' | 'mortarPit' | 'bridge' | 'barbedWire'; pos: Vec2; refund: number }
  | { type: 'buildingHit'; buildingId: number; pos: Vec2; damage: number; healthAfter: number }
  | { type: 'buildingDestroyed'; buildingId: number; name: string; kind: BuildingKind; pos: Vec2 }
  | { type: 'moveOrdered'; unitId: number; pos: Vec2 };

export interface RecruitBuild {
  weaponId?: string;
  upgrades?: Partial<Record<WeaponUpgradeType, number>>;
  stance?: SoldierStance;
  fireOrder?: FireOrder;
}

export type Command =
  | { type: 'callWave' }
  | { type: 'withdraw'; unitId: number }
  | { type: 'equipWeapon'; unitId: number; weaponId: string }
  | { type: 'callGrenadeSupplies'; unitId: number }
  | { type: 'callRocketSupplies'; unitId: number }
  | { type: 'callMortarSupplies'; unitId: number }
  | { type: 'callSpecialistSupplies'; unitId: number }
  | { type: 'callMedic'; unitId: number }
  | { type: 'garrison'; unitIds: number[]; buildingId: number; level: BuildingLevel; facing?: BuildingFacing }
  | { type: 'leaveBuilding'; unitIds: number[] }
  | { type: 'move'; unitId: number; pos: Vec2 }
  | { type: 'patrol'; unitIds: number[]; from: Vec2; to: Vec2 }
  | { type: 'stopPatrol'; unitIds: number[] }
  /**
   * A whole selection moved at once. The order carries the group rather than one
   * destination per soldier, so the formation is resolved against terrain and
   * against who is still standing at the moment the order lands.
   */
  | { type: 'moveGroup'; unitIds: number[]; pos: Vec2 }
  | { type: 'recruit'; role: FriendlyRole; pos: Vec2; build?: RecruitBuild }
  | { type: 'barbedWire'; pos: Vec2 }
  | { type: 'sandbag'; pos: Vec2 }
  | { type: 'trench'; pos: Vec2 }
  | { type: 'bunker'; pos: Vec2 }
  | { type: 'mortarPit'; pos: Vec2 }
  | { type: 'bridge'; pos: Vec2 }
  | { type: 'mine'; kind: MineKind; pos: Vec2 }
  | { type: 'artillery'; pos: Vec2 }
  | { type: 'airSupport'; pos: Vec2 }
  | { type: 'flare'; pos: Vec2 }
  | { type: 'foodSupplies' }
  | { type: 'smoke'; unitId: number; pos: Vec2 }
  | { type: 'satchel'; unitId: number; pos: Vec2 }
  | { type: 'demolishFence'; unitId: number; pos: Vec2 }
  | { type: 'roleAbility'; unitId: number; pos?: Vec2 }
  | { type: 'lightFire'; unitId: number }
  | { type: 'ambush'; unitIds: readonly number[]; aim: Vec2; arcDegrees: number }
  | { type: 'cancelAmbush'; unitIds: readonly number[] }
  | { type: 'fireOrder'; unitIds: number[]; order: FireOrder }
  | { type: 'headlights'; unitIds: number[]; on: boolean }
  | { type: 'posture'; unitIds: number[]; stance: SoldierStance; crawling: boolean }
  | { type: 'pace'; unitIds: number[]; pace: 'walk' | 'run' }
  | { type: 'specialization'; unitId: number; specialization: Specialization };

export interface CommandResult {
  ok: boolean;
  reason?: string;
}

/** The pieces of unit/archetype data the simulation needs at runtime. */
export interface UnitStats {
  health: number;
  /** Pixels per second. */
  speed: number;
  weapon: string | null;
  radius: number;
  killValue: number;
  breakthroughDamage: number;
  /** Fraction of incoming damage taken by vehicles from small arms etc. */
  armor: number;
  immuneToSuppression: boolean;
  heal: { amount: number; range: number; cooldownTicks: number; seekRange: number } | null;
  /**
   * How much of a battlefield problem this unit is, from the enemy's point of
   * view. 1 is an ordinary rifleman; higher values make it a priority target.
   */
  threat: number;
}

export interface WeaponStats {
  name: string;
  damage: number;
  range: number;
  accuracy: number;
  reloadTicks: number;
  burstShots: number;
  shotIntervalTicks: number;
  kind: 'hitscan' | 'explosive';
  projectileSpeed: number;
  splashRadius: number;
  /** Multiplier applied against armored (vehicle) targets. */
  armorMult: number;
  suppressionAmount: number;
  suppressionRadius: number;
}

export interface WaveDef {
  label: string;
  composition: Array<{ archetype: EnemyArchetype; count: number }>;
  /** Seconds between spawns. */
  spawnIntervalSeconds: number;
  /** Optional warning shown when the wave's preparation period starts. */
  telegraph?: string;
}

export interface GameConfig {
  ambush: { minRange: number; maxRange: number; prepareSeconds: number; accuracyMult: number; suppressionMult: number };
  enemySappers: { firstWave: number; seekRange: number; plantSeconds: number; plantReach: number; fuseSeconds: number; radius: number; damage: number; structuralDamage: number; suppression: number };
  barbedWire: { halfLength: number; halfDepth: number; speedMult: number; routeCost: number; cutSeconds: number; cutReach: number; seekRange: number };
  satchel: { fuseSeconds: number; placementRange: number; cost: number; radius: number; damage: number; armorMult: number; suppression: number };
  gunfireOrder: { memorySeconds: number; retrySeconds: number };
  field: { width: number; height: number };
  tickRate: number;
  infantryMovement: {
    walkSpeedMult: number;
    runSpeedMult: number;
    runSeconds: number;
    walkingRecoverySeconds: number;
    restingRecoverySeconds: number;
    minimumRunStamina: number;
    enemyRunStamina: number;
  };
  incomingFire: { artilleryWarningSeconds: number; mortarWarningSeconds: number; airSupportWarningSeconds: number };
  dayNight: {
    gunfire: {
      soundRadius: number;
      flashRadius: number;
      tracerRadius: number;
      visualMemorySeconds: number;
      soundMemorySeconds: number;
      trackRadius: number;
      heardRangeMult: number;
      heardAccuracyMult: number;
    };
    startAfterWaves: number;
    cycleSeconds: number;
    nightVisibilityMult: number;
    nightMovementMult: number;
    nightAccuracyMult: number;
    /** Friendly snipers gain this accuracy multiplier in daylight. */
    sniperDayAccuracyMult: number;
    /** Friendly snipers use this multiplier at night unless their target is flare-lit. */
    sniperNightAccuracyMult: number;
    /** Sighting range multiplier for friendly fire against enemies in a flare's light. */
    flareVisibilityMult: number;
    /** Sighting range multiplier for either army firing at a vehicle with its lights on. */
    headlightsOnVisibilityMult: number;
    /** At night, vehicle lights restore daytime speed; lights-off vehicles use nightMovementMult. */
    headlightsOnMovementMult: number;
  };
  lineY: number;
  breakthroughY: number;
  deploymentZone: { yMin: number; yMax: number };
  spawnMargin: number;
  /**
   * Marching north. Every living soldier who reaches the northern edge leaves
   * this map's order of battle; once the whole squad is across, the next map is
   * generated, the wave counter restarts at 1, and the soldiers - with their
   * wounds, experience, and personal weapon upgrades - are re-deployed in the
   * southern assembly area.
   */
  crossing: {
    /** A soldier at or north of this line has crossed over. */
    thresholdY: number;
    /** Squad cap on how many staggered columns the arrival formation uses. */
    columns: number;
    /** Vertical gap between arrival rows, in pixels. */
    rowSpacing: number;
    /** How many maps the squad must march clear to win the campaign. */
    campaignMaps: number;
    /** Preparation granted on the new map before its wave 1 begins. */
    arrivalSeconds: number;
    captureAfterWaves: number;
    captureSeconds: number;
    captureRadius: number;
    captureMinSoldiers: number;
    captureZone: Vec2;
    /** Points offered as the alternative to healing a veteran after capture. */
    sectorSupplyPoints: number;
    /** Maximum health restored to one living veteran by the medical cache. */
    sectorSupplyHeal: number;
  };
  start: {
    points: number;
    integrity: number;
    squad: Array<{ role: FriendlyRole; pos: Vec2 }>;
    prepSeconds: number;
    breakSeconds: number;
  };
  caps: { friendly: number; liveEnemies: number };
  costs: {
    recruit: Record<FriendlyRole, number>;
    sandbag: number;
    barbedWire: number;
    trench: number;
    bunker: number;
    mortarPit: number;
    bridge: number;
    artillery: number;
    airSupport: number;
    flare: number;
  };
  artillery: {
    delaySeconds: number;
    radius: number;
    damage: number;
    suppression: number;
    cooldownSeconds: number;
  };
  weather: Record<WeatherKind, {
    name: string;
    visibilityMult: number;
    movementMult: number;
    atmosphereAlpha: number;
    rainIntensity: number;
    /** Snowfall density and wind strength; omitted means no snow. */
    snowIntensity?: number;
    fogIntensity: number;
    /** Visual current multiplier applied while this weather is active. */
    riverFlowMult: number;
    description: string;
  }>;
  weatherChangeSeconds: number;
  airSupport: {
    delaySeconds: number;
    cooldownSeconds: number;
    bombCount: number;
    bombSpacing: number;
    bombSpacingSeconds: number;
    radius: number;
    damage: number;
    suppression: number;
  };
  troopTransport: { capacity: number; unloadSeconds: number; dropMinY: number; dropMaxY: number; standOff: number; roadSpeedMult: number };
  gunTruck: {
    /** Moving trucks can fire at this fraction of their normal accuracy. */
    movingAccuracyMult: number;
    /** Road travel speed relative to open ground for either army's trucks. */
    roadSpeedMult: number;
  };
  armoredVehicle: {
    /** Moving tanks fire with reduced accuracy. */
    movingAccuracyMult: number;
    componentDamage: { minimumDamage: number; minimumArmorMult: number; disableChance: number };
    crew: { size: number; destroyedSurvivalChance: number; retreatChance: number; health: number; morale: number; bailoutSeconds: number };
  };
  flare: {
    radius: number;
    deploymentDelaySeconds: number;
    durationSeconds: number;
    cooldownSeconds: number;
  };
  campfire: {
    radius: number;
    durationSeconds: number;
  };
  mortar: {
    initialDelaySeconds: number;
    intervalSeconds: number;
    flightSeconds: number;
    minRange: number;
    maxRange: number;
    scatterRadius: number;
    radius: number;
    damage: number;
    suppression: number;
  };
  /**
   * Axis counter-battery fire: unscheduled shelling of the defended line that
   * begins in the later waves and tightens as the campaign goes on.
   */
  enemyArtillery: {
    /** First wave (per map) on which a barrage may be fired. */
    firstWaveWithBarrage: number;
    /** Ticks before the battery may fire again after a barrage. */
    cooldownSecondsMin: number;
    cooldownSecondsMax: number;
    /** Chance per simulated second of a barrage once ready, per wave. */
    chancePerWave: number;
    maxChancePerSecond: number;
    /** Shells per fire mission, inclusive roll. */
    shellsMin: number;
    shellsMax: number;
    /** Extra shells per this many waves into the barrage. */
    shellGrowthEveryWaves: number;
    maxShells: number;
    /** Seconds between the shells of one mission. */
    shellSpacingSeconds: number;
    /** Scatter from the aimed soldier at the first barrage wave. */
    scatterAtFirstWave: number;
    /** Scatter once the aim has tightened. */
    scatterAtLastWave: number;
    /** Wave at which the aim is at its tightest. */
    scatterWave: number;
    /** A shell is never walked north of this, where the Axis are advancing. */
    minLandY: number;
    observationRange: number;
  };
  foodSupply: { points: number; cooldownSeconds: number };
  weaponUpgrades: {
    maxLevel: number;
    accuracyPerLevel: number;
    reloadReductionPerLevel: number;
    damagePerLevel: number;
    /**
     * Seconds a soldier spends working on his weapon after buying an upgrade, during
     * which he cannot fire or throw. The improvement is banked immediately; the
     * delay is the cost of doing the work in the field.
     */
    upgradeSeconds: number;
    costs: Record<WeaponUpgradeType, number[]>;
  };
  suppression: {
    decayPerTick: number;
    pinThreshold: number;
    recoverThreshold: number;
    max: number;
  };
  morale: {
    initial: number;
    suppressionLossPerSecondAtPin: number;
    recoveryPerSecond: number;
    cohesionBonusPerSecond: number;
    cohesionRange: number;
    nearbyCasualtyLoss: number;
    nearbyKillGain: number;
    aimMin: number;
    aimMax: number;
    speedMin: number;
    shakenThreshold: number;
    rattledThreshold: number;
    officerAuraRange: number;
    officerSuppressionRecoveryMult: number;
    officerMoraleRecoveryBonusPerSecond: number;
  };
  cover: {
    radius: number;
    minSouthOffset: number;
    accuracyMult: number;
  };
  treeCover: {
    /** Infantry can cross foliage, but it costs them some pace. */
    movementSpeedMult: number;
    /** Foliage conceals a soldier standing beneath it. */
    targetAccuracyMult: number;
    /** Each tree crossed by a shot reduces accuracy by this factor. */
    lineAccuracyMult: number;
    /** A unit in foliage is harder to spot and engage at long range. */
    visibilityMult: number;
    /** Each foliage cell between units shortens sighting range, capped at eight. */
    lineVisibilityMult: number;
  };
  bunker: { occupyRadius: number; minSpacing: number; accuracyMult: number };
  mortarPit: { occupyRadius: number; minSpacing: number; accuracyMult: number; artilleryDamageMult: number; artillerySuppressionMult: number; reloadTimeMult: number };
  /**
   * Enemy movement policy. The Axis advance as a body of troops rather than a
   * crowd: each archetype has a preferred engagement distance, a share of the
   * force advances under covering fire, and armour rolls through while firing.
   */
  enemy: {
    tactics: { firstWave: number; sectorWaveBonus: number; decisionSeconds: number; flankSeconds: number; flankWidth: number; supportRadius: number };
    mortarTeam: { bombs: number; setupSeconds: number; standOff: number; intervalMult: number };
    smokeAssault: {
      startWave: number;
      squadRadius: number;
      minSquadSize: number;
      minTargetRange: number;
      maxTargetRange: number;
      warningSeconds: number;
    };
    /** Engagement distance as a fraction of the weapon's own range. */
    engageRangeMult: Record<EnemyArchetype, number>;
    /**
     * Armour is exempt from the bounding pair and always moving, so it needs its
     * own stopping distance or it would never settle to shoot.
     */
    vehicleHoldRangeMult: number;
    /** Seconds armour pauses to shoot before rolling on again. */
    vehicleFirePauseSeconds: number;
    /** Armour does not stop to shoot. */
    vehicleAdvancesWhileFiring: boolean;
    /** Alternating advance-under-cover windows. */
    bounding: {
      enabled: boolean;
      /** Ticks one side of the pair spends advancing on the approach. */
      windowTicks: number;
      /**
       * Share of the bound cycle spent walking once a pair is inside its
       * engagement distance, so the standoff trades fire more than ground.
       */
      standoffAdvanceFraction: number;
    };
    /** Target selection beyond proximity. */
    targetPriority: {
      /**
       * Distance (in pixels of score) a target is allowed to be further away and
       * still be preferred because it is already wounded.
       */
      woundedDistanceBonus: number;
      /** Distance advantage below which a higher-value target is preferred. */
      preferDamagedBonus: number;
      /** Health fraction under which a target counts as a casualty to finish. */
      damagedHealthFraction: number;
    };
  };
  trench: {
    halfLength: number;
    coverRadius: number;
    coverDepth: number;
    /**
     * The physical earthwork an occupant has to be standing on to count as dug
     * in. Deliberately narrower than the cover shadow, which reaches south of the
     * parapet to protect the position.
     */
    occupyHalfLength: number;
    occupyHalfDepth: number;
    minSpacing: number;
    accuracyMult: number;
    artilleryDamageMult: number;
    artillerySuppressionMult: number;
    /**
     * Per-role bonuses for fighting from a trench, on top of the cover every
     * occupant already gets. A braced heavy weapon with ammunition at hand is
     * worth more in a prepared position than a rifleman is, so the trench is the
     * machine gunner's firing position rather than a generic accuracy buff.
     */
    roleBonus: Partial<Record<FriendlyRole, TrenchRoleBonus>>;
  };
  construction: {
    engineerRange: number;
    sandbagSeconds: number;
    barbedWireSeconds: number;
    trenchSeconds: number;
    mineSeconds: number;
    bunkerSeconds: number;
    mortarPitSeconds: number;
    bridgeSeconds: number;
  };
  /**
   * Hand grenades: the only weapon that arcs over cover, so they answer an enemy
   * sitting where rifles cannot reach. Ammunition replenishes on entering a new map;
   * riflemen may also request delivery from a Supply Officer during battle.
   */
  grenade: {
    damage: number;
    radius: number;
    /** Clear ground a soldier will throw across. */
    range: number;
    /** Projectile speed in pixels per second; a lob, not a bullet. */
    throwSpeed: number;
    suppression: number;
    suppressionRadius: number;
    armorMult: number;
    /** Ticks between throws from the same soldier. */
    cooldownTicks: number;
    /** Hostiles inside the blast needed to justify a throw without cover. */
    clusterThreshold: number;
    /** Whether a covered or pinned target alone is worth a grenade. */
    throwAtCoveredTargets: boolean;
  };
  grenadeSupplies: { range: number };
  smoke: { radius: number; durationSeconds: number; throwRange: number; startingGrenades: number };
  automaticSupport: { unlockXp: number; retrySeconds: number };
  specialization: {
    unlockXp: number;
    accuracyBonus: number;
    suppressionMult: number;
    reloadReduction: number;
    armorDamageMult: number;
    healAmountMult: number;
    healRangeMult: number;
    buildSpeedMult: number;
    mineDamageMult: number;
    artilleryCooldownMult: number;
    /** Artillery call-in time multiplier for a Forward Observer. */
    artilleryDelayMult: number;
    /** Movement speed multiplier for a soldier trained in forced marching. */
    movementSpeedMult: number;
    /** Detection range multiplier against a soldier wearing field camouflage. */
    camouflageRangeMult: number;
  };
  /**
   * Mines. Shared placement policy here; per-type weapon data in `mineKinds`.
   * Only the Axis trip them, but the blast catches anyone standing in it.
   */
  mine: {
    /** Mines may only be laid north of this, ahead of the defending line. */
    maxLayY: number;
    /** Whether a mine blast also harms the defenders standing in it. */
    friendlyFire: boolean;
  };
  /** The mine types an engineer can lay. */
  mineKinds: Record<MineKind, MineKindDef>;
  /**
   * Buildings. They are solid while they stand - movement, sight, and bullets -
   * and become walkable ruins when destroyed. Health is per kind, so a church
   * takes a real effort to level and a house does not.
   */
  buildings: {
    /** Collapse damage as a fraction of the occupant's maximum health. */
    collapseDamageMinMult: number;
    collapseDamageMaxMult: number;
    /** Footprint in terrain cells, per kind. */
    footprints: Record<BuildingKind, { cols: number; rows: number }>;
    health: Record<BuildingKind, number>;
    /** How many of each kind a map tries to place; the roll is inclusive. */
    counts: Record<BuildingKind, { min: number; max: number }>;
    /** Minimum gap between two buildings, in cells, so they never touch. */
    minGapCells: number;
    /**
     * Clearance from the deployment zone, in cells. Buildings sit in the
     * contested middle of the map rather than on the player's start line.
     */
    deploymentClearanceCells: number;
    /** Damage multiplier applied to buildings by non-explosive fire. */
    smallArmsDamageMult: number;
  };
  /** Where the squad re-forms on a freshly generated map. */
  assembly: {
    /** Northmost row the arrival formation may occupy. */
    startY: number;
    /** Southmost row the arrival formation may occupy. */
    endY: number;
    /** Horizontal distance between arrival columns. */
    spacing: number;
  };
  /**
   * Formation a grouped move order resolves to. The clicked point is the centre
   * of a slot grid rather than one shared destination, so a squad does not spend
   * the next few seconds shoving itself off a single tile.
   */
  formation: {
    /** Distance in pixels between formation slots. */
    spacing: number;
  };
  xp: {
    accuracyPerLevel: number;
    startingSkillVariation: number;
    reloadReductionPerLevel: number;
    maxLevel: number;
    infantryKillXp: number;
    vehicleKillXp: number;
  };
  rewards: {
    waveClearBase: number;
    waveClearPerLevels: number;
    waveClearBonusScore: number;
    integrityBonusScore: number;
  };
  endless: {
    /** Multiplicative growth of base counts per endless wave. */
    countGrowth: number;
    maxCountPerArchetype: number;
    minSpawnIntervalSeconds: number;
    vehicleEveryWaves: number;
  };
  autosaveSeconds: number;
  sandbagMinSpacing: number;
  terrain: {
    cell: number;
    featureMin: number;
    featureMax: number;
    protectedTopRows: number;
    protectedBottomRows: number;
    /** Movement and combat modifiers for rivers, mud, bridges, and roads. */
    effects: {
      river: TerrainEffects;
      rapids: TerrainEffects;
      bridge: TerrainEffects;
      road: TerrainEffects;
      mud: TerrainEffects;
    };
    river: {
      /**
       * Share of maps that have a river at all. Below 1, some battlefields are
       * dry: faster, more open ground with no water to slow an attack.
       */
      presenceChance: number;
      /** Thickness of the wadeable band, in pixels. */
      widthMin: number;
      widthMax: number;
      /** How far the band's centreline meanders up and down, in pixels. */
      meander: number;
      /**
       * Wavelength of the meander in pixels. A wavelength near the field height
       * would look like a straight band; far below it, like noise.
       */
      meanderWavelength: number;
    };
    mud: {
      patchMin: number;
      patchMax: number;
      /** More patches on a dry map, where mud carries the whole hazard load. */
      patchMinWithoutRiver: number;
      patchMaxWithoutRiver: number;
      /** Radius of a patch, in pixels. */
      radiusMin: number;
      radiusMax: number;
      /** Half-width as a fraction of half-length; keeps a patch round. */
      aspectMin: number;
      aspectMax: number;
      /** Minimum side-by-side gap between patches, as a share of half-lengths. */
      minGapFactorX: number;
      /** Minimum stacked gap between patches, as a share of half-widths. */
      minGapFactorY: number;
      /** Clearance from the river's edge, in pixels. */
      riverClearance: number;
    };
  };
}
