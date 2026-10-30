import manifest from '../assets/ww2/voices/soldiers/manifest.json';
import banterManifest from '../assets/ww2/voices/soldiers/banter-manifest.json';
import type { RadioCue } from './radio';

const files = import.meta.glob('../assets/ww2/voices/soldiers/*.wav', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;

export interface SoldierVoiceClip {
  id: string;
  text: string;
  voice: string;
  cue?: string;
  kind?: string;
  url: string;
}

export const SOLDIER_VOICE_CLIPS: readonly SoldierVoiceClip[] = [...manifest, ...banterManifest].map((clip) => ({
  ...clip, url: files[`../assets/ww2/voices/soldiers/${clip.file}`]!,
}));

export function soldierVoice(speakerId: number): string {
  return speakerId === -3 ? 'fenrir' : ['michael', 'puck'][Math.abs(speakerId) % 2]!;
}

const normalize = (text: string): string => text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/** Reclaim this game's old model download without touching unrelated caches. */
export async function clearLegacyVoiceCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const names = await caches.keys();
    if (names.includes('kokoro-voices')) await caches.delete('kokoro-voices');
    if (names.includes('transformers-cache')) {
      const cache = await caches.open('transformers-cache');
      const requests = await cache.keys();
      await Promise.all(requests.filter((request) => /\/onnx-community\/Kokoro-82M[^/]*\//i.test(request.url))
        .map((request) => cache.delete(request)));
      if ((await cache.keys()).length === 0) await caches.delete('transformers-cache');
    }
  } catch { /* Cache storage may be disabled; local audio still works. */ }
}

/** Use exact prerecorded lines first, then a short cue-appropriate combat bark.
 * Unrecorded jokes/weather remain caption-only rather than speaking unrelated words. */
export function selectSoldierClip(text: string, cue: RadioCue, speakerId: number, variation = 0, exactOnly = false, voiceOverride?: string): SoldierVoiceClip | null {
  const voice = voiceOverride ?? soldierVoice(speakerId);
  const available = SOLDIER_VOICE_CLIPS.filter((clip) => clip.voice === voice);
  const spokenText = normalize(text.replace(/\s+(?:On the [a-z-]+ side—eyes up!|By the center—eyes up!)$/, ''));
  const exact = available.find((clip) => normalize(clip.text) === spokenText);
  if (exact) return exact;
  if (exactOnly || cue === 'ambient' || speakerId === -3) return null;
  const candidates = available.filter((clip) => clip.cue === cue);
  return candidates[Math.abs(variation) % candidates.length] ?? null;
}
