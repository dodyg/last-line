import { DEFAULT_PREFS, type Preferences } from '../persistence';

type Field = [keyof Preferences, string, number?, number?, number?];
const sections: Array<[string, Field[]]> = [
  ['Audio', [['effectsVolume', 'Combat effects', 0, 1, .05], ['voiceVolume', 'Radio voices', 0, 1, .05], ['ambientVolume', 'Ambient sound', 0, 1, .05], ['musicVolume', 'Adaptive music', 0, 1, .05]]],
  ['Graphics', [['graphics', 'Quality preset'], ['shadows', 'Shadows'], ['particles', 'Combat particles'], ['weatherEffects', 'Weather effects'], ['renderScale', 'Render resolution', .5, 1.5, .1]]],
  ['Camera', [['zoomSensitivity', 'Zoom sensitivity', .25, 3, .25], ['panSpeed', 'Pan speed', .25, 3, .25], ['edgeScrolling', 'Scroll at battlefield edges']]],
  ['Accessibility', [['uiScale', 'Interface scale', .8, 1.5, .1], ['largeCaptions', 'Large radio captions'], ['reducedMotion', 'Reduced motion'], ['strongOutlines', 'Strong selection outlines'], ['fadeObstructions', 'Fade obstructing trees and buildings'], ['friendlyColor', 'Friendly color'], ['enemyColor', 'Enemy color']]],
];

/** Settings remain native controls so keyboard, touch, and assistive tools work. */
export function bindExtendedSettings(initial: Preferences, changed: (prefs: Preferences) => void,
  preview: () => string | Promise<string>, resetCamera: () => void): { current: () => Preferences } {
  let prefs = { ...initial, keys: { ...initial.keys } };
  const panel = document.querySelector<HTMLElement>('#overlay-settings .panel')!;
  panel.parentElement!.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); document.getElementById('btn-settings-close')?.click(); }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll<HTMLElement>('button, input, select')].filter((element) => !element.hasAttribute('disabled') && !element.closest('[hidden]') && element.tabIndex >= 0);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  panel.classList.add('settings-panel');
  const tools = panel.querySelector<HTMLElement>('.settings-tools')!;
  const tabs = document.createElement('div'); tabs.className = 'settings-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Settings categories');
  const content = document.createElement('div'); content.className = 'settings-content';
  panel.insertBefore(tabs, tools); panel.insertBefore(content, tools);
  const tabButtons: HTMLButtonElement[] = [];
  const tabPanels: HTMLElement[] = [];
  function selectTab(index: number): void {
    tabButtons.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; tabPanels[i]!.hidden = i !== index; });
    content.scrollTop = 0;
  }
  function addTab(title: string, body: HTMLElement): void {
    const id = title.toLowerCase();
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'settings-tab'; tab.id = `settings-tab-${id}`; tab.textContent = title;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `settings-page-${id}`);
    const page = document.createElement('section'); page.id = `settings-page-${id}`; page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', tab.id); page.append(body);
    const index = tabButtons.length;
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', (event) => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabButtons.length;
      else if (event.key === 'ArrowLeft') next = (index + tabButtons.length - 1) % tabButtons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabButtons.length - 1;
      else return;
      event.preventDefault(); event.stopPropagation(); selectTab(next); tabButtons[next]!.focus();
    });
    tabButtons.push(tab); tabPanels.push(page); tabs.append(tab); content.append(page);
  }
  const controls = new Map<keyof Preferences, HTMLInputElement | HTMLSelectElement>();
  const outputs = new Map<keyof Preferences, HTMLOutputElement>();
  const apply = (): void => { reflect(); changed(prefs); };
  for (const [title, fields] of sections) {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = title; group.append(legend);
    // Keep the existing controls and their listeners, but place them in their category.
    const existingIds = title === 'Audio' ? ['set-volume', 'set-mute'] : title === 'Accessibility' ? ['set-shake', 'reduced-motion-note'] : [];
    for (const id of existingIds) {
      const element = document.getElementById(id);
      if (element) group.append(element.closest('.settings-row') ?? element);
    }
    for (const [key, label, min, max, step] of fields) {
      const row = document.createElement('div'); row.className = 'settings-row';
      const caption = document.createElement('label'); caption.htmlFor = `set-${key}`; caption.textContent = label;
      const input = key === 'graphics' ? document.createElement('select') : document.createElement('input');
      input.id = caption.htmlFor;
      if (input instanceof HTMLSelectElement) {
        for (const name of ['auto', 'low', 'medium', 'high']) {
          const option = document.createElement('option'); option.value = name; option.textContent = name === 'auto' ? 'Auto · adaptive' : name[0]!.toUpperCase() + name.slice(1); input.append(option);
        }
      } else {
        input.type = min !== undefined ? 'range' : key.endsWith('Color') ? 'color' : 'checkbox';
        if (min !== undefined) { input.min = String(min); input.max = String(max); input.step = String(step); }
      }
      controls.set(key, input); row.append(caption, input);
      if (min !== undefined) { const output = document.createElement('output'); output.htmlFor = input.id; outputs.set(key, output); row.append(output); }
      input.addEventListener(input instanceof HTMLInputElement && input.type === 'range' ? 'input' : 'change', () => {
        const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : min !== undefined ? Number(input.value) : input.value;
        prefs = { ...prefs, [key]: value };
        if (key === 'graphics' && value !== 'auto') {
          const level = value as 'low' | 'medium' | 'high';
          prefs = { ...prefs, shadows: level !== 'low', particles: level !== 'low', weatherEffects: level !== 'low', renderScale: level === 'low' ? .6 : level === 'medium' ? .8 : 1 };
        }
        if (key === 'reducedMotion' && value) prefs.screenShake = false;
        apply();
      });
      group.append(row);
    }
    if (title === 'Audio') {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'hud-button'; button.textContent = 'Preview American voice';
      const status = document.createElement('p'); status.className = 'subtle'; status.setAttribute('role', 'status');
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = 'Loading voice clip…';
        try { status.textContent = await preview(); }
        catch { status.textContent = 'Voice clip could not play. Try again.'; }
        finally { button.disabled = false; }
      });
      group.append(button, status);
    }
    if (title === 'Camera') {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'hud-button'; button.textContent = 'Reset camera'; button.addEventListener('click', resetCamera); group.append(button);
      const note = document.createElement('p'); note.className = 'subtle'; note.textContent = 'Zoom with the wheel. Ctrl-drag to pan. Edge scrolling operates while zoomed in.'; group.append(note);
    }
    addTab(title, group);
  }
  const keys = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = 'Keyboard shortcuts'; keys.append(legend);
  const keyInputs = new Map<keyof Preferences['keys'], HTMLButtonElement>();
  const keyLabels = { pause: 'Pause / resume', panel: 'Toggle commands', resetCamera: 'Reset camera', zoomIn: 'Zoom in', zoomOut: 'Zoom out' };
  const keyStatus = document.createElement('p'); keyStatus.className = 'subtle'; keyStatus.setAttribute('role', 'status'); keyStatus.textContent = 'Click a shortcut, then press a key. Escape cancels.';
  for (const action of Object.keys(keyLabels) as Array<keyof typeof keyLabels>) {
    const row = document.createElement('div'); row.className = 'settings-row';
    const label = document.createElement('span'); label.textContent = keyLabels[action];
    const button = document.createElement('button'); button.type = 'button'; button.className = 'hud-button'; button.dataset.action = action;
    let listening = false;
    button.addEventListener('click', () => { listening = true; button.textContent = 'Press a key…'; });
    button.addEventListener('blur', () => { listening = false; reflect(); });
    button.addEventListener('keydown', (event) => {
      if (!listening) return;
      event.preventDefault(); event.stopPropagation();
      if (event.code === 'Escape') { listening = false; reflect(); return; }
      if (!/^(Key[A-Z]|Digit[0-9]|Space|Tab|Equal|Minus|Arrow(Up|Down|Left|Right))$/.test(event.code)) { keyStatus.textContent = 'Use a letter, digit, arrow, Space, Tab, + or −.'; return; }
      if (Object.entries(prefs.keys).some(([name, code]) => name !== action && code === event.code)) { keyStatus.textContent = 'That key is already assigned. Choose another key.'; return; }
      prefs.keys = { ...prefs.keys, [action]: event.code }; listening = false; keyStatus.textContent = 'Shortcut saved.'; apply();
    });
    keyInputs.set(action, button); row.append(label, button); keys.append(row);
  }
  keys.append(keyStatus); addTab('Controls', keys);
  for (const element of panel.querySelectorAll('.scenario-note, .scenario-forces')) tools.append(element);
  addTab('Tools', tools);
  selectTab(0);
  const footer = document.createElement('div'); footer.className = 'settings-footer'; panel.append(footer);
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'menu-button'; reset.textContent = 'Reset settings to defaults';
  reset.addEventListener('click', () => { prefs = { ...DEFAULT_PREFS, keys: { ...DEFAULT_PREFS.keys } }; apply(); }); footer.append(reset);
  const close = document.getElementById('btn-settings-close'); if (close) footer.append(close);
  const volume = document.querySelector<HTMLInputElement>('#set-volume')!, mute = document.querySelector<HTMLInputElement>('#set-mute')!, shake = document.querySelector<HTMLInputElement>('#set-shake')!;
  volume.addEventListener('input', () => { prefs.volume = Number(volume.value) / 100; apply(); });
  mute.addEventListener('change', () => { prefs.muted = mute.checked; apply(); });
  shake.addEventListener('change', () => { prefs.screenShake = shake.checked; apply(); });
  function reflect(): void {
    volume.value = String(Math.round(prefs.volume * 100)); document.querySelector('#set-volume-value')!.textContent = `${volume.value}%`; mute.checked = prefs.muted; shake.checked = prefs.screenShake;
    for (const [key, input] of controls) {
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = prefs[key] as boolean;
      else input.value = String(prefs[key]);
      const output = outputs.get(key); if (output) output.value = `${Math.round(Number(prefs[key]) * 100)}%`;
    }
    for (const [action, button] of keyInputs) button.textContent = prefs.keys[action].replace('Key', '').replace('Digit', '').replace('Equal', '+').replace('Minus', '−');
  }
  reflect();
  return { current: () => prefs };
}
