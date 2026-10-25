import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioSys } from '../src/game/audio';

function fixture(voices: Array<{ name: string; lang: string }>) {
  const speak = vi.fn();
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => voices.map((voice) => ({ ...voice, voiceURI: voice.name })),
    addEventListener: vi.fn(), cancel: vi.fn(), speak,
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    constructor(public text: string) {}
  });
  return { audio: new AudioSys(), speak };
}

afterEach(() => vi.unstubAllGlobals());

describe('Radio voice accents', () => {
  it('keeps player chatter American when other English voices are natural', () => {
    const { audio, speak } = fixture([
      { name: 'Microsoft David', lang: 'en-US' },
      { name: 'George Natural', lang: 'en-GB' },
      { name: 'James Neural', lang: 'en-AU' },
    ]);
    for (let soldier = 0; soldier < 10; soldier++) {
      audio.speakChatter('Contact!', 'friendly', 'shout', soldier);
    }
    expect(speak).toHaveBeenCalledTimes(10);
    for (const [utterance] of speak.mock.calls) {
      expect(utterance.voice.name).toBe('Microsoft David');
      expect(utterance.lang).toBe('en-US');
    }
  });

  it('uses American voices for both sides of a player support exchange', () => {
    const { audio, speak } = fixture([
      { name: 'Microsoft David', lang: 'en-US' },
      { name: 'George Natural', lang: 'en-GB' },
    ]);
    audio.speakRadioExchange('Requesting support.', 'Support inbound.', 1, vi.fn());
    const call = speak.mock.calls[0]![0];
    expect(call.lang).toBe('en-US');
    call.onend();
    expect(speak.mock.calls[1]![0].lang).toBe('en-US');
  });

  it('does not substitute another accent when no American male voice is installed', () => {
    const { audio, speak } = fixture([{ name: 'George Natural', lang: 'en-GB' }]);
    audio.speakChatter('Contact!', 'friendly');
    expect(speak).not.toHaveBeenCalled();
  });

  it('preserves German enemy speech', () => {
    const { audio, speak } = fixture([{ name: 'German voice', lang: 'de-DE' }]);
    audio.speakChatter('Achtung!', 'enemy');
    expect(speak.mock.calls[0]![0].lang).toBe('de-DE');
  });
});
