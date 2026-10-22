import './styles.css';
import { AudioSys } from './game/audio';
import { GameController } from './game/controller';
import { BattleRuntime } from './render/app/BattleRuntime';
import { Storage, loadPrefs, type Preferences } from './persistence';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';

const storage = new Storage();
const prefs: Preferences = loadPrefs(storage);
const audio = new AudioSys();
audio.setPrefs(prefs);

let controller!: GameController;
const menus = new Menus({
  onNewGame: (country) => controller.newRun(undefined, country),
  onContinue: () => controller.continueRun(),
  onResume: () => controller.resumeRun(),
  onRestart: () => controller.restartRun(),
  onQuit: () => controller.quitToTitle(),
  onEndless: () => controller.continueEndless(),
  onCloseHelp: () => menus.closeHelp(),
  onPrefsChanged: (p) => controller.applyPrefs(p),
  onUnlockAudio: () => controller.unlockAudio(),
  onSectorSupply: (choice, unitId) => controller.chooseSectorSupply(choice, unitId),
  onMapReviewOpen: () => controller.openMapReview(),
  onMapReviewGenerate: (country) => controller.generateMapReview(country),
  onMapReviewClose: () => controller.closeMapReview(),
  hasResumableRun: () => storage.get('lastline/save/v1') !== null,
}, prefs);

const hud = new Hud({
  onCallSupplies: (unitId) => controller.callSupplies(unitId),
  onCallMedic: (unitId) => controller.callMedic(unitId),
  onSoldierSelect: (unitId, additive) => controller.selectSoldier(unitId, additive),
  onRecruitSelect: (role) => controller.setMode({ kind: 'recruit', role }),
  onBarbedWire: () => controller.setMode({ kind: 'barbedWire' }),
  onSandbag: () => controller.setMode({ kind: 'sandbag' }),
  onTrench: () => controller.setMode({ kind: 'trench' }),
  onBunker: () => controller.setMode({ kind: 'bunker' }),
  onMortarPit: () => controller.setMode({ kind: 'mortarPit' }),
  onBridge: () => controller.setMode({ kind: 'bridge' }),
  onMine: (kind) => controller.setMode({ kind: 'mine', mineKind: kind }),
  onArtillery: () => controller.setMode({ kind: 'artillery' }),
  onAirSupport: () => controller.setMode({ kind: 'airSupport' }),
  onFlare: () => controller.setMode({ kind: 'flare' }),
  onFoodSupplies: () => controller.requestFoodSupplies(),
  onSmoke: () => controller.beginSmoke(),
  onSatchel: () => controller.beginSatchel(),
  onLightFire: () => controller.lightSelectedFire(),
  onAmbush: (arcDegrees) => controller.toggleAmbush(arcDegrees),
  onAmbushArcChange: (arcDegrees) => controller.updateAmbushArc(arcDegrees),
  onFireOrder: () => controller.cycleFireOrder(),
  onStance: () => controller.cycleStance(),
  onBuildingLevel: (level, facing) => controller.chooseBuildingLevel(level, facing),
  onLeaveBuilding: () => controller.leaveSelectedBuilding(),
  onCrawl: () => controller.toggleCrawl(),
  onRun: () => controller.toggleRun(),
  onPatrol: () => controller.togglePatrol(),
  onHeadlights: () => controller.toggleVehicleHeadlights(),
  onSpecialization: (specialization) => controller.chooseSpecialization(specialization),
  onWeaponUpgrade: (type) => controller.purchaseWeaponUpgrade(type),
  onCancelMode: () => controller.cancelMode(),
  onPauseToggle: () => controller.togglePause(),
  onHelp: () => menus.showHelp(),
  onSettings: () => menus.showSettings(),
  onMenu: () => controller.quitToTitle(),
});

controller = new GameController({ storage, prefs, audio, hud, menus });

let runtime: BattleRuntime | null = null;
const gameContainer = document.getElementById('game');
if (!gameContainer) throw new Error('Missing #game battlefield container.');
try {
  runtime = new BattleRuntime(controller, gameContainer);
  hud.setTerrainProjection((x, y) => runtime?.worldToClient({ x, y }) ?? null);
  controller.boot();
} catch (error) {
  const message = document.createElement('p');
  message.className = 'renderer-error';
  message.setAttribute('role', 'alert');
  message.textContent = `The 3D battlefield could not start. Enable WebGL 2 or update your graphics driver, then reload. ${error instanceof Error ? error.message : ''}`;
  gameContainer.replaceChildren(message);
}

if (new URLSearchParams(window.location.search).has('e2e')) {
  void import('./e2e-hook').then((m) => m.installE2EHooks(controller, () => runtime));
}
