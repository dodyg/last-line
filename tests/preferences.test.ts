import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, KEYS, loadPrefs, savePrefs, Storage } from '../src/persistence';
import { bindExtendedSettings } from '../src/ui/preferences';

beforeEach(() => { window.localStorage.clear(); document.body.replaceChildren(); });

describe('Expanded preferences', () => {
  it('migrates legacy preferences without losing volume or mute', () => {
    const storage = new Storage();
    storage.set(KEYS.prefs, JSON.stringify({ volume: .3, muted: true, screenShake: false }));
    expect(loadPrefs(storage)).toEqual({ ...DEFAULT_PREFS, volume: .3, muted: true, screenShake: false });
  });

  it('rejects corrupt ranges, colors, presets, and colliding shortcuts', () => {
    const storage = new Storage();
    storage.set(KEYS.prefs, JSON.stringify({ renderScale: 20, voiceVolume: -1, friendlyColor: 'red;display:none', graphics: 'ultra', keys: { ...DEFAULT_PREFS.keys, zoomIn: 'Space' } }));
    const prefs = loadPrefs(storage);
    expect(prefs.renderScale).toBe(1); expect(prefs.voiceVolume).toBe(1);
    expect(prefs.friendlyColor).toBe(DEFAULT_PREFS.friendlyColor); expect(prefs.graphics).toBe('auto');
    expect(prefs.keys).toEqual(DEFAULT_PREFS.keys);
  });

  it('applies graphics presets, saves audio settings, rebinds keys, and resets controls', () => {
    document.body.innerHTML = '<div id="overlay-settings"><div class="panel"><input id="set-volume" type="range" min="0" max="100"><span id="set-volume-value"></span><input id="set-mute" type="checkbox"><input id="set-shake" type="checkbox"><div class="settings-tools"></div></div></div>';
    const storage = new Storage();
    const settings = bindExtendedSettings({ ...DEFAULT_PREFS }, (prefs) => savePrefs(storage, prefs), () => 'David · en-US', () => {});
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Audio', 'Graphics', 'Camera', 'Accessibility', 'Controls', 'Tools']);
    expect(document.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    tabs[1]!.click();
    expect(document.querySelector('#settings-page-audio')!.hasAttribute('hidden')).toBe(true);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabs[5]);
    tabs[5]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    expect(document.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    const graphics = document.querySelector<HTMLSelectElement>('#set-graphics')!;
    graphics.value = 'low'; graphics.dispatchEvent(new Event('change'));
    expect(loadPrefs(storage)).toMatchObject({ graphics: 'low', renderScale: .6, shadows: false, particles: false });
    expect(document.querySelector<HTMLInputElement>('#set-shadows')!.checked).toBe(false);
    const volume = document.querySelector<HTMLInputElement>('#set-voiceVolume')!;
    volume.value = '.4'; volume.dispatchEvent(new Event('input'));
    expect(loadPrefs(storage).voiceVolume).toBe(.4);
    const key = document.querySelector<HTMLButtonElement>('[data-action="pause"]')!;
    key.click(); key.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p' }));
    expect(loadPrefs(storage).keys.pause).toBe('KeyP');
    const reset = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Reset settings to defaults')!;
    reset.click(); expect(loadPrefs(storage)).toEqual(DEFAULT_PREFS); expect(settings.current()).toEqual(DEFAULT_PREFS);
    expect(volume.value).toBe('1');
  });
});
