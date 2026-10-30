import { Soundscape, type AtmosphereContext } from './soundscape';
import { DEFAULT_PREFS, type Preferences } from '../persistence';
import type { WeatherKind } from '../simulation/types';
import type { RadioCue } from './radio';
import { SOLDIER_VOICE_CLIPS, selectSoldierClip, soldierVoice, clearLegacyVoiceCache, type SoldierVoiceClip } from './soldier-voices';

type VoiceDelivery = 'shout' | 'tense' | 'panic';

const alliedRadioRecordings = [
  new URL('../assets/ww2/voices/battlecries.ogg', import.meta.url).href,
  new URL('../assets/ww2/voices/wounded.ogg', import.meta.url).href,
  new URL('../assets/ww2/voices/aknowledgement.ogg', import.meta.url).href,
  new URL('../assets/ww2/voices/unitselection.ogg', import.meta.url).href,
  new URL('../assets/ww2/voices/soldierintro.ogg', import.meta.url).href,
];
const medicCallRecording = new URL('../assets/ww2/voices/medic-call.wav', import.meta.url).href;
const grenadeSupplyRecording = new URL('../assets/ww2/voices/grenade-supplies-call.wav', import.meta.url).href;
const selectionRecording = alliedRadioRecordings[3]!;
// Stable timbre and cadence per soldier, with a fresh recorded take on each click.
const selectionVoices = [
  { rate: 0.94, cents: -180 }, { rate: 1.02, cents: -70 },
  { rate: 0.98, cents: 30 }, { rate: 1.06, cents: 120 },
  { rate: 0.91, cents: -100 }, { rate: 1.03, cents: 70 },
] as const;
const axisRadioRecordings = Object.values(import.meta.glob('../assets/ww2/voices/wyrmsun_german-voice_*.wav', {
  eager: true,
  query: '?url',
  import: 'default',
})) as string[];

interface RecordedClip { buffer: AudioBuffer; offset: number; duration: number; group: 'battle' | 'wounded' | 'reply' | 'ambient' | 'axis'; }

/**
 * WebAudio-generated combat effects plus locally bundled, openly licensed radio voices.
 * Shot sounds are rate-capped; voice clips load after the first user gesture.
 */

export type SoundName = 'rifle' | 'mg' | 'smg' | 'rocket' | 'flame' | 'explosion' | 'mortar' | 'artillery' | 'airSupport' | 'airBomb' | 'heal' | 'ui' | 'horn' | 'breakthrough' | 'defeat' | 'victory';

export class AudioSys {
  private selectionClips: Promise<RecordedClip[]> | null = null;
  private readonly selectionTakes = new Map<number, number>();
  private lastSelection: { id: number; at: number } | null = null;
  private voiceVariation = 0;
  private activeChatterGeneration: number | null = null;
  private currentVoiceSource: AudioBufferSourceNode | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private prefs: Preferences = { ...DEFAULT_PREFS };
  private effectsBus: GainNode | null = null;
  private voiceBus: GainNode | null = null;
  private soundscape: Soundscape | null = null;
  private voiceDuckUntil = 0;
  private shotWindow: number[] = [];
  private unlocked = false;
  private lastVoiceURI = '';
  private readonly soldierVoiceURIs = new Map<number, string>();
  private readonly lastRecordedVoiceBySoldier = new Map<number, number>();
  private chatterGeneration = 0;
  private stopRadioBed: (() => void) | null = null;
  private pendingRadioExchangeCancel: (() => void) | null = null;
  private availableVoices: SpeechSynthesisVoice[] = [];
  private recordedChatter: { allied: RecordedClip[]; axis: RecordedClip[] } = { allied: [], axis: [] };
  private radioChatterLoading = false;
  private currentRecordedSource: AudioBufferSourceNode | null = null;
  private fieldCallBuffers = new Map<string, Promise<AudioBuffer | null>>();
  private medicCallGeneration = 0;
  private medicCallNextStart = 0;
  private medicCallSources = new Set<AudioBufferSourceNode>();

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.availableVoices = window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        this.availableVoices = window.speechSynthesis.getVoices();
      });
    }
  }

  setPrefs(prefs: Preferences): void {
    this.prefs = prefs;
    if (prefs.muted || prefs.volume <= 0 || prefs.voiceVolume <= 0) this.cancelChatter();
    if (this.master !== null && this.ctx !== null) {
      this.master.gain.setTargetAtTime(this.effectiveVolume(), this.ctx.currentTime, 0.02);
      this.effectsBus?.gain.setTargetAtTime(prefs.effectsVolume, this.ctx.currentTime, .02);
      this.voiceBus?.gain.setTargetAtTime(prefs.voiceVolume, this.ctx.currentTime, .02);
    }
  }

  async previewAmericanVoice(): Promise<string> {
    this.unlock();
    if (this.prefs.muted || this.effectiveVolume() <= 0 || this.prefs.voiceVolume <= 0) return 'Audio is muted. Enable voice audio to preview.';
    if (!this.ctx || !this.voiceBus) return 'Audio playback is unavailable in this browser.';
    this.cancelChatter(false);
    const generation = this.chatterGeneration;
    this.activeChatterGeneration = generation;
    try {
      const clip = selectSoldierClip('American radio check. Ready for orders.', 'clear', -4, 0, true);
      if (!clip) return 'The bundled voice preview is missing.';
      const played = await this.playSoldierLine(clip, -4, 'field', generation);
      if (generation !== this.chatterGeneration) return 'Voice preview canceled.';
      return played ? `Played bundled American voice · ${soldierVoice(-4)}` : 'The voice clip could not load or play.';
    } finally {
      if (this.activeChatterGeneration === generation) this.activeChatterGeneration = null;
    }
  }

  setAtmosphere(weather: WeatherKind, active: boolean, context: AtmosphereContext = { pressure: 0, night: false, sheltered: false }): void {
    if (!this.ctx || !this.master) return;
    if (active && !this.soundscape) this.soundscape = new Soundscape(this.ctx, this.master);
    this.soundscape?.update(weather, active && !this.prefs.muted, this.prefs, { ...context, ducked: this.ctx.currentTime < this.voiceDuckUntil });
  }

  /** A direct acknowledgment; never interrupt a support request awaiting Control. */
  acknowledgeSelection(speakerId: number, pan = 0): void {
    if (this.prefs.muted || this.effectiveVolume() <= 0 || this.prefs.voiceVolume <= 0 || this.pendingRadioExchangeCancel) return;
    const now = performance.now();
    if (this.lastSelection?.id === speakerId && now - this.lastSelection.at < 180) return;
    this.unlock();
    const ctx = this.ctx, bus = this.voiceBus;
    if (!ctx || !bus) return;
    this.lastSelection = { id: speakerId, at: now };
    void ctx.resume().catch(() => {});
    this.cancelChatter(false);
    const generation = this.chatterGeneration;
    this.activeChatterGeneration = generation;
    void this.loadSelectionClips().then((clips) => {
      if (generation !== this.chatterGeneration || this.prefs.muted || this.effectiveVolume() <= 0 || this.prefs.voiceVolume <= 0) return;
      const take = this.selectionTakes.get(speakerId) ?? Math.abs(speakerId * 7);
      const clip = clips[take % clips.length];
      if (!clip) return;
      this.selectionTakes.set(speakerId, take + 1);
      const voice = selectionVoices[Math.abs(speakerId) % selectionVoices.length]!;
      const source = ctx.createBufferSource(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
      source.buffer = clip.buffer;
      source.playbackRate.value = voice.rate;
      source.detune.value = voice.cents;
      gain.gain.value = 0.85;
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      source.connect(gain).connect(panner).connect(bus);
      this.currentVoiceSource = source;
      this.voiceDuckUntil = ctx.currentTime + clip.duration / (voice.rate * 2 ** (voice.cents / 1200)) + 0.15;
      source.onended = () => {
        source.disconnect(); gain.disconnect(); panner.disconnect();
        if (this.currentVoiceSource === source) this.currentVoiceSource = null;
        if (generation === this.chatterGeneration) {
          this.activeChatterGeneration = null;
          this.voiceDuckUntil = 0;
        }
      };
      source.start(0, clip.offset, clip.duration);
    }).catch(() => { /* A failed acknowledgment never blocks selection. */ }).finally(() => {
      if (generation === this.chatterGeneration && !this.currentVoiceSource) this.activeChatterGeneration = null;
    });
  }

  private loadSelectionClips(): Promise<RecordedClip[]> {
    return this.selectionClips ??= this.loadFieldCall(selectionRecording).then((buffer) => {
      if (buffer) return splitRadioRecording(buffer, 'reply');
      this.selectionClips = null;
      return [];
    });
  }

  speakChatter(text: string, team: 'friendly' | 'enemy', delivery: 'shout' | 'tense' | 'panic' = 'shout', speakerId = 0, cue: RadioCue = 'contact', confirmation?: string, channel: 'field' | 'radio' = 'radio', reply?: { text: string; speakerId: number }): void {
    if (this.prefs.muted || this.effectiveVolume() <= 0 || this.prefs.voiceVolume <= 0) return;
    // Let short recorded lines finish; support exchanges can still interrupt.
    if (this.activeChatterGeneration !== null || this.pendingRadioExchangeCancel !== null) return;
    if (team !== 'friendly') {
      this.speakSystemChatter(text, team, delivery, speakerId, cue, confirmation, channel, reply);
      return;
    }
    if (!this.ctx || !this.voiceBus) return;
    const clip = selectSoldierClip(text, cue, speakerId, this.voiceVariation++);
    if (!clip) return;
    this.cancelChatter(false);
    const generation = this.chatterGeneration;
    this.activeChatterGeneration = generation;
    void (async () => {
      try {
        let answer: SoldierVoiceClip | null = null;
        if (reply) {
          // Distinguish speakers even when their default voice assignments match.
          const assignedVoice = soldierVoice(reply.speakerId);
          const replyVoice = assignedVoice === clip.voice
            ? (clip.voice === 'michael' ? 'puck' : 'michael') : assignedVoice;
          answer = selectSoldierClip(reply.text, cue, reply.speakerId, 0, true, replyVoice);
          if (answer) void this.loadFieldCall(answer.url);
        }
        const played = await this.playSoldierLine(clip, speakerId, channel, generation);
        if (!played || generation !== this.chatterGeneration) return;
        if (reply) {
          if (!answer) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          if (generation !== this.chatterGeneration) return;
          await this.playSoldierLine(answer, reply.speakerId, 'field', generation);
        } else if (confirmation !== undefined) await this.speakRadioConfirmation(confirmation, generation);
      } finally {
        if (this.activeChatterGeneration === generation) this.activeChatterGeneration = null;
      }
    })();
  }

  /** German speech uses the system engine; friendly dialogue uses bundled clips. */
  private speakSystemChatter(text: string, team: 'friendly' | 'enemy', delivery: VoiceDelivery, speakerId: number, cue: RadioCue, confirmation?: string, channel: 'field' | 'radio' = 'radio', reply?: { text: string; speakerId: number }): void {
    this.cancelChatter(false);
    if (channel === 'radio') this.radioSquelch(team);
    if (this.ctx) this.voiceDuckUntil = this.ctx.currentTime + Math.min(12, 1 + text.length / 12);
    const generation = this.chatterGeneration;
    const utteranceSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    const clip = channel === 'radio' ? this.chooseRecordedClip(team, cue, speakerId) : null;
    if (clip !== null) this.playRecordedClip(clip, team, generation);
    if (!utteranceSupported) return;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = this.chooseRadioVoice(team, speakerId);
      // Never fall back to the browser's default voice: its gender is not specified.
      if (voice !== null) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      const panic = delivery === 'panic';
      const shouting = delivery !== 'tense';
      utterance.rate = (panic ? 1.12 : shouting ? 1.045 : 0.96) + (Math.random() - 0.5) * (panic ? 0.12 : 0.08);
      utterance.pitch = (team === 'friendly' ? 0.98 : 0.92) + (Math.random() - 0.5) * (panic ? 0.24 : 0.14);
      utterance.volume = Math.min(1, this.effectiveVolume() * this.prefs.voiceVolume * (panic ? 1 : shouting ? 0.94 : 0.78));
      utterance.onstart = () => { if (generation === this.chatterGeneration && channel === 'radio') this.startRadioStatic(team); };
      utterance.onend = () => {
        if (generation !== this.chatterGeneration) return;
        if (this.ctx) this.voiceDuckUntil = this.ctx.currentTime;
        if (reply) { this.speakChatter(reply.text, team, 'tense', reply.speakerId, cue, undefined, 'field'); return; }
        if (confirmation !== undefined) this.speakRadioConfirmation(confirmation, generation);
        else this.endRadioStatic();
      };
      utterance.onerror = () => { if (generation === this.chatterGeneration) this.endRadioStatic(); };
      const startSpeech = () => {
        if (generation !== this.chatterGeneration || this.prefs.muted || voice === null) {
          if (generation === this.chatterGeneration) this.endRadioStatic();
          return;
        }
        window.speechSynthesis.speak(utterance);
      };
      if (clip !== null && this.currentRecordedSource !== null) {
        this.startRadioStatic(team);
        this.currentRecordedSource.addEventListener('ended', startSpeech, { once: true });
      } else {
        startSpeech();
      }
    } catch {
      // Captions and radio squelch still work if the system has no speech voice.
      this.endRadioStatic();
    }
  }

  /** Speak the request and wait for Control's spoken acknowledgment to finish. */
  speakRadioExchange(request: string, response: string, speakerId: number, onComplete: (confirmed: boolean) => void): void {
    const call = selectSoldierClip(request, 'supplies', speakerId, 0, true);
    const answer = selectSoldierClip(response, 'supplies', -3, 0, true);
    if (!call || !answer || !this.ctx || !this.voiceBus) {
      onComplete(false);
      return;
    }
    if (this.prefs.muted || this.effectiveVolume() <= 0 || this.prefs.voiceVolume <= 0) { onComplete(false); return; }
    this.cancelChatter(false);
    const generation = this.chatterGeneration;
    let completed = false;
    const finish = (confirmed: boolean): void => {
      if (completed) return;
      completed = true;
      this.pendingRadioExchangeCancel = null;
      this.endRadioStatic();
      onComplete(confirmed);
    };
    this.pendingRadioExchangeCancel = () => finish(false);
    void (async () => {
      const played = await this.playSoldierLine(call, speakerId, 'radio', generation);
      if (generation !== this.chatterGeneration || completed) return;
      if (!played) {
        finish(false);
        return;
      }
      const answered = await this.playSoldierLine(answer, -3, 'radio', generation);
      if (generation !== this.chatterGeneration || completed) return;
      finish(answered);
    })();
  }

  /** Radio Control answers over the set after the field operator finishes speaking. */
  private async speakRadioConfirmation(text: string, generation: number): Promise<void> {
    const clip = selectSoldierClip(text, 'supplies', -3, 0, true);
    if (clip && this.ctx && this.voiceBus) {
      this.activeChatterGeneration = generation;
      try {
        await this.playSoldierLine(clip, -3, 'radio', generation);
      } finally {
        if (this.activeChatterGeneration === generation) this.activeChatterGeneration = null;
      }
      return;
    }
  }

  cancelChatter(includeMedicCalls = true): void {
    this.voiceDuckUntil = 0;
    if (includeMedicCalls) {
      this.medicCallGeneration++;
      for (const source of this.medicCallSources) {
        try { source.stop(); } catch { /* Already finished. */ }
      }
      this.medicCallSources.clear();
      this.medicCallNextStart = 0;
    }
    const cancelRadioExchange = this.pendingRadioExchangeCancel;
    this.pendingRadioExchangeCancel = null;
    cancelRadioExchange?.();
    this.chatterGeneration++;
    this.activeChatterGeneration = null;
    try { this.currentVoiceSource?.stop(); } catch { /* Already stopped. */ }
    this.currentVoiceSource = null;
    try { this.currentRecordedSource?.stop(); } catch { /* Already stopped. */ }
    this.currentRecordedSource = null;
    this.endRadioStatic();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch { /* Speech is optional. */ }
    }
  }

  /** Bundled PCM plays through the existing voice bus and radio effects. */
  private async playSoldierLine(clip: SoldierVoiceClip, speakerId: number, channel: 'field' | 'radio', generation: number): Promise<boolean> {
    const buffer = await this.loadFieldCall(clip.url);
    if (!buffer || generation !== this.chatterGeneration || this.prefs.muted || this.prefs.voiceVolume <= 0) return false;
    const ctx = this.ctx, bus = this.voiceBus;
    if (!ctx || !bus) return false;
    try {
      const source = ctx.createBufferSource(); source.buffer = buffer;
      const gain = ctx.createGain(); gain.gain.value = speakerId === -3 ? 0.72 : 0.95;
      const nodes: AudioNode[] = [source, gain];
      if (channel === 'radio') {
        const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 300;
        const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 3400;
        const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -24; compressor.ratio.value = 4;
        source.connect(high).connect(low).connect(compressor).connect(gain);
        nodes.push(high, low, compressor);
        this.radioSquelch('friendly');
        this.startRadioStatic('friendly', speakerId === -3);
      } else source.connect(gain);
      gain.connect(bus);
      this.currentVoiceSource = source;
      this.voiceDuckUntil = ctx.currentTime + buffer.duration + 0.15;
      return await new Promise<boolean>((resolve) => {
        source.onended = () => {
          for (const node of nodes) node.disconnect();
          if (this.currentVoiceSource === source) this.currentVoiceSource = null;
          if (generation === this.chatterGeneration) {
            this.voiceDuckUntil = 0;
            this.endRadioStatic();
            if (channel === 'radio') this.radioSquelch('friendly');
          }
          resolve(generation === this.chatterGeneration);
        };
        source.start();
      });
    } catch { this.endRadioStatic(); this.voiceDuckUntil = 0; return false; }
  }

  private chooseRadioVoice(team: 'friendly' | 'enemy', speakerId: number): SpeechSynthesisVoice | null {
    const language = team === 'friendly' ? 'en-us' : 'de';
    const languageVoices = this.availableVoices.filter((voice) =>
      voice.lang.toLowerCase().replaceAll('_', '-').startsWith(language),
    );
    // Browser speech APIs rarely expose voice gender consistently. Prefer a
    // recognizable male voice, but don't disable German speech when the
    // installed German voice has no gender metadata or known name.
    const maleVoices = languageVoices.filter(isMaleVoice);
    // Keep player soldiers and Control American, even when other English
    // locales offer more natural voices or a previously assigned voice.
    const voices = maleVoices.length > 0 || team === 'friendly' ? maleVoices : languageVoices;
    if (voices.length === 0) return null;
    const assignedUri = this.soldierVoiceURIs.get(speakerId);
    const assigned = assignedUri === undefined ? undefined : voices.find((voice) => voice.voiceURI === assignedUri);
    if (assigned !== undefined) return assigned;
    const preferredLocale = team === 'friendly' ? 'en-us' : 'de-de';
    const teamVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(preferredLocale));
    const localized = teamVoices.length > 0 ? [...teamVoices, ...voices.filter((voice) => !teamVoices.includes(voice))] : voices;
    const natural = localized.filter((voice) => /natural|neural|premium|enhanced/i.test(voice.name));
    const candidates = natural.length > 0 ? natural : localized;
    const fresh = candidates.filter((voice) => voice.voiceURI !== this.lastVoiceURI);
    const pool = fresh.length > 0 ? fresh : candidates;
    const voice = pool[Math.floor(Math.random() * pool.length)];
    if (voice !== undefined) {
      this.lastVoiceURI = voice.voiceURI;
      this.soldierVoiceURIs.set(speakerId, voice.voiceURI);
    }
    return voice ?? null;
  }

  private chooseRecordedClip(team: 'friendly' | 'enemy', cue: RadioCue, speakerId: number): RecordedClip | null {
    const group = cue === 'wounded' || cue === 'medic' ? 'wounded'
      : cue === 'ambient' ? 'ambient'
        : ['contact', 'wave', 'kill', 'breakthrough', 'artillery'].includes(cue) ? 'battle' : 'reply';
    const allClips = team === 'friendly' ? this.recordedChatter.allied : this.recordedChatter.axis;
    const clips = allClips.filter((clip) => team === 'enemy' || clip.group === group);
    if (clips.length === 0 || Math.random() > 0.48) return null;
    const speakerOffset = Math.abs(speakerId * 17) % clips.length;
    const previousIndex = this.lastRecordedVoiceBySoldier.get(speakerId);
    const cueOffset = cue === 'wounded' ? 2 : cue === 'ambient' ? 4 : cue === 'medic' || cue === 'clear' ? 6 : 0;
    let index = (speakerOffset + cueOffset + Math.floor(Math.random() * Math.min(5, clips.length))) % clips.length;
    if (previousIndex === index && clips.length > 1) index = (index + 1) % clips.length;
    this.lastRecordedVoiceBySoldier.set(speakerId, index);
    return clips[index] ?? null;
  }

  private playRecordedClip(clip: RecordedClip, team: 'friendly' | 'enemy', generation: number): void {
    const ctx = this.ctx;
    const master = this.voiceBus;
    if (ctx === null || master === null || generation !== this.chatterGeneration) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = clip.buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = team === 'friendly' ? 1450 : 1220;
      filter.Q.value = 0.85;
      const gain = ctx.createGain();
      gain.gain.value = 0.42;
      const panner = ctx.createStereoPanner();
      panner.pan.value = team === 'friendly' ? -0.18 : 0.18;
      source.connect(filter).connect(gain).connect(panner).connect(master);
      source.addEventListener('ended', () => {
        if (this.currentRecordedSource === source) this.currentRecordedSource = null;
      }, { once: true });
      this.currentRecordedSource = source;
      source.start(ctx.currentTime, clip.offset, clip.duration);
    } catch {
      this.currentRecordedSource = null;
    }
  }

  private loadRadioVoices(): void {
    if (this.radioChatterLoading || this.recordedChatter.allied.length > 0 || this.recordedChatter.axis.length > 0) return;
    this.radioChatterLoading = true;
    const allyUrls = alliedRadioRecordings;
    const allyGroups: RecordedClip['group'][] = ['battle', 'wounded', 'reply', 'ambient', 'reply'];
    void Promise.all([
      Promise.all(allyUrls.map((url) => this.decodeRadioFile(url))).then((buffers) => buffers.flatMap((buffer, index) => splitRadioRecording(buffer, allyGroups[index] ?? 'reply'))),
      Promise.all(axisRadioRecordings.map((url) => this.decodeRadioFile(url))).then((buffers) => buffers.flatMap((buffer) => splitRadioRecording(buffer, 'axis'))),
    ]).then(([allied, axis]) => {
      this.recordedChatter = { allied, axis };
    }).catch(() => {
      // Human recordings are an enhancement; captions and speech remain usable offline.
    }).finally(() => { this.radioChatterLoading = false; });
  }

  private async decodeRadioFile(url: string): Promise<AudioBuffer> {
    const response = await fetch(url);
    if (!response.ok || this.ctx === null) throw new Error('Radio voice unavailable.');
    return this.ctx.decodeAudioData(await response.arrayBuffer());
  }

  private loadMedicCall(): Promise<AudioBuffer | null> {
    return this.loadFieldCall(medicCallRecording);
  }

  private loadFieldCall(url: string): Promise<AudioBuffer | null> {
    const cached = this.fieldCallBuffers.get(url);
    if (cached) return cached;
    const pending = this.decodeRadioFile(url).catch(() => {
      this.fieldCallBuffers.delete(url);
      return null;
    });
    this.fieldCallBuffers.set(url, pending);
    return pending;
  }

  /** A direct battlefield shout, independent of radio chatter and installed voices. */
  shoutMedic(pan = 0): void {
    this.shoutFieldCall(medicCallRecording, pan);
  }

  shoutGrenadeSupplies(pan = 0): void {
    this.shoutFieldCall(grenadeSupplyRecording, pan);
  }

  private shoutFieldCall(url: string, pan: number): void {
    if (this.prefs.muted || this.effectiveVolume() <= 0) return;
    this.unlock();
    const ctx = this.ctx, master = this.voiceBus, generation = this.medicCallGeneration;
    if (!ctx || !master) return;
    void ctx.resume().catch(() => { /* Audio may be blocked by the browser. */ });
    void this.loadFieldCall(url).then((buffer) => {
      if (!buffer || generation !== this.medicCallGeneration || this.effectiveVolume() <= 0) return;
      try {
        const source = ctx.createBufferSource(), panner = ctx.createStereoPanner();
        source.buffer = buffer;
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        source.connect(panner).connect(master);
        const start = Math.max(ctx.currentTime, this.medicCallNextStart);
        this.medicCallNextStart = start + buffer.duration;
        this.medicCallSources.add(source);
        source.addEventListener('ended', () => {
          this.medicCallSources.delete(source); source.disconnect(); panner.disconnect();
        }, { once: true });
        source.start(start);
      } catch { /* A failed voice clip never blocks a support request. */ }
    });
  }

  private startRadioStatic(team: 'friendly' | 'enemy', remoteChannel = false): void {
    const ctx = this.ctx;
    const master = this.voiceBus;
    if (ctx === null || master === null || this.prefs.muted || this.effectiveVolume() <= 0) return;
    this.endRadioStatic();
    try {
      const frameCount = Math.floor(ctx.sampleRate * 0.3);
      const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frameCount; i++) data[i] = (Math.random() * 2 - 1) * (remoteChannel ? 0.58 : 0.45);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = remoteChannel ? 1320 : team === 'friendly' ? 1500 : 1250;
      filter.Q.value = remoteChannel ? 1.25 : 0.8;
      const level = ctx.createGain();
      const now = ctx.currentTime;
      level.gain.setValueAtTime(0.0001, now);
      level.gain.exponentialRampToValueAtTime(remoteChannel ? 0.027 : 0.012, now + 0.05);
      const flutter = ctx.createOscillator();
      flutter.type = 'sine';
      flutter.frequency.value = 7.2 + Math.random() * 2.2;
      const flutterAmount = ctx.createGain();
      flutterAmount.gain.value = remoteChannel ? 0.006 : 0.002;
      const panner = ctx.createStereoPanner();
      panner.pan.value = team === 'friendly' ? -0.2 : 0.2;

      flutter.connect(flutterAmount).connect(level.gain);
      source.connect(filter).connect(level).connect(panner).connect(master);
      source.start(now);
      flutter.start(now);
      this.stopRadioBed = () => {
        const stopAt = ctx.currentTime + 0.2;
        level.gain.cancelScheduledValues(ctx.currentTime);
        level.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.035);
        try { source.stop(stopAt); flutter.stop(stopAt); } catch { /* Already stopped. */ }
        this.stopRadioBed = null;
      };
    } catch {
      this.stopRadioBed = null;
    }
  }

  private endRadioStatic(): void {
    this.stopRadioBed?.();
  }

  private radioSquelch(team: 'friendly' | 'enemy'): void {
    const ctx = this.ctx;
    if (ctx === null || this.master === null || this.prefs.muted || this.effectiveVolume() <= 0) return;
    const pan = team === 'friendly' ? -0.22 : 0.22;
    this.noise(0.075, 0.055, 2200, pan, false, 0, this.voiceBus);
    this.tone(team === 'friendly' ? 1040 : 760, 0.045, 0.025, 0, this.voiceBus);
  }

  private effectiveVolume(): number {
    return this.prefs.muted ? 0 : Math.max(0, Math.min(1, this.prefs.volume));
  }

  /** Must be called from a user gesture; safe to call repeatedly. */
  unlock(): void {
    if (this.unlocked) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.effectiveVolume();
      this.master.connect(this.ctx.destination);
      this.effectsBus = this.ctx.createGain(); this.effectsBus.gain.value = this.prefs.effectsVolume; this.effectsBus.connect(this.master);
      this.voiceBus = this.ctx.createGain(); this.voiceBus.gain.value = this.prefs.voiceVolume; this.voiceBus.connect(this.master);
      this.unlocked = true;
      void this.loadSelectionClips();
      void clearLegacyVoiceCache();
      // Small audio files decode once after the first user gesture, with no model.
      for (const clip of SOLDIER_VOICE_CLIPS) if (clip.kind !== 'banter') void this.loadFieldCall(clip.url);
      void this.loadMedicCall();
      void this.loadFieldCall(grenadeSupplyRecording);
      this.loadRadioVoices();
    } catch {
      // Audio unavailable: play silent.
      this.ctx = null;
      this.master = null;
    }
  }

  /** Cap: at most 5 shot sounds per 120 ms window; excess is dropped. */
  private shotAllowed(): boolean {
    const now = performance.now();
    this.shotWindow = this.shotWindow.filter((t) => now - t < 120);
    if (this.shotWindow.length >= 5) return false;
    this.shotWindow.push(now);
    return true;
  }

  play(name: SoundName, pan = 0): void {
    const ctx = this.ctx;
    const master = this.effectsBus;
    if (ctx === null || master === null || this.prefs.muted || this.effectiveVolume() <= 0) return;
    try {
      switch (name) {
        case 'rifle':
        case 'smg':
        case 'mg':
          if (!this.shotAllowed()) return;
          this.firearmReport(name, pan);
          break;
        case 'flame':
          if (!this.shotAllowed()) return;
          this.noise(.45, .2, 650, pan, true);
          break;
        case 'rocket':
          this.noise(0.22, 0.16, 400, pan, true);
          break;
        case 'explosion':
          this.noise(0.5, 0.5, 120, pan, true);
          this.thump(60, 0.35);
          break;
        case 'artillery':
          this.noise(0.8, 0.7, 90, pan, true);
          this.thump(45, 0.6);
          break;
        case 'mortar':
          // A compact, hollow launch report with a little tube resonance.
          this.noise(0.14, 0.22, 1100, pan, true);
          this.thump(125, 0.25);
          this.noise(0.18, 0.08, 750, pan, true, 0.05);
          break;
        case 'airSupport':
          this.aircraftFlyby(pan);
          break;
        case 'airBomb':
          // The aircraft's bombs hit sharply; artillery retains the longer rumble.
          this.noise(0.38, 0.3, 260, pan, true);
          this.thump(72, 0.44);
          break;
        case 'heal':
          this.tone(660, 0.09, 0.08);
          this.tone(880, 0.12, 0.08, 0.07);
          break;
        case 'ui':
          this.tone(440, 0.04, 0.05);
          break;
        case 'horn':
          this.tone(220, 0.25, 0.12);
          this.tone(277, 0.25, 0.12, 0.02);
          break;
        case 'breakthrough':
          this.tone(160, 0.3, 0.16);
          this.noise(0.25, 0.2, 200, 0, true);
          break;
        case 'defeat':
          this.tone(196, 0.5, 0.2);
          this.tone(147, 0.7, 0.2, 0.25);
          break;
        case 'victory':
          this.tone(392, 0.18, 0.14);
          this.tone(523, 0.18, 0.14, 0.15);
          this.tone(659, 0.4, 0.16, 0.3);
          break;
      }
    } catch {
      // Never let audio errors break gameplay.
    }
  }

  private noise(duration: number, gain: number, filterFreq: number, pan: number, lowpass = false, delay = 0, bus = this.effectsBus): void {
    const ctx = this.ctx;
    const master = bus;
    if (ctx === null || master === null) return;
    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < frames; i++) {
      const white = Math.random() * 2 - 1;
      last = lowpass ? last * 0.82 + white * 0.18 : white;
      data[i] = last * (1 - i / frames);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = lowpass ? 'lowpass' : 'highpass';
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(filter).connect(g).connect(panner).connect(master);
    src.start(ctx.currentTime + delay);
  }

  /** Layered, slightly varied field report: muzzle crack, body and a soft reflection. */
  private firearmReport(weapon: 'rifle' | 'smg' | 'mg', pan: number): void {
    const variation = 0.88 + Math.random() * 0.24;
    const p = Math.max(-1, Math.min(1, pan + (Math.random() - 0.5) * 0.12));
    const crackGain = (weapon === 'rifle' ? 0.24 : weapon === 'smg' ? 0.18 : 0.2) * variation;
    const bodyGain = (weapon === 'rifle' ? 0.2 : weapon === 'smg' ? 0.14 : 0.17) * variation;

    // The fast broadband transient supplies the sharp muzzle crack.
    this.noise(0.024 + Math.random() * 0.009, crackGain, 3600 + Math.random() * 1500, p);
    // A darker, longer blast gives the crack some mass without sounding like an explosion.
    this.noise(weapon === 'rifle' ? 0.105 : 0.078, bodyGain, 700 + Math.random() * 220, p, true);
    this.gunBody(weapon === 'rifle' ? 118 : weapon === 'smg' ? 145 : 105, bodyGain * 0.46, p);
    // A quiet, delayed reflection adds a little outdoor space to the dry report.
    this.noise(0.11, crackGain * 0.16, 850 + Math.random() * 250, -p * 0.65, true, 0.045 + Math.random() * 0.025);
  }

  private gunBody(freq: number, gain: number, pan: number): void {
    const ctx = this.ctx;
    const master = this.effectsBus;
    if (ctx === null || master === null) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.58, t0 + 0.085);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(gain, t0);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(envelope).connect(panner).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.1);
  }

  private tone(freq: number, duration: number, gain: number, delay = 0, bus = this.effectsBus): void {
    const ctx = this.ctx;
    const master = bus;
    if (ctx === null || master === null) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  private thump(freq: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.effectsBus;
    if (ctx === null || master === null) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.4), ctx.currentTime + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    osc.connect(g).connect(master);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  }

  /** A layered propeller-engine pass with a softer rush and clear flyby motion. */
  private aircraftFlyby(pan: number): void {
    const ctx = this.ctx;
    const master = this.effectsBus;
    if (ctx === null || master === null) return;
    const start = ctx.currentTime;
    const pass = start + 1.05;
    const end = start + 2.85;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.Q.value = 0.55;
    engineFilter.frequency.setValueAtTime(340, start);
    engineFilter.frequency.linearRampToValueAtTime(980, pass);
    engineFilter.frequency.exponentialRampToValueAtTime(280, end);
    const engineEnvelope = ctx.createGain();
    engineEnvelope.gain.setValueAtTime(0.0001, start);
    engineEnvelope.gain.linearRampToValueAtTime(0.13, start + 0.28);
    engineEnvelope.gain.linearRampToValueAtTime(0.17, pass);
    engineEnvelope.gain.setValueAtTime(0.14, start + 1.32);
    engineEnvelope.gain.exponentialRampToValueAtTime(0.0001, end);
    const panner = ctx.createStereoPanner();
    const center = Math.max(-1, Math.min(1, pan));
    panner.pan.setValueAtTime(Math.max(-1, center - 0.38), start);
    panner.pan.linearRampToValueAtTime(Math.min(1, center + 0.38), end);

    const engine = ctx.createOscillator();
    engine.type = 'triangle';
    engine.frequency.setValueAtTime(72, start);
    engine.frequency.linearRampToValueAtTime(94, pass);
    engine.frequency.exponentialRampToValueAtTime(64, end);
    const engineHarmonic = ctx.createOscillator();
    engineHarmonic.type = 'sine';
    engineHarmonic.frequency.setValueAtTime(146, start);
    engineHarmonic.frequency.linearRampToValueAtTime(190, pass);
    engineHarmonic.frequency.exponentialRampToValueAtTime(128, end);
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.42;

    const propeller = ctx.createOscillator();
    propeller.type = 'triangle';
    propeller.frequency.setValueAtTime(39, start);
    propeller.frequency.linearRampToValueAtTime(51, pass);
    propeller.frequency.exponentialRampToValueAtTime(34, end);
    const propellerGain = ctx.createGain();
    propellerGain.gain.value = 0.3;
    const bladePulse = ctx.createOscillator();
    bladePulse.type = 'sine';
    bladePulse.frequency.setValueAtTime(17, start);
    bladePulse.frequency.linearRampToValueAtTime(24, pass);
    bladePulse.frequency.linearRampToValueAtTime(19, end);
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.065;
    bladePulse.connect(pulseDepth).connect(propellerGain.gain);

    // Filtered broadband air gives the engine a passing rush without the sharp,
    // static-like edge of the old sawtooth layer.
    const frames = Math.max(1, Math.floor(ctx.sampleRate * (end - start)));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) samples[i] = Math.random() * 2 - 1;
    const air = ctx.createBufferSource();
    air.buffer = buffer;
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.Q.value = 0.42;
    airFilter.frequency.setValueAtTime(420, start);
    airFilter.frequency.linearRampToValueAtTime(760, pass);
    airFilter.frequency.exponentialRampToValueAtTime(290, end);
    const airEnvelope = ctx.createGain();
    airEnvelope.gain.setValueAtTime(0.0001, start);
    airEnvelope.gain.linearRampToValueAtTime(0.035, pass);
    airEnvelope.gain.setValueAtTime(0.028, start + 1.35);
    airEnvelope.gain.exponentialRampToValueAtTime(0.0001, end);

    engine.connect(engineFilter);
    engineHarmonic.connect(harmonicGain).connect(engineFilter);
    propeller.connect(propellerGain).connect(engineFilter);
    engineFilter.connect(engineEnvelope).connect(panner).connect(master);
    air.connect(airFilter).connect(airEnvelope).connect(panner);
    engine.start(start);
    engineHarmonic.start(start);
    propeller.start(start);
    bladePulse.start(start);
    air.start(start);
    engine.stop(end + 0.05);
    engineHarmonic.stop(end + 0.05);
    propeller.stop(end + 0.05);
    bladePulse.stop(end + 0.05);
    air.stop(end + 0.05);
  }
}

/** Split long voice takes at natural pauses so events use a single brief callout. */
function splitRadioRecording(buffer: AudioBuffer, group: RecordedClip['group']): RecordedClip[] {
  const channelCount = buffer.numberOfChannels;
  const windowFrames = Math.max(1, Math.floor(buffer.sampleRate * 0.025));
  const threshold = 0.012;
  const active: boolean[] = [];
  for (let start = 0; start < buffer.length; start += windowFrames) {
    const end = Math.min(buffer.length, start + windowFrames);
    let sum = 0;
    let count = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = start; i < end; i += 4) {
        sum += data[i]! * data[i]!;
        count++;
      }
    }
    active.push(count > 0 && Math.sqrt(sum / count) > threshold);
  }

  const silenceWindows = Math.ceil(0.24 * buffer.sampleRate / windowFrames);
  const segments: Array<{ first: number; last: number }> = [];
  let segmentStart: number | null = null;
  let lastActive = -1;
  for (let i = 0; i < active.length; i++) {
    if (active[i]) {
      if (segmentStart === null) segmentStart = i;
      lastActive = i;
      continue;
    }
    if (segmentStart !== null && i - lastActive >= silenceWindows) {
      const duration = (lastActive - segmentStart + 1) * windowFrames / buffer.sampleRate;
      if (duration >= 0.32 && duration <= 4.6) segments.push({ first: segmentStart, last: lastActive });
      segmentStart = null;
    }
  }
  if (segmentStart !== null) {
    const duration = (lastActive - segmentStart + 1) * windowFrames / buffer.sampleRate;
    if (duration >= 0.32 && duration <= 4.6) segments.push({ first: segmentStart, last: lastActive });
  }
  if (segments.length === 0) return [{ buffer, offset: 0, duration: Math.min(buffer.duration, 4.6), group }];
  return segments.map(({ first, last }) => {
    const startFrame = Math.max(0, first * windowFrames - Math.floor(buffer.sampleRate * 0.04));
    const endFrame = Math.min(buffer.length, (last + 1) * windowFrames + Math.floor(buffer.sampleRate * 0.07));
    return { buffer, offset: startFrame / buffer.sampleRate, duration: (endFrame - startFrame) / buffer.sampleRate, group };
  });
}

/** SpeechSynthesis has no standard gender field, so use explicit metadata or a conservative male-name allowlist. */
function isMaleVoice(voice: SpeechSynthesisVoice): boolean {
  const gender = (voice as SpeechSynthesisVoice & { gender?: string }).gender?.toLowerCase();
  if (gender !== undefined) return gender === 'male';
  return isRecognizablyMaleVoice(voice.name);
}

function isRecognizablyMaleVoice(name: string): boolean {
  const normalized = name.toLowerCase();
  if (/\b(female|woman|zira|samantha|aria|jenny|ava|emma|susan|hazel|sonia|libby|natasha|karen|moira|tessa|victoria|siri female)\b/.test(normalized)) return false;
  if (/\b(male|man)\b/.test(normalized)) return true;
  return /\b(alex|albert|arthur|bruce|brian|daniel|david|derek|fred|george|gordon|guy|henry|james|john|lee|mark|matthew|oliver|paul|peter|ralph|richard|rishi|ryan|thomas|tom|william|edward|jack|rufus|aaron|jason|kevin|michael|patrick|steffan|christopher|andrew|eric|roger|tony|brandon|davis|eddy|reed|rocko|stephen|alexander|benjamin)\b/.test(normalized);
}
