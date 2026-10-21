/**
 * `npm run record-demo -- <script.json> <outDir>` — records a scripted Countertop session, one
 * video per scene (WebM via Puppeteer screencast + ffmpeg), plus a timeline of every sound played
 * (user lines, Alexa replies, the add-on UI's own audio) so the audio can be laid back in sync.
 *
 * Start Countertop with DEMO_AUDIO_DIR=<outDir>/audio so spoken clips are saved alongside.
 *
 * Script format:
 * { "base": "http://localhost:5310/?demo=1", "width": 1920, "height": 1080,
 *   "scenes": [ { "name": "bedtime", "steps": [
 *       { "utter": "Read my bedtime story", "voice": "Ivy" },   // speak a line as the user, then let the agent run
 *       { "waitIdle": true },                                   // agent finished + Alexa done speaking
 *       { "waitAppAudio": true, "timeout": 40000 },             // the add-on UI finished its current clip
 *       { "appClick": ".option:nth-child(2)" },                 // click inside the add-on's UI
 *       { "clock": "18:45" },                                   // home-screen clock shows 6:45 and ticks on (or ?clock= in base)
 *       { "wait": 1500 }, { "mark": "choice" } ] } ] }
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Frame, type Page } from 'puppeteer-core';

const [scriptPath, outDir = 'demo-out'] = process.argv.slice(2);
if (!scriptPath) throw new Error('usage: record-demo <script.json> [outDir]');
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const OUT = path.resolve(outDir);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', `--window-size=${script.width ?? 1920},${script.height ?? 1080}`],
  defaultViewport: { width: script.width ?? 1920, height: script.height ?? 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', (e as Error).message));
page.on('console', (m) => {
  const t = m.text();
  if (/^\[(voice|agent|demo)\]/.test(t) || m.type() === 'error') console.log(`   · ${t.slice(0, 140)}`);
});

async function appFrame(p: Page): Promise<Frame | undefined> {
  return p.frames().find((f) => f.parentFrame()?.url().includes('/sandbox.html'));
}
async function waitFor(fn: () => Promise<boolean>, timeout = 30000, settle = 0) {
  const t0 = Date.now();
  let okSince = 0;
  while (Date.now() - t0 < timeout) {
    if (await fn()) {
      okSince ||= Date.now();
      if (Date.now() - okSince >= settle) return true;
    } else okSince = 0;
    await sleep(150);
  }
  console.log('  ⏱ timed out waiting');
  return false;
}
const openAppClip = () =>
  page.evaluate(() => (window as any).countertop.timeline().audio.some((e: any) => e.kind === 'app' && e.end === undefined));

await page.goto(script.base ?? 'http://localhost:5310/?demo=1', { waitUntil: 'networkidle0' });

// Link the add-on (consent popup), unless already linked in this session.
if (script.link !== false) {
  const popupP = new Promise<Page>((resolve) => browser.once('targetcreated', async (t) => resolve((await t.page())!)));
  await page.click('#link');
  const popup = await popupP;
  await popup.waitForSelector('button[value=allow]');
  await sleep(script.consentPauseMs ?? 0);
  await popup.click('button[value=allow]');
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Linked'), { timeout: 30000 });
  console.log('🔗 linked');
}

for (const scene of script.scenes) {
  console.log(`🎬 ${scene.name}`);
  if (scene.before) for (const step of scene.before) await run(step);
  const file = path.join(OUT, `${scene.name}.webm`);
  const recorder = await page.screencast({ path: file as `${string}.webm` });
  const recordStart = Date.now();
  for (const step of scene.steps) await run(step);
  await recorder.stop();
  const recordEnd = Date.now();
  const tl = await page.evaluate(() => (window as any).countertop.timeline());
  const inScene = (t: number) => t >= recordStart - 50 && t <= recordEnd;
  fs.writeFileSync(
    path.join(OUT, `${scene.name}.json`),
    JSON.stringify(
      {
        recordStart,
        recordEnd,
        audio: tl.audio.filter((e: any) => inScene(e.start)).map((e: any) => ({ ...e, startS: (e.start - recordStart) / 1000, endS: ((e.end ?? recordEnd) - recordStart) / 1000 })),
        marks: tl.marks.filter((m: any) => inScene(m.at)).map((m: any) => ({ ...m, atS: (m.at - recordStart) / 1000 })),
      },
      null,
      2,
    ),
  );
  console.log(`   → ${file} (${((recordEnd - recordStart) / 1000).toFixed(1)}s)`);
}

async function run(step: any) {
  if (step.clock !== undefined) await page.evaluate((c) => (window as any).countertop.setClock(c), step.clock);
  if (step.utter) {
    console.log(`   🗣  ${step.voice ?? ''}: ${step.utter}`);
    await page.evaluate((t, v) => (window as any).countertop.utter(t, v), step.utter, step.voice ?? 'Matthew');
  }
  if (step.say) await page.evaluate((t) => (window as any).countertop.say(t), step.say);
  if (step.waitIdle) await waitFor(() => page.evaluate(() => (window as any).countertop.idle()), step.timeout ?? 45000, 800);
  if (step.waitAppAudio) {
    await waitFor(openAppClip, 8000); // wait for a clip to start…
    await waitFor(async () => !(await openAppClip()), step.timeout ?? 60000, 300); // …and finish
  }
  if (step.waitText) {
    await waitFor(async () => {
      const f = await appFrame(page);
      return !!f && (await f.evaluate((t) => document.body.innerText.includes(t), step.waitText).catch(() => false));
    }, step.timeout ?? 180000);
  }
  if (step.waitAppSelector) {
    await waitFor(async () => {
      const f = await appFrame(page);
      return !!f && (await f.evaluate((sel) => !!document.querySelector(sel), step.waitAppSelector).catch(() => false));
    }, step.timeout ?? 90000);
  }
  if (step.utterChoice) {
    // Say one of the story's choice options out loud, as the child would.
    const f = await appFrame(page);
    const labels: string[] = (await f?.evaluate(() => [...document.querySelectorAll('.option span')].map((e) => e.textContent ?? ''))) ?? [];
    const label = labels[step.utterChoice - 1] ?? labels[0] ?? 'the first one';
    const line = (step.template ?? '{label}!').replace('{label}', label.toLowerCase());
    console.log(`   🗣  ${step.voice ?? ''}: ${line}`);
    await page.evaluate((t, v) => (window as any).countertop.utter(t, v), line, step.voice ?? 'Ivy');
  }
  if (step.appClick) {
    const f = await appFrame(page);
    await f?.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), step.appClick);
  }
  if (step.click) await page.click(step.click);
  if (step.wait) await sleep(step.wait);
  if (step.mark) await page.evaluate((m) => (window as any).countertop.mark(m), step.mark);
  if (step.home) await page.evaluate(() => (window as any).countertop.home());
}

await browser.close();
console.log('✅ done');
