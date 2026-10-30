import { afterEach, expect, it, vi } from 'vitest';
import { bindExtendedSettings } from '../src/ui/preferences';
import { DEFAULT_PREFS } from '../src/persistence';

afterEach(() => document.body.replaceChildren());

it('shows preparation until a single asynchronous preview actually completes', async () => {
  document.body.innerHTML = '<div id="overlay-settings"><div class="panel"><input id="set-volume" type="range"><span id="set-volume-value"></span><input id="set-mute" type="checkbox"><input id="set-shake" type="checkbox"><div class="settings-tools"></div></div></div>';
  let complete!: (result: string) => void;
  const preview = vi.fn(() => new Promise<string>((resolve) => { complete = resolve; }));
  bindExtendedSettings(DEFAULT_PREFS, () => {}, preview, () => {});
  const button = document.querySelector<HTMLButtonElement>('#settings-page-audio button')!;
  const status = document.querySelector('#settings-page-audio [role="status"]')!;
  button.click(); button.click();
  expect(preview).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  expect(status.textContent).toContain('Loading voice clip');
  expect(status.textContent).not.toContain('Played bundled');
  complete('Played bundled American voice · michael');
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(status.textContent).toContain('Played bundled');
});

it('reports preview failures and enables retry instead of claiming audio played', async () => {
  document.body.innerHTML = '<div id="overlay-settings"><div class="panel"><input id="set-volume" type="range"><span id="set-volume-value"></span><input id="set-mute" type="checkbox"><input id="set-shake" type="checkbox"><div class="settings-tools"></div></div></div>';
  bindExtendedSettings(DEFAULT_PREFS, () => {}, async () => { throw new Error('Audio load failed'); }, () => {});
  const button = document.querySelector<HTMLButtonElement>('#settings-page-audio button')!;
  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(document.querySelector('#settings-page-audio [role="status"]')!.textContent).toContain('could not play');
});
