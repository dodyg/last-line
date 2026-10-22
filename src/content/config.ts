import type { GameConfig } from '../simulation/types';

/**
 * Central gameplay configuration. All values here are first-playable tuning
 * defaults; adjust through playtesting without touching simulation code.
 */
export const CONFIG: GameConfig = {
  ambush: { minRange: 48, maxRange: 360, prepareSeconds: 3, accuracyMult: 1.35, suppressionMult: 2 },
  enemySappers: { firstWave: 8, seekRange: 480, plantSeconds: 4, plantReach: 18, fuseSeconds: 8, radius: 64, damage: 180, structuralDamage: 700, suppression: 100 },
  barbedWire: { halfLength: 36, halfDepth: 8, speedMult: .3, routeCost: 6, cutSeconds: 6, cutReach: 12, seekRange: 100 },
  satchel: { fuseSeconds: 10, placementRange: 36, cost: 5, radius: 64, damage: 260, armorMult: 2, suppression: 100 },
  gunfireOrder: { memorySeconds: 12, retrySeconds: 1 },
  field: { width: 960, height: 720 },
  tickRate: 30,
  infantryMovement: {
    walkSpeedMult: .75, runSpeedMult: 1.8, runSeconds: 8, walkingRecoverySeconds: 16,
    restingRecoverySeconds: 10, minimumRunStamina: .25, enemyRunStamina: .75,
  },
  incomingFire: { artilleryWarningSeconds: 1, mortarWarningSeconds: .6, airSupportWarningSeconds: 4 },
  dayNight: {
    startAfterWaves: 3, cycleSeconds: 300, nightVisibilityMult: 0.75, nightMovementMult: 0.75, nightAccuracyMult: 0.8, sniperDayAccuracyMult: 1.2, sniperNightAccuracyMult: 0.65, flareVisibilityMult: 1.25, headlightsOnVisibilityMult: 1.25, headlightsOnMovementMult: 1,
    gunfire: { soundRadius: 320, flashRadius: 260, tracerRadius: 400, visualMemorySeconds: 1.5, soundMemorySeconds: 3, trackRadius: 24, heardRangeMult: .95, heardAccuracyMult: .55 },
  },
  lineY: 640,
  breakthroughY: 664,
  deploymentZone: { yMin: 560, yMax: 708 },
  spawnMargin: 20,
  /**
   * Marching north. The northern strip is the way out of this map: any living
   * soldier who reaches it is across. When the last one is over, a new
   * battlefield is generated, its wave counter starts again at 1, and the squad
   * re-forms in the south with every wound, experience point, and personal
   * weapon upgrade intact. One hundred maps must be marched clear to win.
   */
  crossing: {
    /**
     * A soldier at or north of this line has reached the way out and starts
     * walking off the map. Roughly two terrain cells deep, so a squad ordered at
     * the northern edge reliably lands inside it rather than a few pixels short,
     * while staying well clear of any ground a firefight is fought over.
     */
    thresholdY: 56,
    columns: 5,
    rowSpacing: 22,
    campaignMaps: 100,
    /** A full preparation period on arrival, so the new line can be sited. */
    arrivalSeconds: 12,
    /** The campaign map is secured after this many waves; then march north. */
    captureAfterWaves: 15,
    captureSeconds: 8,
    captureRadius: 92,
    captureMinSoldiers: 2,
    captureZone: { x: 480, y: 112 },
    sectorSupplyPoints: 8,
    sectorSupplyHeal: 35,
  },
  assembly: {
    startY: 372,
    endY: 540,
    spacing: 46,
  },
  start: {
    points: 12,
    integrity: 20,
    squad: [
      { role: 'rifleman', pos: { x: 330, y: 600 } },
      { role: 'rifleman', pos: { x: 430, y: 620 } },
      { role: 'rifleman', pos: { x: 530, y: 620 } },
      { role: 'rifleman', pos: { x: 630, y: 600 } },
    ],
    prepSeconds: 10,
    // Give medics, Supply Officers, and repositioning orders time between attacks.
    breakSeconds: 30,
  },
  caps: {
    friendly: 14,
    liveEnemies: 26,
  },
  costs: {
    recruit: { rifleman: 4, mg: 7, medic: 6, supply_officer: 6, at: 8, sniper: 10, engineer: 6, radio_engineer: 6, officer: 10, mortarman: 10, gun_truck: 25 },
    sandbag: 3,
    barbedWire: 4,
    trench: 6,
    bunker: 10,
    mortarPit: 8,
    bridge: 7,
    artillery: 8,
    airSupport: 12,
    flare: 4,
  },
  artillery: {
    delaySeconds: 2.5,
    radius: 85,
    damage: 130,
    suppression: 45,
    cooldownSeconds: 24,
  },
  weather: {
    clear: { name: 'Clear', visibilityMult: 1, movementMult: 1, atmosphereAlpha: 0, rainIntensity: 0, fogIntensity: 0, riverFlowMult: 1, description: 'Clear skies; normal sighting range and movement speed.' },
    lightRain: { name: 'Light rain', visibilityMult: 0.94, movementMult: 0.95, atmosphereAlpha: 0.018, rainIntensity: 0.3, fogIntensity: 0, riverFlowMult: 1.35, description: 'Light rain cuts sighting range by 6% and movement speed by 5%; river current begins to rise.' },
    rain: { name: 'Steady rain', visibilityMult: 0.84, movementMult: 0.85, atmosphereAlpha: 0.035, rainIntensity: 0.65, fogIntensity: 0, riverFlowMult: 1.9, description: 'Steady rain cuts sighting range by 16% and movement speed by 15%; river current runs faster.' },
    heavyRain: { name: 'Heavy rain', visibilityMult: 0.7, movementMult: 0.7, atmosphereAlpha: 0.075, rainIntensity: 1, fogIntensity: 0, riverFlowMult: 2.8, description: 'Heavy rain cuts sighting range by 30% and movement speed by 30%; river current becomes a torrent.' },
    lightFog: { name: 'Light fog', visibilityMult: 0.88, movementMult: 0.97, atmosphereAlpha: 0.055, rainIntensity: 0, fogIntensity: 0.3, riverFlowMult: 1, description: 'Light fog cuts sighting range by 12% and movement speed by 3%.' },
    fog: { name: 'Steady fog', visibilityMult: 0.68, movementMult: 0.9, atmosphereAlpha: 0.13, rainIntensity: 0, fogIntensity: 0.65, riverFlowMult: 1, description: 'Steady fog cuts sighting range by 32% and movement speed by 10%.' },
    heavyFog: { name: 'Heavy fog', visibilityMult: 0.48, movementMult: 0.82, atmosphereAlpha: 0.23, rainIntensity: 0, fogIntensity: 1, riverFlowMult: 1, description: 'Heavy fog cuts sighting range by 52% and movement speed by 18%.' },
    lightSnow: { name: 'Light snowstorm', visibilityMult: 0.9, movementMult: 0.92, atmosphereAlpha: 0.025, rainIntensity: 0, snowIntensity: 0.3, fogIntensity: 0.06, riverFlowMult: 1, description: 'Light snow cuts sighting range by 10% and movement speed by 8%.' },
    snow: { name: 'Steady snowstorm', visibilityMult: 0.74, movementMult: 0.78, atmosphereAlpha: 0.07, rainIntensity: 0, snowIntensity: 0.65, fogIntensity: 0.2, riverFlowMult: 1, description: 'Steady snow cuts sighting range by 26% and movement speed by 22%; wind carries denser flurries across the field.' },
    heavySnow: { name: 'Heavy snowstorm', visibilityMult: 0.5, movementMult: 0.6, atmosphereAlpha: 0.14, rainIntensity: 0, snowIntensity: 1, fogIntensity: 0.4, riverFlowMult: 1, description: 'Blizzard conditions cut sighting range by 50% and movement speed by 40%; dense snow and strong wind obscure the battlefield.' },
  },
  weatherChangeSeconds: 300,
  airSupport: {
    delaySeconds: 1.6,
    cooldownSeconds: 45,
    bombCount: 3,
    bombSpacing: 48,
    bombSpacingSeconds: 0.35,
    radius: 32,
    damage: 118,
    suppression: 38,
  },
  gunTruck: {
    movingAccuracyMult: 0.6,
    roadSpeedMult: 2,
  },
  troopTransport: { capacity: 6, unloadSeconds: 1, dropMinY: 160, dropMaxY: 520, standOff: 120, roadSpeedMult: 1.5 },
  armoredVehicle: {
    movingAccuracyMult: 0.68,
    componentDamage: { minimumDamage: 20, minimumArmorMult: 0.75, disableChance: 0.65 },
    crew: { size: 4, destroyedSurvivalChance: 0.35, retreatChance: 0.65, health: 45, morale: 65, bailoutSeconds: 1 },
  },
  flare: {
    radius: 180,
    deploymentDelaySeconds: 2.5,
    durationSeconds: 30,
    cooldownSeconds: 30,
  },
  campfire: {
    radius: 70,
    durationSeconds: 60,
  },
  mortar: {
    initialDelaySeconds: 4,
    intervalSeconds: 16,
    flightSeconds: 2.2,
    minRange: 120,
    maxRange: 1560,
    scatterRadius: 24,
    radius: 42,
    damage: 62,
    suppression: 28,
  },
  /**
   * Axis counter-battery fire. The enemy does not buy batteries: as the campaign
   * drags on they locate the defended line and shell it on their own schedule.
   * Nothing is scheduled before `firstWaveWithBarrage`, so the early waves teach
   * rifle combat without an unanswerable threat, and the share of time a battery
   * is ready climbs with the wave number (about 3% a second on the first barrage
   * wave, a third a second by the last), so the final push is fought under
   * observed artillery. The tell is the same as the player's own fire mission - a
   * countdown ring on the ground - which is what makes it survivable: it punishes
   * troops who stand still in the open and rewards moving after the mark appears.
   *
   * Shells land wherever the defenders are standing, so splitting the squad is a
   * real answer; they are never aimed at fixed ground. The battery draws from its
   * own seeded random stream, so its fire plan is a property of the run and
   * tuning it does not reshuffle the rest of the battle.
   */
  enemyArtillery: {
    /**
     * Arrives with the deep waves. The wave counter restarts on each new map, so
     * this is per map, not per run.
     */
    firstWaveWithBarrage: 12,
    /** Ticks before the battery may fire again, after a barrage lands. */
    cooldownSecondsMin: 30,
    cooldownSecondsMax: 46,
    /**
     * Chance per simulated second that the battery fires, once it is ready and a
     * wave is under way, multiplied by how far into the barrage the wave is.
     * Zero below the first barrage wave, capped by `maxChancePerSecond`.
     */
    chancePerWave: 0.028,
    maxChancePerSecond: 0.34,
    /** Shells per fire mission; the roll is inclusive and grows with the wave. */
    shellsMin: 1,
    shellsMax: 1,
    /** Extra shells with every this many waves into the barrage, capped below. */
    shellGrowthEveryWaves: 3,
    maxShells: 3,
    /** Seconds between the shells of one mission, so a barrage walks the ground. */
    shellSpacingSeconds: 0.47,
    /**
     * How far a shell lands from the soldier it was aimed at, and how that
     * tightens as the campaign goes on: early fire missions are harassment,
     * later ones are observed fire that lands on the position. Tuned against the
     * campaign balance suite - looser than this and the shelling is invisible,
     * tighter and it starts deciding campaigns on its own.
     */
    scatterAtFirstWave: 150,
    scatterAtLastWave: 70,
    /** The wave at which the aim is at its tightest. */
    scatterWave: 15,
    /**
     * The northernmost row a shell will land on. Enemy fire is aimed at the
     * defended ground it has located; the empty northern half of the map is not a
     * target, so a barrage can never be walked onto the Axis' own approach.
     */
    minLandY: 280,
    observationRange: 520,
  },
  foodSupply: {
    points: 5,
    cooldownSeconds: 60,
  },
  weaponUpgrades: {
    maxLevel: 3,
    accuracyPerLevel: 0.06,
    reloadReductionPerLevel: 0.08,
    damagePerLevel: 0.12,
    /**
     * How long the soldier spends working on the weapon before the improvement
     * takes effect on the battlefield. The upgrade is fitted in the field, by the
     * man carrying it: while he is at it his weapon is in pieces, so he cannot
     * fire and cannot throw. Everything else - moving, taking cover, being
     * suppressed - carries on normally, and the benefit is banked the moment it is
     * bought, so the delay is a window of vulnerability rather than a risk of
     * losing the points. Buying three levels back to back therefore costs nine
     * seconds of silence at the worst possible moment, which is the real price.
     */
    upgradeSeconds: 3,
    costs: {
      accuracy: [5, 8, 11],
      reload: [5, 8, 11],
      damage: [6, 9, 12],
    },
  },
  suppression: {
    decayPerTick: 0.2,
    pinThreshold: 12,
    recoverThreshold: 5,
    max: 30,
  },
  morale: {
    initial: 82,
    suppressionLossPerSecondAtPin: 3,
    recoveryPerSecond: 1.2,
    cohesionBonusPerSecond: 1.8,
    cohesionRange: 128,
    nearbyCasualtyLoss: 10,
    nearbyKillGain: 4,
    aimMin: 0.68,
    aimMax: 1.08,
    speedMin: 0.75,
    shakenThreshold: 45,
    rattledThreshold: 20,
    officerAuraRange: 140,
    officerSuppressionRecoveryMult: 1.75,
    officerMoraleRecoveryBonusPerSecond: 2.5,
  },
  cover: {
    radius: 22,
    minSouthOffset: 3,
    accuracyMult: 0.45,
  },
  treeCover: {
    movementSpeedMult: 0.72,
    targetAccuracyMult: 0.68,
    lineAccuracyMult: 0.88,
    visibilityMult: 0.78,
    lineVisibilityMult: 0.94,
  },
  enemy: {
    smokeAssault: {
      startWave: 4,
      squadRadius: 144,
      minSquadSize: 2,
      minTargetRange: 120,
      maxTargetRange: 280,
      warningSeconds: 1.5,
    },
    // Attackers close to a distance they choose, instead of freezing the instant
    // any target appears. Assault troops press in to make their SMGs count;
    // riflemen trade fire from a standoff that still lets them advance. This is
    // the distance at which the pair counts as having arrived: from there it
    // bounds on a fire-heavy cycle (see `bounding`) instead of a steady advance.
    engageRangeMult: { sapper: 0.8, rifle: 0.8, assault: 0.65, vehicle: 1, observer: 0.8, gun_truck: 0.9, troop_transport: 1 },
    /**
     * Armour is exempt from the bounding pair and always moving, so it needs a
     * separate stopping distance or it would never settle to shoot.
     */
    vehicleHoldRangeMult: 0.7,
    vehicleFirePauseSeconds: 4,
    vehicleAdvancesWhileFiring: true,
    bounding: {
      enabled: true,
      windowTicks: 60,
      /**
       * Share of the bound cycle a pair spends walking once it is inside its
       * engagement distance. Below the approach's even split the two halves
       * leave stretches in which both are halted and shooting, so the standoff
       * trades fire rather than ground.
       */
      standoffAdvanceFraction: 0.35,
    },
    targetPriority: {
      woundedDistanceBonus: 200,
      preferDamagedBonus: 0.06,
      damagedHealthFraction: 0.75,
    },
  },
  trench: {
    halfLength: 62,
    coverRadius: 60,
    coverDepth: 40,
    /**
     * The physical earthwork an occupant has to be standing on to count as dug
     * in. Deliberately narrower than the cover shadow (coverRadius), which
     * reaches south of the parapet to protect the position.
     */
    occupyHalfLength: 56,
    occupyHalfDepth: 22,
    minSpacing: 132,
    accuracyMult: 0.25,
    /** Earth overhead and parapets soften shell blasts for soldiers inside. */
    artilleryDamageMult: 0.45,
    artillerySuppressionMult: 0.5,
    /**
     * The machine gun is the reason to dig: braced on the parapet with the belt
     * at hand it suppresses harder over a wider beaten zone. Everything else
     * fights from a trench for the cover and nothing more.
     */
    roleBonus: {
      mg: { accuracyMult: 1.35, suppressionMult: 1.6, suppressionRadiusMult: 1.45 },
    },
  },
  construction: {
    engineerRange: 112,
    sandbagSeconds: 2.5,
    barbedWireSeconds: 4,
    trenchSeconds: 6,
    mineSeconds: 3,
    bunkerSeconds: 12,
    mortarPitSeconds: 9,
    bridgeSeconds: 8,
  },
  bunker: { occupyRadius: 24, minSpacing: 64, accuracyMult: 0.3 },
  mortarPit: {
    occupyRadius: 18,
    minSpacing: 58,
    accuracyMult: 0.22,
    artilleryDamageMult: 0.35,
    artillerySuppressionMult: 0.5,
    /** Reduces the normal 16-second interval to 11.2 seconds while occupied. */
    reloadTimeMult: 0.7,
  },
  /**
   * Hand grenades, carried by riflemen and combat engineers. They are the only
   * weapon in the game that arcs over cover, so they are the answer to an enemy
   * sitting behind a wall where rifles cannot reach. Soldiers carry a limited
   * loadout, restored on new maps or delivered to riflemen by Supply Officers.
   */
  grenade: {
    damage: 68,
    /** Wide enough to catch two hostiles at normal spacing, not just a stack. */
    radius: 62,
    /**
     * Comfortably inside rifle range, but far enough out that a soldier still has
     * a reason to reach for a grenade. At a shorter range the squad is already
     * shooting and the grenades go unused.
     */
    range: 220,
    /** Projectile speed in pixels per second; a lob, not a bullet. */
    throwSpeed: 190,
    suppression: 26,
    suppressionRadius: 74,
    /** Fragmentation barely troubles a buttoned-up vehicle. */
    armorMult: 0.35,
    /** Ticks between throws from the same soldier. */
    cooldownTicks: 150,
    /** Hostiles inside the blast needed to justify a throw without cover. */
    clusterThreshold: 2,
    /** A soldier throws at a covered or pinned target even without a cluster. */
    throwAtCoveredTargets: true,
  },
  grenadeSupplies: { range: 36 },
  smoke: {
    radius: 72,
    durationSeconds: 8,
    throwRange: 220,
    startingGrenades: 1,
  },
  automaticSupport: { unlockXp: 3, retrySeconds: 10 },
  specialization: {
    unlockXp: 3,
    accuracyBonus: 0.12,
    suppressionMult: 1.5,
    reloadReduction: 0.15,
    armorDamageMult: 1.25,
    healAmountMult: 1.5,
    healRangeMult: 1.5,
    buildSpeedMult: 1.5,
    mineDamageMult: 1.25,
    artilleryCooldownMult: 0.8,
    artilleryDelayMult: 0.7,
    movementSpeedMult: 1.2,
    camouflageRangeMult: 0.75,
  },
  /**
   * Mines. Shared placement policy here; the two types are separate weapons with
   * their own cost, trigger and effect — neither substitutes for the other.
   */
  mine: {
    /** Mines may only be laid north of this, ahead of the defending line. */
    maxLayY: 604,
    friendlyFire: true,
  },
  mineKinds: {
    /**
     * Anti-personnel: cheap, kills infantry outright, and detonates under them
     * rather than under armour. Useful because the Axis walk onto them.
     */
    ap: {
      label: 'AP mine',
      cost: 3,
      laySeconds: 3,
      damage: 90,
      radius: 44,
      suppression: 30,
      suppressionRadius: 80,
      triggerRadius: 15,
      /** Fragmentation barely troubles a buttoned-up vehicle. */
      armorMult: 0.1,
      triggersOnInfantry: true,
      triggersOnVehicles: false,
      minSpacing: 36,
      color: 0x2f2a22,
      edge: 0x8d8266,
    },
    /**
     * Anti-tank: a shaped charge that only fires under a tracked vehicle, so
     * infantry walk over it untouched. Priced so that the pair needed to break a
     * tank costs about what one reusable anti-tank soldier does: the charge buys
     * a pre-sited ambush instead of a shooter, and it still will not kill a tank
     * alone.
     */
    at: {
      label: 'AT mine',
      cost: 5,
      laySeconds: 5,
      /** Two charges disable a tank; one alone does not. */
      damage: 150,
      radius: 50,
      suppression: 34,
      suppressionRadius: 84,
      triggerRadius: 20,
      armorMult: 1,
      triggersOnInfantry: false,
      triggersOnVehicles: true,
      /** A wider footprint, so the field cannot be densely packed. */
      minSpacing: 52,
      color: 0x33383a,
      edge: 0xa8b0a6,
    },
  },
  /**
   * Buildings. They are the only destructible terrain in the game: solid while
   * they stand, and a walkable ruin once they are levelled. A church is a real
   * landmark that takes sustained fire or artillery to break; a house is cover
   * that a determined attack can clear.
   */
  buildings: {
    footprints: {
      church: { cols: 4, rows: 3 },
      castle: { cols: 6, rows: 5 },
      hospital: { cols: 4, rows: 2 },
      house: { cols: 2, rows: 2 },
      school: { cols: 4, rows: 3 },
      restaurant: { cols: 3, rows: 2 },
      bakery: { cols: 2, rows: 2 },
      clinic: { cols: 3, rows: 2 },
      generalStore: { cols: 3, rows: 2 },
      bar: { cols: 3, rows: 2 },
      barn: { cols: 4, rows: 2 },
    },
    health: {
      church: 1400,
      castle: 2600,
      hospital: 900,
      house: 500,
      school: 900,
      restaurant: 650,
      bakery: 550,
      clinic: 700,
      generalStore: 650,
      bar: 600,
      barn: 750,
    },
    counts: {
      church: { min: 1, max: 1 },
      castle: { min: 0, max: 0 },
      hospital: { min: 0, max: 1 },
      house: { min: 2, max: 4 },
      school: { min: 0, max: 1 },
      restaurant: { min: 0, max: 1 },
      bakery: { min: 0, max: 1 },
      clinic: { min: 0, max: 1 },
      generalStore: { min: 0, max: 1 },
      bar: { min: 0, max: 1 },
      barn: { min: 0, max: 0 },
    },
    minGapCells: 1,
    deploymentClearanceCells: 5,
    /** Small arms barely trouble masonry; artillery and rockets do the work. */
    smallArmsDamageMult: 0.1,
  },
  /**
   * Group move orders. A selection ordered onto one point spreads over a slot
   * grid centred there, spaced wide enough that neighbours do not immediately
   * shove each other apart.
   */
  formation: {
    spacing: 24,
  },
  xp: {
    accuracyPerLevel: 0.025,
    startingSkillVariation: 0.1,
    reloadReductionPerLevel: 0.02,
    maxLevel: 5,
    infantryKillXp: 1,
    vehicleKillXp: 3,
  },
  rewards: {
    waveClearBase: 11,
    /** +1 point per every 2 wave levels (floor(wave / 2)). */
    waveClearPerLevels: 2,
    waveClearBonusScore: 15,
    integrityBonusScore: 20,
  },
  endless: {
    countGrowth: 1.12,
    maxCountPerArchetype: 14,
    minSpawnIntervalSeconds: 0.8,
    vehicleEveryWaves: 2,
  },
  autosaveSeconds: 10,
  sandbagMinSpacing: 20,
  terrain: {
    cell: 24,
    featureMin: 5,
    featureMax: 8,
    protectedTopRows: 3,
    protectedBottomRows: 4,
    /**
     * Soft ground. The river is wadeable everywhere, so it slows a crossing
     * rather than stopping it: infantry lose nearly half their pace and shoot
     * poorly with wet feet, which makes the far bank briefly worth holding.
     * Mud is worse on movement and slightly worse on the weapon, and it lingers
     * away from the water so the battlefield has more than one kind of bad
     * ground.
     */
    effects: {
      river: { speedMult: 0.55, accuracyMult: 0.7, reloadMult: 1.45 },
      rapids: { speedMult: 0.32, accuracyMult: 0.48, reloadMult: 1.8 },
      bridge: { speedMult: 1.1, accuracyMult: 1, reloadMult: 1 },
      road: { speedMult: 1.1, accuracyMult: 1, reloadMult: 1 },
      mud: { speedMult: 0.5, accuracyMult: 0.78, reloadMult: 1.6 },
    },
    river: {
      /**
       * Only this share of maps has a river at all. Water is the strongest
       * terrain feature in the game, so always having it made every battlefield
       * read the same; a map without it is a faster, more open fight, and the
       * mud patches below are what keep soft ground worth reading either way.
       */
      presenceChance: 0.62,
      /** Thickness of the wadeable band, in pixels. */
      widthMin: 54,
      widthMax: 72,
      /**
       * A gentle sweep, not a zigzag: the meander wavelength is well over half
       * the field width, so the channel reads as one continuous obstacle to
       * cross rather than a band that wanders back and forth.
       */
      meander: 26,
      meanderWavelength: 520,
    },
    mud: {
      /**
       * Fewer patches when the map already has a river, so the two hazards do
       * not compete for the same middle ground. A dry map carries the whole load.
       */
      patchMin: 4,
      patchMax: 6,
      patchMinWithoutRiver: 5,
      patchMaxWithoutRiver: 8,
      radiusMin: 52,
      radiusMax: 84,
      /**
       * Patches are roughly round. A half-width far below the half-length turns
       * a patch into a stripe across the whole field, which is a different
       * terrain feature wearing mud's name.
       */
      aspectMin: 0.72,
      aspectMax: 0.95,
      /**
       * Keeps patches from fusing into one continuous bog. A patch is much wider
       * than it is tall, so the two gaps differ: side by side they need far more
       * room than they do stacked. At these values a field of patches still reads
       * as separate bad ground with firm going between them.
       */
      minGapFactorX: 2.0,
      minGapFactorY: 1.35,
      /**
       * Clearance from the water's edge, so mud never lines the river bank and
       * the two hazards stay separately readable.
       */
      riverClearance: 40,
    },
  },
};

export const TICK_DURATION = 1 / CONFIG.tickRate;
