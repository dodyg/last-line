import { describe, expect, it, vi } from 'vitest';
import { Soundscape } from '../src/game/soundscape';
import { DEFAULT_PREFS } from '../src/persistence';

function audioFixture() {
  const param = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const makeNode = () => {
    const result = { gain: param(), frequency: param(), pan: param(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    result.connect.mockImplementation(() => result); return result;
  };
  const nodes: ReturnType<typeof makeNode>[] = [];
  function node(): ReturnType<typeof makeNode> {
    const result = makeNode(); nodes.push(result); return result;
  }
  const gains: ReturnType<typeof node>[] = [];
  const ctx = { currentTime: 0, sampleRate: 100, createGain: () => { const result = node(); gains.push(result); return result; }, createBiquadFilter: node,
    createBufferSource: node, createOscillator: node, createStereoPanner: node,
    createBuffer: () => ({ getChannelData: () => new Float32Array(700) }) };
  const soundscape = new Soundscape(ctx as unknown as AudioContext, node() as unknown as GainNode);
  return { soundscape, ctx, gains, nodes };
}

describe('adaptive audio lifecycle', () => {
  it('mixes music and ambience independently, ducks for voices, and fades on pause', () => {
    const { soundscape, gains } = audioFixture();
    const context = { pressure: 0, night: false, sheltered: false };
    soundscape.update('clear', true, { ...DEFAULT_PREFS, ambientVolume: .4, musicVolume: .6 }, context);
    expect(gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(.4, 0, .35);
    expect(gains[1]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(.6 * .13, 0, 1);
    soundscape.update('rain', true, DEFAULT_PREFS, { ...context, ducked: true });
    expect(gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(DEFAULT_PREFS.ambientVolume * .32, 0, .35);
    soundscape.update('rain', false, DEFAULT_PREFS, context);
    expect(gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, .35);
    expect(gains[1]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 1);
  });

  it('does not schedule notes while paused or music is disabled, and disposes loop sources', () => {
    const { soundscape, ctx, nodes } = audioFixture(); const context = { pressure: .8, night: true, sheltered: false };
    soundscape.update('rain', false, DEFAULT_PREFS, context);
    const initial = nodes.length; ctx.currentTime = 10;
    soundscape.update('rain', false, DEFAULT_PREFS, context); expect(nodes.length).toBe(initial);
    soundscape.update('rain', true, { ...DEFAULT_PREFS, musicVolume: 0, ambientVolume: 0 }, context);
    ctx.currentTime = 20; soundscape.update('rain', true, { ...DEFAULT_PREFS, musicVolume: 0, ambientVolume: 0 }, context);
    expect(nodes.length).toBe(initial);
    soundscape.dispose(); expect(nodes.filter((node) => node.stop.mock.calls.length > 0)).toHaveLength(3);
  });
});
