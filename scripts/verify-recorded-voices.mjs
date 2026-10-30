// Build first and start `npm run preview -- --host 127.0.0.1 --port 4175`.
import { chromium } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://127.0.0.1:4175';
const origin = new URL(base).origin;
const folder = 'src/assets/ww2/voices/soldiers';
const manifest = [
  ...JSON.parse(await readFile(`${folder}/manifest.json`, 'utf8')),
  ...JSON.parse(await readFile(`${folder}/banter-manifest.json`, 'utf8')),
];
let bytes = 0;
for (const clip of manifest) {
  const data = await readFile(`${folder}/${clip.file}`);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.readUInt32LE(24) !== 24000 || data.readUInt16LE(34) !== 16) throw new Error(`Invalid WAV: ${clip.file}`);
  let peak = 0, sum = 0;
  for (let i = 44; i < data.length; i += 2) { const sample = data.readInt16LE(i) / 32768; peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; }
  if (peak < 0.02 || Math.sqrt(sum / ((data.length - 44) / 2)) < 0.003) throw new Error(`Silent clip: ${clip.file}`);
  bytes += data.length;
}
const assets = await readdir('dist/assets');
if (assets.some((file) => /kokoro|\.wasm$|\.onnx$/i.test(file))) throw new Error('The build still contains model runtime assets');
await mkdir('artifacts/recorded-voices', { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const external = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http') && new URL(url).origin !== origin) { external.push(url); await route.abort(); }
    else await route.continue();
  });
  await page.addInitScript(() => {
    window.__voiceSources = []; window.__systemSpeech = []; window.__voiceWorkers = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      // decodeAudioData resamples WAVs to the device's AudioContext rate.
      if (this.buffer?.duration > 0.5) window.__voiceSources.push({ duration: this.buffer.duration, sampleRate: this.buffer.sampleRate, at: performance.now() });
      return start.apply(this, args);
    };
    speechSynthesis.speak = (utterance) => { window.__systemSpeech.push(utterance.text); };
    const WorkerClass = window.Worker;
    window.Worker = class extends WorkerClass { constructor(...args) { window.__voiceWorkers++; super(...args); } };
  });
  await page.goto(base);
  await page.locator('#btn-settings-title').click();
  const preview = page.getByRole('button', { name: 'Preview American voice', exact: true });
  const clickedAt = await page.evaluate(() => performance.now());
  await preview.click();
  await page.waitForFunction(() => document.querySelector('#settings-page-audio [role="status"]')?.textContent?.startsWith('Played bundled'), undefined, { timeout: 20_000 });
  const result = await page.evaluate(() => ({ sources: window.__voiceSources, systemSpeech: window.__systemSpeech, workers: window.__voiceWorkers }));
  if (!result.sources.length || result.systemSpeech.length || result.workers || external.length) throw new Error(`Unexpected speech path: ${JSON.stringify({ ...result, external })}`);
  const replayClickedAt = await page.evaluate(() => performance.now());
  await preview.click();
  await page.waitForFunction(() => window.__voiceSources.length > 1);
  const replayAt = await page.evaluate(() => window.__voiceSources[1].at);
  const metrics = { clips: manifest.length, bytes, firstPlaybackMs: result.sources[0].at - clickedAt, cachedPlaybackMs: replayAt - replayClickedAt, externalRequests: external.length, systemSpeechCalls: result.systemSpeech.length, workers: result.workers };
  await page.waitForFunction(() => !document.querySelector('#settings-page-audio button')?.disabled);
  await page.screenshot({ path: 'artifacts/recorded-voices/preview.png' });
  await writeFile('artifacts/recorded-voices/verification.json', JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} finally { await browser.close(); }
