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
  it('does not substitute system voices for friendly recorded chatter', () => {
    const { audio, speak } = fixture([{ name: 'Microsoft David', lang: 'en-US' }]);
    audio.speakChatter('Contact!', 'friendly');
    expect(speak).not.toHaveBeenCalled();
  });

  it('does not substitute system speech when recorded support audio cannot play', () => {
    const { audio, speak } = fixture([{ name: 'Microsoft David', lang: 'en-US' }]);
    const done = vi.fn();
    audio.speakRadioExchange('Requesting support.', 'Support inbound.', 1, done);
    expect(speak).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledExactlyOnceWith(false);
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
