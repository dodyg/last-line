import type { Preferences } from '../persistence';
import type { BestRecord } from '../persistence';
import { CONFIG } from '../content/config';
import { getContent } from '../content/validate';
import { soldierName, soldierRank } from '../simulation/soldiers';
import type { CampaignCountry, FriendlyRole, Unit } from '../simulation/types';
import { CAMPAIGNS, CAMPAIGN_COUNTRIES } from '../content/campaigns';

/**
 * Overlay menus: title, pause, results, help, settings, and the one-slot
 * replace confirmation. All interaction stays in the DOM layer.
 */

export interface MenusCallbacks {
  onNewGame(country: CampaignCountry): void;
  onContinue(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onEndless(): void;
  onCloseHelp(): void;
  onPrefsChanged(prefs: Preferences): void;
  onUnlockAudio(): void;
  onSectorSupply(choice: 'points' | 'medical', unitId?: number): void;
  onMapReviewOpen(): void;
  onMapReviewGenerate(country: CampaignCountry): string;
  onMapReviewClose(): void;
  hasResumableRun(): boolean;
}

export interface RunSummary {
  campaignCountry?: CampaignCountry;
  score: number;
  waves: number;
  kills: number;
  casualties: number;
  breakthroughs: number;
  seed: number;
  /** Maps the squad marched clear before the run ended. */
  mapsCleared: number;
  survivors: Unit[];
  integrity: number;
  bestScore: number;
  newBest: boolean;
}

interface Overlays {
  campaign: HTMLElement;
  title: HTMLElement;
  pause: HTMLElement;
  results: HTMLElement;
  help: HTMLElement;
  settings: HTMLElement;
  mapReview: HTMLElement;
  sectorSupply: HTMLElement;
}

export class Menus {
  private cb: MenusCallbacks;
  private el: Overlays;
  private pauseNote: HTMLElement;
  private btnContinue: HTMLButtonElement;
  private titleBest: HTMLElement;
  private saveStatus: HTMLElement;
  private resTitle: HTMLElement;
  private resSummary: HTMLElement;
  private btnEndless: HTMLButtonElement;
  private sectorMedicalNote: HTMLElement;
  private sectorMedicalOptions: HTMLElement;
  private replaceConfirm: HTMLElement | null = null;
  private mapReviewPreviousVisibility: Array<{ element: HTMLElement; hidden: boolean }> = [];
  private prefs: Preferences;
  private selectedCountry: CampaignCountry = 'france';

  constructor(cb: MenusCallbacks, prefs: Preferences) {
    this.cb = cb;
    this.prefs = prefs;
    this.el = {
      campaign: required('overlay-campaign'),
      title: required('overlay-title'),
      pause: required('overlay-pause'),
      results: required('overlay-results'),
      help: required('overlay-help'),
      settings: required('overlay-settings'),
      mapReview: required('overlay-map-review'),
      sectorSupply: required('overlay-sector-supply'),
    };
    this.pauseNote = document.createElement('p');
    this.pauseNote.className = 'subtle';
    const pausePanel = this.el.pause.querySelector('.panel');
    if (pausePanel !== null) {
      const h2 = pausePanel.querySelector('h2');
      h2?.after(this.pauseNote);
    }
    this.btnContinue = required('btn-continue');
    this.titleBest = required('title-best');
    this.saveStatus = required('save-status');
    this.resTitle = required('res-title');
    this.resSummary = required('res-summary');
    this.btnEndless = required('btn-endless');
    this.sectorMedicalNote = required('sector-medical-note');
    this.sectorMedicalOptions = required('sector-medical-options');

    this.bindSettings();

    required('btn-new').addEventListener('click', () => {
      this.cb.onUnlockAudio();
      this.showCampaignChoice();
    });
    this.btnContinue.addEventListener('click', () => {
      this.cb.onUnlockAudio();
      this.cb.onContinue();
    });
    required('btn-help-title').addEventListener('click', () => this.showHelp());
    required('btn-settings-title').addEventListener('click', () => this.showSettings());
    required('btn-resume').addEventListener('click', () => this.cb.onResume());
    required('btn-restart').addEventListener('click', () => this.cb.onRestart());
    required('btn-settings-pause').addEventListener('click', () => this.showSettings());
    required('btn-quit').addEventListener('click', () => this.cb.onQuit());
    required('btn-endless').addEventListener('click', () => this.cb.onEndless());
    required('btn-results-new').addEventListener('click', () => this.showCampaignChoice());
    required('btn-results-menu').addEventListener('click', () => this.cb.onQuit());
    required('btn-help-close').addEventListener('click', () => this.cb.onCloseHelp());
    required('btn-settings-close').addEventListener('click', () => this.closeSettings());
    required('btn-map-review').addEventListener('click', () => this.showMapReview());
    required('btn-map-review-generate').addEventListener('click', () => this.generateReviewMap());
    required('btn-map-review-close').addEventListener('click', () => this.closeMapReview());
    const sectorPointsButton = required('btn-sector-points');
    sectorPointsButton.textContent = `Take field supplies · +${CONFIG.crossing.sectorSupplyPoints} points`;
    sectorPointsButton.addEventListener('click', () => this.cb.onSectorSupply('points'));
    this.bindCampaignChoice();
  }

  private bindCampaignChoice(): void {
    const choices = required('campaign-choices');
    for (const country of CAMPAIGN_COUNTRIES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'campaign-choice';
      button.dataset.country = country;
      const name = document.createElement('strong');
      name.textContent = CAMPAIGNS[country].name;
      const detail = document.createElement('span');
      detail.textContent = CAMPAIGNS[country].description;
      button.append(name, detail);
      button.addEventListener('click', () => {
        this.selectedCountry = country;
        this.reflectCampaignChoice();
      });
      choices.append(button);
    }
    required('btn-campaign-start').addEventListener('click', () => {
      const country = this.selectedCountry;
      this.maybeConfirmReplace(() => this.cb.onNewGame(country));
    });
    required('btn-campaign-back').addEventListener('click', () => { this.el.campaign.hidden = true; });
    this.el.campaign.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.el.campaign.hidden = true;
        event.stopPropagation();
      } else if (event.key === 'Tab') {
        const buttons = [...this.el.campaign.querySelectorAll<HTMLButtonElement>('button')];
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    this.reflectCampaignChoice();
  }

  private reflectCampaignChoice(): void {
    for (const button of required('campaign-choices').querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.country === this.selectedCountry));
    }
    required('btn-campaign-start').textContent = `Start ${CAMPAIGNS[this.selectedCountry].name} campaign`;
  }

  private showCampaignChoice(): void {
    this.reflectCampaignChoice();
    // Place above whichever menu opened the chooser; replacement confirmation follows it.
    this.el.campaign.parentElement?.append(this.el.campaign);
    this.el.campaign.hidden = false;
    this.el.campaign.querySelector<HTMLButtonElement>(`[data-country="${this.selectedCountry}"]`)?.focus({ preventScroll: true });
  }

  isOnPause(): boolean {
    return !this.el.pause.hidden;
  }

  hideAll(): void {
    for (const el of Object.values(this.el)) el.hidden = true;
    this.closeReplaceConfirm();
  }

  showTitle(resume: { available: boolean; message: string | null }, best: BestRecord, saveMessage: string | null): void {
    this.hideAll();
    this.el.title.hidden = false;
    this.btnContinue.disabled = !resume.available;
    this.titleBest.textContent = best.bestScore > 0
      ? `Personal best: ${best.bestScore} - victories: ${best.victories}`
      : 'No battles fought yet.';
    const message = saveMessage ?? resume.message ?? null;
    this.saveStatus.textContent = message ?? '';
    this.saveStatus.hidden = message === null;
  }

  showPause(auto: boolean): void {
    this.el.pause.hidden = false;
    this.pauseNote.textContent = auto
      ? 'Paused automatically: the tab lost focus or was hidden. Press Resume to continue.'
      : 'The battle is frozen. You may inspect the field; orders are rejected until you resume.';
  }

  showResults(victory: boolean, summary: RunSummary, showEndless: boolean): void {
    this.hideAll();
    this.el.results.hidden = false;
    const auth = getContent().waves.length;
    this.resTitle.textContent = victory ? 'The line held!' : 'The line is broken';
    const rows: Array<[string, string]> = [
      ...(summary.campaignCountry === undefined ? [] : [['Campaign', CAMPAIGNS[summary.campaignCountry].name] as [string, string]]),
      // The wave counter restarts on every map, so the campaign figure is maps
      // marched clear; the wave figure describes the map the run ended on.
      ['Maps cleared', `${summary.mapsCleared} / ${CONFIG.crossing.campaignMaps}`],
      ['Waves survived', victory ? `${auth} / ${auth}` : `${Math.max(0, summary.waves - 1)} / ${auth}`],
      ['Enemies destroyed', String(summary.kills)],
      ['Soldiers lost', String(summary.casualties)],
      ['Enemy breakthroughs', String(summary.breakthroughs)],
      ['Line integrity remaining', String(summary.integrity)],
      ['Final score', String(summary.score)],
      ['Personal best', String(summary.bestScore)],
    ];
    const table = document.createElement('table');
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = k;
      const td2 = document.createElement('td');
      td2.textContent = v;
      tr.append(td1, td2);
      table.append(tr);
    }
    this.resSummary.replaceChildren(table);
    const heading = document.createElement('h3');
    heading.textContent = `Survivors · ${summary.survivors.length}`;
    this.resSummary.append(heading);
    if (summary.survivors.length === 0) {
      const note = document.createElement('p');
      note.className = 'subtle';
      note.textContent = 'No soldiers survived the battle.';
      this.resSummary.append(note);
    } else {
      const report = document.createElement('table');
      report.className = 'survivor-report';
      const caption = document.createElement('caption');
      caption.textContent = 'Individual service record';
      const head = document.createElement('thead');
      const labels = document.createElement('tr');
      for (const label of ['Soldier', 'Role', 'HP', 'Contribution']) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = label;
        labels.append(cell);
      }
      head.append(labels);
      const body = document.createElement('tbody');
      const content = getContent();
      for (const soldier of summary.survivors) {
        const row = document.createElement('tr');
        const rank = soldierRank(soldier.xp);
        const role = soldier.role as FriendlyRole;
        const contribution = [`${soldier.kills} kill${soldier.kills === 1 ? '' : 's'}`];
        if (role === 'medic' || soldier.service.healthRestored > 0) {
          contribution.push(`${Math.round(soldier.service.healthRestored)} HP restored`);
        }
        if (role === 'engineer' || soldier.service.fortificationsBuilt > 0) {
          const built = soldier.service.fortificationsBuilt;
          contribution.push(`${built} fortification${built === 1 ? '' : 's'} built`);
        }
        if (soldier.service.grenadesThrown > 0) {
          const thrown = soldier.service.grenadesThrown;
          contribution.push(`${thrown} grenade${thrown === 1 ? '' : 's'} thrown`);
        }
        for (const value of [
          `${rank.badge} ${rank.short} ${soldierName(summary.seed, soldier.id)}`,
          content.friendly[role].label,
          `${Math.ceil(soldier.health)}/${content.friendly[role].health}`,
          contribution.join(' · '),
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        row.children[0]!.setAttribute('title', `${rank.name} · XP ${soldier.xp}`);
        body.append(row);
      }
      report.append(caption, head, body);
      this.resSummary.append(report);
    }
    if (summary.newBest) {
      const note = document.createElement('p');
      note.className = 'good';
      note.textContent = 'New personal best!';
      this.resSummary.append(note);
    }
    this.btnEndless.hidden = !showEndless;
  }

  showSectorSupply(squad: readonly Unit[], runSeed: number): void {
    this.hideAll();
    const content = getContent();
    const wounded = squad.filter((unit) =>
      unit.team === 'friendly' && !unit.dead && unit.health > 0
        && unit.health < content.friendly[unit.role as FriendlyRole].health,
    );
    this.sectorMedicalOptions.replaceChildren();
    if (wounded.length === 0) {
      this.sectorMedicalNote.textContent = 'No soldiers are wounded, so medical resupply is unavailable.';
    } else {
      this.sectorMedicalNote.textContent = `Restore up to ${CONFIG.crossing.sectorSupplyHeal} HP to one wounded soldier.`;
      for (const soldier of wounded) {
        const button = document.createElement('button');
        button.className = 'menu-button';
        button.textContent = `${soldierName(runSeed, soldier.id)} · ${Math.ceil(soldier.health)} HP`;
        button.addEventListener('click', () => this.cb.onSectorSupply('medical', soldier.id));
        this.sectorMedicalOptions.append(button);
      }
    }
    this.el.sectorSupply.hidden = false;
  }

  showHelp(): void {
    this.el.help.hidden = false;
  }

  closeHelp(): void {
    this.el.help.hidden = true;
  }

  showSettings(): void {
    this.el.settings.hidden = false;
  }

  closeSettings(): void {
    this.el.settings.hidden = true;
  }

  private showMapReview(): void {
    this.cb.onMapReviewOpen();
    this.mapReviewPreviousVisibility = Object.values(this.el)
      .filter((element) => element !== this.el.mapReview)
      .map((element) => ({ element, hidden: element.hidden }));
    for (const { element } of this.mapReviewPreviousVisibility) element.hidden = true;
    this.el.mapReview.parentElement?.append(this.el.mapReview);
    this.el.mapReview.hidden = false;
    this.generateReviewMap();
    required<HTMLSelectElement>('map-review-country').focus({ preventScroll: true });
  }

  private generateReviewMap(): void {
    const country = required<HTMLSelectElement>('map-review-country').value as CampaignCountry;
    required('map-review-info').textContent = this.cb.onMapReviewGenerate(country);
  }

  private closeMapReview(): void {
    if (this.el.mapReview.hidden) return;
    this.el.mapReview.hidden = true;
    for (const { element, hidden } of this.mapReviewPreviousVisibility) element.hidden = hidden;
    this.mapReviewPreviousVisibility = [];
    this.cb.onMapReviewClose();
  }

  get settingsOpen(): boolean {
    return !this.el.settings.hidden;
  }

  /** Close help/settings panels if open; returns whether anything was closed. */
  closePanels(): boolean {
    let closed = false;
    if (!this.el.mapReview.hidden) {
      this.closeMapReview();
      closed = true;
    }
    else if (!this.el.help.hidden) {
      this.el.help.hidden = true;
      closed = true;
    } else if (!this.el.settings.hidden) {
      this.el.settings.hidden = true;
      closed = true;
    }
    return closed;
  }

  /** New Game replaces the single autosave slot; explain when a run is live. */
  private maybeConfirmReplace(start: () => void): void {
    if (!this.cb.hasResumableRun()) {
      start();
      return;
    }
    this.closeReplaceConfirm();
    const dialog = document.createElement('div');
    dialog.className = 'overlay';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const h = document.createElement('h2');
    h.textContent = 'Replace saved run?';
    const p = document.createElement('p');
    p.className = 'subtle';
    p.textContent = 'There is one autosave slot and it still holds a resumable run. Starting a new game overwrites it.';
    const yes = document.createElement('button');
    yes.className = 'menu-button primary';
    yes.textContent = 'Start New Game';
    const no = document.createElement('button');
    no.className = 'menu-button';
    no.textContent = 'Keep Saved Run';
    yes.addEventListener('click', () => {
      this.closeReplaceConfirm();
      start();
    });
    no.addEventListener('click', () => this.closeReplaceConfirm());
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    actions.append(yes, no);
    panel.append(h, p, actions);
    dialog.append(panel);
    document.getElementById('overlay-root')?.append(dialog);
    this.replaceConfirm = dialog;
  }

  private closeReplaceConfirm(): void {
    this.replaceConfirm?.remove();
    this.replaceConfirm = null;
  }

  private bindSettings(): void {
    const volume = required('set-volume') as HTMLInputElement;
    const volumeValue = required('set-volume-value');
    const mute = required('set-mute') as HTMLInputElement;
    const shake = required('set-shake') as HTMLInputElement;
    const reducedNote = required('reduced-motion-note');
    const countrySelect = required<HTMLSelectElement>('map-review-country');
    for (const country of CAMPAIGN_COUNTRIES) {
      const option = document.createElement('option');
      option.value = country;
      option.textContent = CAMPAIGNS[country].name;
      countrySelect.append(option);
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      reducedNote.hidden = false;
      if (!window.localStorage.getItem('lastline/prefs/v1')) {
        this.prefs = { ...this.prefs, screenShake: false };
      }
    }

    const reflect = (): void => {
      volume.value = String(Math.round(this.prefs.volume * 100));
      volumeValue.textContent = `${Math.round(this.prefs.volume * 100)}%`;
      mute.checked = this.prefs.muted;
      shake.checked = this.prefs.screenShake;
    };
    reflect();

    const emit = (): void => {
      this.prefs = {
        volume: Number(volume.value) / 100,
        muted: mute.checked,
        screenShake: shake.checked,
      };
      reflect();
      this.cb.onPrefsChanged(this.prefs);
    };
    volume.addEventListener('input', emit);
    mute.addEventListener('change', emit);
    shake.addEventListener('change', emit);
  }
}

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Missing UI element #${id}`);
  return el as T;
}
