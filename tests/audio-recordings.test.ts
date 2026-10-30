import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioSys } from '../src/game/audio';
import { DEFAULT_PREFS } from '../src/persistence';
import { LULL_BANTER } from '../src/content/lull-banter';

function fixture() {
  const node = () => ({ connect: vi.fn((destination) => destination), disconnect: vi.fn() });
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null; buffer: { label: string } | null; playbackRate: { value: number }; detune: { value: number } }> = [];
  const context = {
    currentTime: 0, destination: {},
    resume: vi.fn(async () => {}),
    createStereoPanner: () => ({ ...node(), pan: { value: 0 } }),
    createGain: () => ({ ...node(), gain: { value: 1, setTargetAtTime: vi.fn() } }),
    createBiquadFilter: () => ({ ...node(), type: '', frequency: { value: 0 } }),
    createDynamicsCompressor: () => ({ ...node(), threshold: { value: 0 }, ratio: { value: 0 } }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({ label: new TextDecoder().decode(data), duration: 1, numberOfChannels: 1, sampleRate: 24000, length: 24, getChannelData: () => new Float32Array(24) })),
    createBufferSource: () => {
      const source = { ...node(), playbackRate: { value: 1 }, detune: { value: 0 }, buffer: null as { label: string } | null, start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
      sources.push(source); return source;
    },
  };
  vi.stubGlobal('AudioContext', function () { return context; });
  vi.stubGlobal('Worker', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer })));
  const speak = vi.fn();
  vi.stubGlobal('speechSynthesis', { getVoices: () => [], addEventListener: vi.fn(), cancel: vi.fn(), speak });
  const audio = new AudioSys();
  const radio = audio as unknown as { radioSquelch: () => void; startRadioStatic: () => void; endRadioStatic: () => void };
  for (const name of ['radioSquelch', 'startRadioStatic', 'endRadioStatic'] as const) vi.spyOn(radio, name).mockImplementation(() => {});
  audio.unlock();
  return { audio, sources, speak, context };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('recorded soldier playback', () => {
  it('acknowledges selections with bundled audio and six consistent vocal profiles', async () => {
    const { audio, sources, speak } = fixture();
    for (let id = 0; id < 6; id++) {
      audio.acknowledgeSelection(id);
      await vi.waitFor(() => expect(sources).toHaveLength(id + 1));
      expect(sources[id]!.buffer?.label).toContain('unitselection');
      sources[id]!.onended!();
      await Promise.resolve();
    }
    expect(new Set(sources.map((source) => `${source.playbackRate.value}:${source.detune.value}`)).size).toBe(6);
    expect(speak).not.toHaveBeenCalled();
  });

  it('replaces the previous selection voice and suppresses pending loads after cancellation', async () => {
    const { audio, sources } = fixture();
    audio.acknowledgeSelection(0);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    audio.acknowledgeSelection(1);
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    audio.cancelChatter();
    await Promise.resolve(); await Promise.resolve();
    expect(sources).toHaveLength(1);
  });

  it('rotates recorded takes per soldier without repeating adjacent responses', async () => {
    const { audio, sources } = fixture();
    const buffer = { duration: 4 } as AudioBuffer;
    const loader = audio as unknown as { loadSelectionClips: () => Promise<Array<{ buffer: AudioBuffer; offset: number; duration: number; group: 'reply' }>> };
    vi.spyOn(loader, 'loadSelectionClips').mockResolvedValue([0, 1, 2].map((offset) => ({ buffer, offset, duration: 0.5, group: 'reply' })));
    for (const id of [0, 1, 0, 1, 0]) {
      const count = sources.length;
      audio.acknowledgeSelection(id);
      await vi.waitFor(() => expect(sources).toHaveLength(count + 1));
      sources[count]!.onended!();
    }
    expect([0, 2, 4].map((index) => sources[index]!.start.mock.calls[0]![1])).toEqual([0, 1, 2]);
  });

  it('respects voice mute and lets support exchanges finish uninterrupted', async () => {
    const { audio, sources } = fixture();
    audio.setPrefs({ ...DEFAULT_PREFS, voiceVolume: 0 });
    audio.acknowledgeSelection(0);
    await Promise.resolve(); expect(sources).toHaveLength(0);
    audio.setPrefs({ ...DEFAULT_PREFS });
    const done = vi.fn();
    audio.speakRadioExchange('Flare on mark. Over.', 'Roger.', 1, done);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    audio.acknowledgeSelection(2);
    expect(sources[0]!.stop).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('plays bundled speech without a worker, model request, or installed system voice', async () => {
    const { audio, sources, speak } = fixture();
    audio.speakChatter('Contact!', 'friendly', 'shout', 0, 'contact', undefined, 'field');
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(speak).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled();
    for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url)).not.toMatch(/huggingface|jsdelivr|\.onnx|\.wasm/);
    audio.setPrefs({ ...DEFAULT_PREFS, muted: true }); expect(sources[0]!.stop).toHaveBeenCalledOnce();
  });

  it('suppresses a pending load after cancellation', async () => {
    const { audio, sources } = fixture();
    audio.speakChatter('Contact!', 'friendly'); audio.cancelChatter();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sources).toHaveLength(0);
  });

  it('confirms support only after the prerecorded Control reply finishes', async () => {
    const { audio, sources, speak } = fixture(); const done = vi.fn();
    audio.speakRadioExchange('Battery, fire on my mark. Over.', 'Fire away.', 0, done);
    await vi.waitFor(() => expect(sources).toHaveLength(1)); sources[0]!.onended!();
    await vi.waitFor(() => expect(sources).toHaveLength(2)); expect(done).not.toHaveBeenCalled();
    sources[1]!.onended!(); await vi.waitFor(() => expect(done).toHaveBeenCalledExactlyOnceWith(true));
    audio.cancelChatter(); expect(done).toHaveBeenCalledOnce(); expect(speak).not.toHaveBeenCalled();
  });

  it('cancels a support exchange exactly once and never plays a late reply', async () => {
    const { audio, sources } = fixture(); const done = vi.fn();
    audio.speakRadioExchange('Flare on mark. Over.', 'Roger.', 1, done);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    audio.cancelChatter(); sources[0]!.onended!(); await Promise.resolve();
    expect(done).toHaveBeenCalledExactlyOnceWith(false); expect(sources).toHaveLength(1);
  });

  it('previews a file and reuses its decoded buffer on the next preview', async () => {
    const { audio, sources, context } = fixture();
    const preview = audio.previewAmericanVoice();
    await vi.waitFor(() => expect(sources).toHaveLength(1)); sources[0]!.onended!();
    expect(await preview).toContain('Played bundled American voice');
    const count = context.decodeAudioData.mock.calls.length;
    const next = audio.previewAmericanVoice();
    await vi.waitFor(() => expect(sources).toHaveLength(2)); sources[1]!.onended!(); await next;
    expect(context.decodeAudioData).toHaveBeenCalledTimes(count);
  });

  it('plays banter sequentially with a pause and a distinct reply voice', async () => {
    const { audio, sources, speak } = fixture();
    const exchange = LULL_BANTER[0]!;
    audio.speakChatter(exchange.line, 'friendly', 'tense', 0, 'ambient', undefined, 'field', { text: exchange.reply, speakerId: 2 });
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0]!.buffer?.label).toContain('michael-banter-01-line');
    vi.useFakeTimers(); sources[0]!.onended!();
    await vi.advanceTimersByTimeAsync(249); expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);
    expect(sources[1]!.buffer?.label).toContain('puck-banter-01-reply');
    expect(speak).not.toHaveBeenCalled();
    sources[1]!.onended!();
  });

  it('drops the pending banter reply when combat interrupts during the pause', async () => {
    const { audio, sources } = fixture(); const exchange = LULL_BANTER[0]!;
    audio.speakChatter(exchange.line, 'friendly', 'tense', 0, 'ambient', undefined, 'field', { text: exchange.reply, speakerId: 1 });
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    vi.useFakeTimers(); sources[0]!.onended!(); await vi.advanceTimersByTimeAsync(100);
    audio.cancelChatter(false); await vi.advanceTimersByTimeAsync(500);
    expect(sources).toHaveLength(1);
  });
});
