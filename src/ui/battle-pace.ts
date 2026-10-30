import { CONFIG } from '../content/config';
import { getContent } from '../content/validate';
import { buildSpawnQueue, earlyWaveReward } from '../simulation/waves';
import type { SimState } from '../simulation/types';

/** A compact readout for the next tactical decision, outside the playfield. */
export class BattlePaceHud {
  private readonly root = document.createElement('div');
  private readonly title = document.createElement('strong');
  private readonly detail = document.createElement('span');
  private readonly streak = document.createElement('span');
  private readonly call = document.createElement('button');
  private readonly speed = document.createElement('button');
  private previewKey = '';
  private previewLabel = '';
  private previewComposition = '';

  constructor(parent: HTMLElement, onCall: () => void, onSpeed: () => void) {
    this.root.id = 'battle-pace';
    this.root.className = 'battle-pace';
    this.detail.id = 'wave-intel';
    this.detail.className = 'wave-intel';
    this.streak.id = 'clean-streak';
    this.streak.className = 'clean-streak';
    this.streak.title = 'Call a wave early and hold it without casualties or breakthroughs: +1 supply point, +2 on the next early clean wave, then +3 per wave. A loss or waiting out preparation resets the streak.';
    this.call.id = 'btn-call-wave';
    this.call.className = 'hud-button call-wave';
    this.call.type = 'button';
    this.call.addEventListener('click', onCall);
    this.speed.id = 'btn-battle-speed';
    this.speed.className = 'hud-button battle-speed';
    this.speed.type = 'button';
    this.speed.title = 'Toggle normal / double battle speed. Movement, combat, and preparation all advance together. Pause still stops the battle.';
    this.speed.addEventListener('click', onSpeed);
    this.setSpeed(1);
    this.root.append(this.title, this.detail, this.streak, this.call, this.speed);
    parent.append(this.root);
  }

  setSpeed(speed: number): void {
    this.speed.textContent = `${speed}× speed`;
    this.speed.setAttribute('aria-pressed', String(speed === 2));
  }

  update(state: SimState, paused: boolean): void {
    const sched = state.scheduler;
    const prep = sched.phase === 'prep';
    this.root.hidden = state.phase !== 'running';
    if (this.root.hidden) return;
    this.speed.disabled = paused;
    const marching = sched.phase === 'advance' || sched.phase === 'crossing';
    this.streak.hidden = marching;
    if (marching) {
      this.title.textContent = sched.phase === 'crossing' ? 'Moving out' : state.sectorCaptured ? 'Sector secured' : 'Secure the objective';
      this.detail.textContent = state.sectorCaptured || sched.phase === 'crossing' ? 'Move the squad through the north exit.' : 'Hold the marked position to secure this sector.';
      this.detail.title = '';
      this.call.hidden = true;
      this.root.classList.remove('preparing');
      return;
    }
    const key = `${state.baseTerrainSeed}:${state.mapNumber}:${sched.waveIndex}:${state.endless}:${sched.endlessWavesCleared}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      // Scouting must never advance the simulation's random stream.
      const preview = buildSpawnQueue({ ...state.rng }, sched, state.endless);
      const counts = new Map<string, number>();
      for (const role of preview.queue) {
        const label = getContent().enemy[role].label;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      this.previewLabel = preview.label;
      this.previewComposition = [...counts].map(([label, count]) => `${count} ${label}`).join(' · ');
      this.detail.title = [this.previewComposition, preview.telegraph].filter(Boolean).join(' — ');
    }
    this.title.textContent = prep ? `Next: ${this.previewLabel}` : this.previewLabel;
    const living = state.units.filter((u) => u.team === 'enemy' && !u.dead && u.health > 0).length;
    this.detail.textContent = prep ? this.previewComposition : `${living} on field · ${sched.spawnQueue.length} inbound`;
    const broken = !prep && (sched.startCasualties !== state.battleRecord.casualties || sched.startBreakthroughs !== state.battleRecord.breakthroughs);
    const streak = sched.cleanStreak ?? 0;
    this.streak.textContent = broken ? 'Regroup · next wave, new chance'
      : !prep && !sched.calledEarly ? 'Call next wave early to earn a streak'
      : `${prep ? 'Early + clean' : 'Clean defense'} ${streak ? `×${streak} · ` : ''}+${Math.min(3, streak + 1)} pts`;
    this.streak.classList.toggle('broken', broken);
    this.call.hidden = !prep;
    this.call.disabled = paused || sched.prepTicksLeft <= 0;
    const reward = earlyWaveReward(sched.prepTicksLeft);
    this.call.textContent = `Call wave now · +${reward} pts`;
    this.call.title = 'Skip the remaining preparation time and gain supply points: 1 per 10 seconds skipped, up to 3. Enemies attack immediately.';
    this.root.style.setProperty('--prep-progress', `${Math.min(100, sched.prepTicksLeft / (CONFIG.tickRate * CONFIG.start.breakSeconds) * 100)}%`);
    this.root.classList.toggle('preparing', prep);
  }
}
