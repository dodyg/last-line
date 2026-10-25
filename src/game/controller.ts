import { battlePressure } from './soundscape';
import { landmarkHint, localShelter } from '../simulation/environment';
import { ambushShape, supportsAmbush } from '../simulation/ambush';
import { wireContains } from '../simulation/barbed-wire';
import { CONFIG } from '../content/config';
import { CAMPAIGNS } from '../content/campaigns';
import { campaignChapter, type FieldDispatch } from '../content/campaign-story';
import type { CampaignCountry } from '../simulation/types';
import { getContent, unitDef } from '../content/validate';
import { Simulation, waveTelegraph, wonByCampaign } from '../simulation/simulation';
import { TANK_DAMAGE_LABELS } from '../simulation/tank-damage';
import { dayNightAtTick } from '../simulation/daynight';
import { ELEVATION, elevationAt, slopeAt } from '../simulation/elevation';
import { bridgeContains } from '../simulation/bridges';
import { BATTLEFIELD_SETTINGS, TERRAIN_KIND, generateTerrain, isBridgeAt, isRapidsAt, isRiverAt, isMudAt, isRoadAt, isFoliageKind, type TerrainData } from '../simulation/terrain';
import { FIRE_ORDERS, fireOrdersForRole, type BuildingKind, type FriendlyRole, type MineKind, type SimEvent, type SimState, type Specialization, type TerrainEffects, type Unit, type WeaponUpgradeType, type WeatherKind } from '../simulation/types';
import {
  clearSnapshot,
  loadBest,
  loadSnapshot,
  saveBest,
  savePrefs,
  saveSnapshot,
  Storage,
  type BestRecord,
  type Preferences,
} from '../persistence';
import type { AudioSys } from './audio';
import type { PreviewInfo, RendererPort } from './render-contract';
import type { Hud } from '../ui/hud';
import type { Menus } from '../ui/menus';
import { RadioDirector } from './radio';
import { soldierName } from '../simulation/soldiers';
import { buildingArchitecture } from '../simulation/buildings';
import { SEASON_NAMES, seasonForSeed } from '../simulation/seasons';
import { isPatrolRole, patrolArea, validPatrolArea } from '../simulation/patrol';
import { satchelError } from '../simulation/satchels';
import type { BuildingFacing, BuildingLevel } from '../simulation/types';

export type UIMode =
  | { kind: 'none' }
  | { kind: 'suppress'; unitId: number }
  | { kind: 'ambush'; unitIds: number[]; arcDegrees: number }
  | { kind: 'patrol'; unitIds: number[]; origin?: { x: number; y: number } }
  | { kind: 'recruit'; role: FriendlyRole }
  | { kind: 'barbedWire' }
  | { kind: 'sandbag' }
  | { kind: 'trench' }
  | { kind: 'bunker' }
  | { kind: 'mortarPit' }
  | { kind: 'bridge' }
  | { kind: 'mine'; mineKind: MineKind }
  | { kind: 'artillery' }
  | { kind: 'airSupport' }
  | { kind: 'flare' }
  | { kind: 'satchel' }
  | { kind: 'smoke' };

const STEP_MS = 1000 / CONFIG.tickRate;
const MAX_STEPS_PER_FRAME = 5;
/** Forgiveness around a rubber band, so a soldier clipped at the edge is caught. */
const SELECT_MARGIN = 6;

const BUILDING_KIND_LABELS: Record<BuildingKind, string> = {
  church: 'Church',
  castle: 'Castle',
  house: 'House',
  hospital: 'Field hospital',
  school: 'School',
  restaurant: 'Restaurant',
  bakery: 'Bakery',
  clinic: 'Clinic',
  generalStore: 'General store',
  bar: 'Bar',
  barn: 'Barn',
};

/** Human-readable summary of what soft ground costs, for the terrain inspector. */
function describeGroundPenalty(effects: TerrainEffects): string {
  const speed = Math.round((1 - effects.speedMult) * 100);
  const aim = Math.round((1 - effects.accuracyMult) * 100);
  const reload = Math.round((effects.reloadMult - 1) * 100);
  return `-${speed}% speed, -${aim}% accuracy, +${reload}% reload time`;
}

export interface ControllerDeps {
  storage: Storage;
  prefs: Preferences;
  audio: AudioSys;
  hud: Hud;
  menus: Menus;
}

/**
 * Application orchestrator: owns the simulation instance, the fixed-step
 * loop, selection and placement modes, persistence pacing, and the glue
 * between events and audio/HUD/renderer feedback.
 */
export class GameController {
  readonly storage: Storage;
  prefs: Preferences;
  private readonly audio: AudioSys;
  private readonly hud: Hud;
  private readonly menus: Menus;

  private sim: Simulation | null = null;
  private terrainData: TerrainData | null = null;
  private idlePreviewState: SimState | null = null;
  private renderer: RendererPort | null = null;
  private mapReviewActive = false;
  private mapReviewWasRunning = false;
  private mapReviewState: SimState | null = null;
  /** Whether the map the player is standing on has a river, for the HUD. */
  private mapHasRiver = false;

  private accumulator = 0;
  /** Render interpolation fraction in [0,1). */
  alpha = 0;

  /**
   * Selected soldier ids, in the order they were added. A selection is a group:
   * orders apply to all of it, and the first id is the "primary" that the
   * single-soldier panels describe.
   */
  selectionIds: number[] = [];
  mode: UIMode = { kind: 'none' };
  pointerPos: { x: number; y: number } = { x: 0, y: 0 };
  private terrainInspectMode = false;

  /** Left-drag rubber band, in world coordinates, while one is in progress. */
  private dragOrigin: { x: number; y: number } | null = null;
  private dragCurrent: { x: number; y: number } | null = null;
  /** Whether the drag that started this press has moved far enough to be a box. */
  private dragMoved = false;
  private dragAdditive = false;
  /** Pointer travel, in pixels, that turns a press into a rubber band. */
  private static readonly DRAG_THRESHOLD = 6;

  /** The primary selection, for panels that describe a single soldier. */
  get selectionId(): number | null {
    return this.selectionIds[0] ?? null;
  }

  private lastSaveTick = 0;
  private overlayOpen = false;
  private booted = false;
  private readonly radio = new RadioDirector();
  private radioTransmissionPending = false;

  constructor(deps: ControllerDeps) {
    this.storage = deps.storage;
    this.prefs = deps.prefs;
    this.audio = deps.audio;
    this.hud = deps.hud;
    this.menus = deps.menus;
  }

  // ------------------------------------------------------------------ setup

  attachRenderer(renderer: RendererPort): void {
    this.renderer = renderer;
    renderer.setPreferences?.(this.prefs);
    // Idle battlefield behind the title screen.
    this.terrainData = generateTerrain((Math.random() * 0xffffffff) >>> 0);
    const idleState = this.idleState();
    this.idlePreviewState = idleState;
    renderer.rebuildStatic(idleState, this.terrainData);
    renderer.frame(idleState, 0, null, [], 0);
  }

  get isPaused(): boolean { return this.sim?.paused ?? true; }

  /** Rebuild durable presentation after WebGL restoration or a view lifecycle reset. */
  refreshRenderer(): void {
    if (!this.renderer || !this.terrainData) return;
    const state = this.sim?.state ?? this.mapReviewState ?? this.idlePreviewState ?? this.idleState();
    this.renderer.rebuildStatic(state, this.terrainData);
    this.renderer.frame(state, this.alpha, null, this.selectionIds, 0);
  }

  pointerCancel(): void { this.cancelDrag(); }

  private idleState(terrainData: TerrainData = this.terrainData!): SimState {
    // Minimal stand-in state so the renderer can draw terrain with no run.
    // Include generated structures in the preview too; terrainData owns their
    // footprints, while active simulations add health and combat state later.
    const buildings = terrainData.buildings.map((building, index) => ({
      id: index + 1,
      kind: building.kind,
      pos: { x: building.col * terrainData.terrain.cell, y: building.row * terrainData.terrain.cell },
      cols: building.cols,
      rows: building.rows,
      name: building.name,
      health: 1,
      maxHealth: 1,
      destroyed: false,
    }));
    return {
      schemaVersion: 18,
      season: terrainData.season,
      seed: 0,
      rng: { s: 1 },
      enemyArtilleryRng: { s: 1 },
      ticks: 0,
      nextEntityId: buildings.length + 1,
      units: [],
      battleRecord: { enemyKills: 0, casualties: 0, breakthroughs: 0 },
      projectiles: [],
      smokes: [],
      satchelCharges: [],
      strikes: [],
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
      buildings,
      terrain: terrainData.terrain,
      points: 0,
      integrity: 0,
      score: 0,
      scheduler: { waveIndex: 0, phase: 'prep', prepTicksLeft: 0, spawnQueue: [], spawnTimer: 0, rewardGranted: false, endlessWavesCleared: 0 },
      artilleryCooldown: 0,
      airSupportCooldown: 0,
      flareCooldown: 0,
      flares: [],
      campfires: [],
      weather: terrainData.weather,
      weatherChangeTick: 0,
      wavesCompleted: 0,
      dayNightStartTick: null,
      enemyArtilleryCooldown: 0,
      foodSupplyCooldown: 0,
      endless: false,
      phase: 'running',
      mapNumber: 1,
      mapsCleared: 0,
      captureTicks: 0,
      sectorCaptured: false,
      sectorSupplyPending: false,
      baseTerrainSeed: terrainData.seed,
      crossedUnits: [],
      terrainHasBuildings: true,
    };
  }

  openMapReview(): void {
    if (this.mapReviewActive) return;
    this.mapReviewActive = true;
    this.mapReviewWasRunning = this.sim !== null && !this.sim.paused && this.sim.state.phase === 'running';
    if (this.mapReviewWasRunning && this.sim !== null) {
      this.sim.paused = true;
      this.audio.cancelChatter();
      this.accumulator = 0;
      this.saveRun();
      this.hud.setPausedBadge(true);
    }
    this.overlayOpen = true;
  }

  generateMapReview(country: CampaignCountry): string {
    if (!this.mapReviewActive) this.openMapReview();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const data = generateTerrain(seed, true, 4, country, seasonForSeed(seed));
    const previewState = this.idleState(data);
    this.mapReviewState = previewState;
    this.renderer?.rebuildStatic(previewState, data);
    this.renderer?.frame(previewState, 0, null, [], 0);
    const sector = data.layout?.label ?? BATTLEFIELD_SETTINGS[data.settingId] ?? BATTLEFIELD_SETTINGS[0];
    this.hud.setBattlefield(`${CAMPAIGNS[country].name} · ${sector} · ${SEASON_NAMES[data.season]} · Map review`, 'Generated preview. Your campaign remains unchanged.');
    return `${CAMPAIGNS[country].name} · ${sector} · Seed ${seed}`;
  }

  closeMapReview(): void {
    if (!this.mapReviewActive) return;
    this.mapReviewActive = false;
    this.mapReviewState = null;
    const sim = this.sim;
    if (sim !== null) {
      const data = sim.terrainData();
      this.terrainData = data;
      this.renderer?.rebuildStatic(sim.state, data);
      this.renderer?.frame(sim.state, 0, null, this.selectionIds, 0);
      this.updateBattlefieldLabel(sim.state.weather);
      if (this.mapReviewWasRunning) {
        sim.paused = false;
        this.hud.setPausedBadge(false);
        this.overlayOpen = false;
      } else {
        this.overlayOpen = sim.paused;
      }
    } else if (this.terrainData !== null) {
      const idle = this.idlePreviewState ?? this.idleState();
      this.renderer?.rebuildStatic(idle, this.terrainData);
      this.renderer?.frame(idle, 0, null, [], 0);
      this.overlayOpen = false;
    }
    this.mapReviewWasRunning = false;
  }

  /** Wire global listeners once the DOM is ready. Called from main.ts. */
  boot(): void {
    if (this.booted) return;
    this.booted = true;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.sim !== null && !this.sim.paused && this.sim.state.phase === 'running' && !this.overlayOpen) {
        this.pauseRun(true);
      }
    });

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const formControl =
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement ||
        (target !== null && target.isContentEditable);
      if (this.overlayOpen || document.querySelector('.overlay:not([hidden])') !== null) {
        if (e.key === 'Escape' && !formControl) this.escape();
        return;
      }
      if (!formControl && !(target instanceof HTMLButtonElement) && e.code === this.prefs.keys.panel) {
        e.preventDefault();
        document.getElementById('btn-toggle-commands')?.click();
        return;
      }
      if (e.code === this.prefs.keys.pause && !formControl) {
        // Buttons are excluded via formControl-like check below: Space on a
        // focused button should activate the button, not toggle pause.
        if (!(target instanceof HTMLButtonElement)) {
          e.preventDefault();
          this.togglePause();
        }
      } else if (e.key === 'Escape') {
        this.escape();
      }
    });

    this.best = loadBest(this.storage);
    this.menus.showTitle(this.resumeAvailability(), this.best, null);
    this.hud.hide();
  }

  private best: BestRecord = { bestScore: 0, victories: 0 };

  get bestRecord(): BestRecord {
    return this.best;
  }

  // ------------------------------------------------------------- run control

  private resumeAvailability(): { available: boolean; message: string | null } {
    const loaded = loadSnapshot(this.storage);
    if (loaded === null) return { available: false, message: null };
    if ('error' in loaded) return { available: false, message: `Previous save could not be read (${loaded.error}). New Game is still available.` };
    if (loaded.snap.phase !== 'running') {
      clearSnapshot(this.storage);
      return { available: false, message: null };
    }
    return { available: true, message: null };
  }

  newRun(seed?: number, country?: CampaignCountry): void {
    const runSeed = seed ?? (Math.random() * 0xffffffff) >>> 0;
    // Generate the battlefield once and hand it to the simulation, which would
    // otherwise generate an identical copy for itself.
    const terrainData = generateTerrain(runSeed, true, 4, country);
    this.sim = new Simulation(runSeed, undefined, terrainData);
    this.terrainData = terrainData;
    this.afterRunSetup();
    this.hud.notice(`${country === undefined ? '' : CAMPAIGNS[country].name + ' campaign · '}Map 1 - wave 1 approaching. Deploy your defenses.`, 'info');
    const telegraph = waveTelegraph(0);
    if (telegraph) this.hud.notice(telegraph, 'warn');
    if (country !== undefined) {
      this.pauseRun(false);
      this.updateCampaignDispatch('deployment');
      this.menus.showDeploymentBriefing();
    }
  }

  continueRun(): void {
    const loaded = loadSnapshot(this.storage);
    if (loaded === null || 'error' in loaded || loaded.snap.phase !== 'running') {
      this.hud.notice('No resumable run found.', 'error');
      this.menus.showTitle(this.resumeAvailability(), this.best, null);
      return;
    }
    this.sim = Simulation.fromSnapshot(loaded.snap);
    this.afterRunSetup();
    this.sim.paused = true;
    if (this.sim.state.sectorSupplyPending) {
      this.openSectorSupplyChoice();
    } else {
      this.menus.showPause(false);
      this.overlayOpen = true;
    }
    this.hud.notice(
      this.sim.state.sectorSupplyPending
        ? 'Run restored - choose the captured-sector reward to continue.'
        : 'Run restored - paused. Press Resume when ready.',
      'good',
    );
  }

  private openSectorSupplyChoice(): void {
    const sim = this.sim;
    if (sim === null || !sim.state.sectorSupplyPending || sim.state.phase !== 'running') return;
    sim.paused = true;
    this.audio.cancelChatter();
    this.accumulator = 0;
    this.hud.setPausedBadge(true);
    this.menus.showSectorSupply(sim.state.units, sim.state.baseTerrainSeed);
    this.overlayOpen = true;
    this.saveRun();
  }

  chooseSectorSupply(choice: 'points' | 'medical', unitId?: number): void {
    const sim = this.sim;
    if (sim === null || !sim.state.sectorSupplyPending) return;
    const result = sim.claimSectorSupply(choice, unitId);
    if (!result.ok) {
      this.hud.notice(result.reason, 'error');
      return;
    }

    sim.paused = false;
    this.accumulator = 0;
    this.hud.setPausedBadge(false);
    this.menus.hideAll();
    this.overlayOpen = false;
    if (choice === 'points') {
      this.hud.notice(`Field supplies secured. +${result.reward} points.`, 'good');
    } else {
      this.hud.notice(`${this.soldierLabel(result.unitId!)} received medical resupply · +${result.reward} HP.`, 'good');
      this.audio.play('heal');
    }
    this.saveRun();
  }

  private afterRunSetup(): void {
    this.radio.reset();
    this.clearSelection();
    this.cancelDrag();
    this.terrainInspectMode = false;
    this.hud.showTerrainTooltip(null);
    this.mode = { kind: 'none' };
    this.accumulator = 0;
    this.alpha = 0;
    this.lastSaveTick = this.sim!.state.ticks;
    this.overlayOpen = false;
    this.menus.hideAll();
    this.hud.show();
    this.hud.setPausedBadge(false);
    // Re-read the battlefield from the simulation rather than trusting whatever
    // terrain data the caller happened to hold: a restored save is standing on a
    // later map than the run seed would suggest.
    this.reloadBattlefield();
    this.saveRun();
  }

  private endRun(victory: boolean): void {
    if (this.sim === null) return;
    const s = this.sim.state;
    this.sim.paused = true;
    this.audio.cancelChatter();
    clearSnapshot(this.storage);
    const score = s.score;
    const previousBest = this.best.bestScore;
    if (score > previousBest) {
      this.best.bestScore = score;
    }
    if (victory) this.best.victories += 1;
    saveBest(this.storage, this.best);
    const summary = {
      campaignCountry: s.campaignCountry,
      score,
      waves: s.scheduler.waveIndex + 1,
      kills: s.battleRecord.enemyKills,
      casualties: s.battleRecord.casualties,
      breakthroughs: s.battleRecord.breakthroughs,
      // Identity is derived from the run seed, so survivors keep their names
      // across every map they marched.
      seed: s.baseTerrainSeed,
      mapsCleared: s.mapsCleared,
      survivors: s.units.filter((unit) => unit.team === 'friendly' && !unit.dead && unit.health > 0 && unit.crossed !== true),
      integrity: s.integrity,
      bestScore: this.best.bestScore,
      newBest: score > previousBest,
    };
    this.menus.showResults(victory, summary, victory && !wonByCampaign(s));
    this.overlayOpen = true;
    this.audio.play(victory ? 'victory' : 'defeat');
  }

  /** Soldier name for HUD text; stable for the whole run, not just this map. */
  private soldierLabel(unitId: number): string {
    return this.sim === null ? 'A soldier' : soldierName(this.sim.state.baseTerrainSeed, unitId);
  }

  /**
   * Re-read the battlefield the simulation is standing on. Called on every map
   * change and on every run start; the simulation owns the seed, so the
   * renderer, the terrain inspector and the HUD setting label cannot drift out
   * of step with it.
   */
  private reloadBattlefield(arrival: FieldDispatch['arrival'] = 'review'): void {
    const sim = this.sim;
    if (sim === null) return;
    this.terrainData = sim.terrainData();
    this.mapHasRiver = this.terrainData.zones.river !== null;
    this.updateBattlefieldLabel(sim.state.weather);
    this.updateCampaignDispatch(sim.state.sectorSupplyPending ? 'secured' : arrival);
    this.renderer?.rebuildStatic(sim.state, this.terrainData);
  }

  private updateCampaignDispatch(arrival: FieldDispatch['arrival']): void {
    const s = this.sim?.state;
    this.menus.setCampaignDispatch(s?.campaignCountry ? {
      country: s.campaignCountry,
      mapsCleared: s.mapsCleared,
      mapNumber: s.mapNumber,
      sector: this.terrainData?.layout?.label ?? 'Forward position',
      squad: s.units.filter((unit) => unit.team === 'friendly' && !unit.dead && unit.health > 0 && !unit.crossed).length,
      arrival,
    } : null);
  }

  private updateBattlefieldLabel(weatherKind: WeatherKind): void {
    const data = this.terrainData;
    if (data === null) return;
    const setting = data.layout?.label ?? BATTLEFIELD_SETTINGS[data.settingId] ?? BATTLEFIELD_SETTINGS[0];
    const weather = CONFIG.weather[weatherKind];
    const time = this.sim === null ? null : dayNightAtTick(this.sim.state.ticks, this.sim.state.dayNightStartTick);
    const night = time?.night ?? false;
    const timeOfDay = time === null ? 'Day' : time.phase[0]!.toUpperCase() + time.phase.slice(1);
    const nightHint = night
      ? ` Night reduces spotting and firing range by ${Math.round((1 - CONFIG.dayNight.nightVisibilityMult) * 100)}%, accuracy by ${Math.round((1 - CONFIG.dayNight.nightAccuracyMult) * 100)}%, and movement speed by ${Math.round((1 - CONFIG.dayNight.nightMovementMult) * 100)}%.`
      : '';
    const country = data.campaignCountry === undefined ? '' : `${CAMPAIGNS[data.campaignCountry].name} · `;
    const season = SEASON_NAMES[this.sim?.state.season ?? data.season ?? seasonForSeed(data.seed)];
    const chapter = data.campaignCountry && this.sim ? campaignChapter(data.campaignCountry, this.sim.state.mapsCleared).chapter : null;
    this.hud.setBattlefield(`${country}${setting} · ${season} · ${weather.name} · ${this.mapHasRiver ? 'river' : 'Dry'} · ${timeOfDay}`, `${chapter ? `${chapter.period} · ${chapter.title}. Pause to review campaign orders. ` : ''}${data.campaignCountry === undefined ? '' : CAMPAIGNS[data.campaignCountry].description + ' '}${season}. ${weather.description}${nightHint}`);
  }

  pauseRun(auto: boolean): void {
    if (this.sim === null || this.sim.paused || this.sim.state.phase !== 'running') return;
    this.sim.paused = true;
    this.audio.cancelChatter();
    this.accumulator = 0;
    this.saveRun();
    this.hud.setPausedBadge(true);
    this.updateCampaignDispatch('review');
    this.menus.showPause(auto);
    this.overlayOpen = true;
  }

  resumeRun(): void {
    if (this.sim === null || this.sim.state.sectorSupplyPending) return;
    this.sim.paused = false;
    this.accumulator = 0;
    this.hud.setPausedBadge(false);
    this.menus.hideAll();
    this.overlayOpen = false;
  }

  togglePause(): void {
    if (this.sim === null || this.sim.state.phase !== 'running') return;
    if (this.sim.paused) {
      if (this.overlayOpen && this.menus.isOnPause()) this.resumeRun();
    } else {
      this.pauseRun(false);
    }
  }

  /** Escape: close panels first, then cancel placement/targeting mode, then pause. */
  escape(): void {
    if (this.menus.closePanels()) return;
    if (this.mode.kind !== 'none') {
      this.setMode({ kind: 'none' });
      return;
    }
    if (this.sim !== null && !this.sim.paused) this.pauseRun(false);
  }

  restartRun(): void {
    if (this.sim === null) return;
    this.newRun(this.sim.state.baseTerrainSeed, this.sim.state.campaignCountry);
    this.audio.play('ui');
  }

  quitToTitle(): void {
    if (this.sim !== null && this.sim.state.phase === 'running') {
      this.pauseRun(true); // autosave on the way out
    }
    this.sim = null;
    this.overlayOpen = false;
    if (this.terrainData !== null) {
      const idle = this.idleState();
      this.idlePreviewState = idle;
      this.renderer?.rebuildStatic(idle, this.terrainData);
    }
    this.hud.hide();
    this.menus.showTitle(this.resumeAvailability(), this.best, null);
  }

  continueEndless(): void {
    if (this.sim === null || !this.sim.continueEndless()) return;
    this.menus.hideAll();
    this.overlayOpen = false;
    this.sim.paused = false;
    this.hud.notice('Endless mode - how long can you hold?', 'warn');
    this.saveRun();
  }

  // ------------------------------------------------------------------- frame

  /** Called exactly once by the browser runtime's requestAnimationFrame loop. */
  frame(deltaMs: number): void {
    const sim = this.sim;
    const renderer = this.renderer;
    this.audio.setAtmosphere(sim?.state.weather ?? 'clear', sim !== null && !sim.paused && sim.state.phase === 'running' && !this.overlayOpen && !document.hidden, {
      pressure: sim ? battlePressure(sim.state) : 0, night: sim ? dayNightAtTick(sim.state.ticks, sim.state.dayNightStartTick).night : false,
      sheltered: localShelter(sim?.state.units.find((unit) => this.selectionIds.includes(unit.id))), secured: sim?.state.sectorCaptured ?? false,
    });
    if (this.mapReviewActive) {
      const preview = this.mapReviewState;
      if (preview !== null) renderer?.frame(preview, 0, null, [], Math.min(deltaMs, 100) / 1000);
      return;
    }
    if (sim === null) {
      if (renderer !== null && this.terrainData !== null) {
        renderer.frame(this.idlePreviewState ?? this.idleState(), 0, null, [], Math.min(deltaMs, 100) / 1000);
      }
      return;
    }
    if (renderer === null) return;
    const state = sim.state;

    if (!sim.paused && state.phase === 'running') {
      this.accumulator += Math.min(deltaMs, 250);
      let steps = 0;
      const collected: SimEvent[] = [];
      while (this.accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
        const events = sim.step();
        for (const ev of events) collected.push(ev);
        this.accumulator -= STEP_MS;
        steps++;
      }
      if (this.accumulator >= STEP_MS * MAX_STEPS_PER_FRAME) {
        this.accumulator = 0; // discard excess time after a long stall
      }
      this.alpha = Math.min(0.999, this.accumulator / STEP_MS);
      if (collected.length > 0) {
        renderer.handleEvents(state, collected);
        this.processEvents(collected);
      } else this.updateChatter([]);
      if (state.ticks - this.lastSaveTick >= secSafe(CONFIG.autosaveSeconds)) {
        this.saveRun();
      }
    }

    // Marching north replaces the battlefield. Terrain data is generated by the
    // simulation, so compare seeds rather than assuming the save path that led
    // here (new run, restored run, or a completed crossing).
    if (this.terrainData === null || this.terrainData.seed !== state.seed) this.reloadBattlefield();

    this.pruneSelection();
    const preview = this.currentPreview();
    this.hud.setPlacementFeedback(preview);
    renderer.frame(state, this.alpha, preview, this.selectionIds, Math.min(deltaMs, 100) / 1000, this.dragRect());
    this.hud.update(state, this.selectedUnits(), this.mode);
  }

  /** Fast deterministic fixture advancement for the opt-in ?e2e browser hook. */
  advanceForE2E(ticks: number): void {
    const sim = this.sim;
    if (!sim || this.renderer === null) return;
    sim.paused = false;
    const events: SimEvent[] = [];
    for (let i = 0; i < Math.max(0, Math.floor(ticks)) && sim.state.phase === 'running'; i++) events.push(...sim.step());
    this.accumulator = 0;
    this.alpha = 0;
    if (events.length > 0) {
      this.renderer.handleEvents(sim.state, events);
      this.processEvents(events);
    } else this.updateChatter([]);
    if (this.terrainData === null || this.terrainData.seed !== sim.state.seed) this.reloadBattlefield();
    this.pruneSelection();
    this.renderer.frame(sim.state, 0, this.currentPreview(), this.selectionIds, 0, this.dragRect());
    this.hud.update(sim.state, this.selectedUnits(), this.mode);
  }

  /** Living selected soldiers, in selection order. */
  selectedUnits(): Unit[] {
    const sim = this.sim;
    if (sim === null) return [];
    const byId = new Map(sim.state.units.map((u) => [u.id, u]));
    return this.selectionIds
      .map((id) => byId.get(id))
      .filter((u): u is Unit => u !== undefined && !u.dead && u.health > 0 && u.crossed !== true);
  }

  /** Living friendly ids on this map, so stale ids never survive a casualty, a
   *  march north, or a new run. */
  private livingFriendlies(): Set<number> {
    const sim = this.sim;
    if (sim === null) return new Set();
    return new Set(
      sim.state.units
        .filter((u) => u.team === 'friendly' && !u.dead && u.health > 0 && u.crossed !== true)
        .map((u) => u.id),
    );
  }

  /** Replace the selection, dropping ids that are no longer valid and any repeats. */
  setSelection(ids: readonly number[]): void {
    const living = this.livingFriendlies();
    const next: number[] = [];
    for (const id of ids) {
      if (living.has(id) && !next.includes(id)) next.push(id);
    }
    this.selectionIds = next;
  }

  /** Shift-click behaviour: add a soldier to the group, or remove it if present. */
  toggleSelection(unitId: number): void {
    const next = this.selectionIds.includes(unitId)
      ? this.selectionIds.filter((id) => id !== unitId)
      : [...this.selectionIds, unitId];
    this.setSelection(next);
  }

  clearSelection(): void {
    this.selectionIds = [];
  }

  /** Drop soldiers who have died since the last frame. */
  private pruneSelection(): void {
    if (this.selectionIds.length === 0) return;
    const living = this.livingFriendlies();
    if (this.selectionIds.every((id) => living.has(id))) return;
    this.selectionIds = this.selectionIds.filter((id) => living.has(id));
  }

  private cancelDrag(): void {
    this.dragOrigin = null;
    this.dragCurrent = null;
    this.dragMoved = false;
    this.dragAdditive = false;
  }

  /** The live rubber band, or null when no box selection is in progress. */
  private dragRect(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.dragOrigin === null || this.dragCurrent === null || !this.dragMoved) return null;
    return { x0: this.dragOrigin.x, y0: this.dragOrigin.y, x1: this.dragCurrent.x, y1: this.dragCurrent.y };
  }

  selectSoldier(unitId: number, additive = false): void {
    const unit = this.sim?.state.units.find((u) => u.id === unitId && u.team === 'friendly' && !u.dead && u.health > 0 && u.crossed !== true);
    if (unit === undefined) return;
    this.cancelMode();
    if (additive) this.toggleSelection(unit.id);
    else this.setSelection([unit.id]);
  }

  callMedic(unitId: number): void {
    const sim = this.requireSim();
    if (!sim) return;
    const result = sim.command({ type: 'callMedic', unitId });
    if (!result.ok) {
      this.hud.notice(result.reason ?? 'Unable to call a medic.', 'warn');
      return;
    }
    const patient = sim.state.units.find((u) => u.id === unitId)!;
    this.audio.shoutMedic((patient.pos.x / CONFIG.field.width) * 2 - 1);
    this.hud.chatter('friendly', `${this.soldierLabel(unitId)}: Medic!`);
    const assigned = new Set(sim.state.units.flatMap((u) => u.medicalTargetId === undefined ? [] : [u.medicalTargetId]));
    const position = (sim.state.medicalQueue ?? []).filter((id) => !assigned.has(id)).indexOf(unitId) + 1;
    this.hud.notice(assigned.has(unitId) ? `Medic dispatched to ${this.soldierLabel(unitId)}.`
      : `${this.soldierLabel(unitId)} is waiting for a medic · queue position ${position}.`, 'good');
  }

  callSupplies(unitId: number): void {
    const sim = this.requireSim();
    if (!sim) return;
    const role = sim.state.units.find((unit) => unit.id === unitId)?.role;
    const rockets = role === 'at', mortar = role === 'mortarman';
    const result = sim.command({ type: mortar ? 'callMortarSupplies' : rockets ? 'callRocketSupplies' : 'callGrenadeSupplies', unitId });
    if (!result.ok) { this.hud.notice(result.reason ?? 'Unable to request ammunition.', 'warn'); return; }
    const recipient = sim.state.units.find((u) => u.id === unitId)!;
    if (rockets || mortar) this.audio.play('ui');
    else this.audio.shoutGrenadeSupplies((recipient.pos.x / CONFIG.field.width) * 2 - 1);
    this.hud.chatter('friendly', `${this.soldierLabel(unitId)}: ${mortar ? 'Mortar' : rockets ? 'Rocket' : 'Grenade'} supplies!`);
    const assigned = new Set(sim.state.units.map((u) => u.supplyTargetId));
    const position = (sim.state.grenadeSupplyQueue ?? []).filter((id) => !assigned.has(id)).indexOf(unitId) + 1;
    this.hud.notice(assigned.has(unitId) ? `Supply Officer dispatched to ${this.soldierLabel(unitId)}.`
      : `${this.soldierLabel(unitId)} is waiting for ${mortar ? 'mortar bombs' : rockets ? 'rockets' : 'grenades'} · queue position ${position}.`, 'good');
  }

  private processEvents(events: readonly SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'automaticSupportRequested': {
          const caller = this.sim?.state.units.find((unit) => unit.id === ev.unitId);
          const pan = caller ? (caller.pos.x / CONFIG.field.width) * 2 - 1 : 0;
          const label = ev.kind === 'medic' ? 'Medic' : ev.kind === 'rockets' ? 'Rocket supplies' : ev.kind === 'mortarBombs' ? 'Mortar supplies' : 'Grenade supplies';
          if (ev.kind === 'medic') this.audio.shoutMedic(pan);
          else if (ev.kind === 'grenades') this.audio.shoutGrenadeSupplies(pan);
          else this.audio.play('ui');
          this.hud.chatter('friendly', `${this.soldierLabel(ev.unitId)}: ${label}!`);
          this.hud.notice(`${this.soldierLabel(ev.unitId)} automatically requested ${ev.kind === 'medic' ? 'a medic' : label.toLowerCase()}.`, 'info');
          break;
        }
        case 'tankCrewBailedOut':
          this.hud.notice(`Enemy tank crew bailed out: ${ev.crewIds.length} survivors · ${ev.retreating} retreating, ${ev.fighting} fighting.`, 'warn');
          break;
        case 'tankCrewEscaped':
          this.hud.notice('An enemy tank crewman escaped north.', 'info');
          break;
        case 'tankComponentDisabled':
          this.hud.notice(`Enemy tank: ${TANK_DAMAGE_LABELS[ev.component]}.`, 'good');
          break;
        case 'transportUnloaded':
          this.hud.notice(`Enemy transport deployed ${ev.count} riflemen!`, 'warn');
          this.audio.play('horn');
          break;
        case 'transportPassengersKilled':
          this.hud.notice(`Enemy troop transport destroyed · all ${ev.count} passengers killed.`, 'good');
          break;
        case 'grenadesResupplied':
          this.hud.notice(`${this.soldierLabel(ev.targetId)} received ${ev.amount} fresh grenade${ev.amount === 1 ? '' : 's'}.`, 'good');
          this.audio.play('ui');
          break;
        case 'rocketsResupplied':
          this.hud.notice(`${this.soldierLabel(ev.targetId)} received ${ev.amount} bazooka rocket${ev.amount === 1 ? '' : 's'}.`, 'good');
          this.audio.play('ui');
          break;
        case 'mortarBombsResupplied':
          this.hud.notice(`${this.soldierLabel(ev.targetId)} received ${ev.amount} mortar bomb${ev.amount === 1 ? '' : 's'}.`, 'good');
          this.audio.play('ui');
          break;
        case 'wavePhase':
          if (ev.phase === 'prep') {
            this.hud.notice(`Wave ${ev.wave} approaching in ${Math.ceil(ev.prepTicksLeft / CONFIG.tickRate)}s.`, 'info');
            const telegraph = waveTelegraph(ev.wave - 1);
            if (telegraph) this.hud.notice(telegraph, 'warn');
            this.saveRun(); // wave transition autosave
          } else if (ev.phase === 'spawning') {
            this.audio.play('horn');
            this.hud.notice(`Axis forces are attacking in wave ${ev.wave}!`, 'warn');
          }
          break;
        case 'waveCleared':
          this.hud.notice(`Wave ${ev.wave} cleared. +${ev.reward} points.`, 'good');
          this.audio.play('heal');
          break;
        case 'advanceAvailable':
          this.hud.notice('All 15 waves repelled. Move the squad north to advance; the next map starts at wave 1.', 'good');
          this.saveRun();
          break;
        case 'crossingBegan':
          this.hud.notice('The squad is marching north. No further wave will start on this map.', 'warn');
          break;
        case 'unitCrossed':
          this.hud.notice(
            ev.remaining > 0
              ? `${this.soldierLabel(ev.unitId)} is across the north edge - ${ev.remaining} still to cross.`
              : `${this.soldierLabel(ev.unitId)} is across the north edge.`,
            'good',
          );
          this.audio.play('ui');
          break;
        case 'mapCleared':
          this.reloadBattlefield(ev.credited ? 'secured' : 'withdrawal');
          {
            const setting = this.terrainData?.layout?.label ?? BATTLEFIELD_SETTINGS[this.terrainData?.settingId ?? 0] ?? BATTLEFIELD_SETTINGS[0];
          if (ev.credited) {
            this.hud.notice(
              `New map ${ev.mapNumber} · ${setting}. Sector secured (${ev.mapsCleared}/${ev.goal}); ${ev.squad} veteran${ev.squad === 1 ? '' : 's'} advanced. Wave 1 follows the arrival prep.`,
              'good',
            );
          } else {
            this.hud.notice(`New map ${ev.mapNumber} · ${setting}. Sector abandoned with no campaign credit; ${ev.squad} soldier${ev.squad === 1 ? '' : 's'} evacuated.`, 'warn');
          }
          }
          this.hud.notice('Forward positions are lost: sandbags, trenches, bunkers, mortar pits, barbed wire and mines do not march.', 'warn');
          this.audio.play('horn');
          if (this.sim?.state.sectorSupplyPending) this.openSectorSupplyChoice();
          else if (this.sim?.state.campaignCountry && this.sim.state.phase === 'running') {
            this.pauseRun(false);
            this.updateCampaignDispatch(ev.credited ? 'secured' : 'withdrawal');
          }
          break;
        case 'breakthrough':
          const unitLabel = ev.role === 'vehicle' ? 'vehicle' : ev.role === 'gun_truck' ? 'machine-gun truck' : ev.role === 'troop_transport' ? 'troop transport' : 'infantry';
          this.hud.notice(`Enemy ${unitLabel} broke through! Line integrity -${ev.damage}.`, 'error');
          this.audio.play('breakthrough');
          break;
        case 'unitDied':
          if (ev.team === 'friendly') {
            this.hud.notice(`${this.soldierLabel(ev.unitId)} lost.`, 'error');
            this.audio.play('explosion');
          } else {
            if (ev.role === 'vehicle' || ev.role === 'troop_transport') this.audio.play('explosion');
          }
          break;
        case 'satchelPlanted':
          this.hud.notice(`Satchel planted: ${CONFIG.satchel.fuseSeconds}s fuse. Move troops outside the blast radius!`, 'warn');
          this.audio.play('ui');
          break;
        case 'satchelDetonated':
          this.hud.notice(`Satchel charge detonated · ${ev.victims} caught in the blast.`, 'info');
          this.audio.play('explosion');
          if (this.prefs.screenShake && !this.prefs.reducedMotion) this.renderer?.shake(6, 0.5);
          break;
        case 'mineTriggered':
          this.hud.notice(ev.victims > 0 ? `Mine struck - ${ev.victims} caught in the blast.` : 'Mine detonated.', 'good');
          this.audio.play('explosion');
          // A charge going off under armour should register harder than one under
          // a man, so the shake scales with what the blast caught.
          if (this.prefs.screenShake && !this.prefs.reducedMotion) this.renderer?.shake(4 + Math.min(2, ev.victims) * 2, 0.3 + Math.min(2, ev.victims) * 0.1);
          break;
        case 'grenadeThrown':
          this.audio.play('ui');
          break;
        case 'smokeDeployed':
          this.hud.notice(`${this.soldierLabel(ev.unitId)} deployed smoke. Rifle fire is blocked for ${Math.ceil(ev.ticks / CONFIG.tickRate)}s.`, 'good');
          this.saveRun();
          break;
        case 'enemySmokeAssaultWarned':
          this.hud.notice('Enemy smoke-screen assault! Pin or eliminate the thrower before deployment.', 'warn');
          break;
        case 'enemySmokeAssaultDeployed':
          this.hud.notice(`Enemy infantry advancing under smoke for ${Math.ceil(ev.ticks / CONFIG.tickRate)}s. Reposition or use explosives.`, 'warn');
          break;
        case 'enemySmokeAssaultCancelled':
          this.hud.notice('Enemy smoke throw disrupted.', 'good');
          break;
        case 'sectorCaptured':
          this.hud.notice('Northern sector captured. March the squad north to earn campaign progress.', 'good');
          this.audio.play('horn');
          this.saveRun();
          break;
        case 'sectorCaptureProgress':
          this.hud.notice(`Capture position secure · ${Math.ceil(ev.ticks / CONFIG.tickRate)}/${Math.ceil(ev.total / CONFIG.tickRate)}s.`, 'info');
          break;
        case 'ambushTriggered':
          this.hud.notice('Ambush sprung! Opening burst gains accuracy and suppression.', 'good');
          this.saveRun();
          break;
        case 'fireOrderChanged':
        case 'specializationChosen':
          break;
        case 'mortarFired':
          this.audio.play('mortar', (ev.from.x / CONFIG.field.width) * 2 - 1);
          break;
        case 'artilleryOrdered':
          this.hud.notice('Artillery ordered - it damages everything in the area, including friendlies.', 'warn');
          this.saveRun(); // never allow reload to refund the purchase
          break;
        case 'airSupportOrdered':
          this.hud.notice(`Air support ordered - ${ev.bombs} bombs incoming across the marked run. Bombs damage friendlies too.`, 'warn');
          this.audio.play('airSupport', (ev.pos.x / CONFIG.field.width) * 2 - 1);
          this.saveRun();
          break;
        case 'flareDeployed':
          this.hud.notice(`Flare deployed. Enemies within ${ev.radius}px are easier to spot and hit for ${Math.ceil(ev.ticks / CONFIG.tickRate)}s.`, 'good');
          this.saveRun();
          break;
        case 'weatherChanged': {
          const weather = CONFIG.weather[ev.weather];
          this.hud.notice(`Weather changed: ${weather.name}. ${weather.description}`, 'info');
          this.updateBattlefieldLabel(ev.weather);
          this.saveRun();
          break;
        }
        case 'dayNightStarted':
          this.hud.notice(`Three waves cleared. The day/night cycle is now active.`, 'info');
          if (this.sim !== null) this.updateBattlefieldLabel(this.sim.state.weather);
          break;
        case 'dayNightChanged':
          this.hud.notice(ev.phase === 'dusk'
            ? 'Dusk is settling. The battlefield is getting darker.'
            : ev.phase === 'night'
              ? 'Night has fallen. Visibility, accuracy, and movement speed are reduced; tracer fire is active.'
              : ev.phase === 'dawn'
                ? 'Dawn is breaking. The battlefield is growing brighter.'
                : 'Daylight has returned. Visibility, accuracy, and movement speed are back to normal.', 'info');
          if (this.sim !== null) this.updateBattlefieldLabel(this.sim.state.weather);
          break;
        case 'enemyBarrageIncoming':
          this.hud.notice(
            `Axis artillery is ranging the line - ${ev.shells} shell${ev.shells === 1 ? '' : 's'} incoming. Spread out!`,
            'error',
          );
          this.audio.play('horn');
          this.saveRun(); // the barrage is in the air; a reload must not undo it
          break;
        case 'foodSupplies':
          this.hud.notice(`Rations delivered by radio. +${ev.points} supply points.`, 'good');
          this.audio.play('heal');
          break;
        case 'artilleryImpact':
          this.audio.play(ev.delivery === 'airSupport' ? 'airBomb' : 'artillery', (ev.pos.x / CONFIG.field.width) * 2 - 1);
          if (this.prefs.screenShake && !this.prefs.reducedMotion) this.renderer?.shake(6, 0.5);
          break;
        case 'explosion':
          this.audio.play('explosion');
          if (this.prefs.screenShake && !this.prefs.reducedMotion && ev.radius > 40) this.renderer?.shake(3, 0.25);
          break;
        case 'shot': {
          if (ev.weapon === 'Panzerschreck' || ev.weapon === '57 mm M1 Anti-Tank Gun') {
            this.audio.play('rocket', (ev.from.x / CONFIG.field.width) * 2 - 1);
          } else if (ev.shooterTeam === 'enemy' || ev.weapon === 'M1918A2 BAR' || ev.weapon === 'STEN Submachine Gun' || ev.weapon === 'M1A1 Thompson' || ev.weapon.includes('Tripod')) {
            // Only some shots audible to keep the mix restrained.
            if (ev.weapon !== 'M1918A2 BAR' || Math.random() < 0.35) {
              this.audio.play(ev.weapon === 'MP 40' || ev.weapon === 'STEN Submachine Gun' || ev.weapon === 'M1A1 Thompson' ? 'smg' : ev.weapon.includes('M1919') || ev.weapon.includes('MG 42') || ev.weapon === 'M1918A2 BAR' ? 'mg' : 'rifle', (ev.from.x / CONFIG.field.width) * 2 - 1);
            }
          } else if (ev.weapon === 'M1A1 Bazooka') {
            this.audio.play('rocket', (ev.from.x / CONFIG.field.width) * 2 - 1);
          } else if (Math.random() < 0.5) {
            this.audio.play('rifle', (ev.from.x / CONFIG.field.width) * 2 - 1);
          }
          break;
        }
        case 'healed':
          this.audio.play('heal');
          break;
        case 'sapperTeamInbound':
          this.hud.notice('Enemy sapper team inbound: demolition specialist with two rifle escorts. Watch your defenses!', 'warn');
          this.audio.play('horn');
          break;
        case 'sapperTargeted':
          this.hud.notice(`Sapper team targeting ${ev.label}! Pin or eliminate the marked specialist before he plants a charge.`, 'warn');
          break;
        case 'enemyChargePlanted':
          this.hud.notice(`Enemy demolition charge armed! ${CONFIG.enemySappers.fuseSeconds}s fuse. Evacuate the marked blast area! Killing the sapper will not stop it.`, 'error');
          this.audio.play('horn'); this.saveRun();
          break;
        case 'enemyChargeDetonated':
          this.hud.notice('Enemy demolition charge detonated!', 'error');
          this.audio.play('explosion');
          if (this.prefs.screenShake && !this.prefs.reducedMotion) this.renderer?.shake(9, .6);
          this.saveRun();
          break;
        case 'structureDemolished':
          this.hud.notice(ev.kind === 'bridge' ? 'Bridge demolished! The crossing is now water. Engineers can build a replacement pontoon.' : 'Bunker demolished! Its occupants have lost their cover.', 'error');
          if (ev.kind === 'bridge' && this.sim) this.terrainData = this.sim.terrainData();
          this.saveRun();
          break;
        case 'wireCutStarted':
          this.hud.notice('Enemy engineer cutting barbed wire! Pin or eliminate him to stop the breach.', 'warn');
          break;
        case 'wireBreached':
          this.hud.notice('Barbed wire breached! Enemy infantry can use the new lane.', 'error');
          this.saveRun();
          break;
        case 'constructionCompleted':
          this.hud.notice(`${ev.kind === 'barbedWire' ? 'Barbed wire' : ev.kind === 'sandbag' ? 'Sandbags' : ev.kind === 'trench' ? 'Trench' : ev.kind === 'bunker' ? 'Bunker' : ev.kind === 'mortarPit' ? 'Mortar pit' : ev.kind === 'bridge' ? 'Bridge' : 'Mine'} finished ${ev.kind === 'mine' ? 'laying' : 'construction'}.`, 'good');
          this.audio.play('ui');
          break;
        case 'constructionAbandoned': {
          const label = ev.kind === 'barbedWire' ? 'Barbed wire' : ev.kind === 'sandbag' ? 'Sandbags' : ev.kind === 'trench' ? 'Trench' : ev.kind === 'bunker' ? 'Bunker' : ev.kind === 'mortarPit' ? 'Mortar pit' : ev.kind === 'bridge' ? 'Bridge' : 'Mine';
          this.hud.notice(
            `${label} abandoned - no engineer left to finish it.${ev.refund > 0 ? ` +${ev.refund} points back.` : ''}`,
            'warn',
          );
          break;
        }
        case 'buildingHit':
          // A single round striking masonry is not news; the destruction notice is.
          if (this.prefs.screenShake && !this.prefs.reducedMotion) this.renderer?.shake(2, 0.15);
          break;
        case 'buildingDestroyed':
          this.hud.notice(`${ev.name} has been destroyed - the ground it stood on is open.`, 'warn');
          this.audio.play('explosion');
          if (this.prefs.screenShake && !this.prefs.reducedMotion) this.renderer?.shake(9, 0.6);
          break;
        case 'victory':
          this.endRun(true);
          break;
        case 'defeat':
          this.endRun(false);
          break;
        default:
          break;
      }
    }
    this.updateChatter(events);
  }

  private updateChatter(events: readonly SimEvent[]): void {
    const sim = this.sim;
    if (sim !== null && !sim.paused && sim.state.phase === 'running' && !this.radioTransmissionPending) {
      const chatter = this.radio.consider(events, sim.state.units, sim.state.ticks, sim.state.weather, sim.state.campaignCountry, sim.state.scheduler.phase);
      if (this.radio.takeBanterInterruption()) { this.audio.cancelChatter(false); this.hud.clearChatter(); }
      if (chatter !== null) {
        this.hud.chatter(chatter.team, chatter.reply ? `${chatter.text} — ${this.soldierLabel(chatter.reply.speakerId)}: ${chatter.reply.text}` : chatter.text, chatter.channel);
        this.audio.speakChatter(chatter.text, chatter.team, chatter.delivery, chatter.speakerId, chatter.cue, chatter.confirmation, chatter.channel, chatter.reply);
      }
    }
  }

  // ---------------------------------------------------------------- commands

  private requireSim(): Simulation | null {
    if (this.sim === null || this.sim.paused || this.sim.state.phase !== 'running') return null;
    return this.sim;
  }

  orderMove(unitId: number, pos: { x: number; y: number }): boolean {
    const sim = this.requireSim();
    if (sim === null) return false;
    const result = sim.command({ type: 'move', unitId, pos });
    if (!result.ok && result.reason) this.hud.notice(result.reason, 'error');
    return result.ok;
  }

  chooseBuildingLevel(level: BuildingLevel, facing?: BuildingFacing): void {
    const sim = this.requireSim(), units = this.selectedUnits();
    const position = units[0]?.buildingOrder ?? units[0]?.buildingPosition;
    if (!sim || !position) return;
    const result = sim.command({ type: 'garrison', unitIds: units.map((u) => u.id), buildingId: position.buildingId, level, facing });
    if (!result.ok && result.reason) this.hud.notice(result.reason, 'warn');
  }

  leaveSelectedBuilding(): void {
    const sim = this.requireSim();
    if (!sim) return;
    const result = sim.command({ type: 'leaveBuilding', unitIds: this.selectedUnits().map((u) => u.id) });
    if (!result.ok && result.reason) this.hud.notice(result.reason, 'warn');
  }

  /**
   * Move the whole selection. One command carries the group so the simulation
   * can resolve a formation against the terrain and against whoever is still
   * standing when the order lands.
   */
  orderMoveGroup(unitIds: readonly number[], pos: { x: number; y: number }): boolean {
    const sim = this.requireSim();
    if (sim === null || unitIds.length === 0) return false;
    if (unitIds.length === 1) return this.orderMove(unitIds[0] as number, pos);
    const result = sim.command({ type: 'moveGroup', unitIds: [...unitIds], pos });
    if (!result.ok) {
      if (result.reason) this.hud.notice(result.reason, 'error');
      return false;
    }
    this.audio.play('ui');
    return true;
  }

  requestFoodSupplies(): void {
    const sim = this.requireSim();
    if (sim === null) return;
    this.beginRadioSupportRequest(
      'foodSupplies',
      'Quartermaster, send rations. Over.',
      'Roger.',
      (current) => current.command({ type: 'foodSupplies' }),
    );
  }

  private beginRadioSupportRequest(
    kind: 'artillery' | 'airSupport' | 'foodSupplies' | 'flare',
    request: string,
    response: string,
    commit: (sim: Simulation) => { ok: boolean; reason?: string },
  ): boolean {
    const sim = this.requireSim();
    if (sim === null) return false;
    if (this.radioTransmissionPending) {
      this.hud.notice('Radio transmission in progress. Wait for Control to answer.', 'info');
      return false;
    }
    const validation = sim.validateRadioRequest(kind);
    if (!validation.ok) {
      if (validation.reason) this.hud.notice(validation.reason, 'error');
      return false;
    }
    const operator = sim.state.units.find((unit) => unit.team === 'friendly' && unit.role === 'radio_engineer'
      && unit.health > 0 && !unit.pinned && unit.crossed !== true);
    if (operator === undefined) return false;

    this.radioTransmissionPending = true;
    if (kind === 'foodSupplies') this.hud.setFoodSuppliesPending(true);
    if (kind === 'flare') this.hud.setFlareRequestPending(true);
    if (kind === 'artillery') this.hud.setArtilleryRequestPending(true);
    if (kind === 'airSupport') this.hud.setAirSupportRequestPending(true);
    this.hud.chatter('friendly', request);
    this.hud.notice('Transmitting request · waiting for voice confirmation.', 'info');
    this.audio.speakRadioExchange(request, response, operator.id, (confirmed) => {
      this.radioTransmissionPending = false;
      if (kind === 'foodSupplies') this.hud.setFoodSuppliesPending(false);
      if (kind === 'flare') this.hud.setFlareRequestPending(false);
      if (kind === 'artillery') this.hud.setArtilleryRequestPending(false);
      if (kind === 'airSupport') this.hud.setAirSupportRequestPending(false);
      if (this.sim !== sim || sim.state.phase !== 'running') return;
      if (!confirmed) {
        this.hud.notice('No voice confirmation received. Request canceled.', 'warn');
        return;
      }
      this.hud.chatter('friendly', response);
      const currentValidation = sim.validateRadioRequest(kind);
      if (!currentValidation.ok) {
        if (currentValidation.reason) this.hud.notice(currentValidation.reason, 'error');
        return;
      }
      const result = commit(sim);
      if (!result.ok) {
        if (result.reason) this.hud.notice(result.reason, 'error');
        return;
      }
      if (kind === 'foodSupplies') {
        this.processEvents([{ type: 'foodSupplies', points: CONFIG.foodSupply.points }]);
      } else if (kind === 'flare') {
        this.hud.notice(`Flare incoming. Impact in ${CONFIG.flare.deploymentDelaySeconds}s.`, 'info');
      }
      this.saveRun();
    });
    return true;
  }

  lightSelectedFire(): void {
    const sim = this.requireSim();
    const selected = this.selectedUnits();
    if (sim === null) return;
    if (selected.length !== 1) {
      this.hud.notice('Select one soldier to light a small fire.', 'warn');
      return;
    }
    const result = sim.command({ type: 'lightFire', unitId: selected[0]!.id });
    if (result.ok) {
      this.hud.notice(`Small fire lit for ${CONFIG.campfire.durationSeconds}s. Its light reveals nearby soldiers to both sides.`, 'info');
      this.saveRun();
    } else if (result.reason) this.hud.notice(result.reason, 'warn');
  }

  beginSatchel(): void {
    const sim = this.requireSim();
    if (!sim) return;
    const selected = this.selectedUnits();
    const reason = selected.length === 1 ? satchelError(sim.state, selected[0]) : 'Select one Combat Support Engineer.';
    if (reason) { this.hud.notice(reason, 'warn'); return; }
    this.setMode({ kind: 'satchel' });
  }

  beginSmoke(): void {
    const selected = this.selectedUnits();
    if (selected.length !== 1 || (selected[0]!.smokeGrenades ?? 0) <= 0) {
      this.hud.notice('Select one rifleman or engineer with smoke remaining.', 'warn');
      return;
    }
    this.setMode({ kind: 'smoke' });
  }

  cycleFireOrder(): void {
    const sim = this.sim;
    const selected = this.selectedUnits();
    if (sim === null || selected.length === 0) return;
    const orders = FIRE_ORDERS.filter((order) => selected.every((unit) => fireOrdersForRole(unit.role).includes(order)));
    if (orders.length === 0) return;
    const current = selected[0]!.fireOrder ?? 'auto';
    const next = orders[(orders.indexOf(current) + 1) % orders.length]!;
    const result = sim.command({ type: 'fireOrder', unitIds: selected.map((unit) => unit.id), order: next });
    if (result.ok) {
      this.hud.notice(`Fire order: ${next === 'auto' ? 'automatic' : next === 'antiArmor' ? 'prioritize armor' : next === 'stopBreakthrough' ? 'stop breakthroughs' : next === 'seekGunfire' ? 'run to the nearest heard enemy gunfire and engage' : 'hold grenades'}.`, 'info');
      this.saveRun();
    } else if (result.reason) this.hud.notice(result.reason, 'error');
  }

  cycleStance(): void {
    const sim = this.requireSim();
    const selected = this.selectedUnits().filter((unit) => unit.role !== 'vehicle' && unit.role !== 'gun_truck');
    if (sim === null || selected.length === 0) return;
    const order = ['standing', 'crouching', 'prone'] as const;
    const current = selected[0]!.stance ?? 'standing';
    const stance = order[(order.indexOf(current) + 1) % order.length]!;
    const result = sim.command({ type: 'posture', unitIds: selected.map((unit) => unit.id), stance, crawling: false });
    if (!result.ok) {
      if (result.reason) this.hud.notice(result.reason, 'error');
      return;
    }
    this.saveRun();
  }

  toggleCrawl(): void {
    const sim = this.requireSim();
    const selected = this.selectedUnits().filter((unit) => unit.role !== 'vehicle' && unit.role !== 'gun_truck');
    if (sim === null || selected.length === 0) return;
    if (selected.some((unit) => unit.pinned)) {
      this.hud.notice('Pinned soldiers cannot take a crawl order.', 'warn');
      return;
    }
    const crawling = !selected.every((unit) => unit.crawling === true);
    const result = sim.command({ type: 'posture', unitIds: selected.map((unit) => unit.id), stance: selected[0]!.stance ?? 'standing', crawling });
    if (!result.ok) {
      if (result.reason) this.hud.notice(result.reason, 'error');
      return;
    }
    this.saveRun();
  }

  toggleRun(): void {
    const sim = this.requireSim();
    const selected = this.selectedUnits().filter((unit) => unit.role !== 'vehicle' && unit.role !== 'gun_truck');
    if (sim === null || !selected.length) return;
    const pace = selected.some((unit) => unit.movementPace === 'run') ? 'walk' : 'run';
    const result = sim.command({ type: 'pace', unitIds: selected.map((unit) => unit.id), pace });
    if (!result.ok) {
      if (result.reason) this.hud.notice(result.reason, 'warn');
      return;
    }
    this.saveRun();
  }

  useRoleAbility(): void {
    if (this.mode.kind === 'suppress') { this.cancelMode(); return; }
    const sim = this.requireSim();
    if (!sim) return;
    const unit = sim.state.units.find((u) => this.selectionIds.includes(u.id) && u.team === 'friendly');
    if (!unit) return;
    if (!unit.roleDuty && (unit.role === 'mg' || unit.role === 'heavy_mg')) { this.setMode({ kind: 'suppress', unitId: unit.id }); return; }
    const result = sim.command({ type: 'roleAbility', unitId: unit.id });
    if (!result.ok) this.hud.notice(result.reason ?? 'Ability unavailable.', 'warn');
    else { this.saveRun(); this.cancelMode(); }
  }

  toggleAmbush(arcDegrees: number): void {
    if (this.mode.kind === 'ambush') { this.cancelMode(); return; }
    const sim = this.requireSim();
    const selected = this.selectedUnits().filter(supportsAmbush);
    if (!sim || !selected.length) return;
    if (selected.some((unit) => unit.ambush)) {
      const result = sim.command({ type: 'cancelAmbush', unitIds: selected.map((unit) => unit.id) });
      if (result.ok) { this.hud.notice('Ambush cancelled. Normal fire orders resumed.', 'info'); this.saveRun(); }
      return;
    }
    this.setMode({ kind: 'ambush', unitIds: selected.map((unit) => unit.id), arcDegrees });
  }

  updateAmbushArc(arcDegrees: number): void {
    if (this.mode.kind === 'ambush') this.mode = { ...this.mode, arcDegrees };
  }

  togglePatrol(): void {
    if (this.mode.kind === 'patrol') { this.cancelMode(); return; }
    const sim = this.requireSim();
    const selected = this.selectedUnits().filter((unit) => isPatrolRole(unit.role));
    if (!sim || !selected.length) return;
    if (selected.every((unit) => unit.patrol)) {
      const result = sim.command({ type: 'stopPatrol', unitIds: selected.map((unit) => unit.id) });
      if (result.ok) this.saveRun();
      else if (result.reason) this.hud.notice(result.reason, 'warn');
      return;
    }
    this.setMode({ kind: 'patrol', unitIds: selected.filter((unit) => !unit.pinned).map((unit) => unit.id) });
  }

  toggleVehicleHeadlights(): void {
    const sim = this.sim;
    if (sim === null) return;
    const vehicles = this.selectedUnits().filter((unit) => unit.role === 'gun_truck' || unit.role === 'vehicle');
    if (vehicles.length === 0) return;
    const on = vehicles.some((unit) => unit.headlightsOn === false);
    const result = sim.command({ type: 'headlights', unitIds: vehicles.map((unit) => unit.id), on });
    if (result.ok) {
      this.hud.notice(on
        ? 'Headlights on · normal speed at night, but easier for enemies to spot and hit.'
        : 'Headlights off · concealed at night, but movement is 25% slower.', 'info');
      this.saveRun();
    } else if (result.reason) this.hud.notice(result.reason, 'error');
  }

  chooseSpecialization(specialization: Specialization): void {
    const sim = this.sim;
    const selected = this.selectedUnits();
    if (sim === null || selected.length !== 1) return;
    const result = sim.command({ type: 'specialization', unitId: selected[0]!.id, specialization });
    if (result.ok) {
      this.hud.notice(`${this.soldierLabel(selected[0]!.id)} earned a veteran specialization.`, 'good');
      this.saveRun();
    } else if (result.reason) this.hud.notice(result.reason, 'error');
  }

  purchaseWeaponUpgrade(type: WeaponUpgradeType): void {
    const sim = this.requireSim();
    if (sim === null) return;
    // Upgrades are personal issue. With a group selected there is no single
    // soldier to issue one to, so ask for one rather than silently picking.
    if (this.selectionIds.length > 1) {
      this.hud.notice('Weapon upgrades are per soldier - select one soldier first.', 'warn');
      return;
    }
    if (this.selectionId === null) {
      this.hud.notice('Select a soldier before purchasing an upgrade.', 'warn');
      return;
    }
    const soldier = sim.state.units.find((unit) => unit.id === this.selectionId);
    const result = sim.purchaseWeaponUpgrade(this.selectionId, type);
    if (!result.ok) {
      if (result.reason) this.hud.notice(result.reason, 'error');
      return;
    }
    const label = type === 'accuracy' ? 'Accuracy' : type === 'reload' ? 'Reload speed' : 'Weapon damage';
    const level = soldier?.weaponUpgrades[type] ?? 0;
    const soldierLabel = soldier !== undefined && soldier.team === 'friendly'
      ? getContent().friendly[soldier.role as FriendlyRole].label
      : 'Soldier';
    const seconds = Math.ceil(CONFIG.weaponUpgrades.upgradeSeconds);
    this.hud.notice(
      `${soldierLabel}: ${label} upgraded to level ${level}/${CONFIG.weaponUpgrades.maxLevel}. `
      + `Weapon in pieces for ${seconds}s - he cannot fire until it is back together.`,
      'warn',
    );
    this.audio.play('ui');
    this.saveRun();
  }

  setMode(mode: UIMode): void {
    if (mode.kind !== 'none' && this.sim !== null && this.sim.paused) {
      this.hud.notice('Orders are locked while paused - inspect only.', 'warn');
      return;
    }
    this.terrainInspectMode = false;
    this.hud.showTerrainTooltip(null);
    this.mode = mode;
    this.hud.setModeUI(mode);
    this.audio.play('ui');
  }

  cancelMode(): void {
    if (this.mode.kind === 'none') return;
    this.mode = { kind: 'none' };
    this.hud.setModeUI(this.mode);
  }

  /**
   * Left-press on the battlefield. A press selects immediately, which is what a
   * plain click should feel like; a press that then travels becomes a rubber
   * band and the box wins on release.
   *
   * `additive` is the shift modifier: extend the group instead of replacing it.
   */
  pointerLeft(worldX: number, worldY: number, additive = false, resolvedUnitId?: number): void {
    this.terrainInspectMode = false;
    this.hud.showTerrainTooltip(null);
    const sim = this.requireSim();
    if (sim === null) {
      this.cancelDrag();
      return;
    }
    const pos = { x: worldX, y: worldY };
    if (this.mode.kind !== 'none') {
      // Placement modes own the press; there is no selection drag to start.
      this.cancelDrag();
      this.applyModeClick(sim, pos);
      return;
    }
    this.dragOrigin = { ...pos };
    this.dragCurrent = { ...pos };
    this.dragMoved = false;
    this.dragAdditive = additive;

    const resolved = resolvedUnitId === undefined ? undefined : sim.state.units.find((u) => u.id === resolvedUnitId && u.team === 'friendly' && !u.dead && u.health > 0 && u.crossed !== true);
    const hit = resolved ?? this.unitAt(sim.state, pos);
    if (hit !== null) {
      if (additive) this.toggleSelection(hit.id);
      else this.setSelection([hit.id]);
    } else if (!additive) {
      this.clearSelection();
    }
  }

  /** Left-release: if the press travelled, it was a box selection. */
  pointerUp(worldX: number, worldY: number, additive = false): void {
    const origin = this.dragOrigin;
    const moved = this.dragMoved;
    const wasAdditive = this.dragAdditive || additive;
    this.cancelDrag();
    if (origin === null || !moved) return;

    const sim = this.requireSim();
    if (sim === null || this.mode.kind !== 'none') return;
    const box = {
      x0: Math.min(origin.x, worldX) - SELECT_MARGIN,
      y0: Math.min(origin.y, worldY) - SELECT_MARGIN,
      x1: Math.max(origin.x, worldX) + SELECT_MARGIN,
      y1: Math.max(origin.y, worldY) + SELECT_MARGIN,
    };
    const inside = sim.state.units
      .filter((u) => u.team === 'friendly' && !u.dead && u.health > 0 && u.crossed !== true)
      .filter((u) => u.pos.x >= box.x0 && u.pos.x <= box.x1 && u.pos.y >= box.y0 && u.pos.y <= box.y1)
      .map((u) => u.id);
    this.setSelection(wasAdditive ? [...this.selectionIds, ...inside] : inside);
  }

  /** Execute a placement or targeting mode's click. */
  private applyModeClick(sim: Simulation, pos: { x: number; y: number }): void {
    if (this.mode.kind === 'suppress') {
      const result = sim.command({ type: 'roleAbility', unitId: this.mode.unitId, pos });
      if (result.ok) { this.saveRun(); this.cancelMode(); }
      else this.hud.notice(result.reason ?? 'Cannot suppress this ground.', 'warn');
      return;
    }
    if (this.mode.kind === 'ambush') {
      const result = sim.command({ type: 'ambush', unitIds: this.mode.unitIds, aim: pos, arcDegrees: this.mode.arcDegrees });
      if (result.ok) {
        this.hud.notice(`Ambush ordered. Prepare for ${CONFIG.ambush.prepareSeconds}s, then hold fire until a visible enemy enters the marked arc.`, 'info');
        this.saveRun(); this.cancelMode();
      } else if (result.reason) this.hud.notice(result.reason, 'warn');
      return;
    }
    if (this.mode.kind === 'patrol') {
      if (sim.paused) { this.hud.notice('Orders are locked while paused.', 'warn'); return; }
      if (!this.mode.origin) {
        if (pos.x < 4 || pos.y < 4 || pos.x > CONFIG.field.width - 4 || pos.y > CONFIG.field.height - 4) {
          this.hud.notice('Mark the patrol area inside the battlefield.', 'warn'); return;
        }
        this.setMode({ ...this.mode, origin: { ...pos } });
        return;
      }
      const result = sim.command({ type: 'patrol', unitIds: this.mode.unitIds, from: this.mode.origin, to: pos });
      if (result.ok) {
        this.hud.notice('Patrol assigned. Soldiers pause to fight or treat wounded, then resume. A move order cancels patrol.', 'good');
        this.cancelMode(); this.saveRun();
      } else if (result.reason) this.hud.notice(result.reason, 'warn');
      return;
    }
    if (this.mode.kind === 'recruit') {
      const result = sim.command({ type: 'recruit', role: this.mode.role, pos });
      if (result.ok) {
        const def = getContent().friendly[this.mode.role];
        this.hud.notice(`${def.label} deployed.`, 'good');
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'barbedWire') {
      const result = sim.command({ type: 'barbedWire', pos });
      if (result.ok) {
        this.hud.notice(`Engineer started barbed wire construction (${CONFIG.construction.barbedWireSeconds}s). Leave gaps for clear lanes. Stay within ${CONFIG.construction.engineerRange}px.`, 'info');
        this.saveRun();
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'sandbag') {
      const result = sim.command({ type: 'sandbag', pos });
      if (result.ok) {
        this.hud.notice(`Engineer started sandbag construction (${CONFIG.construction.sandbagSeconds}s). Stay within ${CONFIG.construction.engineerRange}px.`, 'info');
        this.saveRun();
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'trench') {
      const result = sim.command({ type: 'trench', pos });
      if (result.ok) {
        this.hud.notice(`Engineer started trench construction (${CONFIG.construction.trenchSeconds}s). Stay within ${CONFIG.construction.engineerRange}px.`, 'info');
        this.saveRun();
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'bunker') {
      const result = sim.command({ type: 'bunker', pos });
      if (result.ok) {
        this.hud.notice(`Engineer started bunker construction (${CONFIG.construction.bunkerSeconds}s). Stay within ${CONFIG.construction.engineerRange}px.`, 'info');
        this.saveRun();
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'mortarPit') {
      const result = sim.command({ type: 'mortarPit', pos });
      if (result.ok) {
        this.hud.notice(`Engineer started mortar pit construction (${CONFIG.construction.mortarPitSeconds}s). Mortarmen inside reload faster and are better protected.`, 'info');
        this.saveRun();
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'bridge') {
      const result = sim.command({ type: 'bridge', pos });
      if (result.ok) {
          this.hud.notice(`Engineer started pontoon bridge construction (${CONFIG.construction.bridgeSeconds}s).`, 'info');
        this.saveRun();
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'mine') {
      const def = CONFIG.mineKinds[this.mode.mineKind];
      const result = sim.command({ type: 'mine', kind: this.mode.mineKind, pos });
      if (result.ok) {
        this.hud.notice(`Engineer is laying an ${def.label} (${def.laySeconds}s). Stay within ${CONFIG.construction.engineerRange}px.`, 'info');
        this.saveRun();
        this.cancelMode();
      } else if (result.reason) {
        this.hud.notice(result.reason, 'error');
      }
      return;
    }
    if (this.mode.kind === 'artillery') {
      if (this.beginRadioSupportRequest(
        'artillery',
        'Battery, fire on my mark. Over.',
      'Fire away.',
        (current) => current.command({ type: 'artillery', pos }),
      )) this.cancelMode();
      return;
    }
    if (this.mode.kind === 'airSupport') {
      if (this.beginRadioSupportRequest(
        'airSupport',
        'Air Control, strike on my mark. Over.',
      'Fire away.',
        (current) => current.command({ type: 'airSupport', pos }),
      )) this.cancelMode();
      return;
    }
    if (this.mode.kind === 'flare') {
      if (this.beginRadioSupportRequest(
        'flare',
        'Flare on mark. Over.',
        'Roger.',
        (current) => current.command({ type: 'flare', pos }),
      )) this.cancelMode();
      return;
    }
    if (this.mode.kind === 'satchel') {
      const selected = this.selectedUnits();
      if (selected.length !== 1) {
        this.hud.notice('Select one Combat Support Engineer.', 'warn');
        this.cancelMode();
        return;
      }
      const result = sim.command({ type: 'satchel', unitId: selected[0]!.id, pos });
      if (result.ok) { this.cancelMode(); this.saveRun(); }
      else if (result.reason) this.hud.notice(result.reason, 'error');
      return;
    }
    if (this.mode.kind === 'smoke') {
      const soldier = this.selectedUnits()[0];
      if (soldier === undefined) {
        this.hud.notice('Select one soldier to throw smoke.', 'warn');
        this.cancelMode();
        return;
      }
      const result = sim.command({ type: 'smoke', unitId: soldier.id, pos });
      if (result.ok) {
        this.cancelMode();
        this.saveRun();
      } else if (result.reason) this.hud.notice(result.reason, 'error');
      return;
    }
  }

  /** Right-click walks the selection; a double right-click orders a run. */
  pointerRight(worldX: number, worldY: number, run = false): void {
    this.pointerPos = { x: worldX, y: worldY };
    this.cancelDrag();
    if (this.mode.kind !== 'none') {
      this.cancelMode();
      return;
    }
    const targets = this.selectedUnits();
    if (targets.length > 0) {
      this.terrainInspectMode = false;
      this.hud.showTerrainTooltip(null);
      const previousPaths = targets.map((unit) => unit.path);
      if (this.orderMoveGroup(targets.map((u) => u.id), { x: worldX, y: worldY })) {
        const infantry = targets.filter((unit, index) => unit.path !== previousPaths[index]
          && unit.role !== 'vehicle' && unit.role !== 'gun_truck');
        if (infantry.length) {
          const result = this.sim!.command({ type: 'pace', unitIds: infantry.map((unit) => unit.id), pace: run ? 'run' : 'walk' });
          if (!result.ok && run && result.reason) this.hud.notice(result.reason, 'warn');
        }
      }
      return;
    }
    if (this.sim === null) return;
    this.terrainInspectMode = !this.terrainInspectMode;
    if (this.terrainInspectMode) this.pointerMove(worldX, worldY);
    else this.hud.showTerrainTooltip(null);
  }

  pointerMove(worldX: number, worldY: number): void {
    this.pointerPos = { x: worldX, y: worldY };
    if (this.dragOrigin !== null) {
      this.dragCurrent = { x: worldX, y: worldY };
      if (!this.dragMoved) {
        const travelled = Math.hypot(worldX - this.dragOrigin.x, worldY - this.dragOrigin.y);
        if (travelled >= GameController.DRAG_THRESHOLD) this.dragMoved = true;
      }
    }
    if (!this.terrainInspectMode) {
      this.hud.showTerrainTooltip(null);
      return;
    }
    const sim = this.sim;
    const terrainData = this.terrainData;
    if (sim === null || terrainData === null || worldX < 0 || worldY < 0 || worldX >= CONFIG.field.width || worldY >= CONFIG.field.height) {
      this.hud.showTerrainTooltip(null);
      return;
    }

    const state = sim.state;
    for (const wire of state.barbedWire) {
      if (!wireContains(wire, { x: worldX, y: worldY }, 4)) continue;
      this.hud.showTerrainTooltip({ title: 'Barbed wire',
        detail: `Infantry on both sides cross at ${Math.round(CONFIG.barbedWire.speedMult * 100)}% speed. Vehicles pass freely. Leave gaps for clear lanes.${wire.cutTicks > 0 ? ` Enemy cutting progress: ${Math.round(wire.cutTicks / (CONFIG.barbedWire.cutSeconds * CONFIG.tickRate) * 100)}%. Pin or eliminate the cutter to pause it.` : ''}`,
      }, worldX, worldY);
      return;
    }
    for (const pit of state.mortarPits) {
      if (Math.hypot(worldX - pit.pos.x, worldY - pit.pos.y) <= CONFIG.mortarPit.occupyRadius + 3) {
        this.hud.showTerrainTooltip({
          title: 'Mortar pit',
          detail: `Mortarmen within ${CONFIG.mortarPit.occupyRadius}px are 78% less likely to be hit by bullets, take ${Math.round((1 - CONFIG.mortarPit.artilleryDamageMult) * 100)}% less artillery damage, and reload ${Math.round((1 - CONFIG.mortarPit.reloadTimeMult) * 100)}% faster.`,
        }, worldX, worldY);
        return;
      }
    }
    for (const site of state.constructionSites) {
      const nearSite = site.kind === 'barbedWire'
        ? wireContains({ ...site, cutTicks: 0 }, { x: worldX, y: worldY }, 4)
        : site.kind === 'trench'
        ? Math.abs(worldY - site.pos.y) <= 23 && Math.abs(worldX - site.pos.x) <= CONFIG.trench.halfLength + 8
        : site.kind === 'mine'
          ? Math.hypot(worldX - site.pos.x, worldY - site.pos.y) <= 22
          : Math.hypot(worldX - site.pos.x, worldY - site.pos.y) <= 22;
      if (nearSite) {
        const progress = Math.round((1 - site.ticksRemaining / site.totalTicks) * 100);
        const label = site.kind === 'barbedWire' ? 'Barbed wire under construction' : site.kind === 'trench' ? 'Trench under construction' : site.kind === 'mine' ? 'Mine being laid' : site.kind === 'bunker' ? 'Bunker under construction' : site.kind === 'mortarPit' ? 'Mortar pit under construction' : site.kind === 'bridge' ? 'Bridge under construction' : 'Sandbags under construction';
        this.hud.showTerrainTooltip({ title: label, detail: `${progress}% complete. The Combat Support Engineer must stay nearby.` }, worldX, worldY);
        return;
      }
    }
    for (const trench of state.trenches) {
      if (Math.abs(worldY - trench.pos.y) <= 23 && Math.abs(worldX - trench.pos.x) <= CONFIG.trench.halfLength + 8) {
        this.hud.showTerrainTooltip({ title: 'Trench', detail: 'Strong cover for infantry inside. Occupants take 55% less damage and 50% less suppression from artillery. A machine gunner here suppresses harder over a wider area with the M1918A2 BAR.' }, worldX, worldY);
        return;
      }
    }
    for (const laid of state.mines) {
      if (Math.hypot(worldX - laid.pos.x, worldY - laid.pos.y) <= 14) {
        this.hud.showTerrainTooltip({ title: 'Mine', detail: 'Armed and waiting. The first Axis soldier to step on it sets it off; it does not block movement or sight.' }, worldX, worldY);
        return;
      }
    }
    for (const sandbag of state.sandbags) {
      if (Math.hypot(worldX - sandbag.pos.x, worldY - sandbag.pos.y) <= 20) {
        this.hud.showTerrainTooltip({ title: 'Sandbags', detail: 'Cover soldiers behind the bags from fire arriving from the north.' }, worldX, worldY);
        return;
      }
    }
    // Buildings are the one piece of terrain that can be destroyed, so they are
    // described with what they are doing right now.
    for (const building of state.buildings) {
      const w = building.cols * CONFIG.terrain.cell;
      const h = building.rows * CONFIG.terrain.cell;
      if (worldX < building.pos.x || worldX > building.pos.x + w || worldY < building.pos.y || worldY > building.pos.y + h) continue;
      const kindLabel = BUILDING_KIND_LABELS[building.kind];
      if (building.destroyed) {
        this.hud.showTerrainTooltip({
          title: `${building.name} (ruin)`,
          detail: `${kindLabel}, destroyed. ${landmarkHint(building)}`,
        }, worldX, worldY);
      } else {
        const pct = Math.round((building.health / building.maxHealth) * 100);
        this.hud.showTerrainTooltip({
          title: `${building.name}`,
          detail: `${kindLabel}, ${pct}% intact. ${buildingArchitecture(building).floors} floors, ${buildingArchitecture(building).roofStyle} roof${buildingArchitecture(building).rooftopAccess ? " with rooftop access" : ""}${buildingArchitecture(building).balcony ? ", balcony" : ""}. Right-click with infantry selected to enter; choose a firing position in the Squad panel. Explosives can collapse it. ${landmarkHint(building)}`,
        }, worldX, worldY);
      }
      return;
    }

    const { terrain, kinds } = terrainData;
    const bridge = terrain.bridges?.find((candidate) => bridgeContains(candidate, { x: worldX, y: worldY }));
    if (bridge) {
      this.hud.showTerrainTooltip({ title: `${bridge.type === 'pontoon' ? 'Low pontoon' : 'Raised'} bridge`, detail: bridge.type === 'pontoon'
        ? 'Cross on the deck from its road ends. There is no headroom underneath.'
        : 'Approach from the road ends to cross the deck. Infantry approaching from either side can pass beneath the central span. Water underneath still slows soldiers; vehicles use the deck.' }, worldX, worldY);
      return;
    }
    const col = Math.floor(worldX / terrain.cell);
    const row = Math.floor(worldY / terrain.cell);
    const idx = row * terrain.cols + col;
    const groundKind = kinds[idx] ?? TERRAIN_KIND.open;
    let info: { title: string; detail: string };
    if (isFoliageKind(groundKind)) {
      if (groundKind === TERRAIN_KIND.trees) info = { title: 'Hedgerow', detail: 'Passable dense growth. It slows soldiers, obscures shots across the row, and conceals anyone beneath it.' };
      else if (groundKind === TERRAIN_KIND.oak) info = { title: 'Oak grove', detail: 'Passable mature European oak cover. It slows soldiers, obscures shots, and conceals anyone beneath the canopy.' };
      else if (groundKind === TERRAIN_KIND.beech) info = { title: 'Beech stand', detail: 'Passable European beech cover. It slows soldiers, obscures shots, and conceals anyone beneath the canopy.' };
      else if (groundKind === TERRAIN_KIND.birch) info = { title: 'Silver birch stand', detail: 'Passable silver birch cover. It slows soldiers, obscures shots, and conceals anyone beneath the canopy.' };
      else if (groundKind === TERRAIN_KIND.pine) info = { title: terrainData.campaignCountry === 'italy' ? 'Mediterranean pine grove' : 'Pine grove', detail: 'Passable evergreen pine cover. It slows soldiers, obscures shots, and conceals anyone beneath the canopy.' };
      else if (groundKind === TERRAIN_KIND.shrub) info = { title: 'Brush and shrubs', detail: 'Low tangled growth slows movement and gives soldiers a little concealment.' };
      else if (groundKind === TERRAIN_KIND.tallGrass) info = { title: 'Tall grass', detail: 'Rough grass slows movement and partly conceals soldiers moving through it.' };
      else info = { title: terrainData.campaignCountry === 'italy' && terrainData.layout?.label.includes('Oliveti') ? 'Olive tree' : 'Orchard tree', detail: 'Passable planted tree cover. It slows soldiers, obscures shots, and conceals anyone beneath the canopy.' };
    } else if (groundKind === TERRAIN_KIND.wildflower) {
      info = { title: 'Wildflowers', detail: 'A small patch of field flowers. It is decorative and does not affect movement.' };
    } else if (terrain.blocked[idx] === 1) {
      const kind = groundKind;
      if (kind === 1) info = { title: 'Hedgerow', detail: 'Dense growth blocks movement and line of sight. Find a gap to cross.' };
      else if (kind === 2) info = { title: 'Stone wall / rocks', detail: 'Solid obstruction blocks movement and line of sight.' };
      else if (kind === TERRAIN_KIND.stoneFence) info = { title: 'Fieldstone fence', detail: 'A low farm wall. It blocks movement; follow it to find a gap.' };
      else if (kind === TERRAIN_KIND.woodFence) info = { title: 'Wood rail fence', detail: 'A timber field boundary. It blocks movement; follow it to a gate or a break.' };
      else if (kind === TERRAIN_KIND.obstacle) info = { title: 'Anti-tank obstacle', detail: 'Blocks movement. Tanks and infantry must route around it.' };
      else if (kind === TERRAIN_KIND.ruins) info = { title: 'Rubble / ruined position', detail: 'Wreckage blocks this tile and the view through it.' };
      else info = { title: 'Terrain obstruction', detail: 'This terrain blocks movement and line of sight.' };
    } else if (isBridgeAt(terrainData.zones, terrainData.seed, worldX, worldY) || this.sim?.state.builtBridges.some((bridge) => bridge.axis === 'vertical'
      ? Math.abs(worldX - bridge.pos.x) <= bridge.halfWidth && Math.abs(worldY - bridge.pos.y) <= bridge.halfLength
      : Math.abs(worldY - bridge.pos.y) <= bridge.halfWidth && Math.abs(worldX - bridge.pos.x) <= bridge.halfLength)) {
      info = { title: 'Wooden bridge', detail: 'A firm crossing over the river. Soldiers move and fight here as on ordinary ground.' };
    } else if (isRapidsAt(terrainData.zones, terrainData.seed, worldX, worldY)) {
      info = {
        title: 'River rapids',
        detail: `Dangerous fast water: ${describeGroundPenalty(CONFIG.terrain.effects.rapids)}. Rain further slows crossings, especially vehicles. Use a bridge or cross at a calmer reach.`,
      };
    } else if (isRiverAt(terrainData.zones, terrainData.seed, worldX, worldY)) {
      info = {
        title: 'River',
        detail: `Wadeable and passable, but the current slows movement and makes firing harder: ${describeGroundPenalty(CONFIG.terrain.effects.river)}.`,
      };
    } else if (isMudAt(terrainData.zones, worldX, worldY) && !isRoadAt(terrainData.zones, worldX, worldY)) {
      info = {
        title: 'Mud',
        detail: `Churned ground that bogs a unit down (rain adds up to 35% vehicle and 15% infantry slowdown): ${describeGroundPenalty(CONFIG.terrain.effects.mud)}.`,
      };
    } else if (groundKind === TERRAIN_KIND.road) {
      info = { title: 'Road', detail: 'Connected firm ground for moving through the sector. Buildings and vegetation leave the route clear; bridges carry it across the river.' };
    } else if (groundKind === TERRAIN_KIND.farmyard) {
      info = { title: 'Farmyard', detail: 'Open working ground beside a barn. Passable, with no cover.' };
    } else if (groundKind === TERRAIN_KIND.crops || groundKind === TERRAIN_KIND.orchard) {
      const field = terrainData.layout?.fields.find((field) => col >= field.col && col < field.col + field.cols && row >= field.row && row < field.row + field.rows);
      const names = { wheat: 'Wheat field', ploughed: 'Ploughed field', pasture: 'Pasture', orchard: 'Orchard' };
      info = { title: field ? names[field.crop] : 'Farmland', detail: groundKind === TERRAIN_KIND.orchard ? 'Planted tree rows are passable. Foliage slows and conceals soldiers, and makes shots across the row less accurate.' : 'Cultivated ground is passable. Tree cover slows and conceals soldiers, and makes shots across foliage less accurate.' };
    } else {
      const y = row * terrain.cell + terrain.cell / 2;
      if ((terrainData.settingId === 1 || terrainData.settingId === 4) && (idx * 31 + row * 11) % 211 === 17 && Math.abs(y - CONFIG.lineY) > 30) {
        info = { title: 'Haystack', detail: 'Farm scenery only. This ground remains passable.' };
      } else if ((idx * 17 + row * 13) % 67 === 7 && Math.abs(y - CONFIG.lineY) > 46) {
        info = { title: 'Supply crate', detail: 'Scenery only; this ground remains passable and the crate cannot be collected.' };
      } else if ((idx * 23 + row * 7) % 31 === 5 && Math.abs(y - CONFIG.lineY) > 30) {
        info = { title: 'Field grass', detail: 'Open ground with no cover.' };
      } else {
        info = { title: 'Open field', detail: 'Passable terrain with no cover.' };
      }
    }
    if (terrain.elevation) {
      const height = elevationAt(terrain, worldX, worldY), slope = slopeAt(terrain, worldX, worldY);
      info.title += ` · level ${Math.round(height / ELEVATION.levelHeight)}`;
      info.detail += slope > ELEVATION.walkGrade
        ? ' Steep slope: infantry automatically crawl; vehicles need a gentler route.'
        : slope > ELEVATION.vehicleGrade ? ' Sloping ground: infantry can walk here; vehicles need a gentler route.'
          : height > 4 ? ' Raised ground. Climbing costs movement speed; hill crests can block sight.' : '';
    }
    this.hud.showTerrainTooltip(info, worldX, worldY);
  }

  pointerLeave(): void {
    this.hud.showTerrainTooltip(null);
  }

  private unitAt(state: SimState, pos: { x: number; y: number }): Unit | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const unit of state.units) {
      if (unit.team !== 'friendly' || unit.health <= 0) continue;
      const d = Math.hypot(unit.pos.x - pos.x, unit.pos.y - pos.y);
      const radius = this.sim?.radiusOf(unit) ?? 9;
      if (d <= radius + 6 && d < bestD) {
        best = unit;
        bestD = d;
      }
    }
    return best;
  }

  private currentPreview(): PreviewInfo | null {
    const sim = this.sim;
    if (sim === null || sim.paused || this.mode.kind === 'none') return null;
    const pos = this.pointerPos;
    if (this.mode.kind === 'suppress') {
      const check = sim.validateSuppression(this.mode.unitId, pos);
      return { kind: 'suppress', pos, valid: check.ok, reason: check.reason };
    }
    if (this.mode.kind === 'ambush') {
      const units = this.mode.unitIds.map((id) => sim.state.units.find((unit) => unit.id === id)).filter((unit): unit is Unit => unit !== undefined && unit.health > 0 && !unit.dead && !unit.crossed);
      const arc = this.mode.arcDegrees;
      return { kind: 'ambush', pos, valid: units.length === this.mode.unitIds.length && units.every((unit) => !unit.pinned && !unit.buildingOrder
        && (unit.upgradeTimer ?? 0) === 0 && Math.hypot(pos.x - unit.pos.x, pos.y - unit.pos.y) >= 8
        && !sim.state.constructionSites.some((site) => site.builderId === unit.id)) && pos.x >= 0 && pos.y >= 0 && pos.x <= CONFIG.field.width && pos.y <= CONFIG.field.height,
        ambushArcs: units.map((unit) => ({ origin: { ...unit.pos }, ...ambushShape(unit.pos, pos, sim.weaponOf(unit)!.range, arc) })) };
    }
    if (this.mode.kind === 'patrol') {
      const area = this.mode.origin ? patrolArea(this.mode.origin, pos) : undefined;
      return { kind: 'patrol', pos, patrolArea: area, valid: area ? validPatrolArea(area) : true };
    }
    if (this.mode.kind === 'recruit') {
      const check = sim.validatePlacement('recruit', pos, this.mode.role);
      return { kind: 'recruit', role: this.mode.role, pos, valid: check.ok, reason: check.reason };
    }
    if (this.mode.kind === 'barbedWire') {
      const check = sim.validatePlacement('barbedWire', pos);
      const engineer = sim.nearestAvailableEngineer(pos);
      return { kind: 'barbedWire', pos, valid: check.ok, reason: check.reason, engineerPos: engineer?.pos, engineerRange: CONFIG.construction.engineerRange };
    }
    if (this.mode.kind === 'sandbag') {
      const check = sim.validatePlacement('sandbag', pos);
      const engineer = sim.nearestAvailableEngineer(pos);
      return { kind: 'sandbag', pos, valid: check.ok, reason: check.reason, engineerPos: engineer?.pos, engineerRange: CONFIG.construction.engineerRange };
    }
    if (this.mode.kind === 'trench') {
      const check = sim.validatePlacement('trench', pos);
      const engineer = sim.nearestAvailableEngineer(pos);
      return { kind: 'trench', pos, valid: check.ok, reason: check.reason, engineerPos: engineer?.pos, engineerRange: CONFIG.construction.engineerRange };
    }
    if (this.mode.kind === 'bunker') {
      const check = sim.validatePlacement('bunker', pos);
      const engineer = sim.nearestAvailableEngineer(pos);
      return { kind: 'bunker', pos, valid: check.ok, reason: check.reason, engineerPos: engineer?.pos, engineerRange: CONFIG.construction.engineerRange };
    }
    if (this.mode.kind === 'bridge') {
      const check = sim.validatePlacement('bridge', pos);
      const engineer = sim.nearestAvailableEngineer(pos);
      const shape = sim.bridgeShapeAt(pos);
      return { kind: 'bridge', pos, valid: check.ok, reason: check.reason, engineerPos: engineer?.pos, engineerRange: CONFIG.construction.engineerRange, bridgeAxis: shape?.axis, bridgeHalfWidth: shape?.halfWidth, bridgeHalfLength: shape?.halfLength };
    }
    if (this.mode.kind === 'mortarPit') {
      const check = sim.validatePlacement('mortarPit', pos);
      const engineer = sim.nearestAvailableEngineer(pos);
      return { kind: 'mortarPit', pos, valid: check.ok, reason: check.reason, engineerPos: engineer?.pos, engineerRange: CONFIG.construction.engineerRange };
    }
    if (this.mode.kind === 'mine') {
      const check = sim.validatePlacement('mine', pos, undefined, this.mode.mineKind);
      const engineer = sim.nearestAvailableEngineer(pos);
      return { kind: 'mine', mineKind: this.mode.mineKind, pos, valid: check.ok, reason: check.reason, engineerPos: engineer?.pos, engineerRange: CONFIG.construction.engineerRange };
    }
    if (this.mode.kind === 'artillery') {
      const check = sim.validatePlacement('artillery', pos);
      return { kind: 'artillery', pos, valid: check.ok, reason: check.reason };
    }
    if (this.mode.kind === 'airSupport') {
      const halfRun = (CONFIG.airSupport.bombCount - 1) * CONFIG.airSupport.bombSpacing / 2;
      const target = {
        x: Math.min(CONFIG.field.width - CONFIG.spawnMargin - halfRun, Math.max(CONFIG.spawnMargin + halfRun, pos.x)),
        y: Math.min(CONFIG.field.height - 10, Math.max(CONFIG.spawnMargin * 3, pos.y)),
      };
      const check = sim.validatePlacement('airSupport', target);
      return { kind: 'airSupport', pos: target, valid: check.ok, reason: check.reason };
    }
    if (this.mode.kind === 'flare') {
      const target = {
        x: Math.min(CONFIG.field.width - 4, Math.max(4, pos.x)),
        y: Math.min(CONFIG.field.height - 4, Math.max(4, pos.y)),
      };
      const check = sim.validatePlacement('flare', target);
      return { kind: 'flare', pos: target, valid: check.ok, reason: check.reason };
    }
    if (this.mode.kind === 'satchel') {
      const selected = this.selectedUnits();
      const engineer = selected.length === 1 ? selected[0] : undefined;
      if (!engineer) return null;
      const reason = satchelError(sim.state, engineer, pos);
      return { kind: 'satchel', pos, valid: reason === null, reason: reason ?? undefined,
        engineerPos: engineer.pos, engineerRange: CONFIG.satchel.placementRange };
    }
    if (this.mode.kind === 'smoke') {
      const thrower = this.selectedUnits()[0];
      if (thrower === undefined) return null;
      const inBounds = pos.x >= 4 && pos.y >= 4 && pos.x <= CONFIG.field.width - 4 && pos.y <= CONFIG.field.height - 4;
      const valid = thrower.health > 0
        && !thrower.pinned
        && thrower.crossed !== true
        && (thrower.smokeGrenades ?? 0) > 0
        && Math.hypot(thrower.pos.x - pos.x, thrower.pos.y - pos.y) <= CONFIG.smoke.throwRange
        && inBounds;
      return { kind: 'smoke', pos, valid, reason: valid ? undefined : !inBounds ? 'Choose a target inside the battlefield.'
        : thrower.pinned ? 'Pinned soldiers cannot throw smoke.' : (thrower.smokeGrenades ?? 0) <= 0 ? 'No smoke grenades remaining.' : `Target must be within ${CONFIG.smoke.throwRange}px.`, throwerPos: thrower.pos, throwRange: CONFIG.smoke.throwRange };
    }
    return null;
  }

  // -------------------------------------------------------------- persistence

  saveRun(): void {
    if (this.sim === null || this.sim.state.phase !== 'running') return;
    if (saveSnapshot(this.storage, this.sim.snapshot())) {
      this.lastSaveTick = this.sim.state.ticks;
    }
    if (this.storage.consumeMemoryNotice()) {
      this.hud.notice('Storage unavailable - progress kept in memory for this session only.', 'warn');
    }
  }

  applyPrefs(prefs: Preferences): void {
    this.prefs = prefs;
    this.audio.setPrefs(prefs);
    this.renderer?.setPreferences?.(prefs);
    document.documentElement.style.fontSize = `${16 * prefs.uiScale}px`;
    document.documentElement.style.setProperty('--friendly', prefs.friendlyColor);
    document.documentElement.style.setProperty('--enemy', prefs.enemyColor);
    document.body.classList.toggle('large-captions', prefs.largeCaptions);
    document.body.classList.toggle('reduced-motion', prefs.reducedMotion);
    const keyLabel = (code: string) => code.replace('Key', '').replace('Digit', '').replace('Equal', '+').replace('Minus', '−');
    document.getElementById('btn-toggle-commands')?.setAttribute('title', `Toggle command panel (${keyLabel(prefs.keys.panel)})`);
    document.getElementById('btn-pause')?.setAttribute('title', `Pause / resume (${keyLabel(prefs.keys.pause)})`);
    savePrefs(this.storage, prefs);
  }

  resetCamera(): void { this.renderer?.resetCamera?.(); }

  openSettings(): void {
    if (this.sim !== null && !this.sim.paused && this.sim.state.phase === 'running') this.pauseRun(false);
    this.menus.showSettings();
  }

  unlockAudio(): void {
    this.audio.unlock();
  }
}

function secSafe(seconds: number): number {
  return Math.max(1, Math.round(seconds * CONFIG.tickRate));
}

/** Role metadata for the recruitment UI. */
export function roleCatalog(): Array<{ role: FriendlyRole; label: string; cost: number; blurb: string }> {
  const content = getContent();
  const roles: FriendlyRole[] = ['rifleman', 'mg', 'medic', 'supply_officer', 'at', 'sniper', 'engineer', 'radio_engineer', 'officer', 'mortarman', 'gun_truck', 'scout', 'heavy_mg', 'assault_infantry', 'at_gun'];
  return roles.map((role) => ({
    role,
    label: content.friendly[role].label,
    cost: CONFIG.costs.recruit[role],
    blurb: `${content.friendly[role].blurb} HP ${content.friendly[role].health}.`,
  }));
}

export { unitDef };
