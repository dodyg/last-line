import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOLDIER_VOICE_CLIPS, selectSoldierClip, soldierVoice, clearLegacyVoiceCache } from '../src/game/soldier-voices';
import type { RadioCue } from '../src/game/radio';
import { LULL_BANTER } from '../src/content/lull-banter';

afterEach(() => vi.unstubAllGlobals());

describe('bundled soldier phrases', () => {
  it('ships a real audio asset for every catalog entry', () => {
    expect(SOLDIER_VOICE_CLIPS).toHaveLength(98 + LULL_BANTER.length * 4);
    expect(new Set(SOLDIER_VOICE_CLIPS.map((clip) => clip.id)).size).toBe(SOLDIER_VOICE_CLIPS.length);
    for (const clip of SOLDIER_VOICE_CLIPS) {
      expect(clip.url, clip.id).toMatch(/\.wav/);
      expect(clip.text.length).toBeGreaterThan(0);
    }
  });

  it('records both halves of every lull conversation in both soldier voices', () => {
    for (const exchange of LULL_BANTER) {
      for (const speaker of [0, 1]) {
        for (const text of [exchange.line, exchange.reply]) {
          const clip = selectSoldierClip(text, 'ambient', speaker, 0, true);
          expect(clip?.text).toBe(text);
          expect(clip?.voice).toBe(soldierVoice(speaker));
        }
      }
    }
  });

  it('covers every combat cue with two takes for both consistent soldier voices', () => {
    const cues: RadioCue[] = ['contact', 'kill', 'wounded', 'medic', 'wave', 'clear', 'breakthrough', 'artillery', 'construction', 'supplies', 'airSupport', 'flare'];
    for (const id of [0, 1]) {
      for (const cue of cues) {
        const first = selectSoldierClip('An unrecorded contextual caption.', cue, id, 0)!;
        const second = selectSoldierClip('An unrecorded contextual caption.', cue, id, 1)!;
        expect(first.voice).toBe(soldierVoice(id));
        expect(second.voice).toBe(first.voice); expect(second.id).not.toBe(first.id);
      }
    }
  });

  it('uses exact event lines before generic cues and keeps unrecorded banter caption-only', () => {
    expect(selectSoldierClip('Mortar round away!', 'artillery', 0)?.id).toBe('michael-mortar-away');
    expect(selectSoldierClip('Tank observed. On the north-west side—eyes up!', 'contact', 1)?.id).toBe('puck-tank-spotted');
    expect(selectSoldierClip('An unrecorded joke.', 'ambient', 0)).toBeNull();
    expect(selectSoldierClip('An unrecorded acknowledgment.', 'supplies', -3)).toBeNull();
  });

  it('records every support request and both Control acknowledgments', () => {
    const requests = ['Quartermaster, send rations. Over.', 'Battery, fire on my mark. Over.', 'Air Control, strike on my mark. Over.', 'Flare on mark. Over.'];
    for (const id of [0, 1]) for (const request of requests) expect(selectSoldierClip(request, 'supplies', id, 0, true)?.text).toBe(request);
    for (const response of ['Roger.', 'Fire away.']) expect(selectSoldierClip(response, 'supplies', -3, 0, true)?.voice).toBe('fenrir');
  });

  it('removes the obsolete voice model cache while preserving unrelated cached data', async () => {
    const model = { url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx' };
    const other = { url: 'https://example.com/another-model.onnx' };
    let entries = [model, other];
    const cache = { keys: async () => entries, delete: vi.fn(async (entry) => { entries = entries.filter((value) => value !== entry); return true; }) };
    const storage = { keys: async () => ['kokoro-voices', 'transformers-cache', 'game-assets'], open: vi.fn(async () => cache), delete: vi.fn(async () => true) };
    vi.stubGlobal('caches', storage);
    await clearLegacyVoiceCache();
    expect(entries).toEqual([other]);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith('kokoro-voices');
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(model);
  });
});
