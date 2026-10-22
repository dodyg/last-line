import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioSys } from '../src/game/audio';
import { DEFAULT_PREFS } from '../src/persistence';

function fixture() {
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; buffer: unknown }> = [];
  const node = () => ({ connect: vi.fn((destination) => destination), disconnect: vi.fn() });
  const context = {
    currentTime: 10, destination: {}, resume: vi.fn().mockResolvedValue(undefined),
    createGain: () => ({ ...node(), gain: { value: 1, setTargetAtTime: vi.fn() } }),
    createStereoPanner: () => ({ ...node(), pan: { value: 0 } }),
    decodeAudioData: vi.fn().mockResolvedValue({ duration: 0.688 }),
    createBufferSource: () => {
      const source = { ...node(), buffer: null, start: vi.fn(), stop: vi.fn(), addEventListener: vi.fn() };
      sources.push(source); return source;
    },
  };
  vi.stubGlobal('AudioContext', function () { return context; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
  const audio = new AudioSys();
  return { audio, context, sources };
}

afterEach(() => vi.unstubAllGlobals());

describe('Medic request shout', () => {
  it('uses the bundled grenade supplies call and shares the pause/mute lifecycle', async () => {
    const { audio, sources } = fixture(); audio.shoutGrenadeSupplies();
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('grenade-supplies-call.wav'));
    audio.cancelChatter(); expect(sources[0]!.stop).toHaveBeenCalled();
  });

  it('plays the bundled word immediately and schedules repeated shouts without overlap', async () => {
    const { audio, sources } = fixture();
    audio.shoutMedic(-0.5); audio.shoutMedic(0.5);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('medic-call.wav'));
    expect(sources[0]!.start).toHaveBeenCalledWith(10);
    expect(sources[1]!.start).toHaveBeenCalledWith(10.688);
    audio.cancelChatter(false);
    expect(sources[0]!.stop).not.toHaveBeenCalled();
    audio.cancelChatter();
    expect(sources[0]!.stop).toHaveBeenCalled(); expect(sources[1]!.stop).toHaveBeenCalled();
  });

  it('respects mute and cancels a pending voice load when paused', async () => {
    const { audio, sources } = fixture();
    audio.setPrefs({ ...DEFAULT_PREFS, muted: true }); audio.shoutMedic();
    expect(fetch).not.toHaveBeenCalled();
    audio.setPrefs({ ...DEFAULT_PREFS, muted: false }); audio.shoutMedic(); audio.cancelChatter();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sources).toHaveLength(0);
    audio.shoutMedic(); await vi.waitFor(() => expect(sources).toHaveLength(1));
    audio.setPrefs({ ...DEFAULT_PREFS, muted: true }); expect(sources[0]!.stop).toHaveBeenCalled();
  });
});
