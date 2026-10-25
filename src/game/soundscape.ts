import { CONFIG } from '../content/config';
import type { Preferences } from '../persistence';
import type { SimState, WeatherKind } from '../simulation/types';

export interface AtmosphereContext { pressure: number; night: boolean; sheltered: boolean; ducked?: boolean; secured?: boolean }

export function battlePressure(state: SimState): number {
  const allies = state.units.filter((u) => u.team === 'friendly' && !u.dead && !u.crossed && u.health > 0);
  const threats = state.units.filter((u) => u.team === 'enemy' && !u.dead && u.health > 0);
  const pinned = allies.filter((u) => u.pinned).length / Math.max(1, allies.length);
  const close = threats.filter((u) => allies.some((a) => Math.hypot(a.pos.x - u.pos.x, a.pos.y - u.pos.y) < 220)).length;
  return Math.min(1, close / 14 + pinned * .55 + Math.min(.2, state.strikes.length * .05));
}

/** Procedural, asset-free atmosphere. All scheduling uses the audio clock, never timers. */
export class Soundscape {
  private ambience: GainNode;
  private music: GainNode;
  private wind: GainNode;
  private rain: GainNode;
  private windFilter: BiquadFilterNode;
  private rainFilter: BiquadFilterNode;
  private nextDetail = 0;
  private nextNote = 0;
  private noteIndex = 0;
  private active = false;
  private lastWeather: WeatherKind | null = null;
  private lastMix = '';
  private sources: AudioScheduledSourceNode[] = [];
  private noiseBuffer: AudioBuffer;

  constructor(private ctx: AudioContext, master: GainNode) {
    this.ambience = ctx.createGain(); this.ambience.gain.value = 0; this.ambience.connect(master);
    this.music = ctx.createGain(); this.music.gain.value = 0; this.music.connect(master);
    this.wind = ctx.createGain(); this.rain = ctx.createGain();
    this.wind.gain.value = .075; this.rain.gain.value = 0;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'lowpass'; this.windFilter.frequency.value = 500;
    this.rainFilter = ctx.createBiquadFilter(); this.rainFilter.type = 'highpass'; this.rainFilter.frequency.value = 1400;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 7, ctx.sampleRate);
    this.noiseBuffer = buffer;
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    for (const [filter, gain, offset] of [[this.windFilter, this.wind, 0], [this.rainFilter, this.rain, 2.3]] as const) {
      const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
      source.connect(filter).connect(gain).connect(this.ambience); source.start(0, offset); this.sources.push(source);
    }
    const gust = ctx.createOscillator(), depth = ctx.createGain();
    gust.frequency.value = .075; depth.gain.value = .012;
    gust.connect(depth).connect(this.wind.gain); gust.start(); this.sources.push(gust);
  }

  update(weather: WeatherKind, active: boolean, prefs: Preferences, context: AtmosphereContext): void {
    const now = this.ctx.currentTime;
    const rain = CONFIG.weather[weather].rainIntensity;
    const pressure = Math.round(context.pressure * 10) / 10;
    const mix = `${active}:${prefs.ambientVolume}:${prefs.musicVolume}:${pressure}:${context.night}:${context.sheltered}:${context.ducked}:${context.secured}`;
    if (mix !== this.lastMix || weather !== this.lastWeather) {
      this.lastMix = mix; this.lastWeather = weather;
      const duck = context.ducked ? .32 : 1;
      this.ambience.gain.setTargetAtTime(active ? prefs.ambientVolume * duck : 0, now, .35);
      this.music.gain.setTargetAtTime(active ? prefs.musicVolume * duck * (context.secured ? .22 : .13 + pressure * .13) : 0, now, 1);
      this.wind.gain.setTargetAtTime(context.sheltered ? .025 : .075 + (weather.toLowerCase().includes('snow') ? .05 : 0), now, 1);
      this.rain.gain.setTargetAtTime(rain * (context.sheltered ? .12 : .22), now, .8);
      this.rainFilter.frequency.setTargetAtTime(context.sheltered ? 500 : 1400, now, .8);
      this.windFilter.frequency.setTargetAtTime(context.night ? 380 : 600, now, 1);
    }
    if (!active) { this.active = false; return; }
    if (!this.active) { this.nextNote = now + .15; this.nextDetail = now + 2; this.active = true; }
    if (prefs.musicVolume > 0 && now >= this.nextNote) {
      const scale = context.secured ? [146.83, 174.61, 220, 293.66] : pressure > .5 ? [73.42, 77.78, 110, 146.83] : [73.42, 110, 130.81, 146.83, 164.81, 110];
      const note = scale[this.noteIndex++ % scale.length]!;
      this.tone(note, context.secured ? 3 : pressure > .5 ? 1.4 : 4.5, .2, this.music, -.12);
      if (pressure > .5) this.tone(note * .5, .65, .15, this.music, .12);
      this.nextNote = now + (context.secured ? 2.4 : pressure > .5 ? 1.4 : 3.8);
    }
    if (prefs.ambientVolume > 0 && now >= this.nextDetail) {
      this.nextDetail = now + 5 + Math.random() * 8;
      const pan = Math.random() * 1.6 - .8;
      if (context.sheltered && rain > 0) {
        this.tone(950 + Math.random() * 500, .08, .06, this.ambience, pan);
        this.tone(700, .13, .025, this.ambience, pan, .18);
      } else if (pressure < .25 && !context.night && rain < .3 && !weather.toLowerCase().includes('snow')) {
        this.tone(2100, .13, .025, this.ambience, pan, 0, 3200);
        this.tone(2650, .09, .018, this.ambience, pan, .18, 1900);
      } else {
        const source = this.ctx.createBufferSource(), filter = this.ctx.createBiquadFilter(), gain = this.ctx.createGain(), panner = this.ctx.createStereoPanner();
        source.buffer = this.noiseBuffer; filter.type = 'lowpass'; filter.frequency.value = 110;
        gain.gain.setValueAtTime(.3, now); gain.gain.exponentialRampToValueAtTime(.0001, now + 3);
        panner.pan.value = pan; source.connect(filter).connect(gain).connect(panner).connect(this.ambience);
        source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); panner.disconnect(); };
        source.start(now, Math.random() * 3, 3);
      }
    }
  }

  private tone(frequency: number, duration: number, volume: number, bus: GainNode, pan: number, delay = 0, endFrequency = frequency): void {
    const start = this.ctx.currentTime + delay, end = start + duration;
    const oscillator = this.ctx.createOscillator(), gain = this.ctx.createGain(), panner = this.ctx.createStereoPanner();
    oscillator.type = bus === this.music ? 'triangle' : 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, end);
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(volume, start + Math.min(.3, duration * .15)); gain.gain.exponentialRampToValueAtTime(.0001, end);
    panner.pan.value = pan; oscillator.connect(gain).connect(panner).connect(bus);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); panner.disconnect(); };
    oscillator.start(start); oscillator.stop(end);
  }

  dispose(): void {
    for (const source of this.sources) { try { source.stop(); } catch { /* Already stopped. */ } source.disconnect(); }
    this.sources = []; this.ambience.disconnect(); this.music.disconnect();
  }
}
