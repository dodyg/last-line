import { AMBUSH_ARCS, ambushShape, insideAmbushArc, supportsAmbush } from './ambush';
import { CONFIG } from '../content/config';
import { demolitionSites, demolitionTargetExists, sameDemolitionTarget } from './sappers';
import type { EnemySapperTeam } from './types';
import { wireContains, wireDistance } from './barbed-wire';
import { usesBackupRifle } from './loadout';
import { isTreeKind, TREE_HEALTH, treeCellPosition, treeOnShot } from './tree-damage';
import { campfireError, campfireIlluminates } from './campfires';
import { satchelError } from './satchels';
import { getContent, type Content } from '../content/validate';
import { deriveRng, rngInt, rngNext, rngPick, rngRange } from './rng';
import {
  generateTerrain,
  hasLineOfSight,
  nearestOpenCell,
  TERRAIN_KIND,
  foliageAlongLine,
  isFoliageKind,
  isBridgeAt,
  isRiverAt,
  riverHalfWidthAtPoint,
  posToCol,
  posToRow,
  rebuildBlocked,
  terrainEffectsAt,
  weatherForSeed,
  type GeneratedBuilding,
  type TerrainData,
} from './terrain';
import { findPath } from './navigation';
import { latestNightContact, nightContactFor, recordNightGunfire } from './perception';
import { BUILDING_FACINGS, buildingArchitecture, buildingLevels, buildingSlot, containsBuilding, positionCapacity, positionFacing, unitBuildingHeight, unitEyeHeight, FLOOR_HEIGHT } from './buildings';
import type { BuildingFacing, BuildingLevel, BuildingPosition } from './types';
import { ELEVATION, elevationAt, elevationTraversal, slopeAt } from './elevation';
import { canRun, updateStamina } from './movement';
import { damageTankComponent, tankImmobilized, TANK_COMPONENTS } from './tank-damage';
import { nextSeasonalWeather, seasonForSeed } from './seasons';
import { strikeIsImminent } from './incoming-fire';
import { insidePatrolArea, isPatrolRole, patrolArea, patrolPoints, patrolTerrain, validPatrolArea } from './patrol';
import { BRIDGE, bridgeContains, bridgeDeckHeight, bridgeFootHeight, bridgeKey, bridgeTraversal, unitBridge } from './bridges';
import {
  acquireTarget,
  applyDamageToUnit,
  applySuppression,
  chooseGrenadeTarget,
  dist,
  effectiveReloadTicks,
  engageDistance,
  hasDirectionalCover,
  hasBunkerCover,
  hasTrenchCover,
  hitChance,
  isInTrench,
  isVehicle,
  suppressNear,
  targetIsValid,
  trenchBonusFor,
  unitRadius,
} from './combat';
import { buildSpawnQueue, currentWaveDef, endlessWaveNumber } from './waves';
import { dayNightAtTick } from './daynight';
import { FIRE_ORDERS, fireOrdersForRole, MAX_GROUND_IMPACTS } from './types';
import type {
  Command,
  CommandResult,
  ConstructionSite,
  BuiltBridge,
  EnemyArchetype,
  FriendlyRole,
  Mine,
  MineKind,
  SimEvent,
  SimSnapshot,
  SimState,
  Strike,
  Team,
  Unit,
  Vec2,
  WeaponUpgradeType,
  WeaponStats,
  TerrainEffects,
  Building,
  FireOrder,
  Specialization,
} from './types';

/** Seconds to ticks conversion. */
export function sec(s: number): number {
  return Math.round(s * CONFIG.tickRate);
}

/**
 * Salt for the Axis battery's derived random stream. Distinct from every other
 * derived stream so the battery never shares a sequence with terrain, and fixed
 * so a run's fire plan is reproducible from its seed.
 */
const BATTERY_RNG_SALT = 0x2b17;
const UNIT_SEPARATION = { infantry: 13, vehicle: 46 } as const;

/**
 * Terrain seed for a map of a campaign. Map 1 is the run's own seed, so a fresh
 * run and a restored one generate the identical first battlefield; each further
 * map derives its own seed from the same base. The sequence of maps is therefore
 * a fixed property of the run seed and a reload reproduces the same
 * battlefields. `mix` is one-to-one over the 32-bit range (an odd multiplier plus
 * a constant), so no two maps of a run share a seed.
 */
export function mapTerrainSeed(baseSeed: number, mapNumber: number): number {
  if (mapNumber <= 1) return baseSeed >>> 0;
  return (Math.imul(mapNumber, 0x9e3779b1) + (baseSeed >>> 0)) >>> 0;
}

/**
 * Whether a victory came from marching the whole campaign clear. Both roads to
 * victory end on the results screen, but only the campaign one has to explain
 * that a further map is the endless continuation.
 */
export function wonByCampaign(state: { mapsCleared: number }): boolean {
  return state.mapsCleared >= CONFIG.crossing.campaignMaps;
}

/**
 * The deterministic fixed-step battle simulation. No Phaser, DOM, audio, or
 * wall-clock time may be imported here. All gameplay randomness flows through
 * state.rng so snapshots reproduce outcomes exactly.
 */
export class Simulation {
  readonly content: Content;
  state: SimState;
  /** Pause gate owned by the UI; a paused sim steps nothing and takes no commands. */
  paused = false;
  private pendingEvents: SimEvent[] = [];
  /**
   * Soft ground for the current map: the wadeable river and the mud patches.
   * Terrain itself is regenerated on demand from the seed, so it is not state;
   * unlike the blocked grid, though, a zone is an area rather than a cell, so it
   * is generated once per map and kept for the movement and combat lookups.
   */
  private zones: TerrainData['zones'];
  /** Per-cell foliage for movement, concealment, and shot attenuation. */
  private terrainKinds: Uint8Array;
  /**
   * Whether this map was generated with buildings at all. False only for a map
   * restored from a save made before buildings existed.
   */
  private terrainHasBuildings: boolean;
  private terrainLayoutVersion: 1 | 2 | 3;
  /**
   * The map's buildings in generation order, kept alongside the state because
   * generation is the only thing that knows their names and footprints. The state
   * owns their health and their ruined-or-standing flag.
   */
  private buildingSpecs: readonly GeneratedBuilding[];
  /** Footprint in cells plus centre, per building id, for hit tests and drawing. */
  private readonly buildingGeometry = new Map<number, { x: number; y: number; w: number; h: number; cx: number; cy: number }>();
  /** Avoidance routes already recalculated for the current set of lit flares. */
  private enemyFlareRouteSignatures = new Map<number, string>();
  private activeFlareRouteSignature = '';

  constructor(seed: number, content: Content = getContent(), terrainData?: TerrainData, withBuildings = true) {
    this.content = content;
    const terrain: TerrainData = terrainData ?? generateTerrain(seed, withBuildings);
    this.terrainHasBuildings = withBuildings;
    this.terrainLayoutVersion = terrain.layoutVersion ?? 1;
    this.zones = terrain.zones;
    terrain.terrain.bridges = this.zones.bridges;
    this.terrainKinds = terrain.kinds;
    this.buildingSpecs = terrain.buildings;
    const squad = CONFIG.start.squad;
    const state: SimState = {
      season: terrain.season,
      schemaVersion: 30,
      ...(terrain.campaignCountry === undefined ? {} : { campaignCountry: terrain.campaignCountry }),
      seed,
      rng: { s: seed >>> 0 },
      // A separate derived stream, so the Axis fire plan is a property of the run
      // seed and tuning the battery leaves the rest of the battle untouched.
      enemyArtilleryRng: { s: deriveRng(seed, BATTERY_RNG_SALT).s },
      ticks: 0,
      nextEntityId: 1,
      units: [],
      medicalQueue: [],
      grenadeSupplyQueue: [],
      battleRecord: { enemyKills: 0, casualties: 0, breakthroughs: 0 },
      projectiles: [],
      smokes: [],
      enemySmokeAssaults: [],
      strikes: [],
      groundImpacts: [],
      treeDamage: [],
      sandbags: [],
      trenches: [],
      bunkers: [],
      mortarPits: [],
      barbedWire: [],
      enemySapperTeams: [],
      enemyDemolitionCharges: [],
      destroyedBridgeKeys: [],
      mines: [],
      builtBridges: [],
      constructionSites: [],
      buildings: [],
      terrain: terrain.terrain,
      points: CONFIG.start.points,
      integrity: CONFIG.start.integrity,
      score: 0,
      scheduler: {
        waveIndex: 0,
        phase: 'prep',
        prepTicksLeft: sec(CONFIG.start.prepSeconds),
        spawnQueue: [],
        spawnTimer: 0,
        rewardGranted: false,
        endlessWavesCleared: 0,
      },
      artilleryCooldown: 0,
      airSupportCooldown: 0,
      flareCooldown: 0,
      flares: [],
      campfires: [],
      satchelCharges: [],
      weather: terrain.weather,
      weatherChangeTick: sec(CONFIG.weatherChangeSeconds),
      wavesCompleted: 0,
      dayNightStartTick: null,
      // The Axis battery starts silent: no barrage is possible before the wave
      // configured in CONFIG.enemyArtillery.firstWaveWithBarrage.
      enemyArtilleryCooldown: 0,
      foodSupplyCooldown: 0,
      endless: false,
      phase: 'running',
      mapNumber: 1,
      mapsCleared: 0,
      captureTicks: 0,
      sectorCaptured: false,
      sectorSupplyPending: false,
      baseTerrainSeed: seed >>> 0,
      crossedUnits: [],
      terrainHasBuildings: true,
    };
    this.state = state;
    this.instantiateBuildings();
    for (const member of squad) {
      this.spawnFriendly(member.role, member.pos);
    }
  }

  /**
   * Turn the generated footprints into live buildings and index their geometry.
   * Called once per map: a new building starts at full health, and the blocked
   * grid already has its footprint marked solid by the generator.
   */
  private instantiateBuildings(): void {
    const s = this.state;
    s.buildings = this.buildingSpecs.map((spec) => {
      const cell = s.terrain.cell;
      const building: Building = {
        id: s.nextEntityId++,
        kind: spec.kind,
        pos: { x: spec.col * cell, y: spec.row * cell },
        cols: spec.cols,
        rows: spec.rows,
        name: spec.name,
        health: CONFIG.buildings.health[spec.kind],
        maxHealth: CONFIG.buildings.health[spec.kind],
        destroyed: false,
      };
      Object.assign(building, buildingArchitecture(building));
      this.indexBuilding(building);
      return building;
    });
    rebuildBlocked(s.terrain, s.buildings);
  }

  private indexBuilding(building: Building): void {
    const cell = this.state.terrain.cell;
    const w = building.cols * cell;
    const h = building.rows * cell;
    this.buildingGeometry.set(building.id, {
      x: building.pos.x,
      y: building.pos.y,
      w,
      h,
      cx: building.pos.x + w / 2,
      cy: building.pos.y + h / 2,
    });
  }

  // ---------------------------------------------------------------- restore

  /** Rebuild a simulation from a validated snapshot. Terrain is regenerated from the map's derived seed. */
  static fromSnapshot(snap: SimSnapshot, content: Content = getContent()): Simulation {
    const base = snap.baseTerrainSeed ?? snap.seed;
    const mapNumber = snap.mapNumber ?? 1;
    // A save from before buildings existed has no record of them, so its map is
    // generated without any rather than with structures the save cannot describe.
    const withBuildings = snap.terrainHasBuildings !== false;
    const season = snap.season ?? (snap.weather?.toLowerCase().includes('snow') ? 'winter' : seasonForSeed(snap.seed));
    const sim = new Simulation(base, content, generateTerrain(mapTerrainSeed(base, mapNumber), withBuildings, snap.terrainLayoutVersion ?? 1, snap.campaignCountry, season), withBuildings);
    const s = sim.state;
    // The constructor uses the run seed for identity; terrain lookups need this map's seed.
    s.seed = mapTerrainSeed(base, mapNumber);
    const cloneUnit = (u: Unit): Unit => ({
      ...structuredClone(u),
      rockets: u.rockets ?? (u.team === 'friendly' && u.role === 'at' ? content.friendly.at.rockets ?? 0 : 0),
      mortarBombs: u.mortarBombs ?? (u.team === 'friendly' && u.role === 'mortarman' ? content.friendly.mortarman.mortarBombs ?? 0 : 0),
    });
    // Replace generated defaults with snapshot data (deep-copied to detach).
    s.rng = { s: snap.rng.s >>> 0 };
    // Independent stream for the Axis battery; see `SimSnapshot`. Derived from
    // the seed when the save predates it, so an older run still gets a battery.
    s.enemyArtilleryRng = { s: (snap.enemyArtilleryRng?.s ?? deriveRng(base, BATTERY_RNG_SALT).s) >>> 0 };
    s.ticks = snap.ticks;
    s.nextEntityId = snap.nextEntityId;
    s.battleRecord = { ...snap.battleRecord };
    s.units = snap.units.map(cloneUnit);
    s.medicalQueue = [...(snap.medicalQueue ?? s.units.flatMap((u) => u.medicalTargetId === undefined ? [] : [u.medicalTargetId]))];
    s.grenadeSupplyQueue = [...(snap.grenadeSupplyQueue ?? [])];
    s.projectiles = snap.projectiles.map((p) => ({ ...p, pos: { ...p.pos }, target: { ...p.target } }));
    s.smokes = (snap.smokes ?? []).map((smoke) => ({ ...smoke, pos: { ...smoke.pos } }));
    s.enemySmokeAssaults = structuredClone(snap.enemySmokeAssaults ?? []);
    s.strikes = snap.strikes.map((k) => ({ ...k, pos: { ...k.pos } }));
    s.groundImpacts = structuredClone(snap.groundImpacts ?? []);
    s.treeDamage = structuredClone(snap.treeDamage ?? []);
    for (const tree of s.treeDamage) if (tree.health === 0) sim.terrainKinds[tree.cell] = TERRAIN_KIND.open;
    s.sandbags = snap.sandbags.map((b) => ({ ...b, pos: { ...b.pos } }));
    s.trenches = (snap.trenches ?? []).map((t) => ({ ...t, pos: { ...t.pos } }));
    s.bunkers = (snap.bunkers ?? []).map((b) => ({ ...b, pos: { ...b.pos } }));
    s.enemySapperTeams = structuredClone(snap.enemySapperTeams ?? []);
    s.enemyDemolitionCharges = structuredClone(snap.enemyDemolitionCharges ?? []);
    s.destroyedBridgeKeys = [...(snap.destroyedBridgeKeys ?? [])];
    sim.zones.bridges = sim.zones.bridges.filter((bridge) => !s.destroyedBridgeKeys.includes(bridgeKey(bridge)));
    s.terrain.bridges = sim.zones.bridges;
    s.barbedWire = (snap.barbedWire ?? []).map((wire) => ({ ...wire, pos: { ...wire.pos } }));
    s.mortarPits = (snap.mortarPits ?? []).map((pit) => ({ ...pit, pos: { ...pit.pos } }));
    s.mines = (snap.mines ?? []).map((m) => ({ ...m, pos: { ...m.pos } }));
    s.builtBridges = (snap.builtBridges ?? []).map((bridge) => ({ ...bridge, pos: { ...bridge.pos } }));
    const bridgeMigrations: Unit[] = [];
    for (const bridge of s.builtBridges) {
      const surface = { ...bridge.pos, axis: bridge.axis, type: 'pontoon' as const, halfWidth: bridge.halfWidth, halfLength: bridge.halfLength };
      sim.zones.bridges.push(surface);
      // Older saves treated engineer crossings as raised timber bridges. There
      // is no lower passage beneath a pontoon: recover occupants onto its deck.
      for (const unit of s.units) if (!unit.buildingPosition && bridgeContains(surface, unit.pos)
        && (!unit.bridgePosition || unit.bridgePosition.key === bridgeKey(surface))) {
        if (unit.bridgePosition?.level === 'under') bridgeMigrations.push(unit);
        unit.bridgePosition = { key: bridgeKey(surface), level: 'deck' };
      }
    }
    s.constructionSites = (snap.constructionSites ?? []).map((site) => ({ ...site, pos: { ...site.pos } }));
    // Buildings arrive with the save's health and ruin flags, and the live blocked
    // grid is rebuilt from the floor plan plus whichever of them still stand.
    s.buildings = (snap.buildings ?? []).map((building) => ({ ...building, pos: { ...building.pos } }));
    sim.buildingGeometry.clear();
    for (const building of s.buildings) sim.indexBuilding(building);
    s.terrainHasBuildings = withBuildings;
    rebuildBlocked(s.terrain, s.buildings);
    for (const unit of bridgeMigrations) if (unit.moveGoal) {
      const route = sim.findUnitPath(unit, unit.pos, unit.moveGoal);
      unit.path = route.reachable ? route.waypoints : [];
    }
    s.points = snap.points;
    s.integrity = snap.integrity;
    s.score = snap.score;
    s.scheduler = {
      ...snap.scheduler,
      spawnQueue: [...snap.scheduler.spawnQueue],
      endlessWavesCleared: snap.scheduler.endlessWavesCleared ?? 0,
    };
    s.artilleryCooldown = snap.artilleryCooldown;
    s.airSupportCooldown = snap.airSupportCooldown ?? 0;
    s.flareCooldown = snap.flareCooldown ?? 0;
    s.flares = (snap.flares ?? []).map((flare) => ({ ...flare, pos: { ...flare.pos } }));
    s.campfires = (snap.campfires ?? []).map((fire) => ({ ...fire, pos: { ...fire.pos } }));
    s.satchelCharges = (snap.satchelCharges ?? []).map((charge) => ({ ...charge, pos: { ...charge.pos } }));
    s.weather = snap.weather ?? weatherForSeed(snap.seed, snap.campaignCountry, season);
    s.weatherChangeTick = snap.weatherChangeTick ?? snap.ticks + sec(CONFIG.weatherChangeSeconds);
    s.wavesCompleted = snap.wavesCompleted ?? Math.max(snap.scheduler.waveIndex, snap.scheduler.endlessWavesCleared ?? 0);
    s.dayNightStartTick = snap.dayNightStartTick !== undefined
      ? snap.dayNightStartTick
      : s.wavesCompleted >= CONFIG.dayNight.startAfterWaves ? snap.ticks : null;
    s.enemyArtilleryCooldown = snap.enemyArtilleryCooldown ?? 0;
    s.foodSupplyCooldown = snap.foodSupplyCooldown ?? 0;
    s.endless = snap.endless;
    s.phase = snap.phase;
    s.mapNumber = mapNumber;
    s.mapsCleared = snap.mapsCleared ?? Math.max(0, mapNumber - 1);
    s.captureTicks = snap.captureTicks ?? 0;
    s.sectorCaptured = snap.sectorCaptured ?? false;
    s.sectorSupplyPending = snap.sectorSupplyPending ?? false;
    s.baseTerrainSeed = base >>> 0;
    s.crossedUnits = (snap.crossedUnits ?? []).map(cloneUnit);
    // The crossing flag is the inverse of field presence, so it is rebuilt from
    // the two arrays rather than trusted from the save.
    const crossedIds = new Set(s.crossedUnits.map((unit) => unit.id));
    for (const unit of s.crossedUnits) unit.crossed = false;
    s.units = s.units.filter((unit) => !crossedIds.has(unit.id));
    sim.pendingEvents = [];
    return sim;
  }

  /** JSON-safe snapshot of all state needed to resume identically. */
  snapshot(): SimSnapshot {
    const s = this.state;
    /**
     * `crossed` is derived state - the inverse of "is on the field" - and
     * restoring rebuilds it from the two unit lists rather than trusting the
     * save. It is stripped here so a snapshot is byte-identical no matter how the
     * march north happened to be timed when it was taken.
     */
    const cloneUnit = (u: Unit): Unit => {
      const copy: Unit = structuredClone(u);
      delete copy.crossed;
      return copy;
    };
    return {
      schemaVersion: s.schemaVersion,
      season: s.season,
      ...(s.campaignCountry === undefined ? {} : { campaignCountry: s.campaignCountry }),
      seed: s.seed,
      // The rng is a uint32 held in a signed int32, so it goes negative in normal
      // play. Persist it in its canonical unsigned form, or a snapshot never
      // compares equal to the state it was taken from after a reload.
      rng: { s: s.rng.s >>> 0 },
      enemyArtilleryRng: { s: s.enemyArtilleryRng.s >>> 0 },
      ticks: s.ticks,
      nextEntityId: s.nextEntityId,
      battleRecord: { ...s.battleRecord },
      units: s.units.map(cloneUnit),
      medicalQueue: [...(s.medicalQueue ?? [])],
      grenadeSupplyQueue: [...(s.grenadeSupplyQueue ?? [])],
      projectiles: s.projectiles.map((p) => ({ ...p, pos: { ...p.pos }, target: { ...p.target } })),
      smokes: s.smokes.map((smoke) => ({ ...smoke, pos: { ...smoke.pos } })),
      enemySmokeAssaults: structuredClone(s.enemySmokeAssaults ?? []),
      strikes: s.strikes.map((k) => ({ ...k, pos: { ...k.pos } })),
      groundImpacts: structuredClone(s.groundImpacts ?? []),
      treeDamage: structuredClone(s.treeDamage ?? []),
      sandbags: s.sandbags.map((b) => ({ ...b, pos: { ...b.pos } })),
      trenches: s.trenches.map((t) => ({ ...t, pos: { ...t.pos } })),
      bunkers: s.bunkers.map((b) => ({ ...b, pos: { ...b.pos } })),
      enemySapperTeams: structuredClone(s.enemySapperTeams),
      enemyDemolitionCharges: structuredClone(s.enemyDemolitionCharges),
      destroyedBridgeKeys: [...s.destroyedBridgeKeys],
      barbedWire: s.barbedWire.map((wire) => ({ ...wire, pos: { ...wire.pos } })),
      mortarPits: s.mortarPits.map((pit) => ({ ...pit, pos: { ...pit.pos } })),
      mines: s.mines.map((m) => ({ ...m, pos: { ...m.pos } })),
      builtBridges: s.builtBridges.map((bridge) => ({ ...bridge, pos: { ...bridge.pos } })),
      constructionSites: s.constructionSites.map((site) => ({ ...site, pos: { ...site.pos } })),
      buildings: s.buildings.map((building) => ({ ...building, pos: { ...building.pos } })),
      points: s.points,
      integrity: s.integrity,
      score: s.score,
      scheduler: { ...s.scheduler, spawnQueue: [...s.scheduler.spawnQueue] },
      artilleryCooldown: s.artilleryCooldown,
      airSupportCooldown: s.airSupportCooldown,
      flareCooldown: s.flareCooldown,
      flares: s.flares.map((flare) => ({ ...flare, pos: { ...flare.pos } })),
      campfires: s.campfires.map((fire) => ({ ...fire, pos: { ...fire.pos } })),
      satchelCharges: s.satchelCharges.map((charge) => ({ ...charge, pos: { ...charge.pos } })),
      weather: s.weather,
      weatherChangeTick: s.weatherChangeTick,
      wavesCompleted: s.wavesCompleted,
      dayNightStartTick: s.dayNightStartTick,
      enemyArtilleryCooldown: s.enemyArtilleryCooldown,
      foodSupplyCooldown: s.foodSupplyCooldown,
      endless: s.endless,
      phase: s.phase,
      mapNumber: s.mapNumber,
      mapsCleared: s.mapsCleared,
      captureTicks: s.captureTicks,
      sectorCaptured: s.sectorCaptured,
      sectorSupplyPending: s.sectorSupplyPending ?? false,
      baseTerrainSeed: s.baseTerrainSeed,
      crossedUnits: s.crossedUnits.map(cloneUnit),
      terrainHasBuildings: s.terrainHasBuildings,
      terrainLayoutVersion: this.terrainLayoutVersion,
    };
  }

  // ------------------------------------------------------------------ step

  /**
   * Advance exactly one tick; returns the events produced (drained once).
   *
   * Anything already queued - a fire mission ordered between ticks, for instance
   * - is returned alongside this tick's own events rather than being discarded.
   */
  step(): SimEvent[] {
    if (this.paused || this.state.phase !== 'running') return [];
    const carried = this.drainEvents();
    const s = this.state;
    const wasPhase = dayNightAtTick(s.ticks, s.dayNightStartTick).phase;
    s.ticks++;
    const timeOfDay = dayNightAtTick(s.ticks, s.dayNightStartTick);
    for (const unit of s.units) {
      if (unit.heardGunfire) {
        unit.heardGunfire = unit.heardGunfire.filter((contact) => contact.expiresTick > s.ticks);
        if (!unit.heardGunfire.length) delete unit.heardGunfire;
      }
      if (!unit.nightContacts) continue;
      if (unit.team === 'enemy' && unit.targetId === null && unit.moveGoal && unit.nightContacts.some((contact) =>
        (!timeOfDay.night || contact.expiresTick <= s.ticks) && dist(unit.moveGoal!, contact.pos) <= s.terrain.cell)) {
        unit.path = []; unit.moveGoal = null;
      }
      unit.nightContacts = timeOfDay.night ? unit.nightContacts.filter((contact) => contact.expiresTick > s.ticks) : [];
      if (!unit.nightContacts.length) delete unit.nightContacts;
    }
    if (timeOfDay.phase !== wasPhase) this.emit({ type: 'dayNightChanged', night: timeOfDay.night, phase: timeOfDay.phase });

    // Soldiers walking off the north edge are processed before the rest of the
    // battlefield, so a man who reaches the edge this tick is already gone when
    // the scheduler decides whether the map is still worth fighting for.
    this.updateCrossing();
    // A completed campaign ends on this very tick; the abandoned map's remaining
    // enemies must not get a last chance to break the line afterwards.
    if (s.phase !== 'running') return [...carried, ...this.drainEvents()];
    this.removeEmptyMap();
    if (s.phase !== 'running') return [...carried, ...this.drainEvents()];
    this.updateWeather();
    this.updateScheduler();
    this.updateEnemyArtillery();
    this.updateStrikes();
    this.updateProjectiles();
    this.updateSatchelCharges();
    this.updateEnemyDemolitionCharges();
    this.updateSapperTeams();
    this.updateMedicalQueue();
    this.updateGrenadeSupplyQueue();
    this.updateEnemySmokeAssaults();
    this.updateUnits();
    // After movement, so a mine bites the unit that actually stepped on it.
    this.updateMines();
    this.updateConstruction();
    this.updateAutomaticSupportRequests();
    this.updateCampaignObjective();
    this.updateSmoke();
    this.updateFlares();
    this.updateCampfires();
    s.artilleryCooldown = Math.max(0, s.artilleryCooldown - 1);
    s.airSupportCooldown = Math.max(0, s.airSupportCooldown - 1);
    s.flareCooldown = Math.max(0, s.flareCooldown - 1);
    s.enemyArtilleryCooldown = Math.max(0, s.enemyArtilleryCooldown - 1);
    s.foodSupplyCooldown = Math.max(0, s.foodSupplyCooldown - 1);
    return [...carried, ...this.drainEvents()];
  }

  // -------------------------------------------------------------- crossing

  /** Rotate conditions on a map timer; the cycle is repeatable after a save. */
  private updateWeather(): void {
    const s = this.state;
    if (s.ticks < s.weatherChangeTick) return;
    s.weather = nextSeasonalWeather(s.season ?? seasonForSeed(s.seed), s.weather);
    s.weatherChangeTick = s.ticks + sec(CONFIG.weatherChangeSeconds);
    this.emit({ type: 'weatherChanged', weather: s.weather });
  }

  /** Weather and darkness both shorten the range at which either army can engage. */
  private visibilityMultiplier(): number {
    const nightMult = dayNightAtTick(this.state.ticks, this.state.dayNightStartTick).night ? CONFIG.dayNight.nightVisibilityMult : 1;
    return CONFIG.weather[this.state.weather].visibilityMult * nightMult;
  }

  /** Headlights and fires expose either army; flares help only the Allied squad. */
  private visibilityMultiplierFor(shooter: Unit, target: Unit): number {
    const crossedFoliage = foliageAlongLine(this.state.terrain, this.terrainKinds, shooter.pos, target.pos);
    const foliageVisibility = (this.isInFoliage(target.pos) ? CONFIG.treeCover.visibilityMult : 1)
      * CONFIG.treeCover.lineVisibilityMult ** Math.min(8, crossedFoliage);
    const night = dayNightAtTick(this.state.ticks, this.state.dayNightStartTick).night;
    if (night) {
      const litByFlare = shooter.team === 'friendly' && target.team === 'enemy' && this.isIlluminated(target.pos);
      const litByHeadlights = this.vehicleHeadlightsOn(target);
      const litByFire = campfireIlluminates(this.state, target.pos);
      if (litByFlare || litByHeadlights || litByFire) {
        const flareBonus = litByFlare ? CONFIG.dayNight.flareVisibilityMult : 0;
        const headlightBonus = litByHeadlights ? CONFIG.dayNight.headlightsOnVisibilityMult : 0;
        return CONFIG.weather[this.state.weather].visibilityMult * Math.max(flareBonus, headlightBonus, litByFire ? 1 : 0) * foliageVisibility;
      }
    }
    const baseline = this.visibilityMultiplier() * foliageVisibility;
    const contact = nightContactFor(this.state, shooter, target);
    const cueRange = contact?.kind === 'sound' ? CONFIG.dayNight.gunfire.heardRangeMult : 1;
    return contact ? Math.max(baseline, contact.kind === 'sound' ? cueRange : CONFIG.weather[this.state.weather].visibilityMult * cueRange) : baseline;
  }

  private vehicleHeadlightsOn(unit: Unit): boolean {
    return isVehicle(this.content, unit) && unit.headlightsOn !== false;
  }

  private isIlluminated(pos: Vec2): boolean {
    if (!dayNightAtTick(this.state.ticks, this.state.dayNightStartTick).night) return false;
    return this.state.flares.some((flare) => (flare.pendingTicksRemaining ?? 0) <= 0 && flare.ticksRemaining > 0 && dist(flare.pos, pos) <= flare.radius);
  }

  private nightFlareSignature(): string {
    const night = dayNightAtTick(this.state.ticks, this.state.dayNightStartTick).night;
    const signature = night
      ? this.state.flares
        .filter((flare) => (flare.pendingTicksRemaining ?? 0) <= 0 && flare.ticksRemaining > 0)
        .map((flare) => flare.id)
        .sort((a, b) => a - b)
        .join(',')
      : '';
    if (signature !== this.activeFlareRouteSignature) {
      this.activeFlareRouteSignature = signature;
      this.enemyFlareRouteSignatures.clear();
    }
    return signature;
  }

  private findUnitPath(unit: Unit, start: Vec2, goal: Vec2, cost?: (pos: Vec2) => number) {
    const infantry = !isVehicle(this.content, unit);
    const wireCost = infantry && unit.role !== 'sapper' && this.state.barbedWire.length > 0
      ? (pos: Vec2) => (cost?.(pos) ?? 1) * (this.state.barbedWire.some((wire) => wireContains(wire, pos, this.state.terrain.cell / 2)) ? CONFIG.barbedWire.routeCost : 1)
      : cost;
    return findPath(this.state.terrain, start, goal, wireCost, infantry ? 'infantry' : 'vehicle', unit.bridgePosition);
  }

  private findEnemyPath(start: Vec2, goal: Vec2, unit?: Unit) {
    const cost = this.nightFlareSignature() === '' ? undefined : (pos: Vec2) => this.isIlluminated(pos) ? 12 : 1;
    return unit ? this.findUnitPath(unit, start, goal, cost) : findPath(this.state.terrain, start, goal, cost);
  }

  /** Detect a route entering flare light; a unit already in light may exit before this flags a later re-entry. */
  private enemyRouteEntersFlare(unit: Unit): boolean {
    const startsLit = this.isIlluminated(unit.pos);
    if (unit.path.length === 0) return startsLit;
    let exitedInitialLight = !startsLit;
    let previous = unit.pos;
    for (const waypoint of unit.path) {
      const length = dist(previous, waypoint);
      const steps = Math.max(1, Math.ceil(length / 12));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const point = { x: previous.x + (waypoint.x - previous.x) * t, y: previous.y + (waypoint.y - previous.y) * t };
        const lit = this.isIlluminated(point);
        if (lit && exitedInitialLight) return true;
        if (!lit) exitedInitialLight = true;
      }
      previous = waypoint;
    }
    return startsLit && !exitedInitialLight;
  }

  /**
   * The squad still on this map's order of battle: alive, and not already walking
   * off the northern edge. Soldiers on the way out are deliberately excluded so
   * they cannot be ordered, targeted, counted against the squad cap, or treated
   * as a garrison by the HUD.
   */
  private livingFriendlies(): Unit[] {
    return this.state.units.filter((unit) => unit.team === 'friendly' && unit.health > 0 && !unit.dead && unit.crossed !== true);
  }

  /** How many soldiers are over the north edge, waiting for the next map. */
  get crossedCount(): number {
    return this.state.crossedUnits.filter((unit) => !unit.dead && unit.health > 0).length;
  }

  /**
   * How many soldiers are on their way north right now - still on the field but
   * already out of the order of battle. Used by the HUD readout and by tests.
   */
  get crossingCount(): number {
    const walking = this.state.units.filter((unit) => unit.team === 'friendly' && unit.crossed === true && unit.health > 0 && !unit.dead);
    return walking.length + this.crossedCount;
  }

  /**
   * Display data for the battlefield the simulation is currently on: the
   * blocked grid it moves units across, plus the cosmetic kinds, lanes, setting
   * and buildings the renderer draws. Generated from the map's derived seed, so
   * the renderer and the simulation can never disagree about where the terrain
   * is - including whether this map has buildings at all.
   */
  terrainData(): TerrainData {
    const s = this.state;
    const data = generateTerrain(s.seed, this.terrainHasBuildings, this.terrainLayoutVersion, s.campaignCountry, s.season);
    data.zones.bridges = [...(s.terrain.bridges ?? [])];
    data.terrain.bridges = data.zones.bridges;
    return data;
  }

  /** True when this map has been given up and the squad is walking north. */
  get isCrossing(): boolean {
    return this.state.scheduler.phase === 'crossing';
  }

  /**
   * What the ground under a unit costs it: wading the river or standing in mud
   * slows the pace, spoils the aim, and takes longer to reload. Roads give all
   * moving units a speed boost, while firm ground has no modifier.
   */
  terrainEffectsFor(unit: Unit): TerrainEffects {
    if (unit.buildingPosition) return { speedMult: 1, accuracyMult: 1, reloadMult: 1 };
    const bridge = unitBridge(this.state.terrain, unit);
    const groundZones = bridge && unit.bridgePosition?.level === 'under'
      ? { ...this.zones, bridges: [] } : this.zones;
    let effects = terrainEffectsAt(groundZones, this.state.seed, unit.pos);
    // Terrain resolution gives water and bridges priority over ordinary roads.
    if (unit.role === 'gun_truck' && effects === CONFIG.terrain.effects.road) {
      effects = { ...effects, speedMult: CONFIG.gunTruck.roadSpeedMult };
    }
    if (unit.role === 'troop_transport' && effects === CONFIG.terrain.effects.road) {
      effects = { ...effects, speedMult: CONFIG.troopTransport.roadSpeedMult };
    }
    if (!isVehicle(this.content, unit) && !bridge && this.state.barbedWire.some((wire) => wireContains(wire, unit.pos))) {
      effects = { ...effects, speedMult: effects.speedMult * CONFIG.barbedWire.speedMult };
    }
    return this.isInFoliage(unit.pos)
      ? { ...effects, speedMult: effects.speedMult * CONFIG.treeCover.movementSpeedMult }
      : effects;
  }

  private isInFoliage(pos: Vec2): boolean {
    const terrain = this.state.terrain;
    const index = posToRow(terrain, pos.y) * terrain.cols + posToCol(terrain, pos.x);
    return isFoliageKind(this.terrainKinds[index] ?? 0);
  }

  /**
   * The march north. A soldier who reaches the exit band leaves the order of
   * battle and is carried off the map that same tick: it is walked just north of
   * the line, handed to `crossedUnits`, and taken out of `units` - which is every
   * list the battlefield uses for targeting, rendering and the roster. It is not
   * a casualty, so it keeps its identity, wounds, experience and personal weapon
   * upgrades, and it is re-deployed in the south of the next map.
   *
   * The cleared map is then held frozen by the `crossing` wave phase, so no
   * further wave starts while the squad leaves and an abandoned map can neither
   * pay a clear reward nor count toward the campaign.
   */
  private updateCrossing(): void {
    const s = this.state;
    if (s.phase !== 'running') return;

    // Anyone who has reached the exit band joins the march. The exit walk is
    // driven from the marcher's own position rather than from a path, so a
    // soldier cannot be left stranded on the line waiting for one more order.
    const reachedExit = s.units.filter(
      (unit) => unit.team === 'friendly' && unit.health > 0 && !unit.dead
        && unit.crossed !== true && !unit.patrol && unit.pos.y <= CONFIG.crossing.thresholdY,
    );
    for (const unit of reachedExit) {
      delete unit.buildingOrder;
      delete unit.buildingPosition;
      unit.crossed = true;
      unit.path = [];
      unit.moveGoal = null;
      unit.targetId = null;
      unit.burstRemaining = 0;
    }
    if (reachedExit.length > 0 && s.scheduler.phase !== 'crossing') this.beginCrossing();

    // Everything already walking north takes its last step and leaves the field.
    const leaving: Unit[] = [];
    for (const unit of s.units) {
      if (unit.team !== 'friendly' || unit.crossed !== true || unit.health <= 0 || unit.dead) continue;
      const marched = this.stepMarcher(unit);
      if (!marched || unit.pos.y > CONFIG.crossing.thresholdY) continue;
      leaving.push(unit);
      this.emit({ type: 'unitCrossed', unitId: unit.id, remaining: this.livingFriendlies().length });
    }
    if (leaving.length > 0) {
      const gone = new Set(leaving.map((unit) => unit.id));
      s.units = s.units.filter((unit) => !gone.has(unit.id));
      s.crossedUnits.push(...leaving);
    }
  }

  /** Give up the current map: no new wave spawns here while the squad marches out. */
  private beginCrossing(): void {
    const s = this.state;
    s.scheduler.phase = 'crossing';
    s.scheduler.spawnQueue = [];
    s.scheduler.rewardGranted = true; // an abandoned map pays no clear reward
    this.emit({ type: 'crossingBegan' });
  }

  /**
   * Take one soldier's last step off the map - a deliberate shortcut that skips
   * the normal pathfinding, because the protected top rows are always open and
   * an outbound soldier is not fighting on this map any more. The point it walks
   * to is north of the threshold, so it always ends up clear of the line.
   */
  private stepMarcher(marcher: Unit): boolean {
    marcher.prevPos = { x: marcher.pos.x, y: marcher.pos.y };
    marcher.running = false; marcher.movementPace = 'walk';
    // Marchers no longer take part in combat, so suppression can only decay.
    // Keep that recovery ticking here because crossed units are skipped by the
    // normal unit update. A pinned soldier cannot finish evacuating until it
    // reaches the same recovery threshold used during combat.
    marcher.suppression = Math.max(0, marcher.suppression - CONFIG.suppression.decayPerTick);
    if (marcher.pinned) {
      if (marcher.suppression > CONFIG.suppression.recoverThreshold) return false;
      marcher.pinned = false;
    }
    const speedPerTick = this.speedOf(marcher) / CONFIG.tickRate;
    // South of the line by at least a full step, so it reads as off the map
    // rather than stopped exactly on the boundary.
    marcher.pos = { x: marcher.pos.x, y: CONFIG.crossing.thresholdY - speedPerTick - 1 };
    marcher.moveGoal = { ...marcher.pos };
    if (marcher.path.length > 0) marcher.path = [];
    return true;
  }

  /** The whole squad is across: generate the next map and keep the campaign going. */
  private removeEmptyMap(): void {
    const s = this.state;
    // Nobody left to fight on this map and at least one soldier alive over the
    // edge: this is an advance, not a wipe. A wipe leaves nobody across and is
    // resolved by the breakthrough rule instead.
    if (this.livingFriendlies().length > 0) return;
    if (!s.crossedUnits.some((unit) => !unit.dead && unit.health > 0)) return;
    this.advanceToNextMap();
  }

  /**
   * March the squad onto a new map. The wave counter restarts at 1 and the
   * battlefield is regenerated from the run seed, but everything that belongs to
   * the player survives: the soldiers themselves (wounds, experience, kills,
   * weapon upgrades, service records), their points and score, and the line
   * integrity they are defending.
   *
   * What does not survive is anything dug into the ground: sandbags, trenches,
   * mines, engineer-built bridges, half-finished construction, shells in flight, and the enemy still on
   * the abandoned map. Giving up a position costs you the position.
   */
  private advanceToNextMap(): void {
    const s = this.state;
    // Only the living march on; a soldier who died of wounds on the way out is a
    // casualty of the map that was abandoned, not a reinforcement for the next.
    const squad = s.crossedUnits.filter((unit) => !unit.dead && unit.health > 0);
    const fallen = s.crossedUnits.filter((unit) => unit.dead || unit.health <= 0);
    if (fallen.length > 0) s.battleRecord.casualties += fallen.length;
    s.crossedUnits = [];
    s.units = [];
    s.medicalQueue = [];
    s.grenadeSupplyQueue = [];
    s.projectiles = [];
    s.smokes = [];
    s.enemySmokeAssaults = [];
    s.strikes = [];
    s.groundImpacts = [];
    s.treeDamage = [];
    s.sandbags = [];
    s.trenches = [];
    s.bunkers = [];
    s.mortarPits = [];
    s.barbedWire = [];
    s.enemySapperTeams = [];
    s.enemyDemolitionCharges = [];
    s.destroyedBridgeKeys = [];
    s.mines = [];
    s.builtBridges = [];
    s.constructionSites = [];
    s.artilleryCooldown = 0;
    s.airSupportCooldown = 0;
    s.flareCooldown = 0;
    s.flares = [];
    s.campfires = [];
    s.satchelCharges = [];
    // A new battlefield means the Axis have to find the line again, so the
    // battery starts quiet and the first barrage waits for the new map's wave
    // gate like every other wave-10 feature.
    s.enemyArtilleryCooldown = 0;
    s.foodSupplyCooldown = 0;
    const credited = s.sectorCaptured;
    if (credited) s.mapsCleared += 1;
    s.captureTicks = 0;
    s.sectorCaptured = false;
    s.sectorSupplyPending = credited && s.mapsCleared < CONFIG.crossing.campaignMaps;
    s.mapNumber += 1;
    s.seed = mapTerrainSeed(s.baseTerrainSeed, s.mapNumber);
    s.season = seasonForSeed(s.seed);
    s.weather = weatherForSeed(s.seed, s.campaignCountry, s.season);
    s.weatherChangeTick = s.ticks + sec(CONFIG.weatherChangeSeconds);
    // The battery's stream is a property of the map, like the terrain: a fresh
    // battlefield gets a fresh fire plan rather than continuing the old one.
    s.enemyArtilleryRng = { s: deriveRng(s.seed, BATTERY_RNG_SALT).s };
    const terrainData = generateTerrain(s.seed, true, 3, s.campaignCountry, s.season);
    this.terrainLayoutVersion = 3;
    this.terrainHasBuildings = true;
    s.terrainHasBuildings = true;
    s.terrain = terrainData.terrain;
    s.terrain.bridges = terrainData.zones.bridges;
    this.terrainKinds = terrainData.kinds;
    // New map, new water, mud, and a fresh set of buildings. Nothing carries over:
    // you are not fighting in the same town, and a ruin you made is behind you.
    this.zones = terrainData.zones;
    this.buildingSpecs = terrainData.buildings;
    this.buildingGeometry.clear();
    this.instantiateBuildings();
    s.scheduler = {
      waveIndex: 0,
      phase: 'prep',
      prepTicksLeft: sec(CONFIG.crossing.arrivalSeconds),
      spawnQueue: [],
      spawnTimer: 0,
      rewardGranted: false,
      endlessWavesCleared: s.scheduler.endlessWavesCleared,
    };
    this.deployArrivals(squad);
    this.emit({
      type: 'mapCleared',
      mapsCleared: s.mapsCleared,
      mapNumber: s.mapNumber,
      squad: squad.length,
      goal: CONFIG.crossing.campaignMaps,
      credited,
    });
    if (!s.endless && s.mapsCleared >= CONFIG.crossing.campaignMaps) {
      s.phase = 'victory';
      this.emit({ type: 'victory' });
    }
  }

  /** Legacy capture objective; campaign maps now secure automatically after wave 15. */
  private updateCampaignObjective(): void {
    const s = this.state;
    if (s.phase !== 'running' || s.scheduler.phase === 'crossing' || s.sectorCaptured || s.endless) return;
    if (s.scheduler.waveIndex < CONFIG.crossing.captureAfterWaves) return;
    const zone = CONFIG.crossing.captureZone;
    const defenders = this.livingFriendlies().filter((unit) => dist(unit.pos, zone) <= CONFIG.crossing.captureRadius);
    const contested = s.units.some((unit) => unit.team === 'enemy' && unit.health > 0 && dist(unit.pos, zone) <= CONFIG.crossing.captureRadius);
    if (defenders.length >= CONFIG.crossing.captureMinSoldiers && !contested) {
      s.captureTicks = Math.min(sec(CONFIG.crossing.captureSeconds), s.captureTicks + 1);
      if (s.captureTicks >= sec(CONFIG.crossing.captureSeconds)) {
        s.sectorCaptured = true;
        this.emit({ type: 'sectorCaptured' });
      } else if (s.ticks % CONFIG.tickRate === 0) {
        this.emit({ type: 'sectorCaptureProgress', ticks: s.captureTicks, total: sec(CONFIG.crossing.captureSeconds) });
      }
    } else {
      s.captureTicks = Math.max(0, s.captureTicks - 2);
    }
  }

  private updateSmoke(): void {
    const clouds = this.state.smokes;
    for (let i = clouds.length - 1; i >= 0; i--) {
      clouds[i]!.ticksRemaining--;
      if (clouds[i]!.ticksRemaining <= 0) clouds.splice(i, 1);
    }
  }

  private smokeAssaultEligible(unit: Unit | undefined): unit is Unit {
    return !!unit && unit.team === 'enemy' && (unit.role === 'rifle' || unit.role === 'assault')
      && !unit.tankCrew && !unit.dead && !unit.crossed && !unit.pinned && !unit.buildingPosition
      && unit.health > this.content.enemy[unit.role].health * .35
      && unit.suppression < CONFIG.suppression.pinThreshold && unit.morale > CONFIG.morale.rattledThreshold;
  }

  /** Coordinate before target acquisition, so smoke blocks both teams on the same tick. */
  private updateEnemySmokeAssaults(): void {
    const s = this.state, tuning = CONFIG.enemy.smokeAssault;
    const plans = s.enemySmokeAssaults ??= [];
    for (let i = plans.length - 1; i >= 0; i--) {
      const plan = plans[i]!;
      plan.unitIds = plan.unitIds.filter((id) => this.smokeAssaultEligible(this.findUnit(id)));
      if (s.ticks >= plan.endTick || (plan.deployed && plan.unitIds.length === 0)) { plans.splice(i, 1); continue; }
      if (plan.deployed) continue;
      const leader = this.findUnit(plan.leaderId);
      if (!this.smokeAssaultEligible(leader) || (leader.smokeGrenades ?? 0) <= 0 || plan.unitIds.length < tuning.minSquadSize) {
        plans.splice(i, 1); this.emit({ type: 'enemySmokeAssaultCancelled', unitId: plan.leaderId }); continue;
      }
      if (s.ticks < plan.deployTick) continue;
      leader.smokeGrenades = (leader.smokeGrenades ?? 0) - 1;
      plan.deployed = true;
      s.smokes.push({ id: plan.id, pos: { ...plan.pos }, radius: CONFIG.smoke.radius, ticksRemaining: plan.endTick - s.ticks + 1 });
      this.emit({ type: 'enemySmokeAssaultDeployed', unitId: leader.id, pos: { ...plan.pos }, ticks: sec(CONFIG.smoke.durationSeconds) });
    }
    if (this.isCrossing || (!s.endless && s.scheduler.waveIndex + 1 < tuning.startWave)) return;
    const assigned = new Set(plans.flatMap((plan) => plan.unitIds));
    const infantry = s.units.filter((unit) => this.smokeAssaultEligible(unit));
    for (const leader of infantry) {
      if (leader.role !== 'assault' || (leader.smokeGrenades ?? 0) <= 0 || assigned.has(leader.id)) continue;
      const squad = infantry.filter((unit) => !assigned.has(unit.id) && dist(unit.pos, leader.pos) <= tuning.squadRadius);
      if (squad.length < tuning.minSquadSize) continue;
      const sightWeapon = this.content.weapons.enemy_rifle!;
      const target = this.livingFriendlies().filter((unit) => unit.pos.y > leader.pos.y
        && dist(unit.pos, leader.pos) >= tuning.minTargetRange && dist(unit.pos, leader.pos) <= tuning.maxTargetRange
        && (unit.specialization !== 'camouflage' || dist(unit.pos, leader.pos) <= sightWeapon.range * CONFIG.specialization.camouflageRangeMult
          || nightContactFor(s, leader, unit) !== undefined)
        && targetIsValid(this.content, s.terrain, s.sandbags, leader, unit, sightWeapon, CONFIG, s.trenches, s.smokes,
          (candidate) => this.visibilityMultiplierFor(leader, candidate)))
        .sort((a, b) => dist(leader.pos, a.pos) - dist(leader.pos, b.pos) || a.id - b.id)[0];
      if (!target) continue;
      const pos = { x: leader.pos.x + (target.pos.x - leader.pos.x) * .55, y: leader.pos.y + (target.pos.y - leader.pos.y) * .55 };
      const goal = nearestOpenCell(s.terrain, { x: pos.x, y: Math.min(CONFIG.breakthroughY + 8, pos.y + CONFIG.smoke.radius + s.terrain.cell) }, 3);
      if (!goal || !this.findEnemyPath(leader.pos, goal, leader).reachable) continue;
      const deployTick = s.ticks + sec(tuning.warningSeconds);
      plans.push({ id: s.nextEntityId++, leaderId: leader.id, unitIds: squad.map((unit) => unit.id), pos, deployTick,
        endTick: deployTick + sec(CONFIG.smoke.durationSeconds), deployed: false });
      for (const unit of squad) assigned.add(unit.id);
      this.emit({ type: 'enemySmokeAssaultWarned', unitId: leader.id, pos: { ...pos }, deployTick });
    }
  }

  private advanceUnderSmoke(unit: Unit): boolean {
    if (!this.smokeAssaultEligible(unit)) return false;
    const plan = this.state.enemySmokeAssaults?.find((plan) => plan.unitIds.includes(unit.id));
    if (!plan) return false;
    if (!plan.deployed) { unit.advance = false; unit.path = []; return true; }
    const goal = nearestOpenCell(this.state.terrain, {
      x: plan.pos.x + Math.max(-CONFIG.smoke.radius * .6, Math.min(CONFIG.smoke.radius * .6, unit.pos.x - plan.pos.x)),
      y: Math.min(CONFIG.breakthroughY + 8, plan.pos.y + CONFIG.smoke.radius + this.state.terrain.cell),
    }, 3);
    if (!goal || unit.pos.y >= goal.y - this.state.terrain.cell * .5) return false;
    if (!unit.path.length || !unit.moveGoal || dist(unit.moveGoal, goal) > this.state.terrain.cell) {
      const route = this.findEnemyPath(unit.pos, goal, unit);
      if (!route.reachable) return false;
      unit.path = route.waypoints; unit.moveGoal = goal;
    }
    unit.advance = true;
    return true;
  }

  private updateCampfires(): void {
    if (!dayNightAtTick(this.state.ticks, this.state.dayNightStartTick).night) {
      this.state.campfires = [];
      return;
    }
    for (const fire of this.state.campfires) fire.ticksRemaining--;
    this.state.campfires = this.state.campfires.filter((fire) => fire.ticksRemaining > 0);
  }

  private updateFlares(): void {
    const flares = this.state.flares;
    for (let i = flares.length - 1; i >= 0; i--) {
      const flare = flares[i]!;
      if ((flare.pendingTicksRemaining ?? 0) > 0) {
        flare.pendingTicksRemaining!--;
        if (flare.pendingTicksRemaining === 0) {
          this.emit({ type: 'flareDeployed', pos: flare.pos, radius: flare.radius, ticks: flare.ticksRemaining });
        }
        continue;
      }
      flare.ticksRemaining--;
      if (flare.ticksRemaining <= 0) flares.splice(i, 1);
    }
  }

  /**
   * Put the crossed soldiers back on the field in the southern assembly area,
   * clear of the deployment zone so the arrival formation never fights the
   * player's own placement. Terrain is generated fresh, so each slot is snapped
   * to open ground.
   */
  private deployArrivals(squad: readonly Unit[]): void {
    const slots = this.arrivalFormation(squad.length);
    squad.forEach((unit, index) => {
      const slot = slots[index] ?? { x: CONFIG.field.width / 2, y: CONFIG.assembly.endY };
      const snapped = nearestOpenCell(this.state.terrain, slot, 4) ?? slot;
      unit.pos = { x: snapped.x, y: snapped.y };
      unit.prevPos = { x: snapped.x, y: snapped.y };
      unit.dead = false;
      // Back on the order of battle: the crossing flag is the opposite of "is on
      // the field", so it is cleared here and nowhere else.
      unit.crossed = false;
      delete unit.buildingPosition;
      delete unit.buildingOrder;
      delete unit.bridgePosition;
      delete unit.nightContacts;
      delete unit.heardGunfire;
      delete unit.gunfirePursuit;
      delete unit.patrol;
      delete unit.ambush;
      delete unit.dodgingStrike;
      unit.suppression = 0;
      delete unit.medicalTargetId;
      delete unit.supplyTargetId;
      unit.pinned = false;
      unit.running = false; unit.movementPace = 'walk';
      unit.morale = Math.max(unit.morale, CONFIG.morale.initial);
      unit.path = [];
      unit.moveGoal = null;
      unit.targetId = null;
      unit.burstRemaining = 0;
      unit.reloadTimer = sec(0.5);
      // Restock ammunition to the role's starting loadout for the new map.
      unit.grenades = this.content.friendly[unit.role as FriendlyRole]?.grenades ?? 0;
      unit.rockets = this.content.friendly[unit.role as FriendlyRole]?.rockets ?? 0;
      unit.mortarBombs = this.content.friendly[unit.role as FriendlyRole]?.mortarBombs ?? 0;
      unit.grenadeTimer = 0;
      // Arriving on a new map with the weapon already reassembled: the work was
      // done during the march, and a fresh battlefield is no place to finish it.
      unit.upgradeTimer = 0;
      delete unit.autoMedicCallAfter;
      delete unit.autoSupplyCallAfter;
      unit.advance = false;
      unit.firePauseTicks = 0;
      unit.firePauseGate = true;
      this.state.units.push(unit);
      this.emit({ type: 'unitSpawned', unitId: unit.id, team: 'friendly', role: unit.role, pos: { ...unit.pos } });
    });
  }

  /** Column-major slots centred on the field, working north from the assembly end. */
  private arrivalFormation(count: number): Vec2[] {
    const { columns, rowSpacing } = CONFIG.crossing;
    const { startY, endY, spacing } = CONFIG.assembly;
    const centre = CONFIG.field.width / 2;
    const perRow = Math.max(1, Math.floor(columns));
    const gridRows = Math.max(1, Math.floor((endY - startY) / rowSpacing) + 1);
    const slots: Vec2[] = [];
    for (let index = 0; index < count && slots.length < perRow * gridRows; index++) {
      const row = Math.floor(index / perRow);
      const column = index % perRow;
      const x = centre + (column - (perRow - 1) / 2) * spacing;
      slots.push({
        x: Math.max(12, Math.min(CONFIG.field.width - 12, x)),
        y: endY - row * rowSpacing,
      });
    }
    // A squad larger than the assembly area holds re-forms in rows from the north
    // edge of that area rather than dropping anyone off the map.
    for (let index = slots.length; index < count; index++) {
      const row = index - perRow * gridRows;
      const column = index % perRow;
      slots.push({
        x: Math.max(12, Math.min(CONFIG.field.width - 12, centre + (column - (perRow - 1) / 2) * spacing)),
        y: Math.max(12, startY + (row % 4) * rowSpacing),
      });
    }
    return slots;
  }

  private emit(event: SimEvent): void {
    this.pendingEvents.push(event);
  }

  /**
   * Drain the events produced since the last call. A single-slot buffer would be
   * simpler, but an event can be emitted outside a tick - an Axis fire mission
   * scheduled by a support path or a test can be raised between steps - and it
   * must survive until the UI consumes it rather than being cleared by the next
   * step. Draining, rather than resetting at the top of `step`, is what makes
   * that safe; a caller that never reads the queue is bounded by the emission
   * sites, none of which run per-unit per-tick.
   */
  private drainEvents(): SimEvent[] {
    if (this.pendingEvents.length === 0) return [];
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  // ---------------------------------------------------------------- orders

  /** Validate and execute a gameplay command. Never mutates on rejection. */
  command(cmd: Command): CommandResult {
    if (this.paused) return { ok: false, reason: 'Paused - orders are not accepted while paused.' };
    if (this.state.phase !== 'running') return { ok: false, reason: 'The battle is over.' };
    switch (cmd.type) {
      case 'callGrenadeSupplies':
        return this.commandCallSupplies(cmd.unitId, this.findUnit(cmd.unitId)?.role === 'engineer' ? 'engineer' : 'rifleman');
      case 'callRocketSupplies':
        return this.commandCallSupplies(cmd.unitId, 'at');
      case 'callMortarSupplies':
        return this.commandCallSupplies(cmd.unitId, 'mortarman');
      case 'callMedic':
        return this.commandCallMedic(cmd.unitId);
      case 'garrison':
        return this.commandGarrison(cmd.unitIds, cmd.buildingId, cmd.level, cmd.facing);
      case 'leaveBuilding': {
        const units = this.state.units.filter((u) => cmd.unitIds.includes(u.id) && u.team === 'friendly' && u.health > 0 && !u.dead && !u.crossed && !u.pinned);
        let left = false;
        for (const unit of units) left = this.leaveBuilding(unit) || left;
        return left ? { ok: true } : { ok: false, reason: 'Select an unpinned building occupant.' };
      }
      case 'move':
        return this.commandMove(cmd.unitId, cmd.pos);
      case 'patrol':
        return this.commandPatrol(cmd.unitIds, cmd.from, cmd.to);
      case 'stopPatrol': {
        let stopped = false;
        for (const unit of this.state.units) {
          if (unit.team !== 'friendly' || !cmd.unitIds.includes(unit.id) || !unit.patrol) continue;
          delete unit.patrol;
          delete unit.dodgingStrike;
          unit.path = []; unit.moveGoal = null; unit.running = false; unit.movementPace = 'walk';
          stopped = true;
        }
        return stopped ? { ok: true } : { ok: false, reason: 'Select a patrolling rifleman, sniper, or medic.' };
      }
      case 'moveGroup':
        return this.commandMoveGroup(cmd.unitIds, cmd.pos);
      case 'recruit':
        return this.commandRecruit(cmd.role, cmd.pos);
      case 'barbedWire':
        return this.placeBarbedWire(cmd.pos);
      case 'sandbag':
        return this.commandSandbag(cmd.pos);
      case 'trench':
        return this.commandTrench(cmd.pos);
      case 'bunker':
        return this.commandBunker(cmd.pos);
      case 'mortarPit':
        return this.commandMortarPit(cmd.pos);
      case 'bridge':
        return this.commandBridge(cmd.pos);
      case 'mine':
        return this.commandMine(cmd.kind, cmd.pos);
      case 'artillery':
        return this.commandArtillery(cmd.pos);
      case 'airSupport':
        return this.commandAirSupport(cmd.pos);
      case 'flare':
        return this.commandFlare(cmd.pos);
      case 'foodSupplies':
        return this.commandFoodSupplies();
      case 'smoke':
        return this.commandSmoke(cmd.unitId, cmd.pos);
      case 'satchel':
        return this.commandSatchel(cmd.unitId, cmd.pos);
      case 'lightFire':
        return this.commandLightFire(cmd.unitId);
      case 'ambush':
        return this.commandAmbush(cmd.unitIds, cmd.aim, cmd.arcDegrees);
      case 'cancelAmbush':
        return this.commandCancelAmbush(cmd.unitIds);
      case 'fireOrder':
        return this.commandFireOrder(cmd.unitIds, cmd.order);
      case 'headlights':
        return this.commandHeadlights(cmd.unitIds, cmd.on);
      case 'posture':
        return this.commandPosture(cmd.unitIds, cmd.stance, cmd.crawling);
      case 'pace':
        return this.commandPace(cmd.unitIds, cmd.pace);
      case 'specialization':
        return this.commandSpecialization(cmd.unitId, cmd.specialization);
    }
  }

  private findUnit(id: number): Unit | undefined {
    return this.state.units.find((u) => u.id === id);
  }

  private needsMedic(patient: Unit | undefined): patient is Unit {
    return !!patient && patient.team === 'friendly' && !patient.dead && !patient.crossed
      && patient.health > 0 && patient.health < this.maxHealthOf(patient);
  }

  private supportInRange(medic: Unit, patient: Unit, range: number): boolean {
    const height = (u: Unit) => elevationAt(this.state.terrain, u.pos.x, u.pos.y) + unitBuildingHeight(this.state.terrain, u);
    if (patient.buildingOrder || ((medic.buildingPosition || patient.buildingPosition || medic.bridgePosition || patient.bridgePosition)
      && Math.abs(height(medic) - height(patient)) > 2)) return false;
    const sameFloor = medic.buildingPosition && patient.buildingPosition
      && medic.buildingPosition.buildingId === patient.buildingPosition.buildingId;
    return !!sameFloor || dist(medic.pos, patient.pos) <= range;
  }

  private medicCanTreat(medic: Unit, patient: Unit): boolean {
    return this.supportInRange(medic, patient, this.content.friendly.medic.heal!.range
      * (medic.specialization === 'fieldMedic' ? CONFIG.specialization.healRangeMult : 1));
  }

  private routeMedic(medic: Unit, patient: Unit): boolean {
    return this.routeSupport(medic, patient, this.content.friendly.medic.heal!.range
      * (medic.specialization === 'fieldMedic' ? CONFIG.specialization.healRangeMult : 1));
  }

  private routeSupport(medic: Unit, patient: Unit, range: number): boolean {
    if (this.supportInRange(medic, patient, range)) {
      this.cancelGunfireOrder(medic);
      delete medic.patrol;
      delete medic.dodgingStrike;
      delete medic.buildingOrder;
      medic.path = []; medic.moveGoal = null; medic.running = false;
      return true;
    }
    const position = patient.buildingOrder ?? patient.buildingPosition;
    if (position) {
      const building = this.state.buildings.find((b) => b.id === position.buildingId && !b.destroyed);
      return !!building && this.assignBuildingPosition(medic, building, position.level, undefined, true);
    }
    return this.commandMove(medic.id, patient.pos, true).ok;
  }

  private commandCallMedic(unitId: number): CommandResult {
    const patient = this.findUnit(unitId);
    if (!this.needsMedic(patient)) return { ok: false, reason: 'That soldier does not need medical attention.' };
    if (this.state.medicalQueue?.includes(unitId) || this.state.units.some((u) => u.role === 'medic' && !u.dead && !u.crossed && u.health > 0 && u.medicalTargetId === unitId)) {
      return { ok: false, reason: 'A medic is already attending that soldier.' };
    }
    if (!this.state.units.some((u) => u.team === 'friendly' && u.role === 'medic' && u.id !== unitId && !u.dead && !u.crossed && u.health > 0)) {
      return { ok: false, reason: 'No medic available. Recruit a medic first.' };
    }
    (this.state.medicalQueue ??= []).push(unitId);
    this.updateMedicalQueue();
    return { ok: true };
  }

  /** Veterans use the same FIFO calls as the player, without replacing existing requests. */
  private updateAutomaticSupportRequests(): void {
    const s = this.state, tuning = CONFIG.automaticSupport;
    if (s.phase !== 'running' || this.isCrossing) return;
    for (const unit of s.units) {
      if (unit.team !== 'friendly' || unit.dead || unit.crossed || unit.health <= 0
        || isVehicle(this.content, unit) || unit.xp < tuning.unlockXp) continue;
      if (this.needsMedic(unit) && s.ticks >= (unit.autoMedicCallAfter ?? 0) && this.commandCallMedic(unit.id).ok) {
        unit.autoMedicCallAfter = s.ticks + sec(tuning.retrySeconds);
        this.emit({ type: 'automaticSupportRequested', unitId: unit.id, kind: 'medic' });
      }
      const empty = unit.role === 'at' ? (unit.rockets ?? this.content.friendly.at.rockets ?? 0) <= 0
        : unit.role === 'mortarman' ? (unit.mortarBombs ?? this.content.friendly.mortarman.mortarBombs ?? 0) <= 0
        : (unit.role === 'rifleman' || unit.role === 'engineer') && unit.grenades <= 0;
      if (empty && s.ticks >= (unit.autoSupplyCallAfter ?? 0)
        && (unit.role === 'rifleman' || unit.role === 'engineer' || unit.role === 'at' || unit.role === 'mortarman')
        && this.commandCallSupplies(unit.id, unit.role).ok) {
        unit.autoSupplyCallAfter = s.ticks + sec(tuning.retrySeconds);
        this.emit({ type: 'automaticSupportRequested', unitId: unit.id,
          kind: unit.role === 'at' ? 'rockets' : unit.role === 'mortarman' ? 'mortarBombs' : 'grenades' });
      }
    }
  }

  /** A player's replacement order cancels the unit's current support call. */
  private cancelSupportRequest(medic: Unit): void {
    if (medic.medicalTargetId !== undefined) {
      const patient = this.findUnit(medic.medicalTargetId);
      if (patient && patient.xp >= CONFIG.automaticSupport.unlockXp) patient.autoMedicCallAfter = this.state.ticks + sec(CONFIG.automaticSupport.retrySeconds);
      this.state.medicalQueue = this.state.medicalQueue?.filter((id) => id !== medic.medicalTargetId);
      delete medic.medicalTargetId;
    }
    if (medic.supplyTargetId !== undefined) {
      const recipient = this.findUnit(medic.supplyTargetId);
      if (recipient && recipient.xp >= CONFIG.automaticSupport.unlockXp) recipient.autoSupplyCallAfter = this.state.ticks + sec(CONFIG.automaticSupport.retrySeconds);
      this.state.grenadeSupplyQueue = this.state.grenadeSupplyQueue?.filter((id) => id !== medic.supplyTargetId);
      delete medic.supplyTargetId;
    }
  }

  private needsSupplies(unit: Unit | undefined): unit is Unit {
    return !!unit && unit.team === 'friendly' && !unit.dead && !unit.crossed && unit.health > 0
      && (((unit.role === 'rifleman' || unit.role === 'engineer') && unit.grenades < (this.content.friendly[unit.role].grenades ?? 0))
        || (unit.role === 'at' && (unit.rockets ?? this.content.friendly.at.rockets ?? 0) < (this.content.friendly.at.rockets ?? 0))
        || (unit.role === 'mortarman' && (unit.mortarBombs ?? this.content.friendly.mortarman.mortarBombs ?? 0) < (this.content.friendly.mortarman.mortarBombs ?? 0)));
  }

  private commandCallSupplies(unitId: number, role: 'rifleman' | 'engineer' | 'at' | 'mortarman'): CommandResult {
    const recipient = this.findUnit(unitId);
    if (recipient?.role !== role || !this.needsSupplies(recipient)) return { ok: false, reason: role === 'mortarman' ? 'Select a mortarman who needs bombs.' : role === 'at' ? 'Select an anti-tank soldier who needs rockets.' : 'Select a rifleman or engineer who needs grenades.' };
    if (this.state.grenadeSupplyQueue?.includes(unitId)) return { ok: false, reason: 'Ammunition supplies have already been requested.' };
    if (!this.state.units.some((u) => u.team === 'friendly' && u.role === 'supply_officer' && !u.dead && !u.crossed && u.health > 0)) {
      return { ok: false, reason: 'No Supply Officer available. Recruit one first.' };
    }
    (this.state.grenadeSupplyQueue ??= []).push(unitId);
    this.updateGrenadeSupplyQueue();
    return { ok: true };
  }

  private updateGrenadeSupplyQueue(): void {
    this.state.grenadeSupplyQueue = (this.state.grenadeSupplyQueue ?? []).filter((id) => this.needsSupplies(this.findUnit(id)));
    const officers = this.state.units.filter((u) => u.team === 'friendly' && u.role === 'supply_officer' && !u.dead && !u.crossed && u.health > 0);
    for (const officer of officers) {
      if (officer.supplyTargetId !== undefined && !this.needsSupplies(this.findUnit(officer.supplyTargetId))) {
        delete officer.supplyTargetId; delete officer.buildingOrder;
        officer.path = []; officer.moveGoal = null; officer.running = false;
      }
    }
    for (const id of this.state.grenadeSupplyQueue) {
      if (officers.some((u) => u.supplyTargetId === id)) continue;
      const recipient = this.findUnit(id)!;
      const available = officers.filter((u) => !u.pinned && u.supplyTargetId === undefined)
        .sort((a, b) => dist(a.pos, recipient.pos) - dist(b.pos, recipient.pos) || a.id - b.id);
      const dispatched = available.find((u) => this.routeSupport(u, recipient, CONFIG.grenadeSupplies.range));
      if (!dispatched) break;
      dispatched.supplyTargetId = id;
    }
  }

  private supplyBehavior(officer: Unit): void {
    if (officer.supplyTargetId === undefined || officer.pinned) return;
    const recipient = this.findUnit(officer.supplyTargetId);
    if (!this.needsSupplies(recipient)) return;
    if (!this.supportInRange(officer, recipient, CONFIG.grenadeSupplies.range)) {
      if (!officer.path.length || !officer.moveGoal || dist(officer.moveGoal, recipient.pos) > this.state.terrain.cell) {
        if (!this.routeSupport(officer, recipient, CONFIG.grenadeSupplies.range)) {
          delete officer.supplyTargetId;
          officer.path = []; officer.moveGoal = null;
        }
      }
      return;
    }
    officer.path = []; officer.moveGoal = null; officer.running = false;
    const rockets = recipient.role === 'at';
    const mortar = recipient.role === 'mortarman';
    const amount = mortar ? (this.content.friendly.mortarman.mortarBombs ?? 0) - (recipient.mortarBombs ?? 0)
      : rockets ? (this.content.friendly.at.rockets ?? 0) - (recipient.rockets ?? 0)
      : (this.content.friendly[recipient.role as FriendlyRole].grenades ?? 0) - recipient.grenades;
    if (mortar) recipient.mortarBombs = (recipient.mortarBombs ?? 0) + amount;
    else if (rockets) recipient.rockets = (recipient.rockets ?? 0) + amount;
    else recipient.grenades += amount;
    this.cancelSupportRequest(officer);
    this.emit({ type: mortar ? 'mortarBombsResupplied' : rockets ? 'rocketsResupplied' : 'grenadesResupplied', officerId: officer.id, targetId: recipient.id, amount });
  }

  /** Dispatch in request order, independent of unit order or distance to later callers. */
  private updateMedicalQueue(): void {
    const queue = this.state.medicalQueue ?? [];
    this.state.medicalQueue = queue.filter((id) => this.needsMedic(this.findUnit(id)));
    const medics = this.state.units.filter((u) => u.team === 'friendly' && u.role === 'medic' && !u.dead && !u.crossed && u.health > 0);
    for (const medic of medics) {
      if (medic.medicalTargetId !== undefined && !this.needsMedic(this.findUnit(medic.medicalTargetId))) {
        delete medic.medicalTargetId; delete medic.buildingOrder;
        medic.path = []; medic.moveGoal = null; medic.running = false;
      }
    }
    for (const id of this.state.medicalQueue) {
      if (medics.some((u) => u.medicalTargetId === id)) continue;
      const patient = this.findUnit(id)!;
      const available = medics.filter((u) => u.id !== id && !u.pinned && u.medicalTargetId === undefined)
        .sort((a, b) => dist(a.pos, patient.pos) - dist(b.pos, patient.pos) || a.id - b.id);
      const dispatched = available.find((medic) => this.routeMedic(medic, patient));
      // Keep the oldest waiting call first even if a path is temporarily blocked.
      if (!dispatched) break;
      dispatched.medicalTargetId = id;
    }
  }

  /** Reachable ground at one of the four entrances, never inside the footprint. */
  private buildingEntrances(building: Building): Vec2[] {
    const cell = this.state.terrain.cell, w = building.cols * cell, h = building.rows * cell;
    return [
      { x: building.pos.x + w / 2, y: building.pos.y + h + cell / 2 },
      { x: building.pos.x + w / 2, y: building.pos.y - cell / 2 },
      { x: building.pos.x - cell / 2, y: building.pos.y + h / 2 },
      { x: building.pos.x + w + cell / 2, y: building.pos.y + h / 2 },
    ].map((p) => nearestOpenCell(this.state.terrain, p, 1))
      .filter((p): p is Vec2 => p !== null && !containsBuilding(building, p, cell));
  }

  private buildingExit(unit: Unit): Vec2 | null {
    if (!unit.buildingPosition) return null;
    const b = this.state.buildings.find((b) => b.id === unit.buildingPosition!.buildingId);
    return b ? this.buildingEntrances(b).sort((a, b) => dist(a, unit.pos) - dist(b, unit.pos))[0] ?? null : null;
  }

  private leaveBuilding(unit: Unit, preserveSupportRequest = false): boolean {
    if (unit.pinned) return false;
    if (!unit.buildingPosition && !unit.buildingOrder) return false;
    const exit = this.buildingExit(unit);
    if (unit.buildingPosition && exit === null) return false;
    if (exit) { unit.pos = { ...exit }; unit.prevPos = { ...exit }; }
    delete unit.buildingPosition;
    delete unit.buildingOrder;
    if (!preserveSupportRequest) this.cancelSupportRequest(unit);
    unit.buildingCooldown = sec(15);
    unit.path = [];
    unit.moveGoal = null;
    return true;
  }

  private commandGarrison(unitIds: readonly number[], buildingId: number, level: BuildingLevel, facing?: BuildingFacing, preserveSupportRequest = false): CommandResult {
    const building = this.state.buildings.find((b) => b.id === buildingId && !b.destroyed);
    if (!building || !buildingLevels(building).includes(level)) return { ok: false, reason: 'That floor, balcony, or rooftop is unavailable.' };
    if (facing !== undefined && (!BUILDING_FACINGS.includes(facing) || (level === 'balcony' && facing !== 'south'))) return { ok: false, reason: 'No fighting position faces that direction.' };
    let accepted = false;
    for (const id of new Set(unitIds)) {
      const unit = this.findUnit(id);
      if (!unit || unit.team !== 'friendly') continue;
      accepted = this.assignBuildingPosition(unit, building, level, facing, preserveSupportRequest) || accepted;
    }
    return accepted ? { ok: true } : { ok: false, reason: 'No free reachable position. Select unpinned infantry; vehicles stay outside and enemies must be cleared first.' };
  }

  private assignBuildingPosition(unit: Unit, building: Building, level: BuildingLevel, facing?: BuildingFacing, preserveSupportRequest = false): boolean {
    if (unit.dead || unit.health <= 0 || unit.crossed || unit.pinned || isVehicle(this.content, unit)) return false;
    if (this.state.constructionSites.some((site) => site.builderId === unit.id)) return false;
    if (this.state.units.some((u) => u.team !== unit.team && u.health > 0 && !u.dead
      && (u.buildingPosition?.buildingId === building.id || u.buildingOrder?.buildingId === building.id))) return false;
    const used = new Set(this.state.units.filter((u) => u.id !== unit.id && u.health > 0 && !u.dead).flatMap((u) =>
      [u.buildingPosition, u.buildingOrder].filter((p) => p?.buildingId === building.id && p.level === level).map((p) => p!.slot)));
    const slots = Array.from({ length: positionCapacity(level) }, (_, slot) => slot)
      .filter((slot) => !used.has(slot) && (facing === undefined || positionFacing({ level, slot }) === facing));
    if (!slots.length) return false;
    // Pick windows facing the enemy; roof positions use the same facade slots.
    const opposing = this.state.units.filter((u) => u.team !== unit.team && !u.dead && u.health > 0);
    const enemy = opposing.sort((a, b) => dist(a.pos, unit.pos) - dist(b.pos, unit.pos))[0];
    const aim = enemy?.pos ?? { x: unit.pos.x, y: unit.team === 'friendly' ? 0 : CONFIG.field.height };
    slots.sort((a, b) => dist(buildingSlot(building, { buildingId: building.id, level, slot: a }, this.state.terrain.cell), aim)
      - dist(buildingSlot(building, { buildingId: building.id, level, slot: b }, this.state.terrain.cell), aim));
    const position: BuildingPosition = { buildingId: building.id, level, slot: slots[0]! };
    const sameBuilding = unit.buildingPosition?.buildingId === building.id;
    let route: ReturnType<Simulation['findUnitPath']> | undefined;
    let entrance: Vec2 | undefined;
    if (!sameBuilding) {
      const start = this.buildingExit(unit) ?? unit.pos;
      for (const candidate of this.buildingEntrances(building).sort((a, b) => dist(a, start) - dist(b, start))) {
        const path = this.findUnitPath(unit, start, candidate);
        if (path.reachable) { route = path; entrance = candidate; break; }
      }
      if (!route || !entrance) return false;
      if ((unit.buildingPosition || unit.buildingOrder) && !this.leaveBuilding(unit, preserveSupportRequest)) return false;
    }
    const currentLevel = unit.buildingPosition?.level ?? 0;
    const oldLevel = typeof currentLevel === 'number' ? currentLevel : currentLevel === 'roof' ? buildingArchitecture(building).floors : 1;
    const targetLevel = typeof level === 'number' ? level : level === 'roof' ? buildingArchitecture(building).floors : 1;
    delete unit.patrol;
    delete unit.dodgingStrike;
    this.cancelGunfireOrder(unit);
    unit.buildingOrder = { ...position, climbTicks: sec(1 + Math.abs(targetLevel - oldLevel) * .8) };
    if (!preserveSupportRequest) this.cancelSupportRequest(unit);
    unit.path = route?.waypoints ?? [];
    unit.moveGoal = entrance ?? null;
    unit.burstRemaining = 0;
    return true;
  }

  /** Building orders own movement until arrival; climbing temporarily holds fire. */
  private updateBuildingOrder(unit: Unit): boolean {
    const order = unit.buildingOrder;
    if (!order) return false;
    const building = this.state.buildings.find((b) => b.id === order.buildingId && !b.destroyed);
    if (!building) { delete unit.buildingOrder; return false; }
    if (unit.pinned) return true;
    if (unit.moveGoal && dist(unit.pos, unit.moveGoal) > 2) {
      if (!unit.path.length) {
        const route = this.findUnitPath(unit, unit.pos, unit.moveGoal);
        if (!route.reachable) { delete unit.buildingOrder; unit.moveGoal = null; return false; }
        unit.path = route.waypoints;
      }
      this.advanceAlongPath(unit);
      return true;
    }
    if (--order.climbTicks > 0) return true;
    unit.buildingPosition = { buildingId: order.buildingId, level: order.level, slot: order.slot };
    unit.pos = buildingSlot(building, order, this.state.terrain.cell);
    unit.prevPos = { ...unit.pos };
    unit.moveGoal = null;
    unit.path = [];
    unit.terrainCrawling = false;
    delete unit.buildingOrder;
    return true;
  }

  private seekEnemyBuilding(unit: Unit): boolean {
    if (isVehicle(this.content, unit) || (unit.buildingCooldown ?? 0) > 0 || unit.id % 3 !== 0 || (this.state.ticks + unit.id) % 30 !== 0) return false;
    const threats = this.livingFriendlies();
    for (const building of [...this.state.buildings].filter((b) => !b.destroyed).sort((a, b) => dist(a.pos, unit.pos) - dist(b.pos, unit.pos))) {
      if (dist(building.pos, unit.pos) > 145) continue;
      const a = buildingArchitecture(building);
      const level = a.rooftopAccess && unit.id % 2 === 0 ? 'roof' : a.floors - 1;
      const point = buildingSlot(building, { buildingId: building.id, level, slot: 4 }, this.state.terrain.cell);
      if (!threats.some((u) => dist(u.pos, point) < (this.weaponOf(unit)?.range ?? 200))) continue;
      if (this.assignBuildingPosition(unit, building, level)) return true;
    }
    return false;
  }

  private commandPatrol(unitIds: readonly number[], from: Vec2, to: Vec2): CommandResult {
    const area = patrolArea(from, to);
    if (!validPatrolArea(area)) return { ok: false, reason: 'Mark an area at least 48 × 48 inside the battlefield.' };
    const selected = this.state.units.filter((unit) => unitIds.includes(unit.id) && unit.team === 'friendly' && isPatrolRole(unit.role)
      && !unit.dead && unit.health > 0 && !unit.crossed && !unit.pinned);
    if (!selected.length) return { ok: false, reason: 'Select an unpinned rifleman, sniper, or medic to patrol.' };
    const points = patrolPoints(this.state.terrain, area);
    if (!points) return { ok: false, reason: 'No connected patrol route inside that area. Mark more open ground.' };
    let accepted = false;
    for (const unit of selected) {
      const start = this.buildingExit(unit) ?? unit.pos;
      const stations = points.map((point, index) => ({ point, index })).sort((a, b) => dist(start, a.point) - dist(start, b.point) || a.index - b.index);
      for (const station of stations) {
        const route = insidePatrolArea(area, start)
          ? findPath(patrolTerrain(this.state.terrain, area), start, station.point, undefined, 'infantry', unit.bridgePosition)
          : this.findUnitPath(unit, start, station.point);
        if (!route.reachable) continue;
        if ((unit.buildingPosition || unit.buildingOrder) && !this.leaveBuilding(unit)) continue;
        unit.patrol = { area: structuredClone(area), points: structuredClone(points), nextPoint: station.index, retryTick: 0 };
        this.cancelSupportRequest(unit);
        this.cancelGunfireOrder(unit);
        delete unit.dodgingStrike;
        unit.path = route.waypoints; unit.moveGoal = { ...station.point };
        unit.movementPace = 'walk'; unit.running = false;
        this.emit({ type: 'moveOrdered', unitId: unit.id, pos: station.point });
        accepted = true;
        break;
      }
    }
    return accepted ? { ok: true } : { ok: false, reason: 'No route from the selected soldiers to that patrol area.' };
  }

  private updatePatrol(unit: Unit, target: Unit | null): void {
    const patrol = unit.patrol;
    if (!patrol || unit.pinned) return;
    // A patrol watches its assigned ground, stops to shoot, then resumes its leg.
    if (target) { unit.path = []; unit.running = false; return; }
    if (unit.path.length || this.state.ticks < patrol.retryTick) return;
    if (dist(unit.pos, patrol.points[patrol.nextPoint]!) <= 2) patrol.nextPoint = (patrol.nextPoint + 1) % patrol.points.length;
    const goal = patrol.points[patrol.nextPoint]!;
    const route = insidePatrolArea(patrol.area, unit.pos)
      ? findPath(patrolTerrain(this.state.terrain, patrol.area), unit.pos, goal, undefined, 'infantry', unit.bridgePosition)
      : this.findUnitPath(unit, unit.pos, goal);
    unit.moveGoal = { ...goal };
    if (route.reachable) unit.path = route.waypoints;
    else patrol.retryTick = this.state.ticks + CONFIG.tickRate;
  }

  private commandMove(unitId: number, pos: Vec2, preserveSupportRequest = false): CommandResult {
    const unit = this.findUnit(unitId);
    if (!unit || unit.team !== 'friendly') return { ok: false, reason: 'No such friendly unit.' };
    if (unit.health <= 0) return { ok: false, reason: 'That soldier is gone.' };
    // A soldier already walking off the north edge has left this map's chain of
    // command; the only order left for the squad is to follow him.
    if (unit.crossed === true) return { ok: false, reason: 'That soldier is already marching north to the next map.' };
    if (unit.pinned) return { ok: false, reason: 'Pinned - this unit cannot move until suppression drops.' };
    if (!this.inBounds(pos, 4)) return { ok: false, reason: 'Order is outside the battlefield.' };
    const building = this.state.buildings.find((b) => !b.destroyed && containsBuilding(b, pos, this.state.terrain.cell));
    if (building && !isVehicle(this.content, unit)) return this.commandGarrison([unitId], building.id, 0, undefined, preserveSupportRequest);
    const dest = nearestOpenCell(this.state.terrain, pos, 3);
    if (dest === null) return { ok: false, reason: 'No passable ground there.' };
    const start = this.buildingExit(unit) ?? unit.pos;
    const result = this.findUnitPath(unit, start, dest);
    if (!result.reachable) return { ok: false, reason: 'No route to that position.' };
    this.leaveBuilding(unit, preserveSupportRequest);
    delete unit.patrol;
    delete unit.dodgingStrike;
    this.cancelGunfireOrder(unit);
    unit.path = result.waypoints;
    unit.moveGoal = dest;
    if (!preserveSupportRequest) this.cancelSupportRequest(unit);
    this.emit({ type: 'moveOrdered', unitId: unit.id, pos: dest });
    return { ok: true };
  }

  /**
   * Move a whole selection. The ordered point is the centre of a formation, not
   * one shared destination: a squad stacked on a single tile spends the next few
   * seconds shoving itself apart instead of marching. Slots are handed out
   * nearest-first to the soldiers nearest the order, and a soldier skips a slot
   * it cannot actually reach, so a hedgerow through the middle of the formation
   * costs one soldier its place rather than the entire order.
   */
  private commandMoveGroup(unitIds: readonly number[], pos: Vec2): CommandResult {
    if (!this.inBounds(pos, 4)) return { ok: false, reason: 'Order is outside the battlefield.' };
    const building = this.state.buildings.find((b) => !b.destroyed && containsBuilding(b, pos, this.state.terrain.cell));
    if (building) return this.commandGarrison(unitIds, building.id, 0);
    const living = new Set(
      this.state.units.filter((u) => u.team === 'friendly' && u.health > 0 && !u.dead && u.crossed !== true).map((u) => u.id),
    );
    const selected = unitIds
      .filter((id, index) => living.has(id) && unitIds.indexOf(id) === index)
      .map((id) => this.findUnit(id))
      .filter((unit): unit is Unit => unit !== undefined);
    if (selected.length === 0) return { ok: false, reason: 'Select at least one soldier.' };

    // Resolve each slot to passable ground once; the result does not depend on
    // which soldier ends up taking it. Two slots can land on the same tile once
    // snapped - a spacing finer than the terrain cell, or a corner where slots
    // clamp together - and two soldiers sent to one tile would spend the march
    // shoving each other off it, so duplicates are dropped rather than shared.
    const snapped = this.formationSlots(pos, selected.length * 2 + 2)
      .map((slot) => nearestOpenCell(this.state.terrain, slot, 3))
      .filter((dest): dest is Vec2 => dest !== null);
    const slots: Vec2[] = [];
    const seenDest = new Set<string>();
    for (const dest of snapped) {
      const key = `${Math.round(dest.x)},${Math.round(dest.y)}`;
      if (seenDest.has(key)) continue;
      seenDest.add(key);
      slots.push(dest);
    }

    // Nearest soldier to the order takes the nearest slot, so the group keeps
    // the shape it was standing in instead of crossing over itself.
    const ordered = [...selected].sort(
      (a, b) => dist(a.pos, pos) - dist(b.pos, pos) || a.id - b.id,
    );

    let moved = 0;
    let refusal: string | null = null;
    const taken = new Set<number>();
    for (const unit of ordered) {
      if (unit.pinned) {
        if (refusal === null) refusal = 'Pinned - some soldiers cannot move until suppression drops.';
        continue;
      }
      for (let i = 0; i < slots.length; i++) {
        if (taken.has(i)) continue;
        const dest = slots[i] as Vec2;
        const route = this.findUnitPath(unit, this.buildingExit(unit) ?? unit.pos, dest);
        if (!route.reachable) continue;
        this.leaveBuilding(unit);
        delete unit.patrol;
        delete unit.dodgingStrike;
        this.cancelGunfireOrder(unit);
        taken.add(i);
        unit.path = route.waypoints;
        unit.moveGoal = dest;
        this.cancelSupportRequest(unit);
        this.emit({ type: 'moveOrdered', unitId: unit.id, pos: dest });
        moved += 1;
        break;
      }
    }
    if (moved === 0) return { ok: false, reason: refusal ?? 'No route to that position.' };
    return { ok: true };
  }

  /**
   * Square spiral of formation slots centred on the ordered point, nearest ring
   * first and in a fixed order, so the same order always resolves identically.
   * Slots are clamped to the battlefield and de-duplicated, or a formation
   * ordered into a corner would pile several soldiers onto one clamped point.
   */
  private formationSlots(centre: Vec2, count: number): Vec2[] {
    const spacing = CONFIG.formation.spacing;
    const slots: Vec2[] = [];
    const seen = new Set<string>();
    const rings = Math.max(2, Math.ceil(Math.sqrt(count)) + 2);
    const clamp = (v: number, max: number): number => Math.min(max - 6, Math.max(6, v));
    for (let ring = 0; ring <= rings && slots.length < count; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = clamp(centre.x + dx * spacing, CONFIG.field.width);
          const y = clamp(centre.y + dy * spacing, CONFIG.field.height);
          const key = `${Math.round(x)},${Math.round(y)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          slots.push({ x, y });
          if (slots.length >= count) break;
        }
        if (slots.length >= count) break;
      }
    }
    return slots;
  }

  private commandRecruit(role: FriendlyRole, pos: Vec2): CommandResult {
    const def = this.content.friendly[role];
    if (!def) return { ok: false, reason: 'Unknown role.' };
    const cost = CONFIG.costs.recruit[role];
    if (this.state.points < cost) return { ok: false, reason: `Not enough points for a ${def.label} (${cost}).` };
    const friendlies = this.livingFriendlies().length;
    if (friendlies >= CONFIG.caps.friendly) return { ok: false, reason: `Squad is at capacity (${CONFIG.caps.friendly}).` };
    if (pos.x < 8 || pos.x > CONFIG.field.width - 8) return { ok: false, reason: 'Deploy inside the battlefield.' };
    if (pos.y < CONFIG.deploymentZone.yMin || pos.y > CONFIG.deploymentZone.yMax) {
      return { ok: false, reason: 'Deploy in the southern zone.' };
    }
    const dest = nearestOpenCell(this.state.terrain, pos, 2);
    if (dest === null || dest.y < CONFIG.deploymentZone.yMin) return { ok: false, reason: 'No room to deploy there.' };
    this.state.points -= cost;
    this.spawnFriendly(role, dest);
    return { ok: true };
  }

  private commandSandbag(pos: Vec2): CommandResult {
    const engineerError = this.engineerRequirementError(pos);
    if (engineerError !== null) return { ok: false, reason: engineerError };
    if (this.state.points < CONFIG.costs.sandbag) return { ok: false, reason: `Sandbags cost ${CONFIG.costs.sandbag} points.` };
    if (!this.inBounds(pos, 10)) return { ok: false, reason: 'Place sandbags inside the battlefield.' };
    if (pos.y < CONFIG.terrain.protectedTopRows * CONFIG.terrain.cell + 8) {
      return { ok: false, reason: 'Too close to the enemy approach.' };
    }
    for (const bag of this.state.sandbags) {
      if (dist(bag.pos, pos) < CONFIG.sandbagMinSpacing) return { ok: false, reason: 'Too close to another sandbag.' };
    }
    if (this.state.trenches.some((trench) => dist(trench.pos, pos) < CONFIG.trench.halfLength + 12)) {
      return { ok: false, reason: 'Too close to a trench.' };
    }
    if (this.state.bunkers.some((bunker) => dist(bunker.pos, pos) < CONFIG.bunker.occupyRadius + 12)) return { ok: false, reason: 'Too close to a bunker.' };
    if (this.state.mortarPits.some((pit) => dist(pit.pos, pos) < CONFIG.mortarPit.occupyRadius + 12)) return { ok: false, reason: 'Too close to a mortar pit.' };
    if (this.state.constructionSites.some((site) => this.constructionOverlap(site, 'sandbag', pos))) {
      return { ok: false, reason: 'Too close to another construction site.' };
    }
    const builder = this.nearestAvailableEngineer(pos);
    if (builder === null) return { ok: false, reason: engineerError ?? 'No available engineer nearby.' };
    this.state.points -= CONFIG.costs.sandbag;
    this.startConstruction('sandbag', pos, builder.id);
    return { ok: true };
  }

  private commandTrench(pos: Vec2): CommandResult {
    const reason = this.trenchPlacementError(pos);
    if (reason !== null) return { ok: false, reason };
    const builder = this.nearestAvailableEngineer(pos);
    if (builder === null) return { ok: false, reason: 'No available engineer nearby.' };
    this.state.points -= CONFIG.costs.trench;
    this.startConstruction('trench', pos, builder.id);
    return { ok: true };
  }

  private commandBunker(pos: Vec2): CommandResult {
    const reason = this.bunkerPlacementError(pos);
    if (reason !== null) return { ok: false, reason };
    const builder = this.nearestAvailableEngineer(pos);
    if (builder === null) return { ok: false, reason: 'No available engineer nearby.' };
    this.state.points -= CONFIG.costs.bunker;
    this.startConstruction('bunker', pos, builder.id);
    return { ok: true };
  }

  private commandMortarPit(pos: Vec2): CommandResult {
    const reason = this.mortarPitPlacementError(pos);
    if (reason !== null) return { ok: false, reason };
    const builder = this.nearestAvailableEngineer(pos);
    if (builder === null) return { ok: false, reason: 'No available engineer nearby.' };
    this.state.points -= CONFIG.costs.mortarPit;
    this.startConstruction('mortarPit', pos, builder.id);
    return { ok: true };
  }

  private commandBridge(pos: Vec2): CommandResult {
    const reason = this.bridgePlacementError(pos);
    if (reason !== null) return { ok: false, reason };
    const builder = this.nearestAvailableEngineer(pos);
    if (builder === null) return { ok: false, reason: 'No available engineer nearby.' };
    this.state.points -= CONFIG.costs.bridge;
    this.startConstruction('bridge', pos, builder.id);
    return { ok: true };
  }

  bridgeShapeAt(pos: Vec2): Pick<BuiltBridge, 'axis' | 'halfWidth' | 'halfLength'> | null {
    const river = this.zones.river;
    if (river === null || !isRiverAt(this.zones, this.state.seed, pos.x, pos.y)) return null;
    const axis = river.orientation === 'vertical' ? 'horizontal' : 'vertical';
    const halfLength = riverHalfWidthAtPoint(river, this.state.seed, pos.x, pos.y) * (river.orientation === 'diagonal' ? Math.SQRT2 : 1) + 12;
    return { axis, halfWidth: 17, halfLength };
  }

  private bridgePlacementError(pos: Vec2): string | null {
    const s = this.state;
    const engineerError = this.engineerRequirementError(pos);
    if (engineerError !== null) return engineerError;
    if (s.points < CONFIG.costs.bridge) return `Bridges cost ${CONFIG.costs.bridge} points.`;
    if (!this.inBounds(pos, 24)) return 'Place the bridge inside the battlefield.';
    const shape = this.bridgeShapeAt(pos);
    if (shape === null) return 'Place the bridge across a river.';
    if (isBridgeAt(this.zones, s.seed, pos.x, pos.y)) return 'A bridge already crosses here.';
    if (s.builtBridges.some((bridge) => dist(bridge.pos, pos) < Math.max(bridge.halfLength, shape.halfLength) + 24)) return 'Too close to another bridge.';
    if (s.constructionSites.some((site) => site.kind === 'bridge' && dist(site.pos, pos) < shape.halfLength + 24)) return 'Too close to another bridge site.';
    return null;
  }

  private barbedWirePlacementError(pos: Vec2): string | null {
    const s = this.state, tuning = CONFIG.barbedWire;
    const engineerError = this.engineerRequirementError(pos);
    if (engineerError !== null) return engineerError;
    if (s.points < CONFIG.costs.barbedWire) return `Barbed wire costs ${CONFIG.costs.barbedWire} points.`;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x < tuning.halfLength + 2
      || pos.x > CONFIG.field.width - tuning.halfLength - 2 || pos.y < CONFIG.terrain.protectedTopRows * s.terrain.cell + tuning.halfDepth
      || pos.y > CONFIG.field.height - tuning.halfDepth - 2) return 'Place the entire wire segment inside the battlefield, away from the enemy approach.';
    // Check the entire footprint, including its north and south edges.
    for (let x = -tuning.halfLength; x <= tuning.halfLength; x += 6) for (const y of [-tuning.halfDepth, 0, tuning.halfDepth]) {
      const point = { x: pos.x + x, y: pos.y + y };
      if (this.isSolid(point.x, point.y) || isRiverAt(this.zones, s.seed, point.x, point.y)
        || isBridgeAt(this.zones, s.seed, point.x, point.y)) return 'Build barbed wire on open, dry ground.';
    }
    if (s.barbedWire.some((wire) => Math.abs(wire.pos.x - pos.x) < tuning.halfLength * 2 + 2
      && Math.abs(wire.pos.y - pos.y) < tuning.halfDepth * 2 + 4)) return 'Too close to another wire segment. Leave a gap for a clear lane.';
    if (s.constructionSites.some((site) => this.constructionOverlap(site, 'barbedWire', pos))) return 'Too close to another construction site.';
    return null;
  }

  private placeBarbedWire(pos: Vec2): CommandResult {
    const reason = this.barbedWirePlacementError(pos);
    if (reason !== null) return { ok: false, reason };
    const builder = this.nearestAvailableEngineer(pos)!;
    this.state.points -= CONFIG.costs.barbedWire;
    this.startConstruction('barbedWire', pos, builder.id);
    this.emit({ type: 'wireConstructionStarted', pos: { ...pos } });
    return { ok: true };
  }

  /** New wire and newly cut lanes must affect existing orders as well as new ones. */
  private rerouteForWire(): void {
    for (const unit of this.state.units) {
      if (unit.health <= 0 || unit.dead || unit.crossed || unit.buildingPosition || unit.buildingOrder
        || isVehicle(this.content, unit) || !unit.moveGoal || unit.path.length === 0) continue;
      const route = unit.team === 'enemy' ? this.findEnemyPath(unit.pos, unit.moveGoal, unit)
        : this.findUnitPath(unit, unit.pos, unit.moveGoal);
      if (route.reachable) unit.path = route.waypoints;
    }
  }

  /** Cutters expose themselves at the wire and cannot shoot while working. */
  /** Spawn a specialist and two escorts atomically, including their cap reservation. */
  spawnEnemySapperTeam(at?: Vec2): boolean {
    const occupied = this.state.units.filter((unit) => unit.team === 'enemy' && unit.health > 0 && !unit.dead)
      .reduce((count, unit) => count + 1 + (unit.transport?.passengers ?? 0), 0);
    if (occupied + 3 > CONFIG.caps.liveEnemies) return false;
    this.spawnEnemy('sapper', at);
    const sapper = this.state.units.at(-1)!;
    const escorts: number[] = [];
    for (const offset of [-20, 20]) {
      const desired = { x: sapper.pos.x + offset, y: sapper.pos.y - 20 };
      const point = desired.y < 0 ? desired : nearestOpenCell(this.state.terrain, desired, 2) ?? desired;
      this.spawnEnemy('rifle', point);
      const escort = this.state.units.at(-1)!;
      escort.laneX = sapper.laneX; escorts.push(escort.id);
    }
    this.state.enemySapperTeams.push({ id: this.state.nextEntityId++, sapperId: sapper.id, escortIds: escorts,
      target: null, plantPos: null, plantTicks: 0, nextPlanTick: this.state.ticks, chargeId: null });
    this.emit({ type: 'sapperTeamInbound', unitIds: [sapper.id, ...escorts], pos: { ...sapper.pos } });
    return true;
  }

  private updateSapperTeams(): void {
    const s = this.state, tuning = CONFIG.enemySappers;
    for (const team of [...s.enemySapperTeams]) {
      const sapper = s.units.find((unit) => unit.id === team.sapperId && unit.health > 0 && !unit.dead);
      if (team.chargeId !== null) {
        if (s.enemyDemolitionCharges.some((charge) => charge.id === team.chargeId)) continue;
        s.enemySapperTeams = s.enemySapperTeams.filter((candidate) => candidate.id !== team.id);
        continue;
      }
      if (!sapper) {
        s.enemySapperTeams = s.enemySapperTeams.filter((candidate) => candidate.id !== team.id);
        for (const unit of s.units) if (team.escortIds.includes(unit.id)) { unit.path = []; unit.moveGoal = null; }
        continue;
      }
      const sites = demolitionSites(s);
      const site = team.target ? sites.find((candidate) => sameDemolitionTarget(candidate.target, team.target!)) : undefined;
      if (team.target && !site) {
        team.target = null; team.plantPos = null; team.plantTicks = 0; team.nextPlanTick = s.ticks;
        sapper.path = []; sapper.moveGoal = null;
      }
      if (team.target && team.plantPos) {
        if (!sapper.pinned && sapper.suppression < CONFIG.suppression.pinThreshold && !sapper.buildingPosition
          && dist(sapper.pos, team.plantPos) <= tuning.plantReach) {
          team.plantTicks++;
          if (team.plantTicks >= sec(tuning.plantSeconds)) {
            const id = s.nextEntityId++;
            s.enemyDemolitionCharges.push({ id, unitId: sapper.id, target: { ...team.target }, pos: { ...team.plantPos }, ticksRemaining: sec(tuning.fuseSeconds) });
            team.chargeId = id;
            this.emit({ type: 'enemyChargePlanted', unitId: sapper.id, pos: { ...team.plantPos } });
            for (const unit of s.units) if (unit.id === sapper.id || team.escortIds.includes(unit.id)) { unit.path = []; unit.moveGoal = null; }
          }
        }
        continue;
      }
      if (s.ticks < team.nextPlanTick || sapper.pinned || sapper.buildingPosition) continue;
      team.nextPlanTick = s.ticks + sec(2);
      const candidates = sites.filter((candidate) => dist(sapper.pos, candidate.pos) <= tuning.seekRange
        && !s.enemySapperTeams.some((other) => other.id !== team.id && other.target && sameDemolitionTarget(other.target, candidate.target)))
        .sort((a, b) => (dist(sapper.pos, a.pos) / a.priority) - (dist(sapper.pos, b.pos) / b.priority));
      for (const candidate of candidates) {
        const approaches = candidate.approaches.map((point) => nearestOpenCell(s.terrain, point, 1))
          .filter((point): point is Vec2 => point !== null && this.inBounds(point, 8) && point.y < CONFIG.breakthroughY - 4)
          .sort((a, b) => dist(sapper.pos, a) - dist(sapper.pos, b));
        let assigned = false;
        for (const approach of approaches) {
          // Reject a nudged point that no longer touches the target's perimeter.
          if (!candidate.approaches.some((point) => dist(point, approach) <= s.terrain.cell * .75)) continue;
          const route = this.findUnitPath(sapper, sapper.pos, approach);
          if (!route.reachable) continue;
          team.target = { ...candidate.target }; team.plantPos = { ...approach }; team.plantTicks = 0;
          sapper.path = route.waypoints; sapper.moveGoal = { ...approach };
          this.emit({ type: 'sapperTargeted', teamId: team.id, label: candidate.label, pos: { ...candidate.pos } });
          assigned = true; break;
        }
        if (assigned) break;
      }
    }
  }

  private demolitionTeamBehavior(unit: Unit, team: EnemySapperTeam): boolean {
    const charge = team.chargeId === null ? undefined : this.state.enemyDemolitionCharges.find((candidate) => candidate.id === team.chargeId);
    if (charge) {
      // The whole team withdraws before its own fuse expires. They remain vulnerable.
      if (!unit.moveGoal || dist(unit.moveGoal, charge.pos) < CONFIG.enemySappers.radius + 36) {
        for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
          const goal = nearestOpenCell(this.state.terrain, { x: charge.pos.x + dx! * 120, y: charge.pos.y + dy! * 120 }, 2);
          if (!goal || dist(goal, charge.pos) < CONFIG.enemySappers.radius + 24 || goal.y >= CONFIG.breakthroughY) continue;
          const route = this.findUnitPath(unit, unit.pos, goal);
          if (route.reachable) { unit.path = route.waypoints; unit.moveGoal = goal; unit.movementPace = 'run'; break; }
        }
      }
      return true;
    }
    if (!team.target || !team.plantPos) return false;
    if (unit.id === team.sapperId) {
      if (dist(unit.pos, team.plantPos) <= CONFIG.enemySappers.plantReach) {
        unit.path = []; unit.moveGoal = null; unit.targetId = null; unit.burstRemaining = 0;
      } else if (!this.sapperBehavior(unit) && (unit.path.length === 0 || !unit.moveGoal || dist(unit.moveGoal, team.plantPos) > 4)) {
        const route = this.findUnitPath(unit, unit.pos, team.plantPos);
        if (route.reachable) { unit.path = route.waypoints; unit.moveGoal = { ...team.plantPos }; }
        else { team.target = null; team.plantPos = null; team.plantTicks = 0; team.nextPlanTick = this.state.ticks + sec(2); }
      }
      return true;
    }
    const sapper = this.state.units.find((candidate) => candidate.id === team.sapperId && candidate.health > 0 && !candidate.dead);
    if (!sapper) return false;
    if (dist(unit.pos, sapper.pos) <= 64) { unit.path = []; unit.moveGoal = null; return true; }
    if (!unit.moveGoal || dist(unit.moveGoal, sapper.pos) > 48 || unit.path.length === 0) {
      const goal = nearestOpenCell(this.state.terrain, { x: sapper.pos.x + (team.escortIds.indexOf(unit.id) === 0 ? -24 : 24), y: sapper.pos.y - 24 }, 2);
      if (goal) {
        const route = this.findUnitPath(unit, unit.pos, goal);
        if (route.reachable) { unit.path = route.waypoints; unit.moveGoal = goal; }
      }
    }
    return true;
  }

  private updateEnemyDemolitionCharges(): void {
    const s = this.state, tuning = CONFIG.enemySappers;
    for (const charge of [...s.enemyDemolitionCharges]) {
      if (--charge.ticksRemaining > 0) continue;
      s.enemyDemolitionCharges = s.enemyDemolitionCharges.filter((other) => other.id !== charge.id);
      const target = charge.target;
      if (demolitionTargetExists(s, target)) {
        if (target.kind === 'bunker') {
          const bunker = s.bunkers.find((candidate) => candidate.id === target.id)!;
          s.bunkers = s.bunkers.filter((candidate) => candidate.id !== target.id);
          this.emit({ type: 'structureDemolished', kind: 'bunker', pos: { ...bunker.pos } });
        } else if (target.kind === 'bridge') this.demolishBridge(target.key, charge.unitId);
      }
      const victims = this.explodeAt(charge.pos, tuning.radius, tuning.damage, 1.5, tuning.suppression, charge.unitId);
      if (target.kind === 'building') {
        const building = s.buildings.find((candidate) => candidate.id === target.id && !candidate.destroyed);
        if (building) this.damageBuilding(building, Math.max(0, tuning.structuralDamage - tuning.damage));
      }
      this.emit({ type: 'enemyChargeDetonated', pos: { ...charge.pos }, radius: tuning.radius, victims });
    }
  }

  private demolishBridge(key: string, sourceId: number): void {
    const s = this.state, surface = s.terrain.bridges?.find((bridge) => bridgeKey(bridge) === key);
    if (!surface) return;
    const built = s.builtBridges.find((bridge) => bridgeKey({ ...bridge.pos, ...bridge }) === key);
    if (!built && !s.destroyedBridgeKeys.includes(key)) s.destroyedBridgeKeys.push(key);
    s.builtBridges = s.builtBridges.filter((bridge) => bridgeKey({ ...bridge.pos, ...bridge }) !== key);
    this.zones.bridges = this.zones.bridges.filter((bridge) => bridgeKey(bridge) !== key);
    s.terrain.bridges = this.zones.bridges;
    for (const unit of s.units) {
      if (unit.bridgePosition?.key !== key) continue;
      const onDeck = unit.bridgePosition.level === 'deck';
      const goal = unit.path.length > 0 ? unit.moveGoal : null;
      delete unit.bridgePosition; unit.path = []; unit.moveGoal = null;
      if (onDeck && unit.health > 0) { const hit = this.damageUnit(unit, 35, 1); if (hit.killed) this.killUnit(unit, sourceId); }
      if (goal && unit.health > 0 && !unit.dead) {
        const route = this.findUnitPath(unit, unit.pos, goal);
        unit.path = route.reachable ? route.waypoints : []; unit.moveGoal = goal;
      }
    }
    this.rerouteForWire();
    this.emit({ type: 'structureDemolished', kind: 'bridge', pos: { x: surface.x, y: surface.y } });
  }

  private sapperBehavior(unit: Unit): boolean {
    if (unit.role !== 'sapper' || unit.team !== 'enemy' || unit.buildingPosition || unit.bridgePosition) return false;
    const tuning = CONFIG.barbedWire;
    const wires = this.state.barbedWire.filter((wire) => wire.pos.y >= unit.pos.y - tuning.halfDepth - tuning.cutReach
      && wireDistance(wire, unit.pos) <= tuning.seekRange)
      .sort((a, b) => wireDistance(a, unit.pos) - wireDistance(b, unit.pos) || a.id - b.id);
    for (const wire of wires) {
      if (unit.pinned) { unit.path = []; unit.running = false; return true; }
      if (wireDistance(wire, unit.pos) <= tuning.cutReach) {
        unit.path = []; unit.moveGoal = null; unit.advance = false; unit.running = false;
        unit.targetId = null; unit.burstRemaining = 0;
        if (wire.cutTicks === 0) this.emit({ type: 'wireCutStarted', unitId: unit.id, wireId: wire.id, pos: { ...wire.pos } });
        wire.cutTicks++;
        if (wire.cutTicks >= sec(tuning.cutSeconds)) {
          this.state.barbedWire = this.state.barbedWire.filter((candidate) => candidate.id !== wire.id);
          this.emit({ type: 'wireBreached', unitId: unit.id, wireId: wire.id, pos: { ...wire.pos } });
          this.rerouteForWire();
        }
        return true;
      }
      const goal = { x: Math.max(wire.pos.x - tuning.halfLength + 4, Math.min(wire.pos.x + tuning.halfLength - 4, unit.pos.x)),
        y: wire.pos.y - tuning.halfDepth - tuning.cutReach + 2 };
      if (!unit.moveGoal || dist(unit.moveGoal, goal) > 4 || unit.path.length === 0) {
        const route = this.findUnitPath(unit, unit.pos, goal);
        if (!route.reachable) continue;
        unit.path = [...route.waypoints, goal]; unit.moveGoal = goal;
      }
      unit.advance = true;
      return true;
    }
    return false;
  }

  private mortarPitPlacementError(pos: Vec2): string | null {
    const s = this.state;
    const engineerError = this.engineerRequirementError(pos);
    if (engineerError !== null) return engineerError;
    if (s.points < CONFIG.costs.mortarPit) return `Mortar pits cost ${CONFIG.costs.mortarPit} points.`;
    const radius = CONFIG.mortarPit.occupyRadius;
    if (!this.inBounds(pos, radius + 4)) return 'Place the mortar pit fully inside the battlefield.';
    if (pos.y < CONFIG.terrain.protectedTopRows * s.terrain.cell + radius) return 'Too close to the enemy approach.';
    if (this.isSolid(pos.x, pos.y)) return 'Build mortar pits on open ground.';
    if (s.mortarPits.some((pit) => dist(pit.pos, pos) < CONFIG.mortarPit.minSpacing)) return 'Too close to another mortar pit.';
    if (s.bunkers.some((bunker) => dist(bunker.pos, pos) < CONFIG.mortarPit.occupyRadius + CONFIG.bunker.occupyRadius)) return 'Too close to a bunker.';
    if (s.trenches.some((trench) => dist(trench.pos, pos) < CONFIG.mortarPit.occupyRadius + CONFIG.trench.halfLength)) return 'Too close to a trench.';
    if (s.sandbags.some((bag) => dist(bag.pos, pos) < CONFIG.mortarPit.occupyRadius + 12)) return 'Too close to sandbags.';
    if (s.constructionSites.some((site) => this.constructionOverlap(site, 'mortarPit', pos))) return 'Too close to another construction site.';
    return null;
  }

  private bunkerPlacementError(pos: Vec2): string | null {
    const s = this.state;
    const engineerError = this.engineerRequirementError(pos);
    if (engineerError !== null) return engineerError;
    if (s.points < CONFIG.costs.bunker) return `Bunkers cost ${CONFIG.costs.bunker} points.`;
    const radius = CONFIG.bunker.occupyRadius;
    if (!this.inBounds(pos, radius + 4)) return 'Place the bunker fully inside the battlefield.';
    if (pos.y < CONFIG.terrain.protectedTopRows * s.terrain.cell + radius) return 'Too close to the enemy approach.';
    if (this.isSolid(pos.x, pos.y)) return 'Build bunkers on open ground.';
    const edge = radius - 3;
    if (this.isSolid(pos.x - edge, pos.y - edge) || this.isSolid(pos.x + edge, pos.y - edge)
      || this.isSolid(pos.x - edge, pos.y + edge) || this.isSolid(pos.x + edge, pos.y + edge)) return 'Build bunkers on open ground.';
    if (s.bunkers.some((bunker) => dist(bunker.pos, pos) < CONFIG.bunker.minSpacing)) return 'Too close to another bunker.';
    if (s.sandbags.some((bag) => dist(bag.pos, pos) < radius + 12) || s.trenches.some((trench) => dist(trench.pos, pos) < radius + CONFIG.trench.halfLength)) return 'Too close to another fortification.';
    if (s.mortarPits.some((pit) => dist(pit.pos, pos) < radius + CONFIG.mortarPit.occupyRadius)) return 'Too close to a mortar pit.';
    if (s.mines.some((mine) => dist(mine.pos, pos) < radius + 10)) return 'Too close to a mine.';
    if (s.constructionSites.some((site) => this.constructionOverlap(site, 'bunker', pos))) return 'Too close to another construction site.';
    return null;
  }

  private trenchPlacementError(pos: Vec2): string | null {
    const s = this.state;
    const engineerError = this.engineerRequirementError(pos);
    if (engineerError !== null) return engineerError;
    if (s.points < CONFIG.costs.trench) return `Trenches cost ${CONFIG.costs.trench} points.`;
    if (pos.x < CONFIG.trench.halfLength || pos.x > CONFIG.field.width - CONFIG.trench.halfLength || !this.inBounds(pos, 10)) {
      return 'Place trenches fully inside the battlefield.';
    }
    if (pos.y < CONFIG.terrain.protectedTopRows * CONFIG.terrain.cell + 8) return 'Too close to the enemy approach.';
    if (s.trenches.some((trench) => dist(trench.pos, pos) < CONFIG.trench.minSpacing)) return 'Too close to another trench.';
    if (s.sandbags.some((bag) => dist(bag.pos, pos) < CONFIG.trench.halfLength + 12)) return 'Too close to sandbags.';
    if (s.bunkers.some((bunker) => dist(bunker.pos, pos) < CONFIG.bunker.occupyRadius + CONFIG.trench.halfLength)) return 'Too close to a bunker.';
    if (s.mortarPits.some((pit) => dist(pit.pos, pos) < CONFIG.mortarPit.occupyRadius + CONFIG.trench.halfLength)) return 'Too close to a mortar pit.';
    if (s.constructionSites.some((site) => this.constructionOverlap(site, 'trench', pos))) return 'Too close to another construction site.';
    const col = Math.floor(pos.x / s.terrain.cell);
    const row = Math.floor(pos.y / s.terrain.cell);
    if (s.terrain.blocked[row * s.terrain.cols + col] === 1) return 'Build trenches on open ground.';
    return null;
  }

  private commandMine(kind: MineKind, pos: Vec2): CommandResult {
    const reason = this.minePlacementError(kind, pos);
    if (reason !== null) return { ok: false, reason };
    const builder = this.nearestAvailableEngineer(pos);
    if (builder === null) return { ok: false, reason: 'No available engineer nearby.' };
    this.state.points -= CONFIG.mineKinds[kind].cost;
    this.startConstruction('mine', pos, builder.id, kind);
    return { ok: true };
  }

  /**
   * Mines are laid forward of the line, so the Axis walk onto them rather than
   * the defenders. They never block movement or sight: a mine is a hazard, not an
   * obstacle. Each type keeps its own spacing so a field cannot be packed tight.
   */
  private minePlacementError(kind: MineKind, pos: Vec2): string | null {
    const s = this.state;
    const def = CONFIG.mineKinds[kind];
    const engineerError = this.engineerRequirementError(pos);
    if (engineerError !== null) return engineerError;
    if (s.points < def.cost) return `${def.label}s cost ${def.cost} points.`;
    if (!this.inBounds(pos, 10)) return 'Lay mines inside the battlefield.';
    if (pos.y < CONFIG.terrain.protectedTopRows * CONFIG.terrain.cell + 8) return 'Too close to the enemy approach.';
    if (pos.y > CONFIG.mine.maxLayY) return 'Lay mines ahead of the line, not among your own positions.';
    if (s.mines.some((laid) => laid.kind === kind && dist(laid.pos, pos) < def.minSpacing)) {
      return `Too close to another ${def.label}.`;
    }
    if (s.constructionSites.some((site) => site.kind === 'mine' && site.mineKind === kind && dist(site.pos, pos) < def.minSpacing)) {
      return `Too close to another ${def.label} being laid.`;
    }
    if (s.sandbags.some((bag) => dist(bag.pos, pos) < 18)) return 'Too close to a sandbag.';
    if (s.trenches.some((trench) => dist(trench.pos, pos) < CONFIG.trench.halfLength)) return 'Too close to a trench.';
    if (s.bunkers.some((bunker) => dist(bunker.pos, pos) < CONFIG.bunker.occupyRadius + 10)) return 'Too close to a bunker.';
    if (s.mortarPits.some((pit) => dist(pit.pos, pos) < CONFIG.mortarPit.occupyRadius + 10)) return 'Too close to a mortar pit.';
    return null;
  }

  private startConstruction(kind: ConstructionSite['kind'], pos: Vec2, builderId: number, mineKind?: MineKind): void {
    const seconds = kind === 'barbedWire' ? CONFIG.construction.barbedWireSeconds : kind === 'sandbag'
      ? CONFIG.construction.sandbagSeconds
      : kind === 'trench'
        ? CONFIG.construction.trenchSeconds
      : kind === 'bunker'
        ? CONFIG.construction.bunkerSeconds
        : kind === 'mortarPit'
          ? CONFIG.construction.mortarPitSeconds
          : kind === 'bridge'
            ? CONFIG.construction.bridgeSeconds
            : CONFIG.mineKinds[mineKind ?? 'ap'].laySeconds;
    const totalTicks = sec(seconds);
    const bridgeShape = kind === 'bridge' ? this.bridgeShapeAt(pos) : null;
    this.state.constructionSites.push({
      id: this.state.nextEntityId++,
      kind,
      mineKind,
      ...(bridgeShape === null ? {} : {
        bridgeAxis: bridgeShape.axis,
        bridgeHalfWidth: bridgeShape.halfWidth,
        bridgeHalfLength: bridgeShape.halfLength,
      }),
      pos: { x: pos.x, y: pos.y },
      builderId,
      ticksRemaining: totalTicks,
      totalTicks,
    });
  }

  private constructionOverlap(site: ConstructionSite, kind: ConstructionSite['kind'], pos: Vec2): boolean {
    if (kind === 'barbedWire' || site.kind === 'barbedWire') {
      const halfLength = kind === 'barbedWire' && site.kind === 'barbedWire' ? CONFIG.barbedWire.halfLength * 2 + 2 : CONFIG.barbedWire.halfLength + 20;
      return Math.abs(site.pos.x - pos.x) < halfLength && Math.abs(site.pos.y - pos.y) < 28;
    }
    if (kind === 'sandbag' && site.kind === 'sandbag') return dist(site.pos, pos) < CONFIG.sandbagMinSpacing;
    if (kind === 'trench' && site.kind === 'trench') return dist(site.pos, pos) < CONFIG.trench.minSpacing;
    if (kind === 'bunker' || site.kind === 'bunker') return dist(site.pos, pos) < CONFIG.bunker.minSpacing;
    if (kind === 'mortarPit' || site.kind === 'mortarPit') return dist(site.pos, pos) < CONFIG.mortarPit.minSpacing;
    if (kind === 'bridge' || site.kind === 'bridge') return dist(site.pos, pos) < 60;
    return dist(site.pos, pos) < CONFIG.trench.halfLength + 12;
  }

  /** Nearest living engineer who is not already assigned to a construction site. */
  nearestAvailableEngineer(pos: Vec2, ignoreSiteId?: number): Unit | null {
    const busy = new Set(this.state.constructionSites.filter((site) => site.id !== ignoreSiteId).map((site) => site.builderId));
    let best: Unit | null = null;
    let bestDistance = Infinity;
    for (const unit of this.state.units) {
      if (unit.team !== 'friendly' || unit.role !== 'engineer' || unit.health <= 0 || unit.crossed === true || unit.pinned || busy.has(unit.id)) continue;
      const distance = dist(unit.pos, pos);
      if (distance < bestDistance) {
        best = unit;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Living engineers anywhere on the map, whether or not they are free to work.
   * Used to tell a paused site from one that can never be finished.
   */
  private livingEngineers(): Unit[] {
    return this.livingFriendlies().filter((unit) => unit.role === 'engineer');
  }

  /** What a work site's points cost, for refunding an abandoned one. */
  private constructionCostOf(site: ConstructionSite): number {
    if (site.kind === 'barbedWire') return CONFIG.costs.barbedWire;
    if (site.kind === 'sandbag') return CONFIG.costs.sandbag;
    if (site.kind === 'trench') return CONFIG.costs.trench;
    if (site.kind === 'bunker') return CONFIG.costs.bunker;
    if (site.kind === 'mortarPit') return CONFIG.costs.mortarPit;
    if (site.kind === 'bridge') return CONFIG.costs.bridge;
    return CONFIG.mineKinds[site.mineKind ?? 'ap'].cost;
  }

  private engineerRequirementError(pos: Vec2): string | null {
    const aliveEngineers = this.livingEngineers();    if (aliveEngineers.length === 0) return 'Deploy a Combat Support Engineer to build fortifications.';
    const builder = this.nearestAvailableEngineer(pos);
    if (builder !== null && dist(builder.pos, pos) <= CONFIG.construction.engineerRange) return null;
    const available = aliveEngineers.some((unit) => !unit.pinned && !this.state.constructionSites.some((site) => site.builderId === unit.id));
    return available
      ? `Build within ${CONFIG.construction.engineerRange} pixels of an available Combat Support Engineer.`
      : 'All Combat Support Engineers are busy, pinned, or building.';
  }

  /**
   * Detonate any armed mine a matching hostile has walked onto. A mine fires once
   * and is removed, so it cannot trigger twice. Only the Axis trip them, and each
   * type ignores what it was not designed for: an anti-tank charge lets infantry
   * walk over it, and an anti-personnel charge lets a tank roll over it. The
   * defenders are still hurt if they are standing in the blast when it goes up.
   *
   * The trigger measures from the edge of the target, not its centre. Terrain
   * routes movement along cell centres, and a cell half-width (12px) is already
   * most of a naive centre-to-centre radius, so a centre-only test lets a tank
   * roll through a minefield untouched.
   */
  private updateMines(): void {
    const s = this.state;
    if (s.mines.length === 0) return;
    for (let i = s.mines.length - 1; i >= 0; i--) {
      const laid = s.mines[i] as Mine;
      if (!laid.armed) continue;
      const def = CONFIG.mineKinds[laid.kind];
      let tripped = false;
      for (const unit of s.units) {
        if (unit.health <= 0 || unit.team !== 'enemy') continue;
        const vehicle = isVehicle(this.content, unit);
        if (vehicle ? !def.triggersOnVehicles : !def.triggersOnInfantry) continue;
        const reach = def.triggerRadius + unitRadius(this.content, unit);
        const dx = unit.pos.x - laid.pos.x;
        const dy = unit.pos.y - laid.pos.y;
        if (dx * dx + dy * dy <= reach * reach) { tripped = true; break; }
      }
      if (!tripped) continue;
      s.mines.splice(i, 1);
      const victims = this.explodeAt(laid.pos, def.radius, def.damage * (laid.damageMult ?? 1), def.armorMult, def.suppression, null, CONFIG.mine.friendlyFire);
      this.emit({ type: 'mineTriggered', kind: laid.kind, pos: { ...laid.pos }, radius: def.radius, victims });
    }
  }

  private updateConstruction(): void {
    const s = this.state;
    if (s.phase !== 'running') return;
    for (let i = s.constructionSites.length - 1; i >= 0; i--) {
      const site = s.constructionSites[i]!;
      let builder = s.units.find((unit) => unit.id === site.builderId && unit.team === 'friendly' && unit.role === 'engineer' && unit.health > 0 && unit.crossed !== true && !unit.pinned);
      if (builder === undefined || dist(builder.pos, site.pos) > CONFIG.construction.engineerRange) {
        builder = this.nearestAvailableEngineer(site.pos, site.id) ?? undefined;
        if (builder === undefined || dist(builder.pos, site.pos) > CONFIG.construction.engineerRange) {
          // Nobody can pick this up. A living engineer who is merely pinned, busy
          // or out of position is a pause and the work persists for them to
          // resume; but with no engineer alive at all it can never be finished, so
          // the site is abandoned rather than left on the field as a permanent
          // half-built marker. The points come back, because the squad lost the
          // man, not the decision.
          if (this.livingEngineers().length === 0) {
            s.constructionSites.splice(i, 1);
            const refund = this.constructionCostOf(site);
            s.points += refund;
            this.emit({ type: 'constructionAbandoned', kind: site.kind, pos: { ...site.pos }, refund });
          }
          continue;
        }
        site.builderId = builder.id;
      }

      const buildSpeed = builder.specialization === 'rapidBuilder' ? CONFIG.specialization.buildSpeedMult : 1;
      site.ticksRemaining = Math.max(0, site.ticksRemaining - buildSpeed);
      if (site.ticksRemaining > 0) continue;

      if (site.kind === 'barbedWire') {
        s.barbedWire.push({ id: site.id, pos: { ...site.pos }, cutTicks: 0 });
        this.rerouteForWire();
      } else if (site.kind === 'sandbag') {
        s.sandbags.push({ id: site.id, pos: { ...site.pos } });
      } else if (site.kind === 'trench') {
        s.trenches.push({ id: site.id, pos: { ...site.pos } });
      } else if (site.kind === 'bunker') {
        s.bunkers.push({ id: site.id, pos: { ...site.pos } });
      } else if (site.kind === 'mortarPit') {
        s.mortarPits.push({ id: site.id, pos: { ...site.pos } });
      } else if (site.kind === 'bridge') {
        const shape = this.bridgeShapeAt(site.pos);
        if (shape !== null) {
          const bridge: BuiltBridge = { id: site.id, pos: { ...site.pos }, ...shape };
          s.builtBridges.push(bridge);
          const surface = { ...site.pos, axis: shape.axis, type: 'pontoon' as const, halfWidth: shape.halfWidth, halfLength: shape.halfLength };
          this.zones.bridges.push(surface);
          for (const unit of s.units) if (!unit.buildingPosition && bridgeContains(surface, unit.pos)) {
            unit.bridgePosition = { key: bridgeKey(surface), level: !isVehicle(this.content, unit)
              && bridgeDeckHeight(surface, unit.pos) - BRIDGE.thickness >= BRIDGE.infantryClearance ? 'under' : 'deck' };
          }
        }
      } else {
        // A mine is only dangerous once the engineer has finished arming it.
        const kind = site.mineKind ?? 'ap';
        s.mines.push({ id: site.id, pos: { ...site.pos }, kind, armed: true, damageMult: builder.specialization === 'heavyCharges' ? CONFIG.specialization.mineDamageMult : 1 });
        this.emit({ type: 'mineLaid', kind, pos: { ...site.pos } });
      }
      s.constructionSites.splice(i, 1);
      builder.service.fortificationsBuilt += 1;
      builder.xp += 1;
      this.emit({ type: 'constructionCompleted', kind: site.kind, pos: { ...site.pos } });
    }
  }

  private commandArtillery(pos: Vec2): CommandResult {
    const validation = this.validateRadioRequest('artillery');
    if (!validation.ok) return validation;
    // Bound the target to playable terrain; allow targeting near obstacles.
    const clamped: Vec2 = {
      x: Math.min(CONFIG.field.width - CONFIG.spawnMargin, Math.max(CONFIG.spawnMargin, pos.x)),
      y: Math.min(CONFIG.field.height - 10, Math.max(CONFIG.spawnMargin * 3, pos.y)),
    };
    this.state.points -= CONFIG.costs.artillery;
    const operators = this.availableRadioEngineers();
    const cooldownMultiplier = operators.some((unit) => unit.specialization === 'signalOfficer')
      ? CONFIG.specialization.artilleryCooldownMult
      : 1;
    const delayMultiplier = operators.some((unit) => unit.specialization === 'forwardObserver')
      ? CONFIG.specialization.artilleryDelayMult
      : 1;
    this.state.artilleryCooldown = Math.round(sec(CONFIG.artillery.cooldownSeconds) * cooldownMultiplier);
    const strike: Strike = {
      id: this.state.nextEntityId++,
      pos: clamped,
      landTick: this.state.ticks + sec(CONFIG.artillery.delaySeconds * delayMultiplier),
      radius: CONFIG.artillery.radius,
      damage: CONFIG.artillery.damage,
      suppressionAmount: CONFIG.artillery.suppression,
      source: 'friendly',
    };
    this.state.strikes.push(strike);
    this.emit({ type: 'artilleryOrdered', pos: clamped, landTick: strike.landTick });
    return { ok: true };
  }

  private commandAirSupport(pos: Vec2): CommandResult {
    const validation = this.validateRadioRequest('airSupport');
    if (!validation.ok) return validation;

    // The aircraft makes a low pass across the battlefield, dropping a short
    // line of bombs through the selected point. Keep the whole run on-map.
    const halfRun = (CONFIG.airSupport.bombCount - 1) * CONFIG.airSupport.bombSpacing / 2;
    const center: Vec2 = {
      x: Math.min(CONFIG.field.width - CONFIG.spawnMargin - halfRun, Math.max(CONFIG.spawnMargin + halfRun, pos.x)),
      y: Math.min(CONFIG.field.height - 10, Math.max(CONFIG.spawnMargin * 3, pos.y)),
    };
    this.state.points -= CONFIG.costs.airSupport;
    this.state.airSupportCooldown = sec(CONFIG.airSupport.cooldownSeconds);
    const operators = this.availableRadioEngineers();
    const delayMultiplier = operators.some((unit) => unit.specialization === 'forwardObserver')
      ? CONFIG.specialization.artilleryDelayMult
      : 1;
    const firstLandTick = this.state.ticks + sec(CONFIG.airSupport.delaySeconds * delayMultiplier);
    for (let index = 0; index < CONFIG.airSupport.bombCount; index++) {
      this.state.strikes.push({
        id: this.state.nextEntityId++,
        pos: { x: center.x + (index - (CONFIG.airSupport.bombCount - 1) / 2) * CONFIG.airSupport.bombSpacing, y: center.y },
        landTick: firstLandTick + sec(index * CONFIG.airSupport.bombSpacingSeconds),
        radius: CONFIG.airSupport.radius,
        damage: CONFIG.airSupport.damage,
        suppressionAmount: CONFIG.airSupport.suppression,
        source: 'friendly',
        delivery: 'airSupport',
      });
    }
    this.emit({ type: 'airSupportOrdered', pos: center, bombs: CONFIG.airSupport.bombCount, landTick: firstLandTick });
    return { ok: true };
  }

  private commandFoodSupplies(): CommandResult {
    const validation = this.validateRadioRequest('foodSupplies');
    if (!validation.ok) return validation;
    const points = CONFIG.foodSupply.points;
    this.state.points += points;
    this.state.foodSupplyCooldown = sec(CONFIG.foodSupply.cooldownSeconds);
    return { ok: true };
  }

  private commandFlare(pos: Vec2): CommandResult {
    const validation = this.validateRadioRequest('flare');
    if (!validation.ok) return validation;
    if (!this.inBounds(pos, 4)) return { ok: false, reason: 'Flare target is outside the battlefield.' };

    const target = { x: pos.x, y: pos.y };
    const ticks = sec(CONFIG.flare.durationSeconds);
    const delayTicks = sec(CONFIG.flare.deploymentDelaySeconds);
    this.state.points -= CONFIG.costs.flare;
    this.state.flareCooldown = sec(CONFIG.flare.cooldownSeconds);
    this.state.flares.push({ id: this.state.nextEntityId++, pos: target, radius: CONFIG.flare.radius, pendingTicksRemaining: delayTicks, ticksRemaining: ticks });
    this.emit({ type: 'flareOrdered', pos: target, landTick: this.state.ticks + delayTicks });
    return { ok: true };
  }

  /** Preflight a radio request before the voice exchange commits its effect. */
  validateRadioRequest(kind: 'artillery' | 'airSupport' | 'foodSupplies' | 'flare'): CommandResult {
    const action = kind === 'artillery' ? 'call artillery' : kind === 'airSupport' ? 'call air support' : kind === 'flare' ? 'call a flare' : 'request food supplies';
    const operatorError = this.radioEngineerRequirementError(action);
    if (operatorError !== null) return { ok: false, reason: operatorError };
    if (kind === 'flare') {
      if (!dayNightAtTick(this.state.ticks, this.state.dayNightStartTick).night) return { ok: false, reason: 'Flares can only be called at night.' };
      if (this.state.flareCooldown > 0) return { ok: false, reason: 'The flare team is reloading.' };
      if (this.state.points < CONFIG.costs.flare) return { ok: false, reason: `Flares cost ${CONFIG.costs.flare} points.` };
    } else if (kind === 'artillery') {
      if (this.state.artilleryCooldown > 0) return { ok: false, reason: 'Artillery is reloaded in a moment.' };
      if (this.state.points < CONFIG.costs.artillery) return { ok: false, reason: `Artillery costs ${CONFIG.costs.artillery} points.` };
    } else if (kind === 'airSupport') {
      if (this.state.airSupportCooldown > 0) return { ok: false, reason: 'Air support is being rearmed.' };
      if (this.state.points < CONFIG.costs.airSupport) return { ok: false, reason: `Air support costs ${CONFIG.costs.airSupport} points.` };
    } else {
      if (this.state.foodSupplyCooldown > 0) return { ok: false, reason: 'Food supplies are not available over the radio yet.' };
    }
    return { ok: true };
  }

  private commandLightFire(unitId: number): CommandResult {
    const unit = this.findUnit(unitId);
    const reason = campfireError(this.state, unit);
    if (reason) return { ok: false, reason };
    if (!unit || !this.inBounds(unit.pos, 4)) return { ok: false, reason: 'Light fires inside the battlefield.' };
    this.state.campfires.push({
      id: this.state.nextEntityId++, unitId, pos: { ...unit.pos },
      radius: CONFIG.campfire.radius, ticksRemaining: sec(CONFIG.campfire.durationSeconds),
    });
    this.emit({ type: 'campfireLit', unitId, pos: { ...unit.pos } });
    return { ok: true };
  }

  private commandSatchel(unitId: number, pos: Vec2): CommandResult {
    const unit = this.findUnit(unitId);
    const reason = satchelError(this.state, unit, pos);
    if (reason) return { ok: false, reason };
    this.state.points -= CONFIG.satchel.cost;
    this.state.satchelCharges.push({ id: this.state.nextEntityId++, unitId, pos: { ...pos }, ticksRemaining: sec(CONFIG.satchel.fuseSeconds) });
    this.emit({ type: 'satchelPlanted', unitId, pos: { ...pos } });
    return { ok: true };
  }

  private updateSatchelCharges(): void {
    for (const charge of [...this.state.satchelCharges]) {
      if (--charge.ticksRemaining > 0) continue;
      this.state.satchelCharges = this.state.satchelCharges.filter((other) => other.id !== charge.id);
      const def = CONFIG.satchel;
      const victims = this.explodeAt(charge.pos, def.radius, def.damage, def.armorMult, def.suppression, charge.unitId);
      this.emit({ type: 'satchelDetonated', pos: { ...charge.pos }, radius: def.radius, victims });
    }
  }

  private commandSmoke(unitId: number, pos: Vec2): CommandResult {
    const unit = this.findUnit(unitId);
    if (!unit || unit.team !== 'friendly' || unit.health <= 0 || unit.crossed === true) return { ok: false, reason: 'Select a living soldier on the battlefield.' };
    if (unit.pinned) return { ok: false, reason: 'Pinned soldiers cannot throw smoke.' };
    if ((unit.smokeGrenades ?? 0) <= 0) return { ok: false, reason: 'This soldier has no smoke grenades left.' };
    if (dist(unit.pos, pos) > CONFIG.smoke.throwRange) return { ok: false, reason: `Smoke must land within ${CONFIG.smoke.throwRange}px.` };
    if (!this.inBounds(pos, 4)) return { ok: false, reason: 'Smoke target is outside the battlefield.' };
    unit.smokeGrenades = (unit.smokeGrenades ?? 0) - 1;
    this.state.smokes.push({ id: this.state.nextEntityId++, pos: { ...pos }, radius: CONFIG.smoke.radius, ticksRemaining: sec(CONFIG.smoke.durationSeconds) });
    this.emit({ type: 'smokeDeployed', unitId, pos: { ...pos }, ticks: sec(CONFIG.smoke.durationSeconds) });
    return { ok: true };
  }

  private commandAmbush(unitIds: readonly number[], aim: Vec2, arcDegrees: number): CommandResult {
    if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y) || !this.inBounds(aim, 0)
      || !AMBUSH_ARCS.some((arc) => arc === arcDegrees)) return { ok: false, reason: 'Choose a battlefield point and a 45, 90, or 120 degree arc.' };
    const selected = [...new Set(unitIds)].map((id) => this.findUnit(id));
    if (!selected.length || selected.some((unit) => !unit || unit.dead || unit.health <= 0 || unit.crossed || !supportsAmbush(unit))) {
      return { ok: false, reason: 'Select living infantry with direct-fire weapons for an ambush.' };
    }
    const units = selected as Unit[];
    if (units.some((unit) => unit.pinned || unit.buildingOrder || (unit.upgradeTimer ?? 0) > 0
      || this.state.constructionSites.some((site) => site.builderId === unit.id))) return { ok: false, reason: 'Pinned, climbing, or busy soldiers cannot prepare an ambush.' };
    if (units.some((unit) => dist(unit.pos, aim) < 8)) return { ok: false, reason: 'Aim at least 8 pixels away from every selected soldier.' };
    for (const unit of units) {
      this.cancelSupportRequest(unit); this.cancelGunfireOrder(unit); delete unit.patrol;
      unit.path = []; unit.moveGoal = null; unit.running = false; unit.movementPace = 'walk';
      unit.targetId = null; unit.burstRemaining = 0;
      unit.ambush = { ...ambushShape(unit.pos, aim, this.weaponOf(unit)!.range, arcDegrees),
        prepTicks: sec(CONFIG.ambush.prepareSeconds), triggered: false, bonusShots: 0 };
      this.emit({ type: 'ambushSet', unitId: unit.id });
    }
    return { ok: true };
  }

  private commandCancelAmbush(unitIds: readonly number[]): CommandResult {
    const units = this.state.units.filter((unit) => unitIds.includes(unit.id) && unit.team === 'friendly' && unit.health > 0 && !unit.dead && !unit.crossed && unit.ambush);
    if (!units.length) return { ok: false, reason: 'Select soldiers with an active ambush order.' };
    for (const unit of units) { delete unit.ambush; unit.targetId = null; unit.burstRemaining = 0; }
    return { ok: true };
  }

  /** Sound alone cannot spring an ambush, and smoke also conceals rocket targets. */
  private ambushSees(unit: Unit, target: Unit): boolean {
    const s = this.state, weapon = this.weaponOf(unit);
    if (!weapon || target.dead || target.health <= 0 || target.team === unit.team) return false;
    const observer = unit.nightContacts?.some((contact) => contact.kind === 'sound')
      ? { ...unit, nightContacts: unit.nightContacts.filter((contact) => contact.kind !== 'sound') } : unit;
    if (dist(unit.pos, target.pos) > weapon.range * this.visibilityMultiplierFor(observer, target)) return false;
    if (!hasLineOfSight(s.terrain, unit.pos, target.pos, unitEyeHeight(s.terrain, unit), unitEyeHeight(s.terrain, target),
      [unit.buildingPosition?.buildingId, target.buildingPosition?.buildingId].filter((id): id is number => id !== undefined))) return false;
    const dx = target.pos.x - unit.pos.x, dy = target.pos.y - unit.pos.y, length = dx * dx + dy * dy;
    return !s.smokes.some((cloud) => {
      const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((cloud.pos.x - unit.pos.x) * dx + (cloud.pos.y - unit.pos.y) * dy) / length));
      return Math.hypot(cloud.pos.x - unit.pos.x - dx * t, cloud.pos.y - unit.pos.y - dy * t) <= cloud.radius;
    });
  }

  private commandFireOrder(unitIds: readonly number[], order: FireOrder): CommandResult {
    if (!FIRE_ORDERS.includes(order)) return { ok: false, reason: 'Unknown fire order.' };
    const selected = [...new Set(unitIds)].map((id) => this.findUnit(id)).filter((u): u is Unit =>
      u !== undefined && u.team === 'friendly' && u.health > 0 && u.crossed !== true,
    );
    if (selected.length === 0) return { ok: false, reason: 'Select at least one living soldier.' };
    if (selected.some((unit) => !fireOrdersForRole(unit.role).includes(order))) {
      return { ok: false, reason: order === 'seekGunfire' ? 'Run to gunfire requires infantry with a direct-fire weapon.' : 'Vehicles cannot use the hold grenades order.' };
    }
    for (const unit of selected) {
      if (unit.fireOrder === 'seekGunfire' || order === 'seekGunfire') {
        unit.path = []; unit.moveGoal = null; unit.running = false; unit.movementPace = 'walk';
        delete unit.gunfirePursuit; delete unit.dodgingStrike;
      }
      if (order === 'seekGunfire') {
        this.cancelSupportRequest(unit);
        delete unit.patrol;
        unit.stance = 'standing'; unit.crawling = false;
      }
      delete unit.ambush;
      unit.fireOrder = order;
      this.emit({ type: 'fireOrderChanged', unitId: unit.id, order });
    }
    return { ok: true };
  }

  /** A direct move, patrol, or building order replaces autonomous pursuit. */
  private cancelGunfireOrder(unit: Unit): void {
    delete unit.ambush;
    if (unit.fireOrder === 'seekGunfire') unit.fireOrder = 'auto';
    delete unit.gunfirePursuit;
  }

  private commandHeadlights(unitIds: readonly number[], on: boolean): CommandResult {
    if (typeof on !== 'boolean') return { ok: false, reason: 'Choose whether the headlights should be on or off.' };
    const selected = [...new Set(unitIds)].map((id) => this.findUnit(id)).filter((unit): unit is Unit =>
      unit !== undefined && unit.team === 'friendly' && unit.health > 0 && unit.crossed !== true &&
      (unit.role === 'gun_truck' || unit.role === 'vehicle'),
    );
    if (selected.length === 0) return { ok: false, reason: 'Select a living friendly truck or tank.' };
    for (const unit of selected) unit.headlightsOn = on;
    return { ok: true };
  }

  private commandPosture(unitIds: readonly number[], stance: Unit['stance'], crawling: boolean): CommandResult {
    if (stance !== 'standing' && stance !== 'crouching' && stance !== 'prone') return { ok: false, reason: 'Choose a valid infantry stance.' };
    const selected = [...new Set(unitIds)].map((id) => this.findUnit(id)).filter((unit): unit is Unit =>
      unit !== undefined && unit.team === 'friendly' && unit.health > 0 && unit.crossed !== true
      && unit.role !== 'vehicle' && unit.role !== 'gun_truck',
    );
    if (selected.length === 0) return { ok: false, reason: 'Select at least one living infantry soldier.' };
    if (crawling && selected.some((unit) => unit.pinned)) return { ok: false, reason: 'Pinned soldiers cannot take a crawl order.' };
    for (const unit of selected) {
      unit.stance = crawling ? 'prone' : stance;
      unit.crawling = crawling;
      if (crawling || stance !== 'standing') { unit.movementPace = 'walk'; unit.running = false; }
    }
    return { ok: true };
  }

  private commandPace(unitIds: readonly number[], pace: Unit['movementPace']): CommandResult {
    if (pace !== 'walk' && pace !== 'run') return { ok: false, reason: 'Choose walking or running.' };
    const selected = [...new Set(unitIds)].map((id) => this.findUnit(id)).filter((unit): unit is Unit =>
      unit !== undefined && unit.team === 'friendly' && unit.health > 0 && !unit.dead && !unit.crossed
      && unit.role !== 'vehicle' && unit.role !== 'gun_truck');
    if (!selected.length) return { ok: false, reason: 'Select living infantry to change pace.' };
    const eligible = selected.filter((unit) => pace === 'walk' || (!unit.pinned && !unit.terrainCrawling
      && !unit.buildingPosition && (unit.stamina ?? 1) >= CONFIG.infantryMovement.minimumRunStamina));
    if (!eligible.length) return { ok: false, reason: 'Running needs at least 25% stamina, open footing, and unpinned infantry.' };
    for (const unit of eligible) {
      unit.movementPace = pace; unit.running = false;
      if (pace === 'run') { unit.stance = 'standing'; unit.crawling = false; }
    }
    return { ok: true };
  }

  private commandSpecialization(unitId: number, specialization: Specialization): CommandResult {
    const unit = this.findUnit(unitId);
    if (!unit || unit.team !== 'friendly' || unit.health <= 0 || unit.crossed === true) return { ok: false, reason: 'Select a living soldier.' };
    if (unit.xp < CONFIG.specialization.unlockXp) return { ok: false, reason: `Reach ${CONFIG.specialization.unlockXp} XP to choose a specialization.` };
    if (unit.specialization !== undefined) return { ok: false, reason: 'This veteran has already chosen a specialization.' };
    if (!this.specializationsFor(unit.role as FriendlyRole).includes(specialization)) return { ok: false, reason: 'That specialization is not available to this role.' };
    unit.specialization = specialization;
    this.emit({ type: 'specializationChosen', unitId, specialization });
    return { ok: true };
  }

  specializationsFor(role: FriendlyRole): Specialization[] {
    const choices: Record<FriendlyRole, Specialization[]> = {
      rifleman: ['steadyAim', 'fastReload', 'forcedMarch', 'camouflage'],
      mg: ['steadyAim', 'suppressor', 'forcedMarch', 'camouflage'],
      mortarman: ['forcedMarch', 'camouflage'],
      at: ['tankHunter', 'fastReload', 'forcedMarch', 'camouflage'],
      sniper: ['steadyAim', 'fastReload', 'forcedMarch', 'camouflage'],
      medic: ['fieldMedic', 'surgeon', 'forcedMarch', 'camouflage'],
      supply_officer: ['steadyAim', 'fastReload', 'forcedMarch', 'camouflage'],
      engineer: ['rapidBuilder', 'heavyCharges', 'forcedMarch', 'camouflage'],
      radio_engineer: ['forwardObserver', 'signalOfficer', 'forcedMarch', 'camouflage'],
      officer: ['steadyAim', 'fastReload', 'forcedMarch', 'camouflage'],
      gun_truck: ['steadyAim', 'fastReload', 'suppressor', 'forcedMarch'],
    };
    return [...choices[role]];
  }

  purchaseWeaponUpgrade(unitId: number, type: WeaponUpgradeType): CommandResult {
    if (this.paused) return { ok: false, reason: 'Paused - orders are not accepted while paused.' };
    if (this.state.phase !== 'running') return { ok: false, reason: 'The battle is over.' };
    const unit = this.findUnit(unitId);
    if (unit === undefined || unit.team !== 'friendly' || unit.health <= 0) {
      return { ok: false, reason: 'Select a living Allied soldier to upgrade.' };
    }
    if (this.weaponOf(unit) === null) return { ok: false, reason: 'This soldier has no personal firearm to upgrade.' };
    const level = unit.weaponUpgrades[type];
    if (level >= CONFIG.weaponUpgrades.maxLevel) return { ok: false, reason: 'This weapon upgrade is already at maximum level.' };
    const cost = CONFIG.weaponUpgrades.costs[type][level];
    if (cost === undefined) return { ok: false, reason: 'No further upgrades are available.' };
    if (this.state.points < cost) return { ok: false, reason: `This upgrade costs ${cost} points.` };
    // One job at a time, because the weapon is in pieces until it is done. The
    // benefit is granted immediately either way; this only stops a soldier from
    // stacking all three levels into a single uninterrupted silence.
    const working = unit.upgradeTimer ?? 0;
    if (working > 0) {
      return { ok: false, reason: `This soldier is still working on his weapon (${Math.ceil(working / CONFIG.tickRate)}s) and cannot take another upgrade yet.` };
    }
    this.state.points -= cost;
    unit.weaponUpgrades[type] = level + 1;
    const ticks = sec(CONFIG.weaponUpgrades.upgradeSeconds);
    unit.upgradeTimer = ticks;
    this.emit({ type: 'weaponUpgraded', unitId: unit.id, upgrade: type, level: level + 1, ticks });
    return { ok: true };
  }

  /**
   * How long a soldier's weapon stays in pieces after an upgrade. Public so the
   * selection panel can show the countdown without reimplementing the rule.
   */
  upgradeTicksLeft(unit: Unit): number {
    return unit.upgradeTimer ?? 0;
  }

  private radioEngineerRequirementError(action = 'call artillery'): string | null {
    return this.availableRadioEngineers().length === 0
      ? `Deploy an unpinned Combat Radio Engineer to ${action}.`
      : null;
  }

  private availableRadioEngineers(): Unit[] {
    return this.state.units.filter((unit) =>
      unit.team === 'friendly' && unit.role === 'radio_engineer' && unit.health > 0
        && !unit.dead && unit.crossed !== true && !unit.pinned,
    );
  }

  /** Meta-action: after victory, keep playing in endless mode. */
  continueEndless(): boolean {
    if (this.state.phase !== 'victory') return false;
    this.state.endless = true;
    this.state.phase = 'running';
    this.state.scheduler.waveIndex += 1;
    this.state.scheduler.phase = 'prep';
    this.state.scheduler.prepTicksLeft = sec(CONFIG.start.breakSeconds);
    this.state.scheduler.spawnQueue = [];
    this.state.scheduler.rewardGranted = false;
    this.emit({ type: 'wavePhase', wave: this.state.scheduler.waveIndex + 1, phase: 'prep', prepTicksLeft: this.state.scheduler.prepTicksLeft, endless: true });
    return true;
  }

  /** Resolve the one-time reward offered after capturing a sector. */
  claimSectorSupply(
    choice: 'points' | 'medical',
    unitId?: number,
  ): { ok: true; reward: number; unitId?: number } | { ok: false; reason: string } {
    const s = this.state;
    if (!s.sectorSupplyPending || s.phase !== 'running') {
      return { ok: false, reason: 'No sector supply choice is waiting.' };
    }

    if (choice === 'points') {
      const reward = CONFIG.crossing.sectorSupplyPoints;
      s.points += reward;
      s.sectorSupplyPending = false;
      return { ok: true, reward };
    }

    const soldier = s.units.find((unit) =>
      unit.id === unitId && unit.team === 'friendly' && !unit.dead && unit.health > 0 && unit.crossed !== true,
    );
    if (soldier === undefined) return { ok: false, reason: 'Choose a living soldier on the battlefield.' };
    const maxHealth = this.content.friendly[soldier.role as FriendlyRole].health;
    const healed = Math.min(CONFIG.crossing.sectorSupplyHeal, maxHealth - soldier.health);
    if (healed <= 0) return { ok: false, reason: 'That soldier is not wounded.' };

    soldier.health += healed;
    s.sectorSupplyPending = false;
    return { ok: true, reward: healed, unitId: soldier.id };
  }

  // -------------------------------------------------------------- placement

  /** Shared placement validation for UI previews. */
  validatePlacement(kind: 'recruit' | 'barbedWire' | 'sandbag' | 'trench' | 'bunker' | 'bridge' | 'mortarPit' | 'mine' | 'artillery' | 'airSupport' | 'flare', pos: Vec2, role?: FriendlyRole, mineKind?: MineKind): { ok: boolean; reason: string } {
    const s = this.state;
    if (kind === 'recruit' && role) {
      const cost = CONFIG.costs.recruit[role];
      if (s.points < cost) return { ok: false, reason: `Costs ${cost} points` };
      const friendlies = this.livingFriendlies().length;
      if (friendlies >= CONFIG.caps.friendly) return { ok: false, reason: 'Squad at capacity' };
      if (pos.x < 8 || pos.x > CONFIG.field.width - 8 || pos.y < CONFIG.deploymentZone.yMin || pos.y > CONFIG.deploymentZone.yMax) {
        return { ok: false, reason: 'Deploy in the southern zone' };
      }
      const dest = nearestOpenCell(s.terrain, pos, 2);
      if (dest === null || dest.y < CONFIG.deploymentZone.yMin) return { ok: false, reason: 'Blocked ground' };
      return { ok: true, reason: '' };
    }
    if (kind === 'barbedWire') {
      const reason = this.barbedWirePlacementError(pos);
      return { ok: reason === null, reason: reason ?? '' };
    }
    if (kind === 'sandbag') {
      const engineerError = this.engineerRequirementError(pos);
      if (engineerError !== null) return { ok: false, reason: engineerError };
      if (s.points < CONFIG.costs.sandbag) return { ok: false, reason: `Costs ${CONFIG.costs.sandbag} points` };
      if (!this.inBounds(pos, 10)) return { ok: false, reason: 'Out of bounds' };
      if (pos.y < CONFIG.terrain.protectedTopRows * CONFIG.terrain.cell + 8) return { ok: false, reason: 'Too close to enemy approach' };
      if (s.sandbags.some((b) => dist(b.pos, pos) < CONFIG.sandbagMinSpacing)) return { ok: false, reason: 'Too close to another sandbag' };
      if (s.trenches.some((trench) => dist(trench.pos, pos) < CONFIG.trench.halfLength + 12)) return { ok: false, reason: 'Too close to a trench' };
      if (s.bunkers.some((bunker) => dist(bunker.pos, pos) < CONFIG.bunker.occupyRadius + 12)) return { ok: false, reason: 'Too close to a bunker' };
      if (s.mortarPits.some((pit) => dist(pit.pos, pos) < CONFIG.mortarPit.occupyRadius + 12)) return { ok: false, reason: 'Too close to a mortar pit' };
      if (s.constructionSites.some((site) => this.constructionOverlap(site, 'sandbag', pos))) return { ok: false, reason: 'Too close to another construction site' };
      return { ok: true, reason: '' };
    }
    if (kind === 'trench') {
      const reason = this.trenchPlacementError(pos);
      return reason === null ? { ok: true, reason: '' } : { ok: false, reason };
    }
    if (kind === 'bunker') {
      const reason = this.bunkerPlacementError(pos);
      return reason === null ? { ok: true, reason: '' } : { ok: false, reason };
    }
    if (kind === 'bridge') {
      const reason = this.bridgePlacementError(pos);
      return reason === null ? { ok: true, reason: '' } : { ok: false, reason };
    }
    if (kind === 'mortarPit') {
      const reason = this.mortarPitPlacementError(pos);
      return reason === null ? { ok: true, reason: '' } : { ok: false, reason };
    }
    if (kind === 'mine') {
      const reason = this.minePlacementError(mineKind ?? 'ap', pos);
      return reason === null ? { ok: true, reason: '' } : { ok: false, reason };
    }
    if (kind === 'flare') {
      const operatorError = this.radioEngineerRequirementError('call a flare');
      if (operatorError !== null) return { ok: false, reason: operatorError };
      if (!dayNightAtTick(s.ticks, s.dayNightStartTick).night) return { ok: false, reason: 'Flares are only available at night' };
      if (s.flareCooldown > 0) return { ok: false, reason: 'Reloading' };
      if (s.points < CONFIG.costs.flare) return { ok: false, reason: `Costs ${CONFIG.costs.flare} points` };
      if (!this.inBounds(pos, 4)) return { ok: false, reason: 'Out of bounds' };
      return { ok: true, reason: '' };
    }
    const operatorError = this.radioEngineerRequirementError();
    if (operatorError !== null) return { ok: false, reason: operatorError };
    if (kind === 'airSupport') {
      if (s.airSupportCooldown > 0) return { ok: false, reason: 'Rearming' };
      if (s.points < CONFIG.costs.airSupport) return { ok: false, reason: `Costs ${CONFIG.costs.airSupport} points` };
      return { ok: true, reason: '' };
    }
    // Artillery accepts anything in bounds (clamped); warn only when unaffordable/cooling.
    if (s.artilleryCooldown > 0) return { ok: false, reason: 'Reloading' };
    if (s.points < CONFIG.costs.artillery) return { ok: false, reason: `Costs ${CONFIG.costs.artillery} points` };
    return { ok: true, reason: '' };
  }

  private inBounds(pos: Vec2, margin: number): boolean {
    return pos.x >= margin && pos.y >= margin && pos.x <= CONFIG.field.width - margin && pos.y <= CONFIG.field.height - margin;
  }

  // ---------------------------------------------------------------- systems

  private updateScheduler(): void {
    const s = this.state;
    const sched = s.scheduler;
    // The squad is marching out of this map: no further wave starts here, and an
    // abandoned map neither pays a clear reward nor counts toward the campaign.
    if (sched.phase === 'crossing' || sched.phase === 'advance') return;
    if (sched.phase === 'prep') {
      sched.prepTicksLeft--;
      if (sched.prepTicksLeft <= 0) {
        const built = buildSpawnQueue(s.rng, sched, s.endless);
        sched.spawnQueue = built.queue;
        sched.spawnTimer = 1;
        sched.phase = 'spawning';
        this.emit({ type: 'wavePhase', wave: sched.waveIndex + 1, phase: 'spawning', prepTicksLeft: 0, endless: s.endless });
      }
      return;
    }

    const livingEnemies = s.units.reduce((n, u) => (u.team === 'enemy' ? n + 1 : n), 0);

    if (sched.phase === 'spawning') {
      if (sched.spawnQueue.length > 0) {
        sched.spawnTimer--;
        const occupied = s.units.filter((u) => u.team === 'enemy' && !u.dead && u.health > 0)
          .reduce((count, u) => count + 1 + (u.transport?.passengers ?? 0), 0);
        const sapperTeam = sched.spawnQueue[0] === 'sapper' && (s.endless || sched.waveIndex + 1 >= CONFIG.enemySappers.firstWave)
          && sched.spawnQueue.filter((role) => role === 'rifle').length >= 2;
        const spawnCost = sapperTeam ? 3 : sched.spawnQueue[0] === 'troop_transport' ? 1 + CONFIG.troopTransport.capacity : 1;
        if (sched.spawnTimer <= 0 && occupied + spawnCost <= CONFIG.caps.liveEnemies) {
          const archetype = sched.spawnQueue.shift() as EnemyArchetype;
          if (sapperTeam) {
            for (let escort = 0; escort < 2; escort++) sched.spawnQueue.splice(sched.spawnQueue.indexOf('rifle'), 1);
            this.spawnEnemySapperTeam();
          } else this.spawnEnemy(archetype);
          const def = currentWaveDef(sched);
          const interval = def && !s.endless ? def.spawnIntervalSeconds : buildSpawnQueue(s.rng, sched, true).spawnIntervalSeconds;
          sched.spawnTimer = Math.max(1, Math.round(sec(interval) * rngRange(s.rng, 0.85, 1.15)));
        }
        if (sched.spawnQueue.length === 0) {
          sched.phase = 'active';
          this.emit({ type: 'wavePhase', wave: sched.waveIndex + 1, phase: 'active', prepTicksLeft: 0, endless: s.endless });
        }
        return;
      }
      sched.phase = 'active';
      this.emit({ type: 'wavePhase', wave: sched.waveIndex + 1, phase: 'active', prepTicksLeft: 0, endless: s.endless });
      return;
    }

    // active: clear when nothing is left alive.
    if (livingEnemies === 0 && !sched.rewardGranted) {
      sched.rewardGranted = true;
      const wave = sched.waveIndex + 1;
      const reward = CONFIG.rewards.waveClearBase + Math.floor(wave / CONFIG.rewards.waveClearPerLevels);
      s.points += reward;
      s.score += CONFIG.rewards.waveClearBonusScore;
      this.emit({ type: 'waveCleared', wave, reward });
      s.wavesCompleted++;
      if (s.dayNightStartTick === null && s.wavesCompleted >= CONFIG.dayNight.startAfterWaves) {
        s.dayNightStartTick = s.ticks;
        this.emit({ type: 'dayNightStarted' });
      }
      const authored = this.content.waves.length;
      if (!s.endless && sched.waveIndex >= authored - 1) {
        s.score += s.integrity * CONFIG.rewards.integrityBonusScore;
        s.sectorCaptured = true;
        sched.phase = 'advance';
        sched.spawnQueue = [];
        this.emit({ type: 'advanceAvailable' });
        return;
      }
      // In endless play the counter restarts at 1 on every map, so this is what
      // keeps endless wave labels and difficulty climbing across maps.
      if (s.endless) sched.endlessWavesCleared += 1;
      sched.waveIndex++;
      sched.phase = 'prep';
      sched.prepTicksLeft = sec(CONFIG.start.breakSeconds);
      sched.rewardGranted = false;
      this.emit({ type: 'wavePhase', wave: sched.waveIndex + 1, phase: 'prep', prepTicksLeft: sched.prepTicksLeft, endless: s.endless });
    }
  }

  /**
   * Axis counter-battery fire. The enemy fields no artillery unit and pays no
   * points for one: once the campaign has run long enough for their observers to
   * range the line, the battery starts working the defended ground on its own.
   *
   * Nothing is scheduled before `CONFIG.enemyArtillery.firstWaveWithBarrage`, so
   * the opening waves stay a rifle fight. From that wave on the battery has a
   * per-second chance of firing whenever it is ready, and that chance grows with
   * the wave number, which is what makes the late waves heavier without changing
   * a single enemy archetype.
   *
   * A fire mission is aimed at a soldier - never at fixed ground - so it lands
   * where the squad is standing and splitting up genuinely helps. It is marked by
   * the same countdown ring as the player's own fire mission, and the shell that
   * lands is the same shell: it does not care whose side called it in, so an
   * Axis barrage that catches its own advancing infantry kills them too.
   */
  private updateEnemyArtillery(): void {
    const s = this.state;
    const tuning = CONFIG.enemyArtillery;
    if (s.enemyArtilleryCooldown > 0) return;
    // Only while a wave is actually under way. There is nothing to range during
    // the preparation period, and an abandoned map does not shell anyone.
    if (s.scheduler.phase !== 'spawning' && s.scheduler.phase !== 'active') return;

    const targets = this.livingFriendlies();
    if (targets.length === 0) return;
    const observer = s.units.find((unit) => unit.team === 'enemy' && unit.role === 'observer' && unit.health > 0 && !unit.dead && !unit.pinned);
    if (observer === undefined || !targets.some((target) => {
      const concealment = target.specialization === 'camouflage' && !nightContactFor(s, observer, target) ? CONFIG.specialization.camouflageRangeMult : 1;
      return dist(observer.pos, target.pos) <= tuning.observationRange * this.visibilityMultiplierFor(observer, target) * concealment
        && hasLineOfSight(s.terrain, observer.pos, target.pos);
    })) return;

    // Endless play counts every endless wave cleared across maps, so marching
    // north does not put the battery back to sleep; authored play uses the wave
    // counter, which restarts at 1 on a fresh map.
    const wave = s.endless ? endlessWaveNumber(s.scheduler) : s.scheduler.waveIndex + 1;
    if (wave < tuning.firstWaveWithBarrage) return;

    const escalation = wave - tuning.firstWaveWithBarrage + 1;
    const chance = Math.min(tuning.maxChancePerSecond, tuning.chancePerWave * escalation) / CONFIG.tickRate;
    // The battery's own stream: whether the guns are ready is a property of the
    // run, not of the combat randomness, so it cannot be nudged by how the
    // firefight happens to be rolling.
    if (rngNext(s.enemyArtilleryRng) >= chance) return;
    this.fireEnemyBarrage(rngPick(s.enemyArtilleryRng, targets), wave);
  }

  /**
   * Schedule one Axis fire mission onto a soldier, and set the battery's reload.
   * Public like the player's own support path so a test can put a barrage in the
   * air without standing up ten waves to earn one.
   */
  fireEnemyBarrage(aimAt: Unit, wave: number, shellsOverride?: number): Strike[] {
    const s = this.state;
    const battery = s.enemyArtilleryRng;
    const tuning = CONFIG.enemyArtillery;
    const escalation = Math.max(0, wave - tuning.firstWaveWithBarrage);

    // The aim tightens as the campaign goes on: early missions are harassment,
    // later ones are observed fire that lands on the position.
    const span = Math.max(1, tuning.scatterWave - tuning.firstWaveWithBarrage);
    const progress = Math.min(1, Math.max(0, (wave - tuning.firstWaveWithBarrage) / span));
    const scatter = tuning.scatterAtFirstWave + (tuning.scatterAtLastWave - tuning.scatterAtFirstWave) * progress;

    const rolls = tuning.shellsMax - tuning.shellsMin + 1;
    let shells = tuning.shellsMin + rngInt(battery, 0, rolls - 1);
    shells += Math.floor(escalation / Math.max(1, tuning.shellGrowthEveryWaves));
    shells = Math.min(tuning.maxShells, Math.max(1, shells));
    if (shellsOverride !== undefined) shells = Math.max(1, Math.min(tuning.maxShells, shellsOverride));

    const strikes: Strike[] = [];
    for (let i = 0; i < shells; i++) {
      const angle = rngNext(battery) * Math.PI * 2;
      const distance = rngRange(battery, scatter * 0.35, scatter);
      const strike: Strike = {
        id: s.nextEntityId++,
        pos: {
          x: Math.min(CONFIG.field.width - CONFIG.spawnMargin, Math.max(CONFIG.spawnMargin, aimAt.pos.x + Math.cos(angle) * distance)),
          y: Math.min(CONFIG.field.height - 10, Math.max(tuning.minLandY, aimAt.pos.y + Math.sin(angle) * distance)),
        },
        landTick: s.ticks + sec(CONFIG.artillery.delaySeconds) + i * sec(tuning.shellSpacingSeconds),
        radius: CONFIG.artillery.radius,
        damage: CONFIG.artillery.damage,
        suppressionAmount: CONFIG.artillery.suppression,
        source: 'enemy',
      };
      s.strikes.push(strike);
      strikes.push(strike);
    }

    const first = strikes[0] as Strike;
    s.enemyArtilleryCooldown = sec(rngRange(battery, tuning.cooldownSecondsMin, tuning.cooldownSecondsMax));
    this.emit({ type: 'enemyBarrageIncoming', pos: { ...first.pos }, shells: strikes.length, landTick: first.landTick });
    return strikes;
  }

  private updateStrikes(): void {
    const s = this.state;
    for (let i = s.strikes.length - 1; i >= 0; i--) {
      const strike = s.strikes[i] as Strike;
      if (s.ticks < strike.landTick) continue;
      s.strikes.splice(i, 1);
      if (!isRiverAt(this.zones, s.seed, strike.pos.x, strike.pos.y) && !isBridgeAt(this.zones, s.seed, strike.pos.x, strike.pos.y)) {
        const impact = { id: strike.id, kind: strike.delivery ?? 'artillery', pos: { ...strike.pos }, tick: s.ticks };
        const marks = s.groundImpacts ??= [];
        marks.push(impact);
        if (marks.length > MAX_GROUND_IMPACTS) marks.splice(0, marks.length - MAX_GROUND_IMPACTS);
        this.emit({ type: 'groundImpact', impact: { ...impact, pos: { ...impact.pos } }, blastRadius: strike.radius });
      }
      if (strike.delivery === 'mortar') this.emit({ type: 'explosion', pos: strike.pos, radius: strike.radius });
      else this.emit({
        type: 'artilleryImpact',
        pos: strike.pos,
        radius: strike.radius,
        delivery: strike.delivery === 'airSupport' ? 'airSupport' : 'artillery',
      });
      // Air support's bombing run is hostile-only. Other incoming strikes can
      // catch friendlies and use the artillery-specific trench protection.
      const isAirSupport = strike.delivery === 'airSupport';
      this.explodeAt(
        strike.pos,
        strike.radius,
        strike.damage,
        1,
        strike.suppressionAmount,
        strike.sourceId ?? null,
        !isAirSupport,
        !isAirSupport,
      );
    }
  }

  private updateProjectiles(): void {
    const s = this.state;
    for (let i = s.projectiles.length - 1; i >= 0; i--) {
      const p = s.projectiles[i]!;
      const d = dist(p.pos, p.target);
      if (d <= p.speed) {
        s.projectiles.splice(i, 1);
        this.emit({ type: 'explosion', pos: p.target, radius: p.splashRadius });
        this.explodeAt(p.target, p.splashRadius, p.damage, p.armorMult, p.suppressionAmount, p.sourceId);
      } else {
        const t = p.speed / d;
        p.pos = { x: p.pos.x + (p.target.x - p.pos.x) * t, y: p.pos.y + (p.target.y - p.pos.y) * t };
      }
    }
  }

  /** Whether a blast circle reaches any part of a building's footprint. */
  private circleOverlapsBox(pos: Vec2, radius: number, box: { x: number; y: number; w: number; h: number }): boolean {
    const nearestX = Math.max(box.x, Math.min(pos.x, box.x + box.w));
    const nearestY = Math.max(box.y, Math.min(pos.y, box.y + box.h));
    return Math.hypot(pos.x - nearestX, pos.y - nearestY) <= radius;
  }

  /**
   * Queue an artillery strike directly, bypassing the radio engineer, the points
   * and the cooldown. Public for tests that need a detonation on a chosen spot
   * without standing up a whole wave to pay for it.
   */
  artilleryStrikeFor(landTick: number, pos: Vec2): Strike {
    const strike: Strike = {
      id: this.state.nextEntityId++,
      pos: { ...pos },
      landTick: this.state.ticks + landTick,
      radius: CONFIG.artillery.radius,
      damage: CONFIG.artillery.damage,
      suppressionAmount: CONFIG.artillery.suppression,
      source: 'friendly',
    };
    this.state.strikes.push(strike);
    return strike;
  }

  /** Every building still standing that the segment from `from` to `to` passes through. */
  buildingOnSegment(from: Vec2, to: Vec2, shooter?: Unit, target?: Unit): Building | null {
    let best: Building | null = null;
    let bestDistance = Infinity;
    for (const building of this.state.buildings) {
      if (building.destroyed) continue;
      if (building.id === shooter?.buildingPosition?.buildingId || building.id === target?.buildingPosition?.buildingId) continue;
      const box = this.buildingGeometry.get(building.id);
      if (box === undefined) continue;
      const t = this.segmentBoxEntry(from, to, box);
      if (t === null) continue;
      if (shooter && target) {
        const end = 1 - (this.segmentBoxEntry(to, from, box) ?? 0);
        const startHeight = elevationAt(this.state.terrain, from.x, from.y) + unitEyeHeight(this.state.terrain, shooter);
        const endHeight = elevationAt(this.state.terrain, to.x, to.y) + unitEyeHeight(this.state.terrain, target);
        const top = elevationAt(this.state.terrain, box.cx, box.cy) + buildingArchitecture(building).floors * FLOOR_HEIGHT + 3;
        if (Math.min(startHeight + (endHeight - startHeight) * t, startHeight + (endHeight - startHeight) * end) > top) continue;
      }
      if (t < bestDistance) {
        bestDistance = t;
        best = building;
      }
    }
    return best;
  }

  /**
   * Where along the segment a shot first enters an axis-aligned box, as a
   * fraction of the segment, or null when it never does. A ray/box slab test:
   * cheap, exact, and it needs no cell-by-cell walk.
   */
  private segmentBoxEntry(from: Vec2, to: Vec2, box: { x: number; y: number; w: number; h: number }): number | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let tMin = 0;
    let tMax = 1;
    for (const [origin, delta, min, max] of [
      [from.x, dx, box.x, box.x + box.w],
      [from.y, dy, box.y, box.y + box.h],
    ] as const) {
      if (Math.abs(delta) < 1e-6) {
        // Parallel to this slab: it can only be inside if it starts inside.
        if (origin < min || origin > max) return null;
        continue;
      }
      const t1 = (min - origin) / delta;
      const t2 = (max - origin) / delta;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) return null;
    }
    // A shooter standing inside a footprint would otherwise shoot its own wall.
    return tMin <= 0 ? null : tMin;
  }

  /** Damage a structure takes from one weapon, before any falloff. */
  private buildingDamageFrom(unit: Unit, weapon: WeaponStats, hitFactor: number): number {
    const raw = this.weaponDamage(unit, weapon.damage) * hitFactor;
    return weapon.kind === 'hitscan' ? raw * CONFIG.buildings.smallArmsDamageMult : raw;
  }

  /**
   * Apply damage to a structure. A building that reaches zero health collapses:
   * its footprint becomes walkable ground, it stops blocking sight and bullets,
   * and it is left on the map as a ruin so the field still reads as built-up.
   */
  damageBuilding(building: Building, amount: number): void {
    if (building.destroyed || amount <= 0) return;
    building.health = Math.max(0, building.health - amount);
    const box = this.buildingGeometry.get(building.id);
    const centre = box === undefined ? { ...building.pos } : { x: box.cx, y: box.cy };
    if (building.health > 0) {
      this.emit({ type: 'buildingHit', buildingId: building.id, pos: centre, damage: amount, healthAfter: building.health });
      return;
    }
    building.destroyed = true;
    for (const unit of this.state.units) {
      if (unit.buildingPosition?.buildingId !== building.id && unit.buildingOrder?.buildingId !== building.id) continue;
      const occupied = unit.buildingPosition !== undefined;
      delete unit.buildingPosition;
      delete unit.buildingOrder;
      const safe = nearestOpenCell({ ...this.state.terrain, blocked: this.state.terrain.baseBlocked ?? this.state.terrain.blocked }, centre, 4) ?? centre;
      unit.pos = { ...safe }; unit.prevPos = { ...safe }; unit.path = []; unit.moveGoal = null;
      if (occupied) {
        const damage = applyDamageToUnit(this.content, unit, 40, 1);
        if (damage.killed) this.killUnit(unit, null);
      }
    }
    // Reopening the ground is the whole point: the floor plan plus the buildings
    // still standing is the live grid.
    rebuildBlocked(this.state.terrain, this.state.buildings);
    this.emit({ type: 'buildingDestroyed', buildingId: building.id, name: building.name, kind: building.kind, pos: centre });
  }

  /**
   * Area damage used by projectiles, artillery, mines and AT rounds. Hits both
   * sides by default; `friendlyFire` narrows it to hostiles only. Returns the
   * number of units actually damaged, for reporting.
   *
   * There is deliberately no "who fired this" parameter. A shell is a shell: the
   * player's own barrage can catch the squad it was called in to protect, and an
   * Axis barrage that walks onto its own advancing infantry kills them just as
   * readily. That symmetry is the point, not an oversight.
   */
  private damageTree(cell: number, amount: number, blast: boolean): void {
    if (!(amount > 0) || !isTreeKind(this.terrainKinds[cell]!)) return;
    const records = this.state.treeDamage ??= [];
    let tree = records.find((record) => record.cell === cell);
    if (!tree) { tree = { cell, kind: this.terrainKinds[cell]!, health: TREE_HEALTH }; records.push(tree); }
    tree.health = Math.max(0, tree.health - amount);
    if (tree.health === 0) this.terrainKinds[cell] = TERRAIN_KIND.open;
    this.emit({ type: 'treeHit', cell, pos: treeCellPosition(this.state.terrain, cell), health: tree.health, blast });
  }

  private explodeAt(
    pos: Vec2,
    radius: number,
    damage: number,
    armorMult: number,
    suppression: number,
    sourceId: number | null,
    friendlyFire = true,
    artilleryBlast = false,
  ): number {
    const s = this.state;
    let victims = 0;
    const terrain = s.terrain;
    for (let row = Math.max(0, Math.floor((pos.y - radius) / terrain.cell)); row <= Math.min(terrain.rows - 1, Math.floor((pos.y + radius) / terrain.cell)); row++) {
      for (let col = Math.max(0, Math.floor((pos.x - radius) / terrain.cell)); col <= Math.min(terrain.cols - 1, Math.floor((pos.x + radius) / terrain.cell)); col++) {
        const cell = row * terrain.cols + col;
        if (!isTreeKind(this.terrainKinds[cell]!)) continue;
        const distance = dist(pos, treeCellPosition(terrain, cell));
        if (distance <= radius) this.damageTree(cell, damage * 1.4 * (1 - distance / Math.max(1, radius) * .8), true);
      }
    }
    // Structures catch the blast too, and artillery is the practical way to level
    // one: a shell does not care that small arms barely scratch masonry.
    for (const building of [...s.buildings]) {
      if (building.destroyed) continue;
      const box = this.buildingGeometry.get(building.id);
      if (box === undefined) continue;
      if (!this.circleOverlapsBox(pos, radius, box)) continue;
      victims += 1;
      this.damageBuilding(building, damage);
    }
    for (const unit of [...s.units]) {
      if (unit.health <= 0) continue;
      if (friendlyFire === false && unit.team === 'friendly') continue;
      if (dist(unit.pos, pos) > radius) continue;
      const inTrench = artilleryBlast && isInTrench(s.trenches, unit.pos, CONFIG);
      const inMortarPit = artilleryBlast && unit.team === 'friendly' && unit.role === 'mortarman'
        && s.mortarPits.some((pit) => dist(pit.pos, unit.pos) <= CONFIG.mortarPit.occupyRadius);
      const structureDamageMult = inMortarPit ? CONFIG.mortarPit.artilleryDamageMult : inTrench ? CONFIG.trench.artilleryDamageMult : 1;
      const applied = this.damageUnit(unit, damage * structureDamageMult, armorMult);
      victims += 1;
      if (applied.killed) this.killUnit(unit, sourceId);
    }
    for (const unit of s.units) {
      if (unit.health <= 0) continue;
      if (friendlyFire === false && unit.team === 'friendly') continue;
      if (dist(unit.pos, pos) <= radius) {
        const inTrench = artilleryBlast && isInTrench(s.trenches, unit.pos, CONFIG);
        const inMortarPit = artilleryBlast && unit.team === 'friendly' && unit.role === 'mortarman'
          && s.mortarPits.some((pit) => dist(pit.pos, unit.pos) <= CONFIG.mortarPit.occupyRadius);
        const structureSuppressionMult = inMortarPit ? CONFIG.mortarPit.artillerySuppressionMult : inTrench ? CONFIG.trench.artillerySuppressionMult : 1;
        applySuppression(unit, suppression * structureSuppressionMult, CONFIG);
      }
    }
    return victims;
  }

  private updateUnits(): void {
    const s = this.state;
    const snapshot = [...s.units];
    for (const unit of snapshot) {
      if (unit.health <= 0 || s.phase !== 'running') continue;
      unit.prevPos = { x: unit.pos.x, y: unit.pos.y };
      unit.running = false;
      // Older saves had only the upper crossing; infer that level for them.
      if (!unit.bridgePosition && !unit.buildingPosition) {
        const bridge = s.terrain.bridges?.find((candidate) => bridgeContains(candidate, unit.pos));
        if (bridge) unit.bridgePosition = { key: bridgeKey(bridge), level: 'deck' };
      }
      // A soldier walking off the northern edge is not fighting on this map and
      // is driven by the crossing pass instead: no suppression, no morale, no
      // target acquisition, no firing.
      if (unit.crossed === true) continue;
      // Enemy bounding state: which half of the pair this unit belongs to.
      unit.advanceFlip = Math.floor((Math.imul(unit.id, 2654435761) >>> 0) % 2) === 0;

      // Suppression decay and pin hysteresis.
      const officerNearby = unit.team === 'friendly' && this.nearbyOfficer(unit);
      const suppressionRecoveryMult = officerNearby ? CONFIG.morale.officerSuppressionRecoveryMult : 1;
      unit.suppression = Math.max(0, unit.suppression - CONFIG.suppression.decayPerTick * suppressionRecoveryMult);
      if (unit.pinned) {
        if (unit.stance === undefined && !isVehicle(this.content, unit)) {
          unit.crawling = unit.id % 4 === 0;
          unit.stance = unit.crawling || unit.id % 3 === 0 ? 'prone' : 'crouching';
        }
        if (unit.suppression <= CONFIG.suppression.recoverThreshold) unit.pinned = false;
        else unit.path = []; // hunkered down: movement orders are dropped until recovery
      } else if (unit.suppression >= CONFIG.suppression.pinThreshold) {
        unit.pinned = true;
        unit.path = [];
        unit.burstRemaining = 0;
        if (!isVehicle(this.content, unit)) {
          // A few immediately belly-crawl; others instinctively crouch or flatten out.
          unit.crawling = unit.id % 4 === 0;
          unit.stance = unit.crawling || unit.id % 3 === 0 ? 'prone' : 'crouching';
        }
      }
      if (unit.ambush) {
        if (unit.pinned && unit.ambush.triggered) delete unit.ambush;
        else if (!unit.pinned && unit.path.length === 0 && !unit.buildingOrder && (unit.upgradeTimer ?? 0) === 0) {
          unit.ambush.prepTicks = Math.max(0, unit.ambush.prepTicks - 1);
        }
      }
      this.updateMorale(unit);

      unit.reloadTimer = Math.max(0, unit.reloadTimer - 1);
      unit.shotTimer = Math.max(0, unit.shotTimer - 1);
      unit.secondaryReloadTimer = Math.max(0, (unit.secondaryReloadTimer ?? 0) - 1);
      unit.secondaryBurstRemaining = Math.max(0, unit.secondaryBurstRemaining ?? 0);
      unit.secondaryShotTimer = Math.max(0, (unit.secondaryShotTimer ?? 0) - 1);
      unit.healTimer = Math.max(0, unit.healTimer - 1);
      unit.grenadeTimer = Math.max(0, unit.grenadeTimer - 1);
      unit.mortarTimer = Math.max(0, (unit.mortarTimer ?? 0) - 1);
      unit.upgradeTimer = Math.max(0, (unit.upgradeTimer ?? 0) - 1);
      unit.buildingCooldown = Math.max(0, (unit.buildingCooldown ?? 0) - 1);
      if (unit.tankCrew && unit.tankCrew.bailoutTicks > 0) {
        unit.tankCrew.bailoutTicks--; unit.path = []; unit.moveGoal = null; unit.targetId = null;
        unit.burstRemaining = 0; unit.movementPace = 'walk';
        continue;
      }
      if (unit.medicalTargetId !== undefined && !this.needsMedic(this.findUnit(unit.medicalTargetId))) {
        delete unit.medicalTargetId;
        delete unit.buildingOrder;
        unit.path = []; unit.moveGoal = null; unit.running = false;
      }
      if (unit.fireOrder === 'seekGunfire' && !unit.pinned) this.leaveBuilding(unit);
      if (this.updateBuildingOrder(unit)) continue;

      const weapon = this.weaponOf(unit);
      const enemies = s.units.filter((u) => u.team !== unit.team && u.health > 0
        && (!unit.ambush || unit.ambush.triggered || (unit.ambush.prepTicks === 0 && insideAmbushArc(unit.pos, unit.ambush, u.pos)
          && this.ambushSees(unit, u))));
      const visibility = (target: Unit): number => this.visibilityMultiplierFor(unit, target);

      // Target retention: keep a valid target; re-acquire only when invalid.
      let target = unit.targetId !== null ? enemies.find((e) => e.id === unit.targetId) ?? null : null;
      const wasEngaged = target !== null;
      if (weapon && target !== null && !targetIsValid(this.content, s.terrain, s.sandbags, unit, target, weapon, CONFIG, s.trenches, s.smokes, visibility)) {
        target = null;
      }
      if (weapon && target === null && !unit.pinned) {
        target = acquireTarget(this.content, s.terrain, s.sandbags, unit, enemies, weapon, CONFIG, s.trenches, unit.team === 'friendly' ? (unit.fireOrder ?? 'auto') : 'auto', s.smokes, visibility, (candidate) => nightContactFor(s, unit, candidate) !== undefined);
      }
      let supportingPinnedComrade = false;
      if (unit.team === 'enemy' && weapon?.kind === 'hitscan' && !unit.pinned) {
        const supportTarget = this.pinnedComradeSuppressor(unit, enemies, weapon, visibility);
        if (supportTarget !== null) {
          target = supportTarget;
          supportingPinnedComrade = true;
        }
      }
      unit.targetId = target ? target.id : null;
      if (unit.ambush?.triggered && target === null) delete unit.ambush;

      if (unit.tankCrew?.behavior === 'retreat') {
        this.retreatTankCrew(unit);
        if (unit.dead) continue;
      } else if (unit.buildingPosition) {
        unit.path = [];
        if (unit.team === 'friendly' && unit.role === 'medic') this.medicBehavior(unit);
        if (unit.team === 'friendly' && unit.role === 'supply_officer') this.supplyBehavior(unit);
        if (unit.team === 'enemy' && target === null && (s.ticks + unit.id) % 90 === 0) this.leaveBuilding(unit);
      } else if (unit.team === 'enemy') {
        const team = s.enemySapperTeams.find((candidate) => candidate.sapperId === unit.id || candidate.escortIds.includes(unit.id));
        const onMission = team !== undefined && this.demolitionTeamBehavior(unit, team);
        if ((onMission && team!.sapperId === unit.id) || (!onMission && this.sapperBehavior(unit))) {
          this.advanceAlongPath(unit);
          if (unit.health > 0 && unit.pos.y >= CONFIG.breakthroughY) this.breakthrough(unit);
          continue;
        }
        if (!onMission) {
          if (!s.enemySmokeAssaults?.some((plan) => plan.unitIds.includes(unit.id)) && this.seekEnemyBuilding(unit)) continue;
          this.enemyBehavior(unit, target, weapon, target !== null && !wasEngaged, supportingPinnedComrade);
        }
      } else {
        if (!this.dodgeIncomingArtillery(unit)) this.friendlyBehavior(unit, target, weapon);
      }

      // Movement along path (moving units hold fire; pinned units hold still).
      const moved = this.advanceAlongPath(unit);
      if (moved) delete unit.ambush;

      // Firing. A grenade is the answer to a position rifles cannot reach, so it
      // is considered first, and a throw spends the turn instead of a shot. A
      // unit with no valid rifle target can still throw, provided it has one.
      //
      // A soldier fitting a personal weapon upgrade is doing that work with both
      // hands: his weapon is in pieces, so he neither shoots nor throws until it
      // is back together. Movement is untouched - he can still be walked behind
      // cover - and the upgrade itself is already banked, so the only thing at
      // risk is the next few seconds of fire.
      const upgrading = (unit.upgradeTimer ?? 0) > 0;
      if (unit.team === 'friendly' && unit.role === 'mortarman' && !unit.pinned && !moved && !upgrading) {
        this.tryMortarFire(unit, enemies);
      }
      const canFireWhileMoving = unit.role === 'gun_truck' || unit.role === 'vehicle';
      if (!unit.pinned && unit.tankCrew?.behavior !== 'retreat' && (!moved || canFireWhileMoving) && !upgrading && ((weapon && target) || unit.grenades > 0)) {
        const threw = !unit.ambush && !moved && (unit.fireOrder ?? 'auto') !== 'holdGrenades' && this.tryThrowGrenade(unit, enemies);
        if (!threw && weapon && target) this.tryFire(unit, target, weapon, moved);
      }

      // German armor keeps its cannon on the primary firing cycle and sweeps
      // infantry with a hull MG on an independent cycle, including on the move.
      const secondaryWeapon = this.secondaryWeaponOf(unit);
      if (secondaryWeapon !== null && !unit.pinned && !upgrading) {
        const infantry = enemies.filter((candidate) => !isVehicle(this.content, candidate));
        const secondaryTarget = this.pinnedComradeSuppressor(unit, infantry, secondaryWeapon, visibility)
          ?? acquireTarget(
            this.content,
            s.terrain,
            s.sandbags,
            unit,
            infantry,
            secondaryWeapon,
            CONFIG,
            s.trenches,
            'auto',
            s.smokes,
            visibility,
            (candidate) => nightContactFor(s, unit, candidate) !== undefined,
          )
          // If no infantry target is reachable, the tank's MG can still engage
          // a visible vehicle such as the player's machine-gun truck.
          ?? acquireTarget(
            this.content,
            s.terrain,
            s.sandbags,
            unit,
            enemies,
            secondaryWeapon,
            CONFIG,
            s.trenches,
            'auto',
            s.smokes,
            visibility,
            (candidate) => nightContactFor(s, unit, candidate) !== undefined,
          );
        if (secondaryTarget !== null) this.tryFireSecondary(unit, secondaryTarget, secondaryWeapon, moved);
      }

      // Breakthrough: even an enemy that halts at the line to shoot has crossed it.
      if (unit.team === 'enemy' && unit.tankCrew?.behavior !== 'retreat' && unit.health > 0 && unit.pos.y >= CONFIG.breakthroughY) {
        this.breakthrough(unit);
      }
    }

    this.separate();
    for (const unit of s.units) updateStamina(unit);

    // Remove the dead once.
    if (s.units.some((u) => u.dead || u.health <= 0)) {
      s.units = s.units.filter((u) => !u.dead && u.health > 0);
    }
  }

  private updateMorale(unit: Unit): void {
    const tuning = CONFIG.morale;
    const officerNearby = unit.team === 'friendly' && this.nearbyOfficer(unit);
    if (unit.pinned || unit.suppression > CONFIG.suppression.recoverThreshold) {
      const pressure = Math.max(0.25, unit.suppression / CONFIG.suppression.pinThreshold);
      const moraleSupportMult = officerNearby ? 0.65 : 1;
      unit.morale -= tuning.suppressionLossPerSecondAtPin * pressure * moraleSupportMult / CONFIG.tickRate;
    } else {
      const supported = this.state.units.some((ally) =>
        ally.id !== unit.id && ally.team === unit.team && ally.health > 0 && dist(ally.pos, unit.pos) <= tuning.cohesionRange,
      );
      const recovery = tuning.recoveryPerSecond + (supported ? tuning.cohesionBonusPerSecond : 0)
        + (officerNearby ? tuning.officerMoraleRecoveryBonusPerSecond : 0);
      unit.morale += recovery / CONFIG.tickRate;
    }
    unit.morale = Math.max(0, Math.min(100, unit.morale));
  }

  private nearbyOfficer(unit: Unit): boolean {
    return this.state.units.some((ally) => ally.id !== unit.id && ally.team === 'friendly' && ally.role === 'officer'
      && ally.health > 0 && !ally.dead && !ally.pinned && ally.crossed !== true
      && dist(ally.pos, unit.pos) <= CONFIG.morale.officerAuraRange);
  }

  private changeNearbyMorale(team: Team, pos: Vec2, amount: number): void {
    const range = CONFIG.morale.cohesionRange;
    for (const unit of this.state.units) {
      if (unit.team !== team || unit.health <= 0 || dist(unit.pos, pos) > range) continue;
      unit.morale = Math.max(0, Math.min(100, unit.morale + amount));
    }
  }

  /** Returns true when the unit moved this tick. */
  private advanceAlongPath(unit: Unit): boolean {
    if (tankImmobilized(unit)) { unit.path = []; unit.moveGoal = null; unit.advance = false; return false; }
    const terrain = this.state.terrain;
    const vehicle = isVehicle(this.content, unit);
    unit.terrainCrawling = !vehicle && !unit.buildingPosition && slopeAt(terrain, unit.pos.x, unit.pos.y) > ELEVATION.walkGrade;
    if (unit.pinned || unit.path.length === 0) return false;
    const wp = unit.path[0] as Vec2;
    const currentBridge = unitBridge(terrain, unit);
    if (currentBridge && unit.bridgePosition?.level === 'deck') unit.terrainCrawling = false;
    // Attackers normally walk too, but can make a short exposed bound or dash
    // out of shellfire. They wait for substantial recovery before another run.
    if (unit.team === 'enemy' && unit.movementPace !== 'run' && canRun(unit)
      && (unit.stamina ?? 1) >= CONFIG.infantryMovement.enemyRunStamina
      && (unit.targetId !== null || unit.suppression > CONFIG.suppression.recoverThreshold
        || this.state.strikes.some((strike) => (strike.source ?? 'friendly') === 'friendly'
          && strikeIsImminent(strike, this.state.ticks) && dist(unit.pos, strike.pos) <= strike.radius + 38))) unit.movementPace = 'run';
    unit.running = unit.movementPace === 'run' && canRun(unit);
    const d = dist(unit.pos, wp);
    // Navigation checks the full route. Posture and movement speed depend on
    // this step, not a steep face still several metres ahead at the waypoint.
    const stride = d > 0 ? Math.min(1, this.speedOf(unit) / CONFIG.tickRate / d) : 1;
    const next = { x: unit.pos.x + (wp.x - unit.pos.x) * stride, y: unit.pos.y + (wp.y - unit.pos.y) * stride };
    const bridgeStep = bridgeTraversal(terrain, unit.pos, next, unit.bridgePosition, vehicle ? 'vehicle' : 'infantry');
    if (!bridgeStep.allowed) { unit.path = []; unit.running = false; return false; }
    const traversal = elevationTraversal(terrain, unit.pos, next, vehicle ? 'vehicle' : 'infantry');
    if (!traversal.allowed) { unit.path = []; unit.running = false; return false; }
    unit.terrainCrawling ||= bridgeStep.position?.level !== 'deck' && traversal.requiresCrawl;
    if (unit.terrainCrawling) unit.running = false;
    const speedPerTick = this.speedOf(unit) / CONFIG.tickRate * traversal.speedMult;
    const destination = d <= speedPerTick ? { x: wp.x, y: wp.y }
      : { x: unit.pos.x + ((wp.x - unit.pos.x) / d) * speedPerTick, y: unit.pos.y + ((wp.y - unit.pos.y) / d) * speedPerTick };
    const finalBridge = bridgeTraversal(terrain, unit.pos, destination, unit.bridgePosition, vehicle ? 'vehicle' : 'infantry');
    if (!finalBridge.allowed) { unit.path = []; unit.running = false; return false; }
    if (d <= speedPerTick) {
      unit.pos = destination;
      unit.path.shift();
    } else {
      unit.pos = destination;
    }
    if (finalBridge.position) unit.bridgePosition = finalBridge.position;
    else delete unit.bridgePosition;
    return true;
  }

  /**
   * Push units apart when they are standing in the same place. Units that are
   * both actively following a path are left alone: the separation force can
   * outweigh a slow vehicle's per-tick movement and wedge two of them against
   * each other permanently, stalling the wave. Letting them overlap briefly
   * while they pass is far better than a deadlock.
   */
  private separate(): void {
    const s = this.state;
    const units = s.units;
    const sepRadius = UNIT_SEPARATION.infantry;
    // Armour needs far more room than infantry, and keeping vehicles apart stops
    // one artillery concentration from removing a whole push at once.
    const vehicleRadius = UNIT_SEPARATION.vehicle;
    const moving = (unit: Unit): boolean => !unit.pinned && unit.path.length > 0;
    const displaced = new Set<Unit>();
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      if (a.health <= 0 || a.buildingPosition || a.buildingOrder) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        if (b.health <= 0 || b.buildingPosition || b.buildingOrder || a.team !== b.team) continue;
        if (Math.abs(bridgeFootHeight(s.terrain, a) - bridgeFootHeight(s.terrain, b)) > 8) continue;
        if (moving(a) && moving(b)) continue;
        const radius = (isVehicle(this.content, a) || isVehicle(this.content, b)) ? vehicleRadius : sepRadius;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        if (d >= radius || d < 0.0001) continue;
        const push = ((radius - d) / radius) * 0.6;
        const nx = dx / d;
        const ny = dy / d;
        if (!a.pinned && !moving(a)) displaced.add(a);
        if (!b.pinned && !moving(b)) displaced.add(b);
        // A pinned soldier is hunkered down. Passing allies yield around them.
        this.nudge(a, -nx * push * (b.pinned ? 2 : 1), -ny * push * (b.pinned ? 2 : 1));
        this.nudge(b, nx * push * (a.pinned ? 2 : 1), ny * push * (a.pinned ? 2 : 1));
      }
    }
    // Slow climbers can take several seconds to pass a settled formation.
    // Rejoin the ordered slot after yielding instead of being pushed away for good.
    for (const unit of displaced) {
      if (unit.team !== 'friendly' || unit.pinned || unit.patrol || unit.moveGoal === null || dist(unit.pos, unit.moveGoal) <= sepRadius) continue;
      // Yield beside an occupied slot instead of repeatedly walking into its
      // occupant and being pushed out again. Fresh player orders still win.
      if (this.movementGoalOccupied(unit)) continue;
      const route = this.findUnitPath(unit, unit.pos, unit.moveGoal);
      if (route.reachable) unit.path = route.waypoints;
    }
  }

  private movementGoalOccupied(unit: Unit): boolean {
    const pos = unit.moveGoal;
    if (!pos) return false;
    const goal = { ...unit, pos }, terrain = this.state.terrain;
    return this.state.units.some((other) => other.id !== unit.id && other.team === unit.team && other.health > 0 && !other.dead && !other.crossed
      && !other.buildingPosition && !other.buildingOrder
      && Math.abs(bridgeFootHeight(terrain, other) - bridgeFootHeight(terrain, goal)) <= 8
      && dist(other.pos, pos) < (isVehicle(this.content, unit) || isVehicle(this.content, other) ? UNIT_SEPARATION.vehicle : UNIT_SEPARATION.infantry) + 1);
  }

  /** Nudge a unit without walking it into solid terrain or out of bounds. */
  private nudge(unit: Unit, dx: number, dy: number): void {
    if (unit.pinned || tankImmobilized(unit)) return;
    const nx = Math.min(CONFIG.field.width - 2, Math.max(2, unit.pos.x + dx));
    const ny = Math.min(CONFIG.field.height - 2, Math.max(-16, unit.pos.y + dy));
    // Resolve axis-by-axis so corridors don't trap units.
    const mode = isVehicle(this.content, unit) ? 'vehicle' : 'infantry';
    const tryStep = (pos: Vec2): void => {
      if (this.isSolid(pos.x, pos.y) || !elevationTraversal(this.state.terrain, unit.pos, pos, mode).allowed) return;
      const step = bridgeTraversal(this.state.terrain, unit.pos, pos, unit.bridgePosition, mode);
      if (!step.allowed) return;
      unit.pos = pos;
      if (step.position) unit.bridgePosition = step.position; else delete unit.bridgePosition;
    };
    tryStep({ x: nx, y: unit.pos.y });
    if (ny > -16) tryStep({ x: unit.pos.x, y: ny });
  }

  private isSolid(x: number, y: number): boolean {
    if (y < 0) return false;
    const terrain = this.state.terrain;
    const col = Math.min(terrain.cols - 1, Math.max(0, Math.floor(x / terrain.cell)));
    const row = Math.min(terrain.rows - 1, Math.max(0, Math.floor(y / terrain.cell)));
    return terrain.blocked[row * terrain.cols + col] === 1;
  }

  // --------------------------------------------------------------- behavior

  /** Retreating crew leave through the enemy edge without scoring a breakthrough. */
  private retreatTankCrew(unit: Unit): void {
    const crew = unit.tankCrew!;
    unit.advance = true;
    if (unit.pinned) return;
    if (dist(unit.pos, crew.exit) <= this.state.terrain.cell / 2) {
      unit.dead = true; unit.health = 0; unit.path = []; unit.moveGoal = null; unit.targetId = null;
      this.emit({ type: 'tankCrewEscaped', unitId: unit.id, tankId: crew.tankId, pos: { ...unit.pos } });
      return;
    }
    if (!unit.path.length && this.state.ticks >= crew.retryTick) {
      crew.retryTick = this.state.ticks + CONFIG.tickRate;
      const cell = this.state.terrain.cell;
      const exits = [crew.exit.x, unit.pos.x, cell / 2, CONFIG.field.width - cell / 2, CONFIG.field.width / 2];
      for (const x of exits) {
        const goal = nearestOpenCell(this.state.terrain, { x, y: cell / 2 }, 1);
        if (!goal || goal.y > cell / 2) continue;
        const route = this.findUnitPath(unit, unit.pos, goal);
        if (!route.reachable) continue;
        crew.exit = { ...goal }; unit.path = route.waypoints; unit.moveGoal = { ...goal };
        break;
      }
      // A crew trapped away from every exit defends itself rather than waiting forever.
      if (!unit.path.length) { crew.behavior = 'fight'; unit.moveGoal = null; }
    }
    if (unit.path.length && canRun(unit) && (unit.stamina ?? 1) >= CONFIG.infantryMovement.enemyRunStamina) unit.movementPace = 'run';
  }

  /** Unarmed trucks rush their drop-off, unload atomically, then drive back north. */
  private transportBehavior(unit: Unit): void {
    const transport = unit.transport;
    if (!transport || unit.pinned) return;
    unit.advance = true;
    const withdrawing = transport.passengers === 0;
    const destination = withdrawing ? transport.exit : transport.dropOff;
    if (dist(unit.pos, destination) > this.state.terrain.cell * .75) {
      if (!unit.path.length && this.state.ticks >= transport.retryTick) {
        transport.retryTick = this.state.ticks + CONFIG.tickRate;
        const step = this.state.terrain.cell * 2;
        const offsets = [{ x: 0, y: 0 }, { x: -step, y: 0 }, { x: step, y: 0 }, { x: 0, y: -step }, { x: 0, y: step },
          { x: -step, y: -step }, { x: step, y: -step }, { x: -step, y: step }, { x: step, y: step }];
        for (const offset of offsets) {
          const proposed = { x: Math.max(12, Math.min(CONFIG.field.width - 12, destination.x + offset.x)),
            y: withdrawing ? 12 : Math.max(12, Math.min(CONFIG.breakthroughY - 48, destination.y + offset.y)) };
          const goal = nearestOpenCell(this.state.terrain, proposed, 3);
          if (!goal) continue;
          const route = this.findUnitPath(unit, unit.pos, goal);
          if (route.reachable) {
            if (withdrawing) transport.exit = { ...goal }; else transport.dropOff = { ...goal };
            unit.path = route.waypoints; unit.moveGoal = { ...goal };
            break;
          }
        }
      }
      return;
    }
    unit.path = []; unit.moveGoal = null; unit.advance = false;
    if (withdrawing) {
      // Departure is neither a kill nor a breakthrough.
      unit.dead = true; unit.health = 0;
      return;
    }
    if (transport.unloadTicks > 0) { transport.unloadTicks--; return; }
    if (this.state.ticks < transport.retryTick) return;
    transport.retryTick = this.state.ticks + CONFIG.tickRate;
    const slots: Vec2[] = [];
    const infantry = { ...unit, role: 'rifle' as const };
    const cell = this.state.terrain.cell;
    for (let ring = 1; ring <= 3 && slots.length < transport.passengers; ring++) {
      for (let row = -ring; row <= ring && slots.length < transport.passengers; row++) {
        for (let col = -ring; col <= ring && slots.length < transport.passengers; col++) {
          if (Math.max(Math.abs(row), Math.abs(col)) !== ring) continue;
          const candidate = nearestOpenCell(this.state.terrain, { x: unit.pos.x + col * cell * 1.5, y: unit.pos.y + row * cell * 1.5 }, 1);
          if (!candidate || slots.some((p) => dist(p, candidate) < cell * .75)
            || this.state.units.some((u) => u.id !== unit.id && !u.dead && u.health > 0 && dist(u.pos, candidate) < cell * .75)) continue;
          if (this.findUnitPath(infantry, unit.pos, candidate).reachable) slots.push(candidate);
        }
      }
    }
    // Keep everyone aboard if six safe dismount points cannot yet be found.
    if (slots.length !== transport.passengers) return;
    const count = transport.passengers;
    transport.passengers = 0;
    for (const position of slots) {
      this.spawnEnemy('rifle', position);
      const soldier = this.state.units[this.state.units.length - 1]!;
      soldier.laneX = unit.laneX;
      const bridge = unitBridge(this.state.terrain, { ...unit, pos: position });
      if (bridge && unit.bridgePosition?.key === bridgeKey(bridge)) soldier.bridgePosition = { ...unit.bridgePosition };
    }
    transport.retryTick = 0;
    this.emit({ type: 'transportUnloaded', unitId: unit.id, count, pos: { ...unit.pos } });
  }

  private enemyBehavior(unit: Unit, target: Unit | null, weapon: WeaponStats | null, justAcquired = false, supportingPinnedComrade = false): void {
    if (tankImmobilized(unit)) { unit.path = []; unit.moveGoal = null; unit.advance = false; return; }
    if (unit.role === 'troop_transport') { this.transportBehavior(unit); return; }
    if (unit.pinned) {
      unit.advance = false;
      return;
    }
    if (this.dodgeIncomingArtillery(unit)) return;
    if (this.advanceUnderSmoke(unit)) return;

    if (unit.team === 'enemy') {
      const flareSignature = this.nightFlareSignature();
      if (flareSignature !== '') {
        const routeEntersLight = this.enemyRouteEntersFlare(unit);
        if (routeEntersLight && this.enemyFlareRouteSignatures.get(unit.id) !== flareSignature) {
          this.enemyFlareRouteSignatures.set(unit.id, flareSignature);
          const goal = unit.moveGoal ?? { x: unit.laneX, y: CONFIG.breakthroughY + 8 };
          const reroute = this.findEnemyPath(unit.pos, goal, unit);
          if (reroute.reachable) unit.path = reroute.waypoints;
        }
        if (this.isIlluminated(unit.pos)) {
          // Break contact and clear the light. A flare is a danger signal to the
          // attackers, so they do not stop to exchange fire while exposed.
          unit.advance = true;
          if (unit.path.length === 0) this.repathToward(unit);
          return;
        }
      }
    }

    const nearbyThreats = this.livingFriendlies().filter((ally) => dist(unit.pos, ally.pos) <= 190);
    const badlyShaken = unit.morale <= CONFIG.morale.rattledThreshold;
    const badlyWounded = unit.health <= this.content.enemy[unit.role as EnemyArchetype].health * 0.35;
    const breakingOff = badlyShaken || badlyWounded;
    const protectedNow = this.enemyHasCover(unit, nearbyThreats);
    if (protectedNow && (breakingOff || target !== null || unit.suppression > CONFIG.suppression.recoverThreshold)) {
      // Fight from cover under pressure. Bounding out of it and immediately
      // seeking it again produces a pointless back-and-forth at corners.
      unit.advance = false;
      unit.path = [];
      return;
    }
    // Answer first contact before starting a potentially long climb into cover.
    if (breakingOff || (!justAcquired && target !== null && nearbyThreats.length > 0)) {
      if (this.moveEnemyToCover(unit, nearbyThreats)) return;
      if (breakingOff) {
        // If there is no safe position to reach, stop the exposed push and
        // return fire from where the unit is instead of spending its life on a charge.
        unit.advance = false;
        unit.path = [];
        return;
      }
    }
    if (supportingPinnedComrade && target !== null) {
      // Stop long enough to put accurate return fire onto nearby defenders
      // threatening a pinned squadmate instead of bounding past them.
      unit.advance = false;
      unit.path = [];
      return;
    }
    const contact = target === null ? latestNightContact(unit, this.state.ticks) : undefined;
    if (contact && !isVehicle(this.content, unit)) {
      // Advance toward the last heard/seen firing position, never a hidden
      // enemy's current coordinates. A short memory prevents endless pursuit.
      if (dist(unit.pos, contact.pos) <= this.state.terrain.cell) {
        unit.path = []; unit.advance = false; return;
      }
      if (unit.path.length === 0 || unit.moveGoal === null || dist(unit.moveGoal, contact.pos) > this.state.terrain.cell) {
        const goal = nearestOpenCell(this.state.terrain, contact.pos, 3);
        if (goal) {
          const route = this.findEnemyPath(unit.pos, goal, unit);
          if (route.reachable) { unit.path = route.waypoints; unit.moveGoal = goal; unit.advance = true; return; }
        }
      } else { unit.advance = true; return; }
    }

    const holdAt = weapon !== null ? engageDistance(weapon, unit.role, CONFIG) : Infinity;
    // A target inside weapon reach is enough to bound against. Covering fire is
    // worth exactly as much on the approach as it is in position, and the older
    // rule - alternate only once already closed to the chosen distance - made the
    // whole approach a silent walk into the defenders' rifles, so most attackers
    // died with their ammunition unfired.
    const hasTarget = target !== null && weapon !== null;
    const inPosition = hasTarget && dist(unit.pos, target.pos) <= holdAt;

    const bounding = CONFIG.enemy.bounding;
    // Bounding overwatch: covering fire only means something once a target is in
    // reach, so the pair alternates from that moment on. The half that is not
    // walking is the half shooting, and the pair always keeps working forward, so
    // an attack can never deadlock in a standoff. Which half moves is derived
    // from the unit id and the clock, so nothing extra is saved.
    if (!hasTarget) {
      unit.advance = true;
    } else if (justAcquired) {
      // First contact: answer it before starting to bound. A bound is up to two
      // seconds long, which is longer than an unsurpressed attacker tends to
      // live under a prepared line's fire, so without this the half that happens
      // to be walking on contact is shot before it ever fires a round.
      unit.advance = false;
    } else if (bounding.enabled) {
      // One cycle is a bound for each half. On the approach the two halves split
      // it evenly, so exactly one of them is always moving. Inside the chosen
      // engagement distance the pair walks a smaller share of the cycle, so each
      // cycle contains a stretch where both halves are halted with their weapons
      // up: that standoff is where the attack trades fire rather than ground.
      const cycle = bounding.windowTicks * 2;
      const share = inPosition ? bounding.standoffAdvanceFraction : 0.5;
      const advanceTicks = Math.max(1, Math.min(cycle - 1, Math.round(cycle * share)));
      const offset = unit.advanceFlip ? 0 : Math.floor(cycle / 2);
      unit.advance = (this.state.ticks + offset) % cycle < advanceTicks;
    } else {
      // Overwatch disabled: the force closes as a body, then holds and fires.
      unit.advance = !inPosition;
    }

    // Armour is immune to suppression, so a plain hold rule would freeze it for
    // good. It rolls forward and pauses to shoot. The pause gate opens on
    // entering range and only closes again once the vehicle has left range, so a
    // completed pause cannot be re-armed at the same distance - which would park
    // the vehicle exactly where the old code froze it.
    if (isVehicle(this.content, unit) && CONFIG.enemy.vehicleAdvancesWhileFiring) {
      const vehicleHold = weapon !== null ? weapon.range * CONFIG.enemy.vehicleHoldRangeMult : Infinity;
      const inRange = target !== null && dist(unit.pos, target.pos) <= vehicleHold;
      if (!inRange) unit.firePauseGate = true;
      if (unit.firePauseTicks > 0) {
        unit.firePauseTicks--;
        unit.advance = false;
        if (unit.path.length > 0) unit.path = [];
        return;
      }
      if (inRange && unit.firePauseGate) {
        unit.firePauseTicks = sec(CONFIG.enemy.vehicleFirePauseSeconds);
        unit.firePauseGate = false;
        unit.advance = false;
        if (unit.path.length > 0) unit.path = [];
        return;
      }
      unit.advance = true;
      if (unit.path.length === 0) this.repathToward(unit);
      return;
    }

    // The covering half holds where it stands and shoots: on the approach that is
    // what covers its partner's bound, and in the standoff it is the firing line.
    //
    // Suppression deliberately does not enter into this. It already costs the
    // attacker most of its accuracy, and pinning is the state that stops it
    // outright. Letting mere suppression force movement as well silenced it at
    // exactly the moment it should have been shooting back - under fire - so the
    // Axis crossed the beaten zone without ever returning a round.
    if (hasTarget && !unit.advance) {
      if (unit.path.length > 0) unit.path = [];
      return;
    }

    if (unit.path.length === 0) this.repathToward(unit);
  }

  /** Move out of an incoming hostile barrage, then resume the prior order. */
  private dodgeIncomingArtillery(unit: Unit): boolean {
    if (unit.pinned) return false;
    const incomingSource = unit.team === 'friendly' ? 'enemy' : 'friendly';
    const strikes = this.state.strikes.filter((strike) => (strike.source ?? 'friendly') === incomingSource
      && strikeIsImminent(strike, this.state.ticks)
      && dist(unit.pos, strike.pos) <= strike.radius + 38);
    if (strikes.length === 0) {
      // Automatic medic/engineer routes can differ from the last player order.
      // Restore that order only when shell avoidance actually interrupted it.
      if (unit.team !== 'friendly' || !unit.dodgingStrike) return false;
      delete unit.dodgingStrike;
      if (unit.patrol) return false;
      if (unit.moveGoal === null) {
        if (unit.path.length > 0) unit.path = [];
        return false;
      }
      if (!unit.path.length && this.movementGoalOccupied(unit)) return false;
      const lastWaypoint = unit.path[unit.path.length - 1] ?? unit.pos;
      if (dist(lastWaypoint, unit.moveGoal) <= 40) return false;
      const resumed = this.findUnitPath(unit, unit.pos, unit.moveGoal);
      if (!resumed.reachable) {
        unit.path = [];
        return false;
      }
      unit.path = resumed.waypoints;
      return true;
    }

    const stepOut = Math.max(96, Math.max(...strikes.map((strike) => strike.radius + 24)));
    const angleOffset = (unit.id % 16) * (Math.PI / 8);
    const options: Array<{ goal: Vec2; score: number }> = [];
    for (let i = 0; i < 16; i++) {
      const angle = angleOffset + i * (Math.PI / 8);
      const proposed = {
        x: Math.max(12, Math.min(CONFIG.field.width - 12, unit.pos.x + Math.cos(angle) * stepOut)),
        y: Math.max(12, Math.min(CONFIG.field.height - 12, unit.pos.y + Math.sin(angle) * stepOut)),
      };
      const goal = nearestOpenCell(this.state.terrain, proposed, 3);
      if (goal === null) continue;
      const clearance = Math.min(...strikes.map((strike) => dist(goal, strike.pos) - strike.radius));
      const spacing = this.state.units
        .filter((other) => other.team === unit.team && other.id !== unit.id && other.health > 0)
        .reduce((nearest, other) => Math.min(nearest, dist(goal, other.pos)), 180);
      const score = clearance + Math.min(100, spacing) * 0.18 - dist(unit.pos, goal) * 0.16;
      options.push({ goal, score });
    }
    options.sort((a, b) => b.score - a.score);
    for (const option of options.slice(0, 5)) {
      const route = unit.team === 'enemy' ? this.findEnemyPath(unit.pos, option.goal, unit) : this.findUnitPath(unit, unit.pos, option.goal);
      if (!route.reachable) continue;
      unit.path = route.waypoints;
      // Keep a friendly's commanded goal so it can resume after the shells land.
      if (unit.team === 'enemy') unit.moveGoal = option.goal;
      else unit.dodgingStrike = true;
      unit.advance = true;
      return true;
    }
    return false;
  }

  /** Whether a nearby friendly's fire crosses a building or low fence first. */
  private enemyHasCover(unit: Unit, threats: readonly Unit[]): boolean {
    return threats.some((threat) => this.buildingOnSegment(threat.pos, unit.pos) !== null
      || hasDirectionalCover(this.state.sandbags, unit.pos, threat.pos, CONFIG, this.state.trenches, this.state.terrain));
  }

  /** Pick a reachable position behind a building or fence relative to nearby defenders. */
  private moveEnemyToCover(unit: Unit, threats: readonly Unit[]): boolean {
    if (threats.length === 0 || this.enemyHasCover(unit, threats)) return false;
    const currentGoal = unit.moveGoal;
    if (unit.path.length > 0 && currentGoal !== null && threats.some((threat) =>
      this.buildingOnSegment(threat.pos, currentGoal) !== null
      || hasDirectionalCover(this.state.sandbags, currentGoal, threat.pos, CONFIG, this.state.trenches, this.state.terrain))) {
      // Finish the chosen route while its destination still provides cover.
      // Replanning at every grid edge can swap corners and reverse a bound.
      unit.advance = true;
      return true;
    }
    const candidates: Array<{ goal: Vec2; estimate: number }> = [];
    const seen = new Set<number>();
    const consider = (proposed: Vec2, isProtected: (candidate: Vec2) => boolean): void => {
      const goal = nearestOpenCell(this.state.terrain, proposed, 3);
      if (goal === null || !isProtected(goal)) return;
      const estimate = dist(unit.pos, goal);
      const key = Math.floor(goal.y / this.state.terrain.cell) * this.state.terrain.cols
        + Math.floor(goal.x / this.state.terrain.cell);
      if (estimate > 180 || seen.has(key)) return;
      seen.add(key);
      candidates.push({ goal, estimate });
    };

    for (const building of this.state.buildings) {
      if (building.destroyed) continue;
      const box = this.buildingGeometry.get(building.id);
      if (box === undefined) continue;
      const candidates = [
        { x: box.cx, y: box.y - 18 },
        { x: box.cx, y: box.y + box.h + 18 },
        { x: box.x - 18, y: box.cy },
        { x: box.x + box.w + 18, y: box.cy },
      ];
      for (const candidate of candidates) {
        consider(candidate, (point) => threats.some((threat) => this.buildingOnSegment(threat.pos, point) === building));
      }
    }

    const terrain = this.state.terrain;
    if (terrain.kinds !== undefined) {
      const rowMin = Math.max(0, Math.floor((unit.pos.y - 150) / terrain.cell));
      const rowMax = Math.min(terrain.rows - 1, Math.floor((unit.pos.y + 150) / terrain.cell));
      const colMin = Math.max(0, Math.floor((unit.pos.x - 150) / terrain.cell));
      const colMax = Math.min(terrain.cols - 1, Math.floor((unit.pos.x + 150) / terrain.cell));
      for (let row = rowMin; row <= rowMax; row++) {
        for (let col = colMin; col <= colMax; col++) {
          if (terrain.kinds[row * terrain.cols + col] !== TERRAIN_KIND.stoneFence) continue;
          const fence = { x: (col + 0.5) * terrain.cell, y: (row + 0.5) * terrain.cell };
          if (dist(unit.pos, fence) > 180 || (row + col) % 2 !== 0) continue;
          const candidate = { x: fence.x, y: fence.y - 12 };
          consider(candidate, (point) => threats.some((threat) =>
            hasDirectionalCover([], point, threat.pos, CONFIG, [], terrain)));
        }
      }
    }

    candidates.sort((a, b) => a.estimate - b.estimate);
    for (const candidate of candidates.slice(0, 10)) {
      const route = this.findEnemyPath(unit.pos, candidate.goal, unit);
      if (!route.reachable) continue;
      unit.path = route.waypoints;
      unit.moveGoal = candidate.goal;
      unit.advance = true;
      return true;
    }
    return false;
  }

  /** Return fire against defenders near a pinned Axis soldier, when reachable. */
  private pinnedComradeSuppressor(
    unit: Unit,
    defenders: readonly Unit[],
    weapon: WeaponStats,
    visibility: (target: Unit) => number,
  ): Unit | null {
    if (unit.team !== 'enemy' || weapon.kind !== 'hitscan') return null;
    const supportRadius = Math.min(260, weapon.range * 0.9);
    const pinnedComrades = this.state.units
      .filter((ally) => ally.team === 'enemy' && ally.id !== unit.id && ally.health > 0 && ally.pinned
        && dist(unit.pos, ally.pos) <= supportRadius)
      .sort((a, b) => b.suppression - a.suppression || dist(unit.pos, a.pos) - dist(unit.pos, b.pos) || a.id - b.id);
    for (const ally of pinnedComrades) {
      const likelySuppressors = defenders.filter((defender) => dist(defender.pos, ally.pos) <= supportRadius);
      if (likelySuppressors.length === 0) continue;
      const target = acquireTarget(
        this.content,
        this.state.terrain,
        this.state.sandbags,
        unit,
        likelySuppressors,
        weapon,
        CONFIG,
        this.state.trenches,
        'auto',
        this.state.smokes,
        visibility,
        (candidate) => nightContactFor(this.state, unit, candidate) !== undefined,
      );
      if (target !== null) return target;
    }
    return null;
  }

  /** Route an attacker toward the defended line, or straight on if it has no route. */
  private repathToward(unit: Unit): void {
    const objective = { x: unit.laneX, y: CONFIG.breakthroughY + 8 };
    const goal = nearestOpenCell(this.state.terrain, objective, 5);
    if (goal !== null) {
      const result = this.findEnemyPath(unit.pos, goal, unit);
      if (result.reachable) {
        unit.path = result.waypoints;
        unit.moveGoal = goal;
        return;
      }
    }
    // Fallback: walk straight south.
    unit.path = [{ x: unit.pos.x, y: Math.min(CONFIG.breakthroughY + 10, unit.pos.y + 60) }];
    unit.moveGoal = null;
  }

  private friendlyBehavior(unit: Unit, target: Unit | null, _weapon: WeaponStats | null): void {
    if (unit.role === 'supply_officer' && unit.supplyTargetId !== undefined) { this.supplyBehavior(unit); return; }
    if (unit.fireOrder === 'seekGunfire') { this.seekGunfire(unit, target); return; }
    if (unit.patrol) {
      if (unit.role === 'medic' && this.medicBehavior(unit, true)) return;
      this.updatePatrol(unit, target); return;
    }
    if (unit.role === 'medic') this.medicBehavior(unit);
  }

  private seekGunfire(unit: Unit, target: Unit | null): void {
    if (unit.pinned) { unit.running = false; return; }
    // Existing combat handles sight, range, smoke, height, and firing. Hearing
    // supplies a destination only, never permission to fire through an obstacle.
    if (target) { unit.path = []; unit.moveGoal = null; unit.running = false; return; }
    const contacts = (unit.heardGunfire ?? []).filter((contact) => contact.expiresTick > this.state.ticks);
    const heard = contacts.sort((a, b) => dist(unit.pos, a.pos) - dist(unit.pos, b.pos) || a.sourceId - b.sourceId)[0];
    if (!heard) {
      unit.path = []; unit.moveGoal = null; unit.running = false;
      delete unit.gunfirePursuit;
      return;
    }
    let pursuit = unit.gunfirePursuit;
    if (!pursuit || pursuit.sourceId !== heard.sourceId || dist(pursuit.pos, heard.pos) > this.state.terrain.cell) {
      pursuit = unit.gunfirePursuit = { ...heard, pos: { ...heard.pos }, retryTick: 0 };
      unit.path = []; unit.moveGoal = null;
    }
    const goal = unit.moveGoal ?? nearestOpenCell(this.state.terrain, pursuit.pos, 6);
    if (!goal || dist(unit.pos, goal) <= this.state.terrain.cell / 2) {
      // Consume this cue, so silence cannot make the soldier pace around it.
      unit.heardGunfire = contacts.filter((contact) => contact.sourceId !== heard.sourceId);
      delete unit.gunfirePursuit;
      unit.path = []; unit.moveGoal = null; unit.running = false;
      return;
    }
    if (!unit.path.length && this.state.ticks >= pursuit.retryTick) {
      const route = this.findUnitPath(unit, unit.pos, goal);
      pursuit.retryTick = this.state.ticks + sec(CONFIG.gunfireOrder.retrySeconds);
      if (!route.reachable) {
        unit.heardGunfire = contacts.filter((contact) => contact.sourceId !== heard.sourceId);
        delete unit.gunfirePursuit; unit.moveGoal = null;
        return;
      }
      unit.path = route.waypoints; unit.moveGoal = { ...goal };
    }
    // Exhaustion falls back to walking. Wait for substantial recovery before
    // another dash, using the same endurance budget as manual run orders.
    if (unit.path.length && canRun(unit) && (unit.stamina ?? 1) >= CONFIG.infantryMovement.enemyRunStamina) unit.movementPace = 'run';
  }

  private medicBehavior(unit: Unit, patrolling = false): boolean {
    const heal = this.content.friendly.medic.heal;
    if (unit.medicalTargetId !== undefined) {
      const patient = this.findUnit(unit.medicalTargetId);
      if (!this.needsMedic(patient)) {
        delete unit.medicalTargetId;
        unit.path = []; unit.moveGoal = null; unit.running = false;
      } else {
        if (unit.pinned) return false;
        if (!this.medicCanTreat(unit, patient)) {
          if (!unit.path.length || !unit.moveGoal || dist(unit.moveGoal, patient.pos) > this.state.terrain.cell) {
            if (!this.routeMedic(unit, patient)) {
              delete unit.medicalTargetId;
              unit.path = []; unit.moveGoal = null;
            } else unit.medicalTargetId = patient.id;
          }
          return false;
        }
        unit.path = []; unit.moveGoal = null; unit.running = false;
      }
    }
    if (!heal || (!patrolling && unit.path.length > 0)) return false; // explicit orders win
    if (unit.pinned) return false;
    const height = (patient: Unit) => elevationAt(this.state.terrain, patient.pos.x, patient.pos.y) + unitBuildingHeight(this.state.terrain, patient);
    const medicHeight = height(unit);
    const reachMult = unit.specialization === 'fieldMedic' ? CONFIG.specialization.healRangeMult : 1;
    const sharesFloor = (patient: Unit) => unit.buildingPosition && patient.buildingPosition
      && unit.buildingPosition.buildingId === patient.buildingPosition.buildingId;
    const wounded = this.state.units
      .filter((u) => u.team === 'friendly' && u.id !== unit.id && !u.dead && !u.crossed && !u.buildingOrder
        && (unit.medicalTargetId === undefined || u.id === unit.medicalTargetId)
        && (unit.medicalTargetId !== undefined || !this.state.medicalQueue?.includes(u.id))
        && u.health > 0 && u.health < this.maxHealthOf(u)
        // Compare standing surfaces, not posture or floor number: a balcony
        // shares the second floor, and terrain can raise a building's base.
        && (!(unit.buildingPosition || u.buildingPosition || unit.bridgePosition || u.bridgePosition) || Math.abs(height(u) - medicHeight) <= 2)
        && (!(unit.buildingPosition || patrolling) || sharesFloor(u) || dist(unit.pos, u.pos) <= heal.range * reachMult))
      .sort((a, b) => dist(unit.pos, a.pos) - dist(unit.pos, b.pos) || a.id - b.id)[0];
    if (!wounded) return false;
    // Window slots represent posts around an accessible interior. A medic can
    // attend that entire floor without navigating the solid building footprint.
    const d = sharesFloor(wounded) ? 0 : dist(unit.pos, wounded.pos);
    if (d <= heal.range * reachMult) {
      // A medical patrol treats nearby casualties from its current route, then
      // resumes that leg. It never replaces the patrol goal with a patient.
      if (patrolling) { unit.path = []; unit.running = false; }
      if (unit.healTimer <= 0) {
        unit.healTimer = sec(heal.cooldownSeconds);
        const amount = heal.amount * (unit.specialization === 'surgeon' ? CONFIG.specialization.healAmountMult : 1);
        const restored = Math.min(amount, this.maxHealthOf(wounded) - wounded.health);
        wounded.health += restored;
        unit.service.healthRestored += restored;
        if (restored >= 15) unit.xp += 1;
        this.emit({ type: 'healed', medicId: unit.id, targetId: wounded.id, pos: wounded.pos, amount: restored });
        if (wounded.health >= this.maxHealthOf(wounded)) this.cancelSupportRequest(unit);
      }
      return true;
    } else if (!patrolling && !unit.buildingPosition && d <= heal.seekRange * reachMult) {
      const result = this.findUnitPath(unit, unit.pos, wounded.pos);
      if (result.reachable) {
        unit.path = result.waypoints;
        // This is now the medic's active destination. Crowd separation must not
        // pull it back to a completed player order while it approaches a casualty.
        unit.moveGoal = { ...wounded.pos };
      }
    }
    return false;
  }

  private tryFire(unit: Unit, target: Unit, weapon: WeaponStats, moving = false): void {
    if (unit.reloadTimer > 0) return;
    if (unit.burstRemaining <= 0) {
      unit.burstRemaining = weapon.burstShots;
      unit.shotTimer = 0;
    }
    if (unit.shotTimer > 0) return;
    // Target may have gone invalid mid-burst; drop the rest of the burst.
    const visibility = (candidate: Unit): number => this.visibilityMultiplierFor(unit, candidate);
    if (!targetIsValid(this.content, this.state.terrain, this.state.sandbags, unit, target, weapon, CONFIG, this.state.trenches, this.state.smokes, visibility)) {
      unit.burstRemaining = 0;
      if (unit.ambush?.triggered) delete unit.ambush;
      unit.reloadTimer = this.reloadTicksFor(unit, weapon);
      return;
    }
    if (!this.fireShot(unit, target, weapon, moving)) return;
    unit.burstRemaining--;
    unit.shotTimer = weapon.shotIntervalTicks;
    if (unit.burstRemaining <= 0) {
      if (unit.ambush?.triggered) delete unit.ambush;
      unit.reloadTimer = this.reloadTicksFor(unit, weapon);
    }
  }

  private tryFireSecondary(unit: Unit, target: Unit, weapon: WeaponStats, moving: boolean): void {
    if ((unit.secondaryReloadTimer ?? 0) > 0) return;
    if ((unit.secondaryBurstRemaining ?? 0) <= 0) {
      unit.secondaryBurstRemaining = weapon.burstShots;
      unit.secondaryShotTimer = 0;
    }
    if ((unit.secondaryShotTimer ?? 0) > 0) return;
    const visibility = (candidate: Unit): number => this.visibilityMultiplierFor(unit, candidate);
    if (!targetIsValid(this.content, this.state.terrain, this.state.sandbags, unit, target, weapon, CONFIG, this.state.trenches, this.state.smokes, visibility)) {
      unit.secondaryBurstRemaining = 0;
      unit.secondaryReloadTimer = this.reloadTicksFor(unit, weapon);
      return;
    }
    this.fireShot(unit, target, weapon, moving);
    unit.secondaryBurstRemaining = Math.max(0, (unit.secondaryBurstRemaining ?? 0) - 1);
    unit.secondaryShotTimer = weapon.shotIntervalTicks;
    if (unit.secondaryBurstRemaining <= 0) unit.secondaryReloadTimer = this.reloadTicksFor(unit, weapon);
  }

  /**
   * Throw a grenade if this soldier has one and it is worth spending. Returns
   * true when a grenade was thrown, in which case the turn is spent.
   */
  private tryThrowGrenade(unit: Unit, enemies: readonly Unit[]): boolean {
    if (unit.grenades <= 0) return false;
    const s = this.state;
    const target = chooseGrenadeTarget(s.terrain, s.sandbags, unit, enemies, CONFIG, s.trenches);
    if (target === null) return false;
    const grenade = CONFIG.grenade;
    unit.grenades -= 1;
    unit.grenadeTimer = grenade.cooldownTicks;
    unit.service.grenadesThrown += 1;
    s.projectiles.push({
      id: s.nextEntityId++,
      team: unit.team,
      sourceId: unit.id,
      pos: { x: unit.pos.x, y: unit.pos.y },
      target: { x: target.pos.x, y: target.pos.y },
      speed: grenade.throwSpeed / CONFIG.tickRate,
      damage: grenade.damage,
      splashRadius: grenade.radius,
      armorMult: grenade.armorMult,
      suppressionAmount: grenade.suppression,
      suppressionRadius: grenade.suppressionRadius,
      arc: true,
    });
    this.emit({ type: 'grenadeThrown', unitId: unit.id, team: unit.team, from: { ...unit.pos }, to: { ...target.pos }, remaining: unit.grenades });
    return true;
  }

  /** A stationary mortarman drops an imprecise shell onto a random enemy position in range. */
  private tryMortarFire(unit: Unit, enemies: readonly Unit[]): boolean {
    const s = this.state;
    const mortar = CONFIG.mortar;
    const remaining = unit.mortarBombs ?? this.content.friendly.mortarman.mortarBombs ?? 0;
    if (remaining <= 0 || (unit.mortarTimer ?? 0) > 0 || unit.path.length > 0) return false;
    const targets = enemies.filter((enemy) => {
      if (enemy.health <= 0 || enemy.crossed === true) return false;
      const range = dist(unit.pos, enemy.pos);
      return range >= mortar.minRange && range <= mortar.maxRange;
    });
    if (targets.length === 0) return false;

    unit.mortarBombs = remaining - 1;

    const target = rngPick(s.rng, targets);
    const angle = rngNext(s.rng) * Math.PI * 2;
    const scatter = rngRange(s.rng, 0, mortar.scatterRadius);
    let x = target.pos.x + Math.cos(angle) * scatter;
    let y = target.pos.y + Math.sin(angle) * scatter;
    const dx = x - unit.pos.x;
    const dy = y - unit.pos.y;
    const impactRange = Math.hypot(dx, dy);
    if (impactRange > mortar.maxRange || impactRange < mortar.minRange) {
      const desiredRange = Math.max(mortar.minRange, Math.min(mortar.maxRange, impactRange));
      const scale = impactRange > 0 ? desiredRange / impactRange : 1;
      x = unit.pos.x + dx * scale;
      y = unit.pos.y + dy * scale;
    }
    const pos = {
      x: Math.min(CONFIG.field.width - 2, Math.max(2, x)),
      y: Math.min(CONFIG.field.height - 2, Math.max(2, y)),
    };
    const strike: Strike = {
      id: s.nextEntityId++,
      pos,
      landTick: s.ticks + sec(mortar.flightSeconds),
      radius: mortar.radius,
      damage: this.weaponDamage(unit, mortar.damage),
      suppressionAmount: mortar.suppression,
      source: 'friendly',
      sourceId: unit.id,
      delivery: 'mortar',
    };
    const inMortarPit = s.mortarPits.some((pit) => dist(pit.pos, unit.pos) <= CONFIG.mortarPit.occupyRadius);
    unit.mortarTimer = sec(mortar.intervalSeconds * (inMortarPit ? CONFIG.mortarPit.reloadTimeMult : 1));
    s.strikes.push(strike);
    recordNightGunfire(s, unit, this.terrainKinds);
    this.emit({ type: 'mortarFired', unitId: unit.id, from: { ...unit.pos }, pos: { ...pos }, landTick: strike.landTick, radius: strike.radius });
    return true;
  }

  /**
   * Resolve one shot: hit chance, damage, suppression and the shot event. Public
   * so the firing path (including positional bonuses) can be exercised directly.
   */
  fireShot(unit: Unit, target: Unit, weapon: WeaponStats, moving = false): boolean {
    if (unit.team === 'enemy' && unit.role === 'vehicle'
      && ((unit.tankDamage?.turret && weapon.name === this.content.weapons.shell!.name)
        || (unit.tankDamage?.machineGun && weapon.name === this.content.weapons.tank_mg!.name))) return false;
    if (unit.ambush && !unit.ambush.triggered) {
      if (unit.pinned || unit.path.length > 0 || moving || (unit.upgradeTimer ?? 0) > 0 || unit.reloadTimer > 0 || unit.shotTimer > 0
        || unit.ambush.prepTicks > 0 || !insideAmbushArc(unit.pos, unit.ambush, target.pos) || !this.ambushSees(unit, target)
        || !targetIsValid(this.content, this.state.terrain, this.state.sandbags, unit, target, weapon, CONFIG,
          this.state.trenches, this.state.smokes, (candidate) => this.visibilityMultiplierFor(unit, candidate))) return false;
      if (unit.role === 'at' && weapon.name === this.content.weapons.at?.name && (unit.rockets ?? 0) <= 0) return false;
      unit.ambush.triggered = true; unit.ambush.bonusShots = weapon.burstShots;
      this.emit({ type: 'ambushTriggered', unitId: unit.id, pos: { ...unit.pos } });
    }
    const ambushBonus = unit.ambush?.triggered === true && unit.ambush.bonusShots > 0;
    if (unit.team === 'friendly' && unit.role === 'at' && weapon.name === this.content.weapons.at?.name) {
      const remaining = unit.rockets ?? this.content.friendly.at.rockets ?? 0;
      if (remaining <= 0) return false;
      unit.rockets = remaining - 1;
    }
    const s = this.state;
    recordNightGunfire(s, unit, this.terrainKinds, weapon);
    const distance = dist(unit.pos, target.pos);
    const inTrench = hasTrenchCover(s.trenches, target.pos, unit.pos, CONFIG);
    const inBunker = hasBunkerCover(s.bunkers, target, CONFIG);
    const inMortarPit = target.team === 'friendly' && target.role === 'mortarman'
      && s.mortarPits.some((pit) => dist(pit.pos, target.pos) <= CONFIG.mortarPit.occupyRadius);
    const covered = target.buildingPosition !== undefined || inTrench || hasDirectionalCover(s.sandbags, target.pos, unit.pos, CONFIG, s.trenches, s.terrain);
    // A building in the way eats the round. This matters most for cannon and
    // rockets, which arc over obstacles and so never asked line of sight whether
    // the target was even visible: a wall on the flight path stops the shell, and
    // the wall takes the hit instead of whatever was behind it.
    const wall = this.buildingOnSegment(unit.pos, target.pos, unit, target);
    const impact: Vec2 = wall === null
      ? { x: target.pos.x, y: target.pos.y }
      : { x: this.buildingGeometry.get(wall.id)!.cx, y: this.buildingGeometry.get(wall.id)!.cy };
    // Firing from a prepared position: the machine gunner's emplacement, and
    // nothing else, is worth more than the cover alone.
    const emplacement = trenchBonusFor(unit, s.trenches, CONFIG);
    const isNight = dayNightAtTick(s.ticks, s.dayNightStartTick).night;
    const litTarget = this.vehicleHeadlightsOn(target) || campfireIlluminates(s, target.pos) || (unit.team === 'friendly' && target.team === 'enemy' && this.isIlluminated(target.pos));
    const nightAccuracy = isNight && !litTarget
      ? CONFIG.dayNight.nightAccuracyMult
      : 1;
    const sniperFlareLit = unit.team === 'friendly' && unit.role === 'sniper'
      && target.team === 'enemy' && (this.isIlluminated(target.pos) || campfireIlluminates(s, target.pos));
    const sniperAccuracy = unit.team === 'friendly' && unit.role === 'sniper'
      ? isNight
        ? sniperFlareLit ? CONFIG.dayNight.sniperDayAccuracyMult : CONFIG.dayNight.sniperNightAccuracyMult
        : CONFIG.dayNight.sniperDayAccuracyMult
      : 1;
    const movingAccuracy = !moving
      ? 1
      : unit.role === 'gun_truck'
        ? CONFIG.gunTruck.movingAccuracyMult
        : unit.role === 'vehicle'
          ? CONFIG.armoredVehicle.movingAccuracyMult
          : 1;
    const chance = hitChance({
      weapon,
      distance,
      attackerXp: unit.xp,
      attackerAccuracySkill: unit.accuracySkill * nightAccuracy * sniperAccuracy * movingAccuracy * (unit.team === 'friendly'
        ? (1 + unit.weaponUpgrades.accuracy * CONFIG.weaponUpgrades.accuracyPerLevel) * (unit.specialization === 'steadyAim' || unit.specialization === 'spotter' ? 1 + CONFIG.specialization.accuracyBonus : 1)
        : 1),
      attackerMorale: unit.morale,
      attackerSuppression: unit.suppression,
      targetInCover: covered,
      targetInTrench: inTrench,
      targetInBunker: inBunker,
      targetInMortarPit: inMortarPit,
      targetStance: target.terrainCrawling ? 'prone' : target.stance,
      targetInFoliage: this.isInFoliage(target.pos),
      lineFoliageCount: foliageAlongLine(s.terrain, this.terrainKinds, unit.pos, target.pos),
      attackerPositionAccuracyMult: (emplacement?.accuracyMult ?? 1) * (ambushBonus ? CONFIG.ambush.accuracyMult : 1),
      attackerGroundAccuracyMult: this.terrainEffectsFor(unit).accuracyMult
        * (nightContactFor(s, unit, target)?.kind === 'sound' && distance > weapon.range * this.visibilityMultiplier()
          ? CONFIG.dayNight.gunfire.heardAccuracyMult : 1),
      config: CONFIG,
    });
    const hit = rngNext(s.rng) < chance;
    if (ambushBonus && unit.ambush && --unit.ambush.bonusShots <= 0) delete unit.ambush;

    if (wall !== null) {
      // Stopped by the wall: the target is untouched, and the structure takes the
      // round. Small arms barely scratch masonry, so this is mostly the sound of
      // a firefight rather than a way to level a town.
      this.damageBuilding(wall, this.buildingDamageFrom(unit, weapon, hit ? 1 : 0.6));
      this.emit({ type: 'shot', shooterId: unit.id, shooterTeam: unit.team, from: { ...unit.pos }, to: impact, hit: false, weapon: weapon.name, targetId: null });
      return true;
    }

    if (weapon.kind === 'hitscan') {
      // A missed round can lodge in a nearby trunk or branch along its path.
      const treeCell = hit ? null : treeOnShot(s.terrain, this.terrainKinds, unit.pos, target.pos,
        elevationAt(s.terrain, unit.pos.x, unit.pos.y) + unitEyeHeight(s.terrain, unit),
        elevationAt(s.terrain, target.pos.x, target.pos.y) + unitEyeHeight(s.terrain, target));
      if (treeCell !== null) {
        this.damageTree(treeCell, this.weaponDamage(unit, weapon.damage) * .35, false);
        this.emit({ type: 'shot', shooterId: unit.id, shooterTeam: unit.team, from: { ...unit.pos }, to: treeCellPosition(s.terrain, treeCell), hit: false, weapon: weapon.name, targetId: null });
      }
      if (hit) {
        const tankBonus = target.role === 'vehicle' && unit.specialization === 'tankHunter' ? CONFIG.specialization.armorDamageMult : 1;
        const applied = this.damageUnit(target, this.weaponDamage(unit, weapon.damage) * tankBonus, weapon.armorMult);
        if (applied.killed) this.killUnit(target, unit.id);
      }
      // Nearby shots suppress the victim's comrades whether they hit or not. A
      // braced gun beats a wider zone, which is what makes the position matter.
      suppressNear(
        s.units,
        target.team,
        target.pos,
        weapon.suppressionRadius * (emplacement?.suppressionRadiusMult ?? 1),
        weapon.suppressionAmount * (ambushBonus ? CONFIG.ambush.suppressionMult : 1) * (emplacement?.suppressionMult ?? 1) * (unit.specialization === 'suppressor' ? CONFIG.specialization.suppressionMult : 1) * (hit ? 1 : 0.5),
        CONFIG,
      );
      if (treeCell === null) this.emit({ type: 'shot', shooterId: unit.id, shooterTeam: unit.team, from: { ...unit.pos }, to: { ...target.pos }, hit, weapon: weapon.name, targetId: target.id });
    } else {
      // Missed cannon and rocket shots scatter clear of the intended target.
      let impact = { x: target.pos.x, y: target.pos.y };
      if (!hit) {
        const angle = rngNext(s.rng) * Math.PI * 2;
        const minimumScatter = weapon.splashRadius + unitRadius(this.content, target) + 4;
        const spread = 18 + (1 - chance) * 70 + Math.min(1, distance / weapon.range) * 42;
        const scatter = minimumScatter + rngNext(s.rng) * spread;
        impact = {
          x: Math.min(CONFIG.field.width - 2, Math.max(2, target.pos.x + Math.cos(angle) * scatter)),
          y: Math.min(CONFIG.field.height - 2, Math.max(2, target.pos.y + Math.sin(angle) * scatter)),
        };
      }
      // The projectile travels to the aimed or scattered impact point.
      s.projectiles.push({
        id: s.nextEntityId++,
        team: unit.team,
        sourceId: unit.id,
        pos: { x: unit.pos.x, y: unit.pos.y },
        target: impact,
        speed: weapon.projectileSpeed / CONFIG.tickRate,
        damage: this.weaponDamage(unit, weapon.damage) * (target.role === 'vehicle' && unit.specialization === 'tankHunter' ? CONFIG.specialization.armorDamageMult : 1),
        splashRadius: weapon.splashRadius,
        armorMult: weapon.armorMult,
        suppressionAmount: weapon.suppressionAmount * (ambushBonus ? CONFIG.ambush.suppressionMult : 1),
        suppressionRadius: weapon.suppressionRadius,
        arc: false,
      });
      this.emit({ type: 'shot', shooterId: unit.id, shooterTeam: unit.team, from: { ...unit.pos }, to: impact, hit, weapon: weapon.name, targetId: target.id });
    }
    return true;
  }

  // ------------------------------------------------------------------ units

  private damageUnit(target: Unit, damage: number, armorMult: number): ReturnType<typeof applyDamageToUnit> {
    const applied = applyDamageToUnit(this.content, target, damage, armorMult);
    if (applied.killed) return applied;
    const component = damageTankComponent(target, applied.damageDealt, armorMult, this.state.rng);
    if (component) {
      this.emit({ type: 'tankComponentDisabled', unitId: target.id, component, pos: { ...target.pos } });
      // A tank with no mobility or weapons is a combat loss, so an abandoned
      // vehicle cannot keep a wave alive indefinitely. Normal kill credit applies.
      if (TANK_COMPONENTS.every((part) => target.tankDamage?.[part])) { target.health = 0; applied.killed = true; }
    }
    return applied;
  }

  private killUnit(unit: Unit, killerId: number | null, escaped = false): void {
    if (unit.dead) return; // exactly once
    unit.dead = true;
    unit.health = 0;
    unit.path = [];
    unit.targetId = null;
    if (unit.team === 'friendly') this.state.battleRecord.casualties += 1;
    else if (!escaped) this.state.battleRecord.enemyKills += 1;
    let killer: Unit | null = null;
    if (killerId !== null) {
      killer = this.state.units.find((u) => u.id === killerId && u.health > 0) ?? null;
    }
    this.changeNearbyMorale(unit.team, unit.pos, -CONFIG.morale.nearbyCasualtyLoss);
    this.emit({ type: 'unitDied', unitId: unit.id, team: unit.team, role: unit.role, pos: { ...unit.pos }, killerId: killer !== null ? killer.id : null });
    if (killer !== null && killer.team !== unit.team) {
      const xp = isVehicle(this.content, unit) ? CONFIG.xp.vehicleKillXp : CONFIG.xp.infantryKillXp;
      killer.xp += xp;
      killer.kills += 1;
      this.changeNearbyMorale(killer.team, killer.pos, CONFIG.morale.nearbyKillGain);
    }
    if (unit.team === 'enemy' && !escaped) {
      this.state.score += this.killValueOf(unit);
      const passengers = unit.transport?.passengers ?? 0;
      if (passengers > 0) {
        unit.transport!.passengers = 0;
        this.state.battleRecord.enemyKills += passengers;
        this.state.score += passengers * this.content.enemy.rifle.killValue;
        if (killer && killer.team !== unit.team) {
          killer.kills += passengers; killer.xp += passengers * CONFIG.xp.infantryKillXp;
        }
        this.emit({ type: 'transportPassengersKilled', unitId: unit.id, count: passengers, pos: { ...unit.pos } });
      }
      if (unit.role === 'vehicle') this.bailOutTankCrew(unit);
    }
  }

  private bailOutTankCrew(tank: Unit): void {
    const tuning = CONFIG.armoredVehicle.crew, terrain = this.state.terrain, cell = terrain.cell;
    const abandoned = TANK_COMPONENTS.every((component) => tank.tankDamage?.[component]);
    // Include transport passengers already reserved by the scheduler in the cap.
    const occupied = this.state.units.filter((unit) => unit.team === 'enemy' && unit.health > 0 && !unit.dead)
      .reduce((total, unit) => total + 1 + (unit.transport?.passengers ?? 0), 0);
    const capacity = Math.max(0, Math.min(tuning.size, CONFIG.caps.liveEnemies - occupied));
    const crew: Unit[] = [];
    const infantry: Unit = { ...tank, role: 'rifle', tankDamage: undefined };
    for (let member = 0; member < tuning.size && crew.length < capacity; member++) {
      if (!abandoned && rngNext(this.state.rng) >= tuning.destroyedSurvivalChance) continue;
      let position: Vec2 | null = null;
      for (let ring = 1; ring <= 3 && !position; ring++) {
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const candidate = nearestOpenCell(terrain, { x: tank.pos.x + dx! * cell * ring, y: tank.pos.y + dy! * cell * ring }, 1);
          if (!candidate || !this.inBounds(candidate, 8) || candidate.y >= CONFIG.breakthroughY - 8
            || dist(tank.pos, candidate) > cell * 4
            || this.state.units.some((unit) => unit.health > 0 && !unit.dead && dist(unit.pos, candidate) < UNIT_SEPARATION.infantry + 1)) continue;
          const route = this.findUnitPath(infantry, tank.pos, candidate);
          if (!route.reachable) continue;
          let length = 0, previous = tank.pos;
          for (const waypoint of route.waypoints) { length += dist(previous, waypoint); previous = waypoint; }
          if (length > cell * 6) continue;
          position = candidate; break;
        }
      }
      if (!position) continue;
      this.spawnEnemy('rifle', position);
      const survivor = this.state.units.at(-1)!;
      survivor.health = tuning.health; survivor.morale = tuning.morale; survivor.grenades = 0;
      survivor.laneX = tank.laneX;
      survivor.tankCrew = { tankId: tank.id, behavior: rngNext(this.state.rng) < tuning.retreatChance ? 'retreat' : 'fight',
        exit: { x: position.x, y: cell / 2 }, retryTick: 0, bailoutTicks: sec(tuning.bailoutSeconds) };
      const bridge = unitBridge(terrain, { ...tank, pos: position });
      if (bridge && tank.bridgePosition?.key === bridgeKey(bridge)) survivor.bridgePosition = { ...tank.bridgePosition };
      crew.push(survivor);
    }
    if (crew.length) this.emit({ type: 'tankCrewBailedOut', tankId: tank.id, crewIds: crew.map((unit) => unit.id),
      retreating: crew.filter((unit) => unit.tankCrew!.behavior === 'retreat').length,
      fighting: crew.filter((unit) => unit.tankCrew!.behavior === 'fight').length, pos: { ...tank.pos } });
  }

  private breakthrough(unit: Unit): void {
    if (unit.dead) return;
    const dmg = this.breakthroughDamageOf(unit);
    this.killUnit(unit, null, true); // removal is not an enemy destroyed
    this.state.battleRecord.breakthroughs += 1;
    this.state.integrity = Math.max(0, this.state.integrity - dmg);
    this.emit({ type: 'breakthrough', unitId: unit.id, role: unit.role, pos: { ...unit.pos }, damage: dmg, integrityAfter: this.state.integrity });
    if (this.state.integrity <= 0 && this.state.phase === 'running') {
      this.state.phase = 'defeat';
      this.emit({ type: 'defeat' });
    }
  }

  /** Place a friendly unit directly; used at setup and by the recruit command. */
  spawnFriendly(role: FriendlyRole, pos: Vec2): Unit {
    const def = this.content.friendly[role];
    const unit: Unit = this.baseUnit('friendly', role, pos);
    unit.health = def.health;
    this.state.units.push(unit);
    this.emit({ type: 'unitSpawned', unitId: unit.id, team: 'friendly', role, pos: { ...pos } });
    return unit;
  }

  spawnEnemy(archetype: EnemyArchetype, at?: Vec2): void {
    const s = this.state;
    // Reinforcements look for a weak, reachable sector and avoid stacking into
    // the same approach lane. Explicitly placed enemies keep their authored lane.
    const spawnX = at !== undefined ? at.x : rngRange(s.rng, 160, CONFIG.field.width - 160);
    const laneX = at !== undefined ? at.x : this.chooseEnemyApproachLane(spawnX);
    const pos: Vec2 = at !== undefined ? { x: at.x, y: at.y } : { x: spawnX, y: -14 };
    const unit = this.baseUnit('enemy', archetype, pos);
    unit.laneX = laneX;
    unit.health = this.content.enemy[archetype].health;
    if (archetype === 'troop_transport') {
      const tuning = CONFIG.troopTransport;
      const defenderY = Math.min(CONFIG.lineY, ...this.livingFriendlies().map((u) => u.pos.y));
      const y = Math.min(CONFIG.breakthroughY - 48, Math.max(pos.y, tuning.dropMinY, Math.min(tuning.dropMaxY, defenderY - tuning.standOff)));
      unit.transport = { passengers: tuning.capacity, dropOff: { x: laneX, y }, exit: { x: Math.max(12, Math.min(CONFIG.field.width - 12, spawnX)), y: 12 }, unloadTicks: sec(tuning.unloadSeconds), retryTick: 0 };
    }
    s.units.push(unit);
    this.emit({ type: 'unitSpawned', unitId: unit.id, team: 'enemy', role: archetype, pos: { ...pos } });
  }

  /** Choose a flanking lane with less defender pressure and less enemy traffic. */
  private chooseEnemyApproachLane(spawnX: number): number {
    const s = this.state;
    const step = Math.max(s.terrain.cell * 2, 48);
    const edge = s.terrain.cell * 1.5;
    const objectiveY = CONFIG.breakthroughY + 8;
    const defenders = s.units.filter((unit) => unit.team === 'friendly' && unit.health > 0 && unit.crossed !== true);
    const attackers = s.units.filter((unit) => unit.team === 'enemy' && unit.health > 0 && unit.crossed !== true);
    let bestLane = Math.max(edge, Math.min(CONFIG.field.width - edge, spawnX));
    let bestScore = Infinity;

    for (let x = edge; x <= CONFIG.field.width - edge; x += step) {
      const goal = nearestOpenCell(s.terrain, { x, y: objectiveY }, 5);
      if (goal === null) continue;
      const route = this.findEnemyPath({ x: spawnX, y: 0 }, goal);
      if (!route.reachable) continue;

      let routeLength = 0;
      let previous = { x: spawnX, y: 0 };
      for (const point of route.waypoints) {
        routeLength += dist(previous, point);
        previous = point;
      }

      let defenderPressure = 0;
      for (const defender of defenders) {
        const projectedY = Math.max(0, Math.min(CONFIG.breakthroughY, defender.pos.y));
        const routeDistance = Math.hypot(defender.pos.x - x, defender.pos.y - projectedY);
        const range = Math.max(100, (this.weaponOf(defender)?.range ?? 150) * 0.7);
        const coverage = Math.max(0, 1 - routeDistance / range);
        if (coverage <= 0) continue;
        const def = this.content.friendly[defender.role as FriendlyRole];
        const threat = def?.threat ?? 1;
        const behindCover = hasBunkerCover(s.bunkers, defender, CONFIG)
          || hasDirectionalCover(s.sandbags, defender.pos, { x, y: 0 }, CONFIG, s.trenches, s.terrain);
        defenderPressure += threat * coverage * (behindCover ? 1.45 : 1);
      }

      const enemyTraffic = attackers.reduce((total, attacker) => {
        const spacing = Math.abs(attacker.laneX - x);
        return total + Math.max(0, 1 - spacing / (step * 2)) * (attacker.pos.y < objectiveY ? 1 : 0.35);
      }, 0);
      const spawnDrift = Math.abs(x - spawnX);
      const score = defenderPressure + enemyTraffic * 1.35 + routeLength * 0.0005 + spawnDrift * 0.001;
      if (score < bestScore) {
        bestScore = score;
        bestLane = x;
      }
    }
    return bestLane;
  }

  private baseUnit(team: Team, role: Unit['role'], pos: Vec2): Unit {
    return {
      id: this.state.nextEntityId++,
      team,
      role,
      pos: { x: pos.x, y: pos.y },
      prevPos: { x: pos.x, y: pos.y },
      health: 100,
      dead: false,
      suppression: 0,
      pinned: false,
      stance: 'standing',
      crawling: false,
      movementPace: 'walk', stamina: 1, running: false,
      morale: CONFIG.morale.initial,
      weaponUpgrades: { accuracy: 0, reload: 0, damage: 0 },
      reloadTimer: sec(0.5),
      burstRemaining: 0,
      shotTimer: 0,
      targetId: null,
      path: [],
      moveGoal: null,
      advance: false,
      advanceFlip: false,
      firePauseTicks: 0,
      firePauseGate: true,
      healTimer: 0,
      mortarTimer: team === 'friendly' && role === 'mortarman' ? sec(CONFIG.mortar.initialDelaySeconds) : 0,
      // Only friendly roles carry grenades; enemy archetypes never do.
      grenades: team === 'friendly' ? (this.content.friendly[role as FriendlyRole]?.grenades ?? 0) : 0,
      rockets: team === 'friendly' && role === 'at' ? (this.content.friendly.at.rockets ?? 0) : 0,
      mortarBombs: team === 'friendly' && role === 'mortarman' ? (this.content.friendly.mortarman.mortarBombs ?? 0) : 0,
      smokeGrenades: (team === 'friendly' && (role === 'rifleman' || role === 'engineer')) || (team === 'enemy' && role === 'assault') ? CONFIG.smoke.startingGrenades : 0,
      grenadeTimer: 0,
      xp: 0,
      accuracySkill: this.initialAccuracySkill(team, role),
      // No one starts with work in hand; upgrades set this.
      upgradeTimer: 0,
      fireOrder: 'auto',
      headlightsOn: role === 'gun_truck' || role === 'vehicle' || role === 'troop_transport',
      kills: 0,
      service: { healthRestored: 0, fortificationsBuilt: 0, grenadesThrown: 0 },
      laneX: pos.x,
    };
  }

  private initialAccuracySkill(team: Team, role: Unit['role']): number {
    const baseline = team === 'friendly'
      ? this.content.friendly[role as FriendlyRole].initialAccuracySkill
      : this.content.enemy[role as EnemyArchetype].initialAccuracySkill;
    const variation = CONFIG.xp.startingSkillVariation;
    return Math.max(0.4, Math.min(1.3, baseline + rngRange(this.state.rng, -variation, variation)));
  }

  // ------------------------------------------------------------------ stats

  weaponOf(unit: Unit): WeaponStats | null {
    if (unit.tankCrew) return this.content.weapons.crew_pistol ?? null;
    if (usesBackupRifle(unit, this.content)) return this.content.weapons.rifle ?? null;
    if (unit.team === 'enemy' && unit.role === 'vehicle' && unit.tankDamage?.turret) return null;
    const id = unit.team === 'friendly' ? this.content.friendly[unit.role as FriendlyRole]?.weapon : this.content.enemy[unit.role as EnemyArchetype]?.weapon;
    if (!id) return null;
    return this.content.weapons[id] ?? null;
  }

  private secondaryWeaponOf(unit: Unit): WeaponStats | null {
    if (unit.team !== 'enemy' || unit.role !== 'vehicle' || unit.tankDamage?.machineGun) return null;
    return this.content.weapons.tank_mg ?? null;
  }

  maxHealthOf(unit: Unit): number {
    if (unit.tankCrew) return CONFIG.armoredVehicle.crew.health;
    return unit.team === 'friendly'
      ? this.content.friendly[unit.role as FriendlyRole]!.health
      : this.content.enemy[unit.role as EnemyArchetype]!.health;
  }

  private speedOf(unit: Unit): number {
    const baseSpeed = unit.team === 'friendly'
      ? this.content.friendly[unit.role as FriendlyRole]!.speed
      : this.content.enemy[unit.role as EnemyArchetype]!.speed;
    const moraleRatio = Math.max(0, Math.min(100, unit.morale)) / 100;
    const speedFactor = CONFIG.morale.speedMin + (1 - CONFIG.morale.speedMin) * moraleRatio;
    const specializationSpeed = unit.team === 'friendly' && unit.specialization === 'forcedMarch'
      ? CONFIG.specialization.movementSpeedMult
      : 1;
    const night = dayNightAtTick(this.state.ticks, this.state.dayNightStartTick).night;
    const nightSpeed = night
      ? this.vehicleHeadlightsOn(unit) ? CONFIG.dayNight.headlightsOnMovementMult : CONFIG.dayNight.nightMovementMult
      : 1;
    const weatherSpeed = CONFIG.weather[this.state.weather].movementMult;
    // Wading a river or ploughing through mud costs pace for both sides alike:
    // soft ground is a fact of the battlefield, not a weapon.
    const stanceSpeed = unit.crawling || unit.terrainCrawling ? 0.38 : unit.stance === 'prone' ? 0.55 : unit.stance === 'crouching' ? 0.78 : 1;
    const paceSpeed = unit.running && canRun(unit) ? CONFIG.infantryMovement.runSpeedMult : 1;
    const walkingSpeed = isVehicle(this.content, unit) ? 1 : CONFIG.infantryMovement.walkSpeedMult;
    return baseSpeed * walkingSpeed * speedFactor * this.terrainEffectsFor(unit).speedMult * specializationSpeed * nightSpeed * weatherSpeed * stanceSpeed * paceSpeed;
  }

  /**
   * Ticks this unit's weapon takes to reload, including its personal reload
   * drills and the ground it is standing on. Public so the soft-ground penalty
   * can be checked directly instead of inferred from a firefight.
   */
  reloadTicksFor(unit: Unit, weapon: WeaponStats): number {
    const baseTicks = effectiveReloadTicks(unit, weapon, CONFIG);
    const groundMult = this.terrainEffectsFor(unit).reloadMult;
    if (unit.team !== 'friendly') return Math.max(1, Math.round(baseTicks * groundMult));
    const reduction = unit.weaponUpgrades.reload * CONFIG.weaponUpgrades.reloadReductionPerLevel;
    const perk = unit.specialization === 'fastReload' ? 1 - CONFIG.specialization.reloadReduction : 1;
    return Math.max(1, Math.round(baseTicks * (1 - reduction) * perk * groundMult));
  }

  private weaponDamage(unit: Unit, baseDamage: number): number {
    if (unit.team !== 'friendly') return baseDamage;
    const bonus = unit.weaponUpgrades.damage * CONFIG.weaponUpgrades.damagePerLevel;
    return baseDamage * (1 + bonus);
  }

  private killValueOf(unit: Unit): number {
    return unit.team === 'enemy' ? this.content.enemy[unit.role as EnemyArchetype]!.killValue : 0;
  }

  private breakthroughDamageOf(unit: Unit): number {
    return unit.team === 'enemy' ? this.content.enemy[unit.role as EnemyArchetype]!.breakthroughDamage : 0;
  }

  radiusOf(unit: Unit): number {
    return unitRadius(this.content, unit);
  }
}

/** Wave telegraph text for the UI, if the upcoming wave declares one. */
export function waveTelegraph(waveIndex: number): string | undefined {
  return getContent().waves[waveIndex]?.telegraph;
}

/** LOS re-export for UI/tests convenience. */
export { hasLineOfSight };
