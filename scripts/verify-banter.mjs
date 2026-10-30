// Production browser check: real lull conversations, local audio only.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://127.0.0.1:4175';
const origin = new URL(base).origin;
await mkdir('artifacts/banter', { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const external = [], errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http') && new URL(url).origin !== origin) { external.push(url); await route.abort(); }
    else await route.continue();
  });
  await page.addInitScript(() => {
    Math.random = () => 0;
    window.__banterAudio = []; window.__systemSpeech = [];
    speechSynthesis.speak = (utterance) => window.__systemSpeech.push(utterance.text);
    const dataLabels = new WeakMap(), audioLabels = new WeakMap(), sources = new WeakMap();
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      const url = String(args[0]);
      if (url.includes('.wav')) {
        const arrayBuffer = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const data = await arrayBuffer(); dataLabels.set(data, url); return data;
        };
      }
      return response;
    };
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (data, ...args) {
      const label = dataLabels.get(data);
      return decode.call(this, data, ...args).then((buffer) => { if (label) audioLabels.set(buffer, label); return buffer; });
    };
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const url = audioLabels.get(this.buffer);
      if (url?.includes('-banter-')) {
        const entry = { url, at: performance.now(), duration: this.buffer.duration, endedAt: null, stoppedAt: null };
        window.__banterAudio.push(entry); sources.set(this, entry);
        this.addEventListener('ended', () => { entry.endedAt = performance.now(); }, { once: true });
      }
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      const entry = sources.get(this); if (entry) entry.stoppedAt = performance.now();
      return stop.apply(this, args);
    };
  });
  await page.goto(`${base}/?e2e`);
  await page.waitForFunction(() => window.__lastlineTest);
  const staged = await page.evaluate(() => {
    const api = window.__lastlineTest; api.startRun(2026); api.pause();
    const state = api.getState();
    state.units = state.units.filter((unit) => unit.team === 'friendly').slice(0, 2);
    if (state.units.length !== 2) throw new Error('Banter fixture needs two soldiers');
    state.units.forEach((unit, index) => {
      unit.pos = { x: 492 + index * 40, y: 612 }; unit.prevPos = { ...unit.pos };
      unit.path = []; unit.moveGoal = null; unit.pinned = false; unit.suppression = 0;
      unit.targetId = null; unit.health = 100; unit.running = false;
      delete unit.buildingPosition;
    });
    state.scheduler.phase = 'prep'; state.scheduler.prepTicksLeft = 100000;
    return state;
  });
  await page.evaluate((state) => localStorage.setItem('lastline/save/v1', JSON.stringify(state)), staged);
  await page.reload(); await page.waitForFunction(() => window.__lastlineTest);
  await page.locator('#btn-continue').click(); await page.locator('#btn-resume').click();
  await page.evaluate(() => { window.__lastlineTest.step(0); window.__lastlineTest.step(210); });
  await page.waitForFunction(() => window.__banterAudio.length >= 2, undefined, { timeout: 20_000 });
  const first = await page.evaluate(() => window.__banterAudio.slice(0, 2));
  if (!first[0].url.includes('-01-line-') || !first[1].url.includes('-01-reply-')) throw new Error(`Wrong exchange: ${JSON.stringify(first)}`);
  const firstVoice = first[0].url.match(/(michael|puck)-banter/)[1];
  const secondVoice = first[1].url.match(/(michael|puck)-banter/)[1];
  if (firstVoice === secondVoice) throw new Error('Banter voices are identical');
  const gapMs = first[1].at - first[0].endedAt;
  if (gapMs < 200 || gapMs > 3000) throw new Error(`Unexpected response timing: ${gapMs}ms`);
  await page.screenshot({ path: 'artifacts/banter/conversation.png' });
  await page.waitForFunction(() => window.__banterAudio[1].endedAt !== null);
  await page.evaluate(() => window.__lastlineTest.step(1200));
  await page.waitForFunction(() => window.__banterAudio.length >= 3);
  await page.evaluate(() => {
    window.__lastlineTest.spawnEnemyAt('rifle', 100, 100);
    window.__lastlineTest.step(0);
  });
  await page.waitForTimeout(600);
  const result = await page.evaluate(() => ({ audio: window.__banterAudio, systemSpeech: window.__systemSpeech }));
  if (!result.audio[2].stoppedAt || result.audio.length !== 3) throw new Error(`Combat failed to cancel banter: ${JSON.stringify(result.audio)}`);
  if (external.length || errors.length || result.systemSpeech.length) throw new Error(JSON.stringify({ external, errors, systemSpeech: result.systemSpeech }));
  const summary = { firstVoice, secondVoice, gapMs, combatCanceled: true, externalRequests: external.length, systemSpeechCalls: result.systemSpeech.length };
  await writeFile('artifacts/banter/verification.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally { await browser.close(); }
