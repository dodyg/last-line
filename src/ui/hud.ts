import { ROLE_ABILITIES } from '../simulation/role-abilities';
import { supportsAmbush } from '../simulation/ambush';
import { CONFIG } from '../content/config';
import type { PreviewInfo } from '../game/render-contract';

import { campfireError } from '../simulation/campfires';

import { satchelError } from '../simulation/satchels';

import { isPatrolRole } from '../simulation/patrol';

import { dayNightAtTick } from '../simulation/daynight';

import { getContent } from '../content/validate';

import { usesBackupRifle } from '../simulation/loadout';

import { fireOrdersForRole, type FireOrder, type FriendlyRole, type SimState, type SoldierStance, type Specialization, type Unit, type WeaponUpgradeType } from '../simulation/types';

import type { UIMode } from '../game/controller';

import { soldierName, soldierRank } from '../simulation/soldiers';

import { contactBearing, latestNightContact } from '../simulation/perception';

import { fightingPositionLabel, fightingPositionOptions, fightingPositionValue, positionFacing } from '../simulation/buildings';

import type { BuildingFacing, BuildingLevel } from '../simulation/types';



/**

 * A soldier's name comes from the run's stable seed, not from the current map's

 * terrain seed: identity has to survive a march north, when the battlefield -

 * and with it the map seed - is regenerated.

 */

function nameOf(state: SimState, unitId: number): string {

  return soldierName(state.baseTerrainSeed, unitId);

}



/** Soldiers already over the north edge, waiting for the next map. */

function crossedCountOf(state: SimState): number {

  return state.crossedUnits.filter((unit) => !unit.dead && unit.health > 0).length;

}



/** Soldiers still available on this map: alive, and not walking off the edge. */

function onMapCountOf(state: SimState): number {

  return state.units.filter((unit) => unit.team === 'friendly' && !unit.dead && unit.health > 0 && unit.crossed !== true).length;

}



/**

 * DOM HUD: top status bar, recruitment/support panel, selection details, and

 * the notice feed. Lives above the canvas; its buttons never forward pointer

 * events into the battlefield.

 */



export interface HudCallbacks {

  onCallSupplies(unitId: number): void;

  onCallMedic(unitId: number): void;

  onBuildingLevel(level: BuildingLevel, facing?: BuildingFacing): void;

  onLeaveBuilding(): void;

  onSoldierSelect(unitId: number, additive: boolean): void;

  onRecruitSelect(role: FriendlyRole): void;

  onBarbedWire(): void;

  onSandbag(): void;

  onTrench(): void;

  onBunker(): void;

  onMortarPit(): void;

  onBridge(): void;

  onMine(kind: 'ap' | 'at'): void;

  onArtillery(): void;

  onAirSupport(): void;

  onFlare(): void;

  onFoodSupplies(): void;

  onSmoke(): void;

  onSatchel(): void;

  onLightFire(): void;

  onAmbush(arcDegrees: number): void;
  onAmbushArcChange(arcDegrees: number): void;
  onFireOrder(): void;
  onRoleAbility(): void;

  onStance(): void;

  onCrawl(): void;

  onRun(): void;

  onPatrol(): void;

  onHeadlights(): void;

  onSpecialization(specialization: Specialization): void;

  onWeaponUpgrade(type: WeaponUpgradeType): void;

  onCancelMode(): void;

  onPauseToggle(): void;

  onHelp(): void;

  onSettings(): void;

  onMenu(): void;

}



interface Elements {

  buildingControls: HTMLElement;

  buildingStatus: HTMLElement;

  buildingLevel: HTMLSelectElement;

  btnLeaveBuilding: HTMLButtonElement;

  top: HTMLElement;

  side: HTMLElement;

  squadTab: HTMLButtonElement;

  armyTab: HTMLButtonElement;

  supportTab: HTMLButtonElement;

  squadPanel: HTMLElement;

  armyPanel: HTMLElement;

  supportPanel: HTMLElement;

  points: HTMLElement;

  map: HTMLElement;

  wave: HTMLElement;

  phase: HTMLElement;

  integrity: HTMLElement;

  score: HTMLElement;

  setting: HTMLElement;

  pausedBadge: HTMLElement;

  btnPause: HTMLButtonElement;

  btnHelp: HTMLButtonElement;

  btnSettings: HTMLButtonElement;

  btnMenu: HTMLButtonElement;

  recruitButtons: HTMLElement;

  roster: HTMLElement;

  rosterCount: HTMLElement;

  btnBarbedWire: HTMLButtonElement;

  btnSandbag: HTMLButtonElement;

  btnTrench: HTMLButtonElement;

  btnBunker: HTMLButtonElement;

  btnMortarPit: HTMLButtonElement;

  btnBridge: HTMLButtonElement;

  btnMineAp: HTMLButtonElement;

  btnMineAt: HTMLButtonElement;

  btnArtillery: HTMLButtonElement;

  artilleryCd: HTMLElement;

  btnAirSupport: HTMLButtonElement;

  airSupportCd: HTMLElement;

  btnFlare: HTMLButtonElement;

  flareCd: HTMLElement;

  btnFoodSupplies: HTMLButtonElement;

  btnSmoke: HTMLButtonElement;

  btnSatchel: HTMLButtonElement;

  btnLightFire: HTMLButtonElement;

  foodSupplyCd: HTMLElement;

  btnAccuracyUpgrade: HTMLButtonElement;

  btnReloadUpgrade: HTMLButtonElement;

  btnDamageUpgrade: HTMLButtonElement;

  game: HTMLElement;

  terrainTooltip: HTMLElement;

  constructionStatus: HTMLElement;

  btnCancelMode: HTMLButtonElement;

  modeHint: HTMLElement;

  satchelStatus: HTMLElement;

  selEmpty: HTMLElement;

  selMulti: HTMLElement;

  selMultiCount: HTMLElement;

  selMultiList: HTMLElement;

  selDetails: HTMLElement;

  selRole: HTMLElement;

  selName: HTMLElement;

  selRank: HTMLElement;

  selHp: HTMLElement;

  selHpText: HTMLElement;

  selSupp: HTMLElement;

  selSuppText: HTMLElement;

  selMorale: HTMLElement;

  selMoraleText: HTMLElement;

  selXp: HTMLElement;

  selGrenades: HTMLElement;

  selRockets: HTMLElement;

  selMortarBombs: HTMLElement;

  selAction: HTMLElement;

  selContact: HTMLElement;

  btnAmbush: HTMLButtonElement;
  ambushArc: HTMLSelectElement;
  btnFireOrder: HTMLButtonElement;

  btnStance: HTMLButtonElement;

  btnCrawl: HTMLButtonElement;

  btnRun: HTMLButtonElement;

  btnPatrol: HTMLButtonElement;

  staminaRow: HTMLElement;

  selStamina: HTMLElement;

  selStaminaText: HTMLElement;

  btnHeadlights: HTMLButtonElement;

  specializationControls: HTMLElement;

  specializationSelect: HTMLSelectElement;

  btnSpecialization: HTMLButtonElement;

  notices: HTMLElement;

  chatter: HTMLElement;

}



const MAX_NOTICES = 6;

const NOTICE_TTL_MS = 6000;

const FIRE_ORDER_LABELS: Record<FireOrder, string> = {

  auto: 'Auto', antiArmor: 'Prioritize armor', stopBreakthrough: 'Stop breakthroughs', holdGrenades: 'Hold grenades', seekGunfire: 'Run to gunfire',

};

const COMMAND_ICONS = {

  fireOrder: {

    auto: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',

    antiArmor: '<path d="M3 10h18l-2 7H5l-2-7Zm3 0 2-4h8l2 4M7 17v2m10-2v2"/><circle cx="8" cy="13" r="1"/><circle cx="16" cy="13" r="1"/>',

    stopBreakthrough: '<path d="M12 2 20 5v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3Z"/><path d="M8 12h8"/>',

    holdGrenades: '<path d="M9 5h6m-5 0V3h4v2m-6 2h8l1 2v9a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3V9l1-2Z"/><path d="m9 11 6 6m0-6-6 6"/>',

    seekGunfire: '<circle cx="9" cy="4" r="2"/><path d="m10 7 4 3-4 4-4 1-3 5m7-6 4 6M5 8l4-1m8-2q5 4 0 8m3-10q7 6 0 12"/>',

  },

  stance: {

    standing: '<circle cx="12" cy="4" r="2"/><path d="M12 6.5v6m0-3 4 2m-4-2-3 3m3 0-3 7m3-7 4 7"/>',

    crouching: '<circle cx="9" cy="7" r="2"/><path d="m10 9 4 2 3 4m-7-6-3 4 3 3m4-3-4 1-2 5m7-4 4 4"/>',

    prone: '<circle cx="5" cy="14" r="2"/><path d="m7 14 6-2 4 2 3 4m-7-6 1-4m-6 6-3 4m10-4-1 5"/>',

    mixed: '<circle cx="6" cy="7" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 10v6m0-3-3 4m3-4 3 4m9-7v7m0-4-4 3m4-3 3 3"/>',

  },

  crawl: {

    on: '<circle cx="18" cy="7" r="2"/><path d="m15.5 9-5 2-3 4m3-4 3 4 5 1m-11-1-4 4m10-3-1 4"/>',

    off: '<circle cx="18" cy="7" r="2"/><path d="m15.5 9-5 2-3 4m3-4 3 4 5 1m-11-1-4 4m10-3-1 4M3 3l18 18"/>',

    mixed: '<circle cx="18" cy="7" r="2"/><path d="m15.5 9-5 2-3 4m3-4 3 4 5 1m-11-1-4 4m10-3-1 4M3 3l8 8"/>',

  },

  pace: {

    walk: '<circle cx="13" cy="4" r="2"/><path d="m7 12 3-4 3-1 3 4 4 1m-7-5-2 7-3 7m3-7 4 3 1 4"/>',

    run: '<circle cx="15" cy="4" r="2"/><path d="m5 12 4-5 4 2 3 4 4 1m-7-5-4 6-5 1m5-1 5 2 1 4M3 5h4M2 9h3"/>',

  },

} as const;



function setCommandIcon(button: HTMLButtonElement, state: string, paths: string): void {

  if (button.dataset.iconState === state) return;

  button.dataset.iconState = state;

  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

}

const SPECIALIZATION_CHOICES: Record<FriendlyRole, Array<{ value: Specialization; label: string }>> = {
  scout: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'forcedMarch', label: 'Forced march (+20% speed)' }, { value: 'camouflage', label: 'Camouflage' }],
  heavy_mg: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'suppressor', label: 'Suppressor (+50% suppression)' }, { value: 'fastReload', label: 'Fast reload (-15%)' }],
  assault_infantry: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'fastReload', label: 'Fast reload (-15%)' }, { value: 'forcedMarch', label: 'Forced march (+20% speed)' }, { value: 'camouflage', label: 'Camouflage' }],
  at_gun: [{ value: 'tankHunter', label: 'Tank hunter (+25% armor damage)' }, { value: 'fastReload', label: 'Fast reload (-15%)' }, { value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }],

  rifleman: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'fastReload', label: 'Fast reload (−15%)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  mg: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'suppressor', label: 'Suppressor (+50% suppression)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  mortarman: [{ value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  at: [{ value: 'tankHunter', label: 'Tank hunter (+25% vehicle damage)' }, { value: 'fastReload', label: 'Fast reload (−15%)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  sniper: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'fastReload', label: 'Fast reload (−15%)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  medic: [{ value: 'fieldMedic', label: 'Field medic (+50% healing range)' }, { value: 'surgeon', label: 'Surgeon (+50% healing)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  supply_officer: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'fastReload', label: 'Fast reload (−15%)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  engineer: [{ value: 'rapidBuilder', label: 'Rapid builder (+50% build speed)' }, { value: 'heavyCharges', label: 'Heavy charges (+25% mine damage)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  radio_engineer: [{ value: 'forwardObserver', label: 'Forward observer (−30% artillery call-in time)' }, { value: 'signalOfficer', label: 'Signal officer (−20% artillery cooldown)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  officer: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'fastReload', label: 'Fast reload (−15%)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }, { value: 'camouflage', label: 'Camouflage (−25% enemy detection range)' }],

  gun_truck: [{ value: 'steadyAim', label: 'Steady aim (+12% accuracy)' }, { value: 'fastReload', label: 'Fast reload (−15%)' }, { value: 'suppressor', label: 'Suppressor (+50% suppression)' }, { value: 'forcedMarch', label: 'Forced march (+20% movement speed)' }],

};

const SPECIALIZATION_LABELS: Record<Specialization, string> = {

  steadyAim: 'Steady aim (+12% accuracy)',

  fastReload: 'Fast reload (−15% reload time)',

  tankHunter: 'Tank hunter (+25% vehicle damage)',

  fieldMedic: 'Field medic (+50% healing range)',

  surgeon: 'Surgeon (+50% healing)',

  rapidBuilder: 'Rapid builder (+50% build speed)',

  heavyCharges: 'Heavy charges (+25% mine damage)',

  spotter: 'Spotter (+12% accuracy · legacy)',

  forwardObserver: 'Forward observer (−30% artillery call-in time)',

  signalOfficer: 'Signal officer (−20% artillery cooldown)',

  suppressor: 'Suppressor (+50% suppression)',

  forcedMarch: 'Forced march (+20% movement speed)',

  camouflage: 'Camouflage (−25% enemy detection range)',

};



export class Hud {

  private terrainProject: ((x: number, y: number) => { x: number; y: number } | null) | null = null;

  private foodSuppliesPending = false;

  private flareRequestPending = false;

  private artilleryRequestPending = false;

  private airSupportRequestPending = false;

  private el: Elements;

  private cb: HudCallbacks;

  private noticeTimer: number | undefined;

  private chatterTimer: number | undefined;

  private rosterRows = new Map<number, HTMLButtonElement>();

  private rosterState: SimState | null = null;

  private contextUnitId: number | null = null;

  private contextMenu = document.createElement('div');

  private contextName = document.createElement('div');

  private contextNote = document.createElement('div');

  private callMedicButton = document.createElement('button');

  private callSupplyButton = document.createElement('button');

  private supplyNote = document.createElement('div');

  private contextAnchor: HTMLElement | null = null;

  /** Last rendered group summary, so the list is only rebuilt when it changes. */

  private multiSelectionKey = '';

  private selectionKey = '';

  private specializationRole = '';
  private readonly roleAbilityButton: HTMLButtonElement;



  constructor(cb: HudCallbacks) {

    this.cb = cb;

    this.el = {

      top: required('hud-top'),

      side: required('hud-side'),

      squadTab: required('tab-squad') as HTMLButtonElement,

      armyTab: required('tab-army') as HTMLButtonElement,

      supportTab: required('tab-support') as HTMLButtonElement,

      squadPanel: required('panel-squad'),

      armyPanel: required('panel-army'),

      supportPanel: required('panel-support'),

      points: required('hud-points'),

      map: required('hud-map'),

      wave: required('hud-wave'),

      phase: required('hud-phase'),

      integrity: required('hud-integrity'),

      score: required('hud-score'),

      setting: required('hud-setting'),

      pausedBadge: required('hud-paused-badge'),

      btnPause: required('btn-pause'),

      btnHelp: required('btn-help'),

      btnSettings: required('btn-settings'),

      btnMenu: required('btn-menu'),

      recruitButtons: required('recruit-buttons'),

      roster: required('squad-roster'),

      rosterCount: required('squad-count'),

      btnBarbedWire: required('btn-barbed-wire'),

      btnSandbag: required('btn-sandbag'),

      btnTrench: required('btn-trench'),

      btnBunker: required('btn-bunker'),

      btnMortarPit: required('btn-mortar-pit'),

      btnBridge: required('btn-bridge'),

      btnMineAp: required('btn-mine-ap'),

      btnMineAt: required('btn-mine-at'),

      btnArtillery: required('btn-artillery'),

      artilleryCd: required('artillery-cd'),

      btnAirSupport: required('btn-air-support'),

      airSupportCd: required('air-support-cd'),

      btnFlare: required('btn-flare'),

      flareCd: required('flare-cd'),

      btnFoodSupplies: required('btn-food-supplies'),

      btnSmoke: required('btn-smoke'),

      btnSatchel: required('btn-satchel'),

      btnLightFire: required('btn-light-fire'),

      foodSupplyCd: required('food-supply-cd'),

      btnAccuracyUpgrade: required('btn-upgrade-accuracy'),

      btnReloadUpgrade: required('btn-upgrade-reload'),

      btnDamageUpgrade: required('btn-upgrade-damage'),

      game: required('game'),

      terrainTooltip: required('terrain-tooltip'),

      constructionStatus: required('construction-status'),

      btnCancelMode: required('btn-cancel-mode'),

      modeHint: required('mode-hint'),

      satchelStatus: required('satchel-status'),

      selEmpty: required('sel-empty'),

      selMulti: required('sel-multi'),

      selMultiCount: required('sel-multi-count'),

      selMultiList: required('sel-multi-list'),

      selDetails: required('sel-details'),

      selRole: required('sel-role'),

      selName: required('sel-name'),

      selRank: required('sel-rank'),

      selHp: required('sel-hp'),

      selHpText: required('sel-hp-text'),

      selSupp: required('sel-supp'),

      selSuppText: required('sel-supp-text'),

      selMorale: required('sel-morale'),

      selMoraleText: required('sel-morale-text'),

      selXp: required('sel-xp'),

      selGrenades: required('sel-grenades'),

      selRockets: required('sel-rockets'),

      selMortarBombs: required('sel-mortar-bombs'),

      selAction: required('sel-action'),

      selContact: required('sel-contact'),

      btnAmbush: required('btn-ambush'),
      ambushArc: required('ambush-arc'),
      btnFireOrder: required('btn-fire-order'),

      btnStance: required('btn-stance'),

      buildingControls: required('building-controls'),

      buildingStatus: required('building-status'),

      buildingLevel: required('building-level'),

      btnLeaveBuilding: required('btn-leave-building'),

      btnCrawl: required('btn-crawl'),

      btnRun: required('btn-run'),

      btnPatrol: required('btn-patrol'),

      staminaRow: required('stamina-row'),

      selStamina: required('sel-stamina'),

      selStaminaText: required('sel-stamina-text'),

      btnHeadlights: required('btn-headlights'),

      specializationControls: required('specialization-controls'),

      specializationSelect: required('sel-specialization') as HTMLSelectElement,

      btnSpecialization: required('btn-specialization'),

      notices: required('notices'),

      chatter: required('radio-chatter'),

    };



    this.buildRecruitButtons();

    this.buildSupportButtons();

    this.buildSoldierMenu();

    this.el.squadTab.addEventListener('click', () => this.selectTab('squad'));

    this.el.armyTab.addEventListener('click', () => this.selectTab('army'));

    this.el.supportTab.addEventListener('click', () => this.selectTab('support'));

    const tabs = [

      [this.el.squadTab, 'squad'],

      [this.el.armyTab, 'army'],

      [this.el.supportTab, 'support'],

    ] as const;

    for (const [tab, name] of tabs) {

      tab.addEventListener('keydown', (event: KeyboardEvent) => {

        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {

          event.preventDefault();

          const currentIndex = tabs.findIndex(([, tabName]) => tabName === name);

          const nextIndex = event.key === 'Home' ? 0

            : event.key === 'End' ? tabs.length - 1

              : (currentIndex + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;

          const next = tabs[nextIndex]![1];

          this.selectTab(next);

          tabs[nextIndex]![0].focus();

        }

      });

    }

    this.el.btnPause.addEventListener('click', () => this.cb.onPauseToggle());

    this.el.btnHelp.addEventListener('click', () => this.cb.onHelp());

    this.el.btnSettings.addEventListener('click', () => this.cb.onSettings());

    this.el.btnMenu.addEventListener('click', () => this.cb.onMenu());

    this.el.btnBarbedWire.addEventListener('click', () => this.cb.onBarbedWire());

    this.el.btnSandbag.addEventListener('click', () => this.cb.onSandbag());

    this.el.btnTrench.addEventListener('click', () => this.cb.onTrench());

    this.el.btnBunker.addEventListener('click', () => this.cb.onBunker());

    this.el.btnMortarPit.addEventListener('click', () => this.cb.onMortarPit());

    this.el.btnBridge.addEventListener('click', () => this.cb.onBridge());

    this.el.btnMineAp.addEventListener('click', () => this.cb.onMine('ap'));

    this.el.btnMineAt.addEventListener('click', () => this.cb.onMine('at'));

    this.el.btnArtillery.addEventListener('click', () => this.cb.onArtillery());

    this.el.btnAirSupport.addEventListener('click', () => this.cb.onAirSupport());

    this.el.btnFlare.addEventListener('click', () => this.cb.onFlare());

    this.el.btnFoodSupplies.addEventListener('click', () => this.cb.onFoodSupplies());

    this.el.btnSmoke.addEventListener('click', () => this.cb.onSmoke());

    this.el.btnSatchel.addEventListener('click', () => this.cb.onSatchel());

    this.el.btnLightFire.addEventListener('click', () => this.cb.onLightFire());

    this.roleAbilityButton = document.createElement('button');
    this.roleAbilityButton.id = 'btn-role-ability'; this.roleAbilityButton.type = 'button';
    this.roleAbilityButton.className = 'action-button'; this.roleAbilityButton.hidden = true;
    this.roleAbilityButton.addEventListener('click', () => this.cb.onRoleAbility());
    this.el.btnAmbush.parentElement!.append(this.roleAbilityButton);
    this.el.btnAmbush.addEventListener('click', () => this.cb.onAmbush(Number(this.el.ambushArc.value)));
    this.el.ambushArc.addEventListener('change', () => this.cb.onAmbushArcChange(Number(this.el.ambushArc.value)));
    this.el.btnFireOrder.addEventListener('click', () => this.cb.onFireOrder());

    this.el.btnStance.addEventListener('click', () => this.cb.onStance());

    this.el.buildingLevel.addEventListener('change', () => {

      const [level, facing] = this.el.buildingLevel.value.split(':');

      this.cb.onBuildingLevel(level === 'roof' || level === 'balcony' ? level : Number(level), facing as BuildingFacing | undefined);

    });

    this.el.btnLeaveBuilding.addEventListener('click', () => this.cb.onLeaveBuilding());

    this.el.btnCrawl.addEventListener('click', () => this.cb.onCrawl());

    this.el.btnRun.addEventListener('click', () => this.cb.onRun());

    this.el.btnPatrol.addEventListener('click', () => this.cb.onPatrol());

    this.el.btnHeadlights.addEventListener('click', () => this.cb.onHeadlights());

    this.el.btnSpecialization.addEventListener('click', () => this.cb.onSpecialization(this.el.specializationSelect.value as Specialization));

    this.el.btnAccuracyUpgrade.addEventListener('click', () => this.cb.onWeaponUpgrade('accuracy'));

    this.el.btnReloadUpgrade.addEventListener('click', () => this.cb.onWeaponUpgrade('reload'));

    this.el.btnDamageUpgrade.addEventListener('click', () => this.cb.onWeaponUpgrade('damage'));

    this.el.btnCancelMode.addEventListener('click', () => this.cb.onCancelMode());

  }



  private selectTab(tab: 'squad' | 'army' | 'support'): void {

    if (tab !== 'squad') this.closeSoldierMenu();

    const selectedTab = tab === 'squad' ? this.el.squadTab : tab === 'army' ? this.el.armyTab : this.el.supportTab;

    const selectedPanel = tab === 'squad' ? this.el.squadPanel : tab === 'army' ? this.el.armyPanel : this.el.supportPanel;

    for (const candidate of [this.el.squadTab, this.el.armyTab, this.el.supportTab]) {

      const selected = candidate === selectedTab;

      candidate.setAttribute('aria-selected', String(selected));

      candidate.tabIndex = selected ? 0 : -1;

    }

    for (const panel of [this.el.squadPanel, this.el.armyPanel, this.el.supportPanel]) {

      panel.hidden = panel !== selectedPanel;

    }

  }



  private buildRecruitButtons(): void {

    const content = getContent();

    const costs = CONFIG.costs.recruit;

    this.el.recruitButtons.replaceChildren();

    const roles: FriendlyRole[] = ['rifleman', 'mg', 'medic', 'supply_officer', 'at', 'sniper', 'engineer', 'radio_engineer', 'officer', 'mortarman', 'gun_truck', 'scout', 'heavy_mg', 'assault_infantry', 'at_gun'];

    for (const role of roles) {

      const def = content.friendly[role];

      const btn = document.createElement('button');

      btn.className = 'recruit-button';

      btn.dataset.role = role;

      btn.title = `${def.blurb} Cost ${costs[role]} pts. Click, then left-click a spot in the southern zone.`;

      const name = document.createElement('span');

      name.className = 'role-name';

      name.textContent = def.label;

      const cost = document.createElement('span');

      cost.className = 'role-cost';

      cost.textContent = `${costs[role]} pts`;

      btn.append(name, cost);

      btn.addEventListener('click', () => this.cb.onRecruitSelect(role));

      this.el.recruitButtons.append(btn);

    }

  }



  /**

   * The support buttons state their price and build time on their face, so both

   * are rendered from the config that actually charges for them. Markup that

   * spells out a cost by hand goes stale the first time the cost is tuned, and a

   * button advertising the wrong price is worse than no price at all.

   */

  private buildSupportButtons(): void {

    this.el.btnSmoke.textContent = 'Smoke grenade';

    this.el.btnSatchel.textContent = `Satchel charge · ${CONFIG.satchel.cost} pts · ${CONFIG.satchel.fuseSeconds}s fuse`;

    this.el.btnSmoke.title = `Select a rifleman or engineer and throw a smoke grenade within ${CONFIG.smoke.throwRange}px. Blocks rifle fire for ${CONFIG.smoke.durationSeconds} seconds; explosives still pass through.`;

    const range = CONFIG.construction.engineerRange;

    const engineer = `Requires an available engineer within ${range}px.`;

    const support: Array<{ btn: HTMLButtonElement; name: string; price?: number; title: string }> = [

      {

        btn: this.el.btnBarbedWire,

        name: 'Barbed wire',

        price: CONFIG.costs.barbedWire,

        title: `${engineer} Build time: ${CONFIG.construction.barbedWireSeconds}s. A ${CONFIG.barbedWire.halfLength * 2}px east–west segment slows all infantry to ${Math.round(CONFIG.barbedWire.speedMult * 100)}% speed. Vehicles pass freely. Leave gaps for lanes; enemy engineers cut breaches.`,

      },

      {

        btn: this.el.btnSandbag,

        name: 'Sandbag',

        price: CONFIG.costs.sandbag,

        title: `${engineer} Costs ${CONFIG.costs.sandbag} points and takes ${CONFIG.construction.sandbagSeconds} seconds to build.`,

      },

      {

        btn: this.el.btnTrench,

        name: 'Trench',

        price: CONFIG.costs.trench,

        title: `${engineer} Costs ${CONFIG.costs.trench} points and takes ${CONFIG.construction.trenchSeconds} seconds to build. Occupants take 55% less artillery damage and 50% less artillery suppression.`,

      },

      {

        btn: this.el.btnBunker,

        name: 'Bunker',

        price: CONFIG.costs.bunker,

        title: `${engineer} Costs ${CONFIG.costs.bunker} points and takes ${CONFIG.construction.bunkerSeconds} seconds to build. Protects nearby soldiers from direct fire from every direction; artillery still hits occupants.`,

      },

      {

        btn: this.el.btnBridge,

        name: 'Pontoon bridge',

        price: CONFIG.costs.bridge,

        title: `${engineer} Build time: ${CONFIG.construction.bridgeSeconds}s. Builds a simple floating pontoon crossing on a river. The low deck has no passage underneath.`,

      },

      {

        btn: this.el.btnMortarPit,

        name: 'Mortar pit',

        price: CONFIG.costs.mortarPit,

        title: `${engineer} Costs ${CONFIG.costs.mortarPit} points and takes ${CONFIG.construction.mortarPitSeconds} seconds to build. Mortarmen inside are much harder to hit, take less artillery damage, and reload 30% faster.`,

      },

      ...(['ap', 'at'] as const).map((kind) => {

        const def = CONFIG.mineKinds[kind];

        return {

          btn: kind === 'ap' ? this.el.btnMineAp : this.el.btnMineAt,

          name: def.label,

          price: def.cost,

          title: `${engineer} Costs ${def.cost} points and takes ${def.laySeconds} seconds to lay. Detonates under ${mineTargets(kind)}. Does not block movement or sight, and the blast harms friendly troops too.`,

        };

      }),

      {

        btn: this.el.btnArtillery,

        name: 'Artillery',

        price: CONFIG.costs.artillery,

        title: `Requires a living, unpinned Combat Radio Engineer. Costs ${CONFIG.costs.artillery} points, ${CONFIG.artillery.cooldownSeconds}s cooldown, and damages everyone in the blast including friendly troops.`,

      },

      {

        btn: this.el.btnAirSupport,

        name: 'Air Support',

        price: CONFIG.costs.airSupport,

        title: `Requires a living, unpinned Combat Radio Engineer. Costs ${CONFIG.costs.airSupport} points and has a ${CONFIG.airSupport.cooldownSeconds}s cooldown. Drops ${CONFIG.airSupport.bombCount} bombs across the target; marked blast zones damage friendlies too.`,

      },

      {

        btn: this.el.btnFlare,

        name: 'Flares',

        price: CONFIG.costs.flare,

        title: `Requires a living, unpinned Combat Radio Engineer. Costs ${CONFIG.costs.flare} points and has a ${CONFIG.flare.cooldownSeconds}s cooldown. Takes ${CONFIG.flare.deploymentDelaySeconds}s to reach its target, then illuminates a ${CONFIG.flare.radius}px area for ${CONFIG.flare.durationSeconds}s at night, helping your squad spot and hit enemies there.`,

      },

      {

        btn: this.el.btnFoodSupplies,

        name: `Radio for Rations (+${CONFIG.foodSupply.points})`,

        title: `Requires a living, unpinned Combat Radio Engineer. Radio for ${CONFIG.foodSupply.points} supply points once every ${CONFIG.foodSupply.cooldownSeconds} seconds.`,

      },

    ];

    for (const { btn, name, price, title } of support) {

      btn.textContent = price === undefined ? name : `${name} (${price})`;

      btn.title = title;

    }

  }



  show(): void {
    const log = document.getElementById('battle-log'); if (log) log.hidden = false;

    this.el.top.hidden = false;

    this.el.side.hidden = false;

  }



  hide(): void {
    for (const id of ['battle-log', 'combat-alert', 'placement-feedback']) { const element = document.getElementById(id); if (element) element.hidden = true; }
    window.clearTimeout(this.alertTimer);

    this.closeSoldierMenu();

    this.el.top.hidden = true;

    this.el.side.hidden = true;

  }



  setBattlefield(name: string, weatherHint?: string): void {

    this.el.setting.textContent = name;

    this.el.setting.title = weatherHint ?? 'Current battlefield and weather';

  }



  setTerrainProjection(project: (x: number, y: number) => { x: number; y: number } | null): void {

    this.terrainProject = project;

  }



  showTerrainTooltip(info: { title: string; detail: string } | null, worldX = 0, worldY = 0): void {

    const tooltip = this.el.terrainTooltip;

    if (info === null) {

      tooltip.hidden = true;

      return;

    }

    const title = document.createElement('strong');

    title.textContent = info.title;

    const detail = document.createElement('span');

    detail.textContent = info.detail;

    tooltip.replaceChildren(title, detail);

    const frame = tooltip.parentElement;

    const point = this.terrainProject?.(worldX, worldY) ?? null;

    if (frame === null || point === null) {

      tooltip.hidden = true;

      return;

    }

    tooltip.hidden = false;

    const bounds = frame.getBoundingClientRect();

    const left = point.x - bounds.left;

    const top = point.y - bounds.top;

    const maxLeft = Math.max(4, frame.clientWidth - tooltip.offsetWidth - 6);

    const maxTop = Math.max(4, frame.clientHeight - tooltip.offsetHeight - 6);

    tooltip.style.left = `${Math.max(4, Math.min(left + 14, maxLeft))}px`;

    tooltip.style.top = `${Math.max(4, Math.min(top + 14, maxTop))}px`;

  }



  private alertTimer = 0;
  private pinnedIds = new Set<number>();
  private pinnedSeed = -1;
  private readonly originalTitles = new WeakMap<HTMLButtonElement, string>();

  private availability(button: HTMLButtonElement, reason: string): void {
    if (!this.originalTitles.has(button)) this.originalTitles.set(button, button.title);
    const base = this.originalTitles.get(button)!;
    const title = button.disabled ? `${base} · Unavailable: ${reason}` : base;
    if (button.title !== title) { button.title = title; button.setAttribute('aria-description', button.disabled ? reason : base); }
  }

  private addHistory(text: string, kind: string): void {
    const history = document.getElementById('battle-history');
    if (!history) return;
    const row = document.createElement('li'); row.className = kind; row.textContent = text;
    history.prepend(row);
    while (history.children.length > 60) history.lastChild?.remove();
  }

  setPlacementFeedback(preview: PreviewInfo | null): void {
    const element = document.getElementById('placement-feedback');
    if (!element) return;
    element.hidden = preview === null;
    if (!preview) return;
    const costs = CONFIG.costs as unknown as Record<string, number>;
    const cost = preview.kind === 'recruit' ? CONFIG.costs.recruit[preview.role as FriendlyRole]
      : preview.kind === 'satchel' ? CONFIG.satchel.cost : costs[preview.kind];
    const label = preview.kind.replace(/([A-Z])/g, ' $1');
    const text = `${label[0]!.toUpperCase()}${label.slice(1)}${cost !== undefined ? ` · ${cost} points` : ''} · ${preview.valid ? 'Click to confirm · Esc to cancel' : preview.reason ?? 'Invalid position or soldier unavailable'}`;
    if (element.textContent !== text) element.textContent = text;
    element.classList.toggle('invalid', !preview.valid);
  }

  notice(text: string, kind: 'info' | 'warn' | 'error' | 'good' = 'info'): void {
    this.addHistory(text, kind);
    if (kind === 'error' || text.includes('pinned')) {
      const alert = document.getElementById('combat-alert');
      if (alert) { alert.textContent = text; alert.hidden = false; window.clearTimeout(this.alertTimer); this.alertTimer = window.setTimeout(() => { alert.hidden = true; }, 6500); }
    }

    const div = document.createElement('div');

    div.className = `notice ${kind}`;

    div.textContent = text;

    this.el.notices.prepend(div);

    while (this.el.notices.children.length > MAX_NOTICES) {

      this.el.notices.lastChild?.remove();

    }

    window.setTimeout(() => div.remove(), kind === 'error' ? NOTICE_TTL_MS * 2 : NOTICE_TTL_MS);

    if (this.noticeTimer === undefined) {

      this.noticeTimer = window.setInterval(() => {

        if (this.el.notices.children.length === 0) {

          window.clearInterval(this.noticeTimer);

          this.noticeTimer = undefined;

        }

      }, 1000);

    }

  }



  clearChatter(): void { window.clearTimeout(this.chatterTimer); this.el.chatter.hidden = true; }

  chatter(team: 'friendly' | 'enemy', text: string, channel: 'field' | 'radio' = 'radio'): void {
    this.addHistory(`${team === 'friendly' ? 'Allied' : 'Axis'} ${channel}: ${text}`, 'info');

    this.el.chatter.className = team === 'enemy' ? 'axis' : 'allied';

    this.el.chatter.replaceChildren();

    const label = document.createElement('span');

    label.className = 'radio-label';

    label.textContent = `${team === 'enemy' ? 'AXIS' : 'ALLIED'} ${channel === 'field' ? 'FIELD' : 'RADIO'}`;

    const line = document.createElement('span');

    line.textContent = text;

    this.el.chatter.append(label, line);

    this.el.chatter.hidden = false;

    window.clearTimeout(this.chatterTimer);

    this.chatterTimer = window.setTimeout(() => { this.el.chatter.hidden = true; }, 6200);

  }



  setPausedBadge(paused: boolean): void {

    if (paused) this.closeSoldierMenu();

    this.el.pausedBadge.hidden = !paused;

    this.el.btnPause.textContent = paused ? 'Resume' : 'Pause';

  }



  setModeUI(mode: UIMode): void {
    this.el.btnAmbush.classList.toggle('active', mode.kind === 'ambush');

    this.el.btnBarbedWire.classList.toggle('active', mode.kind === 'barbedWire');

    this.el.btnSandbag.classList.toggle('active', mode.kind === 'sandbag');

    this.el.btnTrench.classList.toggle('active', mode.kind === 'trench');

    this.el.btnBunker.classList.toggle('active', mode.kind === 'bunker');

    this.el.btnMortarPit.classList.toggle('active', mode.kind === 'mortarPit');

    this.el.btnBridge.classList.toggle('active', mode.kind === 'bridge');

    this.el.btnMineAp.classList.toggle('active', mode.kind === 'mine' && mode.mineKind === 'ap');

    this.el.btnMineAt.classList.toggle('active', mode.kind === 'mine' && mode.mineKind === 'at');

    this.el.btnArtillery.classList.toggle('active', mode.kind === 'artillery');

    this.el.btnAirSupport.classList.toggle('active', mode.kind === 'airSupport');

    this.el.btnFlare.classList.toggle('active', mode.kind === 'flare');

    if (mode.kind === 'flare') this.el.btnFlare.disabled = true;

    this.el.btnSmoke.classList.toggle('active', mode.kind === 'smoke');

    this.el.btnSatchel.classList.toggle('active', mode.kind === 'satchel');

    for (const child of Array.from(this.el.recruitButtons.children)) {

      const btn = child as HTMLButtonElement;

      btn.classList.toggle('active', mode.kind === 'recruit' && btn.dataset.role === mode.role);

    }

    const showCancel = mode.kind !== 'none';

    this.el.btnCancelMode.hidden = !showCancel;

    const hints: Record<string, string> = {
      suppress: 'Click visible ground within the selected machine gun’s range to suppress it for 10 seconds. Esc or right-click cancels.',
      ambush: `Click to set facing and trigger range. The selected arc width applies to each soldier. Prepare for ${CONFIG.ambush.prepareSeconds}s, then hold guns and grenades until a visible enemy enters. Moving cancels the order. Esc or right-click cancels targeting.`,

      recruit: 'Left-click the southern zone to deploy. Esc or right-click cancels.',

      barbedWire: `Place a ${CONFIG.barbedWire.halfLength * 2}px east–west wire segment on dry ground within ${CONFIG.construction.engineerRange}px of an available engineer (${CONFIG.construction.barbedWireSeconds}s). Slows all infantry; leave gaps for lanes. Enemy engineers cut breaches. Esc or right-click cancels.`,

      sandbag: `Place within ${CONFIG.construction.engineerRange}px of an available engineer. Build time: ${CONFIG.construction.sandbagSeconds}s; the engineer must stay nearby. Esc or right-click cancels.`,

      trench: `Place within ${CONFIG.construction.engineerRange}px of an available engineer. Build time: ${CONFIG.construction.trenchSeconds}s; the engineer must stay nearby. Occupants take 55% less artillery damage and 50% less artillery suppression. Machine gunners fight best from a trench with their M1918A2 BAR.`,

      bunker: `Place within ${CONFIG.construction.engineerRange}px of an available engineer. Build time: ${CONFIG.construction.bunkerSeconds}s; protects nearby soldiers from direct fire from all directions.`,

      bridge: `Place on a river within ${CONFIG.construction.engineerRange}px of an available engineer. Build time: ${CONFIG.construction.bridgeSeconds}s; a low pontoon deck provides a firm crossing, with no passage underneath. Esc or right-click cancels.`,

      mortarPit: `Place within ${CONFIG.construction.engineerRange}px of an available engineer. Build time: ${CONFIG.construction.mortarPitSeconds}s; mortarmen within ${CONFIG.mortarPit.occupyRadius}px take 65% less artillery damage and reload 30% faster.`,

      artillery: 'Left-click to fire the barrage. Esc or right-click cancels.',

      airSupport: `Click to mark a bombing run: ${CONFIG.airSupport.bombCount} bombs cross the target after ${CONFIG.airSupport.delaySeconds}s. Keep friendlies clear. Esc or right-click cancels.`,

      flare: `Left-click to launch a flare. It takes ${CONFIG.flare.deploymentDelaySeconds}s to arrive, then lights a ${CONFIG.flare.radius}px area for ${CONFIG.flare.durationSeconds}s and improves friendly fire against enemies there. Available at night. Esc or right-click cancels.`,

      smoke: `Left-click a landing point within ${CONFIG.smoke.throwRange}px. Smoke blocks rifle fire for ${CONFIG.smoke.durationSeconds}s. Esc or right-click cancels.`,

      satchel: `Left-click open ground within ${CONFIG.satchel.placementRange}px of the selected engineer. The ${CONFIG.satchel.fuseSeconds}s fuse starts immediately. Move troops outside the ${CONFIG.satchel.radius}px blast radius. Esc or right-click cancels placement.`,

      patrol: mode.kind === 'patrol' && mode.origin

        ? 'Click the opposite corner to confirm the patrol area (at least 48 × 48). Esc or right-click cancels.'

        : 'Click the first corner of the patrol area, then the opposite corner. Esc or right-click cancels.',

    };

    const mineHint = (kind: 'ap' | 'at'): string => {

      const def = CONFIG.mineKinds[kind];

      return `Place ahead of the line, within ${CONFIG.construction.engineerRange}px of an available engineer. Laying takes ${def.laySeconds}s. Detonates under ${mineTargets(kind)}.`;

    };

    this.el.modeHint.hidden = mode.kind === 'none';

    this.el.modeHint.textContent = mode.kind === 'none'

      ? ''

      : mode.kind === 'mine' ? mineHint(mode.mineKind) : hints[mode.kind] ?? '';

  }



  /**

   * `selection` is every selected soldier. One soldier fills the detail panel;

   * a group gets a compact summary instead, because describing one member of a

   * group as "the" selection is how a player loses track of what an order will

   * actually move.

   */

  update(state: SimState, selection: readonly Unit[], mode: UIMode): void {
    if (this.pinnedSeed !== state.baseTerrainSeed) { this.pinnedIds.clear(); this.pinnedSeed = state.baseTerrainSeed; }
    const pinned = state.units.filter((unit) => unit.team === 'friendly' && unit.pinned && !unit.dead && unit.health > 0);
    for (const soldier of pinned) if (!this.pinnedIds.has(soldier.id)) this.notice(`${nameOf(state, soldier.id)} pinned! Move support into position.`, 'warn');
    this.pinnedIds = new Set(pinned.map((unit) => unit.id));

    const selectionKey = selection.map((unit) => unit.id).sort((a, b) => a - b).join(',');

    if (selectionKey !== this.selectionKey) {

      this.selectionKey = selectionKey;

      if (selection.length > 0) this.selectTab('squad');

    }

    this.updateRoster(state, selection);

    this.el.points.textContent = String(state.points);

    this.el.map.textContent = state.endless

      ? `Endless · map ${state.mapNumber}`

      : `Map ${state.mapNumber} · ${state.mapsCleared}/${CONFIG.crossing.campaignMaps}`;

    const auth = getContent().waves.length;

    this.el.wave.textContent = state.endless

      ? `Endless ${state.scheduler.endlessWavesCleared + 1}`

      : state.scheduler.phase === 'crossing'

        ? `Crossing · ${crossedCountOf(state)}/${crossedCountOf(state) + onMapCountOf(state)}`

        : `${Math.min(state.scheduler.waveIndex + 1, auth)}/${auth}`;

    if (state.phase !== 'running') {

      this.el.phase.textContent = state.phase === 'victory' ? 'Victory' : 'Defeat';

    } else if (state.scheduler.phase === 'prep') {

      this.el.phase.textContent = `Prep ${Math.ceil(state.scheduler.prepTicksLeft / CONFIG.tickRate)}s`;

    } else if (state.scheduler.phase === 'spawning') {

      this.el.phase.textContent = 'Incoming';

    } else if (state.scheduler.phase === 'crossing') {

      const onMap = onMapCountOf(state);

      const across = crossedCountOf(state);

      this.el.phase.textContent = onMap > 0

        ? `Marching north · ${onMap} on the map`

        : `${across} soldier${across === 1 ? '' : 's'} across`;

    } else if (state.scheduler.phase === 'advance') {

      this.el.phase.textContent = 'March north';

    } else {

      this.el.phase.textContent = 'Combat';

    }

    this.el.integrity.textContent = String(state.integrity);

    this.el.integrity.classList.toggle('low', state.integrity <= 3);

    this.el.score.textContent = String(state.score);



    // Affordability states.

    const costs = CONFIG.costs.recruit;

    for (const child of Array.from(this.el.recruitButtons.children)) {

      const btn = child as HTMLButtonElement;

      const role = (btn.dataset.role ?? 'rifleman') as FriendlyRole;

      btn.classList.toggle('unaffordable', state.points < costs[role]);

    }

    const busyBuilders = new Set(state.constructionSites.map((site) => site.builderId));

    const hasEngineer = state.units.some((unit) => unit.team === 'friendly' && unit.role === 'engineer' && unit.health > 0 && !unit.pinned && !busyBuilders.has(unit.id));

    this.el.btnBarbedWire.disabled = !hasEngineer || state.points < CONFIG.costs.barbedWire;

    this.el.btnSandbag.disabled = !hasEngineer || state.points < CONFIG.costs.sandbag;

    this.el.btnTrench.disabled = !hasEngineer || (state.points < CONFIG.costs.trench && mode.kind !== 'trench');

    this.el.btnBunker.disabled = !hasEngineer || (state.points < CONFIG.costs.bunker && mode.kind !== 'bunker');

    this.el.btnMortarPit.disabled = !hasEngineer || (state.points < CONFIG.costs.mortarPit && mode.kind !== 'mortarPit');

    this.el.btnBridge.disabled = !hasEngineer || (state.points < CONFIG.costs.bridge && mode.kind !== 'bridge');

    this.el.btnMineAp.disabled = !hasEngineer || (state.points < CONFIG.mineKinds.ap.cost && !isMineMode(mode, 'ap'));

    this.el.btnMineAt.disabled = !hasEngineer || (state.points < CONFIG.mineKinds.at.cost && !isMineMode(mode, 'at'));

    if (state.constructionSites.length === 0) {

      this.el.constructionStatus.hidden = true;

    } else {

      const status = state.constructionSites.map((site) => {

        const builder = state.units.find((unit) => unit.id === site.builderId && unit.team === 'friendly' && unit.role === 'engineer' && unit.health > 0 && !unit.pinned);

        const working = builder !== undefined && Math.hypot(builder.pos.x - site.pos.x, builder.pos.y - site.pos.y) <= CONFIG.construction.engineerRange;

        const label = site.kind === 'barbedWire' ? 'Barbed wire' : site.kind === 'sandbag' ? 'Sandbag' : site.kind === 'trench' ? 'Trench' : site.kind === 'bunker' ? 'Bunker' : site.kind === 'mortarPit' ? 'Mortar pit' : site.kind === 'bridge' ? 'Bridge' : 'Mine';

        const remaining = `${Math.ceil(site.ticksRemaining / CONFIG.tickRate)}s`;

        return `${label}: ${working ? `${remaining} remaining` : `paused · engineer must be unpinned and within ${CONFIG.construction.engineerRange}px`}`;

      });

      this.el.constructionStatus.hidden = false;

      this.el.constructionStatus.textContent = status.join(' | ');

    }

    const artilleryReady = state.artilleryCooldown <= 0 && state.points >= CONFIG.costs.artillery;

    const hasRadioEngineer = state.units.some((unit) => unit.team === 'friendly' && unit.role === 'radio_engineer' && unit.health > 0 && !unit.pinned);

    this.el.btnArtillery.disabled = !hasRadioEngineer || (!artilleryReady && mode.kind !== 'artillery') || this.artilleryRequestPending;

    const airSupportReady = state.airSupportCooldown <= 0 && state.points >= CONFIG.costs.airSupport;

    this.el.btnAirSupport.disabled = !hasRadioEngineer || (!airSupportReady && mode.kind !== 'airSupport') || this.airSupportRequestPending;

    const night = dayNightAtTick(state.ticks, state.dayNightStartTick).night;

    const flareReady = state.flareCooldown <= 0 && state.points >= CONFIG.costs.flare;

    this.el.btnFlare.disabled = !hasRadioEngineer || !night || !flareReady || mode.kind === 'flare' || this.flareRequestPending;

    if (state.artilleryCooldown > 0) {

      this.el.artilleryCd.hidden = false;

      this.el.artilleryCd.textContent = `Reloaded in ${Math.ceil(state.artilleryCooldown / CONFIG.tickRate)}s`;

    } else {

      this.el.artilleryCd.hidden = true;

    }

    if (state.airSupportCooldown > 0) {

      this.el.airSupportCd.hidden = false;

      this.el.airSupportCd.textContent = `Air support rearm · ${Math.ceil(state.airSupportCooldown / CONFIG.tickRate)}s`;

    } else {

      this.el.airSupportCd.hidden = true;

    }

    const incomingFlare = state.flares.find((flare) => (flare.pendingTicksRemaining ?? 0) > 0);

    if (incomingFlare) {

      this.el.flareCd.hidden = false;

      this.el.flareCd.textContent = `Flare incoming · ${Math.ceil(incomingFlare.pendingTicksRemaining! / CONFIG.tickRate)}s`;

    } else if (state.flareCooldown > 0) {

      this.el.flareCd.hidden = false;

      this.el.flareCd.textContent = `Flare rearm · ${Math.ceil(state.flareCooldown / CONFIG.tickRate)}s`;

    } else if (!night) {

      this.el.flareCd.hidden = false;

      this.el.flareCd.textContent = state.dayNightStartTick === null ? 'Flares unlock after three waves' : 'Flares available at night';

    } else {

      this.el.flareCd.hidden = true;

    }

    this.el.btnFoodSupplies.disabled = !hasRadioEngineer || state.foodSupplyCooldown > 0 || this.foodSuppliesPending;
    for (const [button, cost] of [
      [this.el.btnBarbedWire, CONFIG.costs.barbedWire], [this.el.btnSandbag, CONFIG.costs.sandbag],
      [this.el.btnTrench, CONFIG.costs.trench], [this.el.btnBunker, CONFIG.costs.bunker],
      [this.el.btnMortarPit, CONFIG.costs.mortarPit], [this.el.btnBridge, CONFIG.costs.bridge],
      [this.el.btnMineAp, CONFIG.mineKinds.ap.cost], [this.el.btnMineAt, CONFIG.mineKinds.at.cost],
    ] as const) this.availability(button, !hasEngineer ? 'Recruit an unpinned Combat Support Engineer.' : `Requires ${cost} tactical points.`);
    for (const [button, cooldown, cost, pending] of [
      [this.el.btnArtillery, state.artilleryCooldown, CONFIG.costs.artillery, this.artilleryRequestPending],
      [this.el.btnAirSupport, state.airSupportCooldown, CONFIG.costs.airSupport, this.airSupportRequestPending],
      [this.el.btnFlare, state.flareCooldown, CONFIG.costs.flare, this.flareRequestPending],
      [this.el.btnFoodSupplies, state.foodSupplyCooldown, 0, this.foodSuppliesPending],
    ] as const) this.availability(button, pending ? 'Waiting for radio confirmation.' : !hasRadioEngineer ? 'Recruit an unpinned Radio Engineer.'
      : button === this.el.btnFlare && !night ? 'Flares are available at night after three waves.'
      : cooldown > 0 ? `Ready in ${Math.ceil(cooldown / CONFIG.tickRate)} seconds.` : `Requires ${cost} tactical points.`);

    if (state.foodSupplyCooldown > 0) {

      this.el.foodSupplyCd.hidden = false;

      this.el.foodSupplyCd.textContent = `Radio available in ${Math.ceil(state.foodSupplyCooldown / CONFIG.tickRate)}s`;

    } else {

      this.el.foodSupplyCd.hidden = true;

    }

    const primary = selection.length === 1 ? selection[0] as Unit : null;

    const occupant = selection[0];

    const position = occupant?.buildingOrder ?? occupant?.buildingPosition;

    const building = position && state.buildings.find((b) => b.id === position.buildingId && !b.destroyed);

    if (this.el.buildingControls.hidden !== !building) this.el.buildingControls.hidden = !building;

    if (building && position) {

      const options = fightingPositionOptions(building);

      const optionsKey = `${building.id}:${options.map((option) => option.value).join(',')}`;

      if (this.el.buildingLevel.dataset.buildingOptions !== optionsKey) {

        this.el.buildingLevel.replaceChildren(...options.map(({ value, label }) => new Option(label, value)));

        this.el.buildingLevel.dataset.buildingOptions = optionsKey;

      }

      // Reassigning an unchanged native select value refreshes its open popup.

      // Keep the menu stable while the HUD continues to render every frame.

      const value = fightingPositionValue(position);

      if (this.el.buildingLevel.value !== value) this.el.buildingLevel.value = value;

      const pinned = selection.every((unit) => unit.pinned);

      if (this.el.buildingLevel.disabled !== pinned) this.el.buildingLevel.disabled = pinned;

      if (this.el.btnLeaveBuilding.disabled !== pinned) this.el.btnLeaveBuilding.disabled = pinned;

      const destination = fightingPositionLabel(position.level, positionFacing(position));

      const status = `${building.name} · ${occupant?.buildingOrder ? `Moving to ${destination}` : destination}`;

      if (this.el.buildingStatus.textContent !== status) this.el.buildingStatus.textContent = status;

    }

    this.el.btnSmoke.disabled = primary === null || (primary.smokeGrenades ?? 0) <= 0 || primary.pinned || primary.crossed === true;

    this.el.btnSatchel.hidden = primary?.role !== 'engineer';

    const satchelReason = satchelError(state, primary ?? undefined);

    this.el.btnSatchel.disabled = satchelReason !== null;

    const burningSatchel = state.satchelCharges.find((charge) => charge.unitId === primary?.id);

    this.el.satchelStatus.hidden = state.satchelCharges.length === 0;

    this.el.satchelStatus.textContent = state.satchelCharges.length

      ? `Satchel fuse: ${state.satchelCharges.map((charge) => `${Math.ceil(charge.ticksRemaining / CONFIG.tickRate)}s`).join(' · ')}. Keep troops clear!` : '';

    this.el.btnSatchel.textContent = burningSatchel ? `Satchel fuse · ${Math.ceil(burningSatchel.ticksRemaining / CONFIG.tickRate)}s`

      : `Satchel charge · ${CONFIG.satchel.cost} pts · ${CONFIG.satchel.fuseSeconds}s fuse`;

    this.el.btnSatchel.title = satchelReason ?? `Plant within ${CONFIG.satchel.placementRange}px. Detonates after ${CONFIG.satchel.fuseSeconds}s, damaging troops, vehicles, and buildings within ${CONFIG.satchel.radius}px, including friendlies.`;

    this.el.btnSmoke.textContent = primary === null ? 'Smoke grenade · select one' : `Smoke grenade · ${primary.smokeGrenades ?? 0}`;

    this.el.btnLightFire.hidden = selection.length === 0 || (primary !== null && (primary.role === 'gun_truck' || primary.role === 'vehicle'));

    const fireError = campfireError(state, primary ?? undefined);

    const burningFire = primary === null ? undefined : state.campfires.find((fire) => fire.unitId === primary.id);

    this.el.btnLightFire.disabled = fireError !== null;

    this.el.btnLightFire.textContent = burningFire ? `Fire burning · ${Math.ceil(burningFire.ticksRemaining / CONFIG.tickRate)}s` : 'Light small fire';

    this.el.btnLightFire.title = fireError ?? `Light a free fire at this soldier's position for ${CONFIG.campfire.durationSeconds}s. Illuminates ${CONFIG.campfire.radius}px for both sides. One fire per soldier at a time; extinguished at dawn.`;

    const ability = primary ? ROLE_ABILITIES[primary.role] : undefined;
    this.roleAbilityButton.hidden = !ability || selection.length !== 1;
    this.roleAbilityButton.disabled = !primary || primary.pinned || primary.crossed === true || (!primary.roleDuty && (primary.roleCooldown ?? 0) > 0);
    const duty = primary?.roleDuty;
    const remaining = duty?.ticksRemaining ? ` · ${Math.ceil(duty.ticksRemaining / CONFIG.tickRate)}s` : duty?.kind === 'supply' ? ` · ${duty.stock} items` : '';
    this.roleAbilityButton.textContent = duty ? `${duty.kind === 'observe' ? 'Stop observing' : duty.kind === 'supply' ? 'Close supply point' : duty.kind === 'repair' ? 'Stop repair detail' : duty.kind === 'suppress' ? 'Cease area fire' : 'End rally'}${remaining}` : `${ability?.label ?? ''}${(primary?.roleCooldown ?? 0) > 0 ? ` · ${Math.ceil(primary!.roleCooldown! / CONFIG.tickRate)}s` : ''}`;
    this.roleAbilityButton.title = ability?.description ?? '';
    this.roleAbilityButton.classList.toggle('active', !!duty || mode.kind === 'suppress');
    this.roleAbilityButton.setAttribute('aria-pressed', String(!!duty || mode.kind === 'suppress'));
    const ambushUnits = selection.filter(supportsAmbush);
    const ambushing = ambushUnits.some((unit) => unit.ambush);
    this.el.btnAmbush.hidden = ambushUnits.length === 0;
    this.el.ambushArc.hidden = ambushUnits.length === 0 || (!ambushing && mode.kind !== 'ambush');
    const ambushArcs = [...new Set(ambushUnits.flatMap((unit) => unit.ambush ? [unit.ambush.arcDegrees] : []))];
    if (ambushArcs.length > 0) this.el.ambushArc.value = ambushArcs.length === 1 ? String(ambushArcs[0]) : 'mixed';
    else if (this.el.ambushArc.value === 'mixed') this.el.ambushArc.value = '90';
    this.el.ambushArc.disabled = ambushing;
    this.el.btnAmbush.disabled = !ambushing && ambushUnits.some((unit) => unit.pinned || unit.buildingOrder || (unit.upgradeTimer ?? 0) > 0
      || state.constructionSites.some((site) => site.builderId === unit.id));
    this.el.btnAmbush.classList.toggle('active', ambushing || mode.kind === 'ambush');
    this.el.btnAmbush.setAttribute('aria-pressed', String(ambushing || mode.kind === 'ambush'));
    this.el.btnAmbush.setAttribute('aria-label', ambushing ? 'Cancel ambush' : mode.kind === 'ambush' ? 'Cancel ambush targeting' : 'Set ambush');
    this.el.btnAmbush.title = ambushing ? 'Cancel the ambush and resume normal fire orders.'
      : 'Activate ambush, choose an arc width, then click to set its direction and range. Infantry hold fire for a prepared opening burst.';
    this.el.btnFireOrder.hidden = selection.length === 0;

    this.el.btnFireOrder.disabled = selection.length === 0;

    if (selection.length > 0) {

      const selectedUnit = selection[0]!;

      const savedOrder = (selectedUnit.fireOrder ?? 'auto') as FireOrder;

      const order = fireOrdersForRole(selectedUnit.role).includes(savedOrder) ? savedOrder : 'auto';

      setCommandIcon(this.el.btnFireOrder, order, COMMAND_ICONS.fireOrder[order]);

      this.el.btnFireOrder.setAttribute('aria-label', `Fire order: ${FIRE_ORDER_LABELS[order]}`);

      const sharedOrdersExcludeGrenades = selection.some((unit) => unit.role === 'gun_truck');

      this.el.btnFireOrder.title = order === 'seekGunfire'

        ? 'Run to the nearest heard enemy gunfire, then stop and engage a located enemy. Uses stamina; works day and night. Direct move, patrol, or building orders cancel pursuit. Click to cycle.'

        : sharedOrdersExcludeGrenades

        ? `Fire order: ${FIRE_ORDER_LABELS[order]}. Click to cycle targeting orders for every selected unit. Machine Gun Trucks cannot hold grenades.`

        : `Fire order: ${FIRE_ORDER_LABELS[order]}. Click to cycle this order for every selected soldier.`;

    }

    const selectedInfantry = selection.filter((unit) => unit.role !== 'vehicle' && unit.role !== 'gun_truck');

    const patrolUnits = selection.filter((unit) => isPatrolRole(unit.role));

    const patrolling = patrolUnits.length > 0 && patrolUnits.every((unit) => unit.patrol);

    this.el.btnPatrol.hidden = patrolUnits.length === 0;

    this.el.btnPatrol.disabled = !patrolling && patrolUnits.every((unit) => unit.pinned);

    this.el.btnPatrol.textContent = mode.kind === 'patrol' ? 'Cancel patrol area' : patrolling ? 'Stop patrol' : 'Patrol area';

    this.el.btnPatrol.classList.toggle('active', mode.kind === 'patrol' || patrolling);

    this.el.btnPatrol.setAttribute('aria-pressed', String(mode.kind === 'patrol' || patrolling));

    this.el.btnPatrol.title = 'Riflemen, scouts, snipers, and medics patrol the marked area. Fighters stop to engage enemies; medics stop to treat nearby wounded soldiers, then resume. A move or building order replaces the patrol.';

    this.el.btnStance.hidden = selectedInfantry.length === 0;

    this.el.btnCrawl.hidden = selectedInfantry.length === 0;

    this.el.btnRun.hidden = selectedInfantry.length === 0 || selectedInfantry.every((unit) => unit.role === 'at_gun' || unit.role === 'heavy_mg');

    if (selectedInfantry.length > 0) {

      const stanceNames: Record<SoldierStance, string> = { standing: 'Standing', crouching: 'Crouching', prone: 'Prone' };

      const stances = new Set(selectedInfantry.map((unit) => unit.terrainCrawling ? 'prone' : unit.stance ?? 'standing'));

      const onlyStance = [...stances][0];

      const stanceState = stances.size === 1 && onlyStance ? onlyStance : 'mixed';

      setCommandIcon(this.el.btnStance, stanceState, COMMAND_ICONS.stance[stanceState]);

      const stanceLabel = stances.size === 1 && onlyStance ? stanceNames[onlyStance] : 'Mixed';

      this.el.btnStance.setAttribute('aria-label', `Stance: ${stanceLabel}`);

      this.el.btnStance.title = 'Cycle standing, crouching, and prone for selected infantry. Lower stances are harder to hit and move more slowly.';

      const crawlingCount = selectedInfantry.filter((unit) => unit.crawling === true).length;

      const crawlState = crawlingCount === selectedInfantry.length ? 'on' : crawlingCount > 0 ? 'mixed' : 'off';

      setCommandIcon(this.el.btnCrawl, crawlState, COMMAND_ICONS.crawl[crawlState]);

      const crawlLabel = crawlState === 'on' ? 'On' : crawlState === 'mixed' ? 'Mixed' : 'Off';

      this.el.btnCrawl.setAttribute('aria-label', `Crawl: ${crawlLabel}`);

      this.el.btnCrawl.title = 'Toggle a slow prone crawl for selected infantry. Steep slopes automatically require crawling. Pinned soldiers cannot be ordered to crawl.';

      this.el.btnCrawl.disabled = selectedInfantry.some((unit) => unit.pinned);

      const runOrdered = selectedInfantry.some((unit) => unit.movementPace === 'run');

      const paceAction = runOrdered ? 'walk' : 'run';

      setCommandIcon(this.el.btnRun, paceAction, COMMAND_ICONS.pace[paceAction]);

      this.el.btnRun.setAttribute('aria-label', runOrdered ? 'Switch to walking' : 'Run');

      this.el.btnRun.setAttribute('aria-pressed', String(runOrdered));

      this.el.btnRun.disabled = !runOrdered && selectedInfantry.every((unit) => unit.pinned || unit.terrainCrawling

        || unit.buildingPosition || (unit.stamina ?? 1) < CONFIG.infantryMovement.minimumRunStamina);

      this.el.btnRun.title = runOrdered ? 'Return selected soldiers to walking.'

        : 'Stand upright and run at 1.8× walking speed for up to 8 seconds. Needs 25% stamina; pinned soldiers and soldiers on steep ground cannot run. Arrival or exhaustion returns to walking.';

    }

    const selectedVehicles = selection.filter((unit) => unit.team === 'friendly' && (unit.role === 'gun_truck' || unit.role === 'vehicle'));

    this.el.btnHeadlights.hidden = selectedVehicles.length === 0;

    this.el.btnHeadlights.disabled = selectedVehicles.length === 0;

    if (selectedVehicles.length > 0) {

      const lightsOn = selectedVehicles.every((unit) => unit.headlightsOn !== false);

      const lightsOff = selectedVehicles.every((unit) => unit.headlightsOn === false);

      const lightState = lightsOn ? 'On' : lightsOff ? 'Off' : 'Mixed';

      this.el.btnHeadlights.textContent = `Headlights: ${lightState} · click to turn ${lightsOn ? 'off' : 'on'}`;

      this.el.btnHeadlights.title = 'At night, headlights on restore daytime speed but make vehicles easier to spot and hit. Lights off keep the 25% night speed penalty and conceal the vehicle.';

    }

    const canChoose = primary !== null && primary.xp >= CONFIG.specialization.unlockXp && primary.specialization === undefined;

    this.el.specializationControls.hidden = primary === null || (primary.specialization === undefined && !canChoose);

    if (primary !== null) {

      if (primary.specialization !== undefined) {

        const value = primary.specialization as Specialization;

        this.el.specializationSelect.replaceChildren(new Option(SPECIALIZATION_LABELS[value] ?? value, value));

        this.el.specializationSelect.disabled = true;

        this.el.btnSpecialization.textContent = 'Specialization chosen';

        this.el.btnSpecialization.disabled = true;

      } else if (canChoose) {

        const choices = SPECIALIZATION_CHOICES[primary.role as FriendlyRole] ?? [];

        if (this.specializationRole !== `${primary.id}:${primary.role}`) {

          this.specializationRole = `${primary.id}:${primary.role}`;

          this.el.specializationSelect.replaceChildren(...choices.map(({ value, label }) => new Option(label, value)));

        }

        this.el.specializationSelect.disabled = false;

        this.el.btnSpecialization.textContent = 'Choose specialization';

        this.el.btnSpecialization.disabled = choices.length === 0;

      }

    }

    this.updateWeaponUpgradeButton(this.el.btnAccuracyUpgrade, 'accuracy', state, primary, selection.length);

    this.updateWeaponUpgradeButton(this.el.btnReloadUpgrade, 'reload', state, primary, selection.length);

    this.updateWeaponUpgradeButton(this.el.btnDamageUpgrade, 'damage', state, primary, selection.length);



    // Selection panel: nothing, one soldier in detail, or a group summary.

    const group = selection.length > 1;

    this.el.selEmpty.hidden = selection.length > 0;

    this.el.selMulti.hidden = !group;

    this.el.selDetails.hidden = primary === null;

    if (group) this.updateMultiSelection(state, selection);

    const selected = primary;

    if (selected !== null) {

      const maxHp = maxHealthOf(selected);

      const hpFrac = Math.max(0, selected.health / maxHp);

      this.el.selRole.textContent = labelOf(selected);

      const rank = soldierRank(selected.xp);

      this.el.selName.textContent = nameOf(state, selected.id);

      this.el.selRank.textContent = `${rank.badge} ${rank.name}`;

      this.el.selRank.title = `Rank follows combat XP: level ${rank.level}/${CONFIG.xp.maxLevel}.`;

      this.el.selHp.style.width = `${hpFrac * 100}%`;

      this.el.selHp.classList.toggle('low', hpFrac <= 0.4);

      this.el.selHpText.textContent = `${Math.ceil(selected.health)}/${maxHp}`;

      const suppFrac = Math.min(1, selected.suppression / CONFIG.suppression.pinThreshold);

      this.el.selSupp.style.width = `${suppFrac * 100}%`;

      this.el.selSuppText.textContent = selected.pinned ? 'Pinned' : String(Math.round(selected.suppression));

      const morale = Math.max(0, Math.min(100, selected.morale));

      this.el.selMorale.style.width = `${morale}%`;

      this.el.selMorale.classList.toggle('low', morale <= CONFIG.morale.shakenThreshold);

      this.el.selMorale.classList.toggle('critical', morale <= CONFIG.morale.rattledThreshold);

      const moraleState = morale > CONFIG.morale.shakenThreshold ? 'Steady' : morale > CONFIG.morale.rattledThreshold ? 'Shaken' : 'Rattled';

      this.el.selMoraleText.textContent = `${Math.round(morale)} · ${moraleState}`;

      this.el.staminaRow.hidden = selected.role === 'gun_truck' || selected.role === 'vehicle';

      const stamina = Math.max(0, Math.min(1, selected.stamina ?? 1));

      this.el.selStamina.style.width = `${stamina * 100}%`;

      this.el.selStaminaText.textContent = `${Math.round(stamina * 100)}%`;

      const upgradedAim = selected.accuracySkill * (1 + selected.weaponUpgrades.accuracy * CONFIG.weaponUpgrades.accuracyPerLevel);

      this.el.selXp.textContent = `Aim ${Math.round(upgradedAim * 100)}% · XP ${selected.xp} · ${selected.kills} kill${selected.kills === 1 ? '' : 's'}`;

      if (selected.xp >= CONFIG.automaticSupport.unlockXp && selected.role !== 'gun_truck' && selected.role !== 'vehicle') this.el.selXp.textContent += ' · Auto support';

      this.el.selXp.title = `At ${CONFIG.automaticSupport.unlockXp} XP, infantry automatically call a medic when wounded and request ammunition when empty. Recruit the needed support soldier first.`;

      const grenadeCapacity = getContent().friendly[selected.role as FriendlyRole]?.grenades ?? 0;

      this.el.selGrenades.hidden = grenadeCapacity === 0;

      this.el.selGrenades.textContent = `Grenades: ${selected.grenades}/${grenadeCapacity}`;

      const rocketCapacity = getContent().friendly.at.rockets ?? 0;

      this.el.selRockets.hidden = selected.role !== 'at';

      this.el.selRockets.textContent = `Rockets: ${selected.rockets ?? rocketCapacity}/${rocketCapacity}`;

      const mortarCapacity = getContent().friendly.mortarman.mortarBombs ?? 0;

      this.el.selMortarBombs.hidden = selected.role !== 'mortarman';

      this.el.selMortarBombs.textContent = `Mortar bombs: ${selected.mortarBombs ?? mortarCapacity}/${mortarCapacity}`;

      let action = 'Holding position';

      if (selected.pinned) action = 'Pinned - cannot act';

      else if ((selected.upgradeTimer ?? 0) > 0) {

        action = `Working on weapon - ${Math.ceil((selected.upgradeTimer ?? 0) / CONFIG.tickRate)}s`;

      } else if (selected.terrainCrawling) action = 'Crawling on steep ground';

      else if (selected.path.length > 0 && selected.running) action = `Running · ${Math.ceil((selected.stamina ?? 1) * CONFIG.infantryMovement.runSeconds - 1e-9)}s stamina`;

      else if (selected.role === 'mortarman' && !usesBackupRifle(selected, getContent())) action = selected.path.length > 0

        ? 'Walking · mortar holds fire'

        : (selected.mortarTimer ?? 0) > 0

          ? `Mortar reloading · ${Math.ceil((selected.mortarTimer ?? 0) / CONFIG.tickRate)}s`

          : 'Mortar ready · waiting for target';

      else if (selected.role === 'officer' && selected.path.length === 0 && selected.targetId === null) action = 'Steadying nearby soldiers';

      else if (selected.role === 'gun_truck') action = selected.path.length > 0

        ? `Moving · mounted gun at ${Math.round(CONFIG.gunTruck.movingAccuracyMult * 100)}% accuracy`

        : selected.targetId !== null

          ? 'Mounted gun engaging'

          : 'Mounted gun ready · hold position to fire';

      else if (selected.supplyTargetId !== undefined) action = state.units.find((unit) => unit.id === selected.supplyTargetId)?.role === 'mortarman' ? 'Delivering mortar supplies' : state.units.find((unit) => unit.id === selected.supplyTargetId)?.role === 'at' ? 'Delivering rocket supplies' : 'Delivering grenade supplies';

      else if (selected.path.length > 0) action = selected.role === 'vehicle' ? 'Moving' : selected.crawling || selected.stance === 'prone' ? 'Crawling' : 'Walking';

      else if (selected.medicalTargetId !== undefined) action = selected.path.length || selected.buildingOrder ? 'Attending wounded' : 'Tending wounded';

      else if (selected.role === 'medic' && selected.healTimer > 0) action = 'Tending wounded';

      else if (selected.targetId !== null) action = 'Engaging';

      if (!selected.pinned && selected.clearBuilding) action = selected.path.length ? 'Approaching hostile building' : 'Clearing hostile occupants';
      if (!selected.pinned && selected.deployment) action = selected.deployment.packingTicks > 0
        ? `Packing weapon · ${Math.ceil(selected.deployment.packingTicks / CONFIG.tickRate)}s`
        : selected.path.length ? 'Moving weapon crew'
          : selected.deployment.ticks > 0 ? `Deploying / traversing · ${Math.ceil(selected.deployment.ticks / CONFIG.tickRate)}s`
            : selected.targetId !== null ? 'Deployed · engaging' : 'Deployed · covering firing arc';
      if (selected.role === 'scout' && !selected.path.length && selected.targetId === null && !selected.pinned) action = 'Observing · spotting for mortars';
      if (selected.patrol && !selected.pinned && (selected.upgradeTimer ?? 0) === 0) action = selected.role === 'medic' && !selected.path.length && selected.healTimer > 0

        ? 'Patrol · tending wounded' : selected.targetId !== null ? 'Patrol · engaging' : selected.path.length ? 'Patrolling' : 'Patrol · waiting for route';

      if (selected.fireOrder === 'seekGunfire' && !selected.pinned && (selected.upgradeTimer ?? 0) === 0) action = selected.targetId !== null

        ? 'Gunfire order · engaging' : selected.path.length

          ? `${selected.running ? 'Running' : selected.terrainCrawling || selected.crawling ? 'Crawling' : 'Walking'} to gunfire` : 'Listening for gunfire';

      if (selected.roleDuty) action = `${ROLE_ABILITIES[selected.role]?.label ?? 'Support duty'}${selected.pinned ? ' · paused under fire' : ''}${selected.roleDuty.kind === 'supply' ? ` · ${selected.roleDuty.stock} items` : ''}`;
      if (selected.scoutReports?.length) action += ` · ${selected.scoutReports.length} reports (amber markers fade over 12s)`;
      if (selected.bridgePosition) action += selected.bridgePosition.level === 'under' ? ' · Under bridge' : ' · Bridge deck';

      if (usesBackupRifle(selected, getContent())) action += ` · Using rifle · Out of ${selected.role === 'at' ? 'rockets' : 'mortar bombs'}`;

      if (selected.ambush && !selected.pinned && (selected.upgradeTimer ?? 0) === 0) action = selected.ambush.triggered
        ? 'Ambush: opening burst'
        : selected.ambush.prepTicks > 0 ? `Preparing ambush - ${Math.ceil(selected.ambush.prepTicks / CONFIG.tickRate)}s`
          : `Ambush ready - ${Math.round(selected.ambush.range)}px / ${selected.ambush.arcDegrees} degrees - holding fire`;
      this.el.selAction.textContent = action;

      const contact = dayNightAtTick(state.ticks, state.dayNightStartTick).night ? latestNightContact(selected, state.ticks) : undefined;

      this.el.selContact.hidden = !contact;

      if (contact) {

        const clue = { sound: 'Gunfire heard', muzzleFlash: 'Muzzle flash spotted', tracer: 'Tracer spotted' }[contact.kind];

        this.el.selContact.textContent = `${clue} · ${contactBearing(selected.pos, contact.pos)} · ${Math.ceil((contact.expiresTick - state.ticks) / CONFIG.tickRate)}s`;

        this.el.selContact.title = 'Last-known firing position. Silence and movement break contact. Sound cannot guide rifle fire through walls or smoke.';

      }

      const gunTruckWeapon = getContent().friendly.gun_truck.weapon;

      const gunTruckRange = gunTruckWeapon === null ? 0 : (getContent().weapons[gunTruckWeapon]?.range ?? 0);

      this.el.selAction.title = selected.role === 'mortarman'

        ? `Carries ${mortarCapacity} mortar bombs and switches to an M1 Garand when empty. Right-click this soldier in the roster and choose Mortar supplies to refill and resume mortar fire. Keep stationary to fire at an enemy ${CONFIG.mortar.minRange}–${CONFIG.mortar.maxRange}px away. Blasts can hit friendlies.`

        : selected.role === 'at'

          ? `Carries ${rocketCapacity} bazooka rockets and switches to an M1 Garand when empty. Right-click this soldier in the roster and choose Rocket supplies to refill and resume bazooka fire. Prioritize armor to make vehicles the first targets.`

        : selected.role === 'officer'

          ? `Nearby unpinned officers within ${CONFIG.morale.officerAuraRange}px help soldiers recover morale and suppression faster.`

        : selected.role === 'gun_truck'

          ? `The mounted machine gun can fire while moving at ${Math.round(CONFIG.gunTruck.movingAccuracyMult * 100)}% accuracy, or stop for full accuracy (range ${gunTruckRange}px). Strong against infantry, weak against armor.`

          : '';

      this.el.selAction.classList.toggle('pinned', selected.pinned || (selected.upgradeTimer ?? 0) > 0);

    }

  }



  setFoodSuppliesPending(pending: boolean): void {

    this.foodSuppliesPending = pending;

    if (pending) this.el.btnFoodSupplies.disabled = true;

  }



  setFlareRequestPending(pending: boolean): void {

    this.flareRequestPending = pending;

    if (pending) this.el.btnFlare.disabled = true;

  }



  setArtilleryRequestPending(pending: boolean): void {

    this.artilleryRequestPending = pending;

    if (pending) this.el.btnArtillery.disabled = true;

  }



  setAirSupportRequestPending(pending: boolean): void {

    this.airSupportRequestPending = pending;

    if (pending) this.el.btnAirSupport.disabled = true;

  }



  /**

   * Group selection summary: who is in it, and what state they are in, so the

   * player can see what a right-click is about to move without reading the field.

   */

  private updateMultiSelection(state: SimState, selection: readonly Unit[]): void {

    const pinned = selection.filter((u) => u.pinned).length;

    const wounded = selection.filter((u) => u.health < maxHealthOf(u)).length;

    const moving = selection.filter((u) => u.path.length > 0).length;

    const bits = [`${selection.length} soldiers selected`];

    if (pinned > 0) bits.push(`${pinned} pinned`);

    if (wounded > 0) bits.push(`${wounded} wounded`);

    if (moving > 0) bits.push(`${moving} moving`);

    this.el.selMultiCount.textContent = bits.join(' · ');



    const names = selection

      .map((unit) => {

        const label = `${nameOf(state, unit.id)} · ${labelOf(unit)}`;

        const state_ = unit.pinned ? 'Pinned' : unit.health < maxHealthOf(unit) ? 'Wounded' : 'Ready';

        return `${label} · HP ${Math.ceil(unit.health)}/${maxHealthOf(unit)} · ${state_}`;

      });

    // Rebuild only when the group or its text actually changed, so the list does

    // not churn every frame and steal focus.

    if (this.multiSelectionKey !== names.join('|')) {

      this.multiSelectionKey = names.join('|');

      this.el.selMultiList.replaceChildren(...names.map((text) => {

        const li = document.createElement('li');

        li.textContent = text;

        return li;

      }));

    }

  }



  private updateRoster(state: SimState, selection: readonly Unit[]): void {

    this.rosterState = state;

    const selectedIds = new Set(selection.map((unit) => unit.id));

    const soldiers = state.units.filter((unit) => unit.team === 'friendly' && !unit.dead && unit.health > 0);

    const assignedPatients = new Set(soldiers.filter((u) => !u.crossed && u.medicalTargetId !== undefined).map((u) => u.medicalTargetId));

    const waitingPatients = (state.medicalQueue ?? []).filter((id) => !assignedPatients.has(id));

    const assignedSupplies = new Set(soldiers.filter((u) => !u.crossed).map((u) => u.supplyTargetId));

    const waitingSupplies = (state.grenadeSupplyQueue ?? []).filter((id) => !assignedSupplies.has(id));

    this.el.rosterCount.textContent = `${soldiers.length}/${CONFIG.caps.friendly}`;

    const livingIds = new Set(soldiers.map((unit) => unit.id));

    for (const [id, row] of this.rosterRows) {

      if (!livingIds.has(id)) {

        row.remove();

        this.rosterRows.delete(id);

      }

    }

    for (const soldier of soldiers) {

      let row = this.rosterRows.get(soldier.id);

      if (row === undefined) {

        row = document.createElement('button');

        row.className = 'roster-soldier';

        row.dataset.unitId = String(soldier.id);

        row.type = 'button';

        const name = document.createElement('span');

        name.className = 'roster-name';

        const detail = document.createElement('span');

        detail.className = 'roster-detail';

        row.append(name, detail);

        row.addEventListener('click', (event) => this.cb.onSoldierSelect(soldier.id, event.shiftKey));

        row.setAttribute('aria-haspopup', 'menu');

        row.addEventListener('contextmenu', (event) => {

          event.preventDefault();

          this.openSoldierMenu(soldier.id, event.clientX, event.clientY);

        });

        row.addEventListener('keydown', (event) => {

          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;

          event.preventDefault();

          const rect = row!.getBoundingClientRect();

          this.openSoldierMenu(soldier.id, rect.left, rect.bottom);

        });

        this.el.roster.append(row);

        this.rosterRows.set(soldier.id, row);

      }

      const rank = soldierRank(soldier.xp);

      const name = `${rank.badge} ${rank.short} ${nameOf(state, soldier.id)}`;

      const wounded = soldier.health < maxHealthOf(soldier);

      const status = [

        soldier.pinned ? 'Pinned' : '',

        soldier.medicalTargetId !== undefined ? 'Attending wounded' : '',

        soldier.supplyTargetId !== undefined ? state.units.find((unit) => unit.id === soldier.supplyTargetId)?.role === 'mortarman' ? 'Delivering mortar bombs' : state.units.find((unit) => unit.id === soldier.supplyTargetId)?.role === 'at' ? 'Delivering rockets' : 'Delivering grenades' : '',

        assignedSupplies.has(soldier.id) ? soldier.role === 'mortarman' ? 'Mortar supplies incoming' : soldier.role === 'at' ? 'Rocket supplies incoming' : 'Grenade supplies incoming'

          : waitingSupplies.includes(soldier.id) ? `Waiting for ${soldier.role === 'mortarman' ? 'mortar bombs' : soldier.role === 'at' ? 'rockets' : 'grenades'} · #${waitingSupplies.indexOf(soldier.id) + 1}` : '',

        usesBackupRifle(soldier, getContent()) ? `Using rifle · Out of ${soldier.role === 'at' ? 'rockets' : 'mortar bombs'}` : '',

        assignedPatients.has(soldier.id) ? 'Medic assigned'

          : waitingPatients.includes(soldier.id) ? `Waiting for medic · #${waitingPatients.indexOf(soldier.id) + 1}` : '',

        soldier.patrol ? soldier.role === 'medic' && !soldier.path.length && soldier.healTimer > 0 ? 'Patrol · tending wounded'

          : soldier.targetId !== null ? 'Patrol · engaging' : 'Patrolling' : '',

        soldier.terrainCrawling ? 'Crawling on slope' : '',

        soldier.bridgePosition?.level === 'under' ? 'Under bridge' : '',

        soldier.path.length > 0 && !soldier.pinned && !soldier.terrainCrawling && soldier.role !== 'gun_truck' && soldier.role !== 'vehicle'

          ? soldier.running ? 'Running' : soldier.crawling || soldier.stance === 'prone' ? 'Crawling' : 'Walking' : '',

        wounded ? 'Wounded' : '',

        soldier.morale <= CONFIG.morale.rattledThreshold ? 'Rattled' : soldier.morale <= CONFIG.morale.shakenThreshold ? 'Shaken' : '',

      ].filter(Boolean).join(' · ') || 'Ready';

      const detail = `${labelOf(soldier)} · HP ${Math.ceil(soldier.health)}/${maxHealthOf(soldier)} · ${status}`;

      // Keep buttons and their focus stable while health and morale change.

      if (row.children[0]!.textContent !== name) row.children[0]!.textContent = name;

      if (row.children[1]!.textContent !== detail) row.children[1]!.textContent = detail;

      row.title = `${rank.name} · XP ${soldier.xp} · ${soldier.kills} kills. Click to select, shift-click to add to the group. Right-click for options.`;

      row.setAttribute('aria-pressed', String(selectedIds.has(soldier.id)));

      row.classList.toggle('wounded', wounded);

      row.classList.toggle('pinned', soldier.pinned);

    }

    if (this.contextUnitId !== null) this.updateSoldierMenu();

  }



  private buildSoldierMenu(): void {

    this.contextMenu.id = 'soldier-options';

    this.contextMenu.className = 'soldier-options';

    this.contextMenu.hidden = true;

    this.contextMenu.setAttribute('role', 'menu');

    this.contextMenu.setAttribute('aria-labelledby', 'soldier-options-name');

    this.contextName.id = 'soldier-options-name';

    this.contextName.className = 'soldier-options-name';

    this.callMedicButton.type = 'button';

    this.callMedicButton.className = 'soldier-option';

    this.callMedicButton.setAttribute('role', 'menuitem');

    this.callMedicButton.setAttribute('aria-describedby', 'soldier-options-note');

    this.callMedicButton.textContent = '✚ Call medic';

    this.contextNote.id = 'soldier-options-note';

    this.contextNote.className = 'soldier-options-note';

    this.contextMenu.append(this.contextName, this.callMedicButton, this.contextNote);

    this.callSupplyButton.type = 'button';

    this.callSupplyButton.className = 'soldier-option supply-option';

    this.callSupplyButton.setAttribute('role', 'menuitem');

    this.callSupplyButton.setAttribute('aria-describedby', 'soldier-supply-note');

    this.callSupplyButton.textContent = '▣ Grenade supplies';

    this.supplyNote.id = 'soldier-supply-note';

    this.supplyNote.className = 'soldier-options-note';

    this.contextMenu.append(this.callSupplyButton, this.supplyNote);

    document.body.append(this.contextMenu);

    this.callMedicButton.addEventListener('click', () => {

      if (this.contextUnitId === null || this.callMedicButton.getAttribute('aria-disabled') === 'true') return;

      const unitId = this.contextUnitId;

      this.closeSoldierMenu(true);

      this.cb.onCallMedic(unitId);

    });

    this.callSupplyButton.addEventListener('click', () => {

      if (this.contextUnitId === null || this.callSupplyButton.getAttribute('aria-disabled') === 'true') return;

      const unitId = this.contextUnitId;

      this.closeSoldierMenu(true);

      this.cb.onCallSupplies(unitId);

    });

    this.contextMenu.addEventListener('contextmenu', (event) => event.preventDefault());

    document.addEventListener('pointerdown', (event) => {

      if (!this.contextMenu.contains(event.target as Node)) this.closeSoldierMenu();

    }, true);

    document.addEventListener('keydown', (event) => {

      if (this.contextMenu.hidden) return;

      if (event.key === 'Escape') {

        event.preventDefault(); event.stopImmediatePropagation();

        this.closeSoldierMenu(true);

      } else if (event.key === 'Tab') this.closeSoldierMenu();

      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {

        event.preventDefault(); event.stopImmediatePropagation();

        const items = [this.callMedicButton, this.callSupplyButton].filter((button) => !button.hidden);

        const current = items.indexOf(document.activeElement as HTMLButtonElement);

        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1

          : (current + (event.key === 'ArrowUp' ? items.length - 1 : 1)) % items.length;

        items[next]!.focus();

      }

    }, true);

    window.addEventListener('resize', () => this.closeSoldierMenu());

    document.addEventListener('scroll', () => this.closeSoldierMenu(), true);

    this.el.selDetails.addEventListener('contextmenu', (event) => {

      const id = Number(this.selectionKey);

      if (!this.selectionKey || !Number.isInteger(id)) return;

      event.preventDefault();

      this.openSoldierMenu(id, event.clientX, event.clientY);

    });

  }



  private openSoldierMenu(unitId: number, x: number, y: number): void {

    this.closeSoldierMenu();

    this.cb.onSoldierSelect(unitId, false);

    this.contextUnitId = unitId;

    this.contextAnchor = this.rosterRows.get(unitId) ?? null;

    this.contextAnchor?.setAttribute('aria-expanded', 'true');

    this.contextMenu.hidden = false;

    this.updateSoldierMenu();

    const rect = this.contextMenu.getBoundingClientRect();

    this.contextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;

    this.contextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

    this.callMedicButton.focus({ preventScroll: true });

  }



  private updateSoldierMenu(): void {

    const state = this.rosterState;

    const patient = state?.units.find((u) => u.id === this.contextUnitId && !u.dead && u.health > 0 && !u.crossed);

    if (!state || !patient || state.phase !== 'running') { this.closeSoldierMenu(); return; }

    this.contextName.textContent = nameOf(state, patient.id);

    const assigned = state.units.some((u) => !u.dead && !u.crossed && u.health > 0 && u.medicalTargetId === patient.id);

    const queued = state.medicalQueue?.includes(patient.id);

    const active = new Set(state.units.filter((u) => !u.dead && !u.crossed && u.health > 0).map((u) => u.medicalTargetId));

    const position = (state.medicalQueue ?? []).filter((id) => !active.has(id)).indexOf(patient.id) + 1;

    const hasMedic = state.units.some((u) => u.team === 'friendly' && u.role === 'medic' && u.id !== patient.id

      && !u.dead && !u.crossed && u.health > 0);

    const reason = patient.health >= maxHealthOf(patient) ? 'This soldier is at full health.'

      : assigned ? 'A medic is already attending this soldier.'

        : queued ? `Waiting for a medic · queue position ${position}.`

          : !hasMedic ? 'No medic available. Recruit a medic first.' : '';

    this.callMedicButton.setAttribute('aria-disabled', String(!!reason));

    this.contextNote.textContent = reason || 'Call for treatment. Medics attend requests in the order received.';

    const canRequestSupplies = patient.role === 'rifleman' || patient.role === 'assault_infantry' || patient.role === 'engineer' || patient.role === 'at' || patient.role === 'mortarman';

    this.callSupplyButton.hidden = !canRequestSupplies; this.supplyNote.hidden = !canRequestSupplies;

    if (canRequestSupplies) {

      const rockets = patient.role === 'at';

      const mortar = patient.role === 'mortarman';

      const ammunition = mortar ? 'mortar bombs' : rockets ? 'rockets' : 'grenades';

      const supplyLabel = mortar ? 'Mortar' : rockets ? 'Rocket' : 'Grenade';

      const capacity = mortar ? getContent().friendly.mortarman.mortarBombs ?? 0 : rockets ? getContent().friendly.at.rockets ?? 0 : getContent().friendly[patient.role as FriendlyRole].grenades ?? 0;

      const remaining = mortar ? patient.mortarBombs ?? capacity : rockets ? patient.rockets ?? capacity : patient.grenades;

      this.callSupplyButton.textContent = `▣ ${supplyLabel} supplies`;

      const supplyActive = new Set(state.units.filter((u) => !u.dead && !u.crossed && u.health > 0).map((u) => u.supplyTargetId));

      const supplyPosition = (state.grenadeSupplyQueue ?? []).filter((id) => !supplyActive.has(id)).indexOf(patient.id) + 1;

      const hasOfficer = state.units.some((u) => u.team === 'friendly' && u.role === 'supply_officer' && !u.dead && !u.crossed && u.health > 0);

      const supplyReason = remaining >= capacity ? `${mortar ? 'Mortar bombs' : rockets ? 'Rockets' : 'Grenades'} are full (${remaining}/${capacity}).`

        : supplyActive.has(patient.id) ? `A Supply Officer is bringing ${ammunition}.`

          : state.grenadeSupplyQueue?.includes(patient.id) ? `Waiting for ${supplyLabel.toLowerCase()} supplies · queue position ${supplyPosition}.`

            : !hasOfficer ? `Recruit a Supply Officer to request ${ammunition}.` : '';

      this.callSupplyButton.setAttribute('aria-disabled', String(!!supplyReason));

      this.supplyNote.textContent = supplyReason || `Call a Supply Officer to refill ${ammunition} (${remaining}/${capacity}). Requests are served in order.`;

    }

  }



  private closeSoldierMenu(restoreFocus = false): void {

    this.contextMenu.hidden = true;

    this.contextUnitId = null;

    this.contextAnchor?.setAttribute('aria-expanded', 'false');

    if (restoreFocus) this.contextAnchor?.focus({ preventScroll: true });

    this.contextAnchor = null;

  }



  private updateWeaponUpgradeButton(button: HTMLButtonElement, type: WeaponUpgradeType, state: SimState, selected: Unit | null, selectionSize: number): void {

    const labels: Record<WeaponUpgradeType, string> = { accuracy: 'Aim training', reload: 'Faster reload', damage: 'Improved ammunition' };

    const upgrade = CONFIG.weaponUpgrades;

    if (selectionSize > 1) {

      button.textContent = `${labels[type]} · one soldier`;

      button.title = 'Weapon upgrades are personal issue. Select a single soldier.';

      button.disabled = true;

      return;

    }

    if (selected === null || selected.team !== 'friendly' || selected.health <= 0) {

      button.textContent = `${labels[type]} · select soldier`;

      button.title = 'Select a living soldier to purchase a personal weapon upgrade.';

      button.disabled = true;

      return;

    }

    if (getContent().friendly[selected.role as FriendlyRole]?.weapon === null && !usesBackupRifle(selected, getContent())) {

      button.textContent = `${labels[type]} · no firearm`;

      button.title = 'This soldier has no personal firearm to upgrade.';

      button.disabled = true;

      return;

    }

    // A soldier already working on his weapon cannot start another job, because

    // the weapon he would be working on is the one in pieces on the ground sheet.

    const working = Math.ceil((selected.upgradeTimer ?? 0) / CONFIG.tickRate);

    if (working > 0) {

      button.textContent = `${labels[type]} · in pieces (${working}s)`;

      button.title = `This soldier is fitting an upgrade and cannot fire for ${working}s. One job at a time.`;

      button.disabled = true;

      return;

    }

    const level = selected.weaponUpgrades[type];

    const cost = upgrade.costs[type][level];

    const bonus = type === 'accuracy'

      ? `+${Math.round(upgrade.accuracyPerLevel * 100)}% aim`

      : type === 'reload'

        ? `-${Math.round(upgrade.reloadReductionPerLevel * 100)}% reload`

        : `+${Math.round(upgrade.damagePerLevel * 100)}% damage`;

    button.textContent = cost === undefined

      ? `${labels[type]} · MAX (${level}/${upgrade.maxLevel})`

      : `${labels[type]} · ${bonus} (${cost} pts) · ${level}/${upgrade.maxLevel}`;

    button.title = cost === undefined

      ? 'Maximum personal weapon upgrade level.'

      : `Improves ${labelOf(selected)} only. ${bonus} per level. Next level costs ${cost} points, and the weapon is out of action for ${Math.ceil(upgrade.upgradeSeconds)}s while it is fitted.`;

    button.disabled = cost === undefined || state.points < cost;

  }

}



function isMineMode(mode: UIMode, kind: 'ap' | 'at'): boolean {

  return mode.kind === 'mine' && mode.mineKind === kind;

}



function required<T extends HTMLElement>(id: string): T {

  const el = document.getElementById(id);

  if (el === null) throw new Error(`Missing HUD element #${id}`);

  return el as T;

}



function maxHealthOf(unit: Unit): number {

  const content = getContent();

  if (unit.team === 'friendly') {

    return content.friendly[unit.role as FriendlyRole]?.health ?? 100;

  }

  return content.enemy[unit.role as keyof typeof content.enemy]?.health ?? 100;

}



function labelOf(unit: Unit): string {

  const content = getContent();

  const def = unit.team === 'friendly'

    ? content.friendly[unit.role as FriendlyRole]

    : content.enemy[unit.role as keyof typeof content.enemy];

  return def?.label ?? unit.role;

}



/** What a mine type detonates under, described from its own trigger flags. */

function mineTargets(kind: 'ap' | 'at'): string {

  const def = CONFIG.mineKinds[kind];

  if (def.triggersOnVehicles && def.triggersOnInfantry) return 'anything that crosses it';

  return def.triggersOnVehicles ? 'vehicles only - infantry walk over it' : 'infantry only - tanks roll over it';

}

