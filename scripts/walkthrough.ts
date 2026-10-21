/**
 * `npm run walkthrough` — drives Countertop in headless Chrome through a scripted conversation
 * (link → make a story → read → next page → choose → recap) and saves screenshots. Doubles as a UI smoke test.
 * Env: CHROME_PATH, OUT_DIR (default docs/img), BASE (default http://localhost:5310)
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve(process.env.OUT_DIR ?? 'docs/img');
const BASE = process.env.BASE ?? 'http://localhost:5310';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('  [page error]', m.text()));

async function shot(name: string, el?: string) {
  const file = path.join(OUT, `${name}.jpg`);
  if (el) await (await page.$(el))!.screenshot({ path: file as `${string}.jpg`, type: 'jpeg', quality: 86 });
  else await page.screenshot({ path: file as `${string}.jpg`, type: 'jpeg', quality: 86 });
  console.log(`  📸 ${file}`);
}
async function say(p: Page, text: string, waitMs: number) {
  await p.type('#say', text);
  await p.keyboard.press('Enter');
  console.log(`  🗣  "${text}"`);
  await sleep(waitMs);
}

console.log('① open + link');
await page.goto(BASE, { waitUntil: 'networkidle0' });
const popupPromise = new Promise<Page>((resolve) => browser.once('targetcreated', async (t) => resolve((await t.page())!)));
await page.click('#link');
const popup = await popupPromise;
await popup.waitForSelector('button[value=allow]');

await popup.screenshot({ path: path.join(OUT, 'account-linking.jpg') as `${string}.jpg`, type: 'jpeg', quality: 86 });
await popup.click('button[value=allow]');
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Linked'), { timeout: 20000 });
await sleep(800);
await shot('countertop-home');

console.log('② parent makes a story');
await say(page, "Make tonight's story. Maya lost her first tooth today and she's nervous about the dentist tomorrow.", 9000);
await shot('studio', '#screen');
await sleep(6000);
await shot('studio-ready', '#screen');

console.log('③ bedtime');
await say(page, 'Read my bedtime story', 9000);
await sleep(7000);
await shot('storybook', '#screen');
await shot('countertop');
await say(page, 'next page please', 8000);
await say(page, 'next page', 9000);
await shot('choice', '#screen');
await say(page, "Let's build the pillow fort!", 9000);
await shot('branch', '#screen');

console.log('④ next morning');
await say(page, 'How did bedtime go last night?', 9000);
await shot('recap', '#screen');
await page.click('.tab[data-tab=ready]');
await sleep(500);
await shot('readiness', '.panel');
await page.click('.tab[data-tab=wire]');
await sleep(300);
await shot('inspector', '.panel');
const report = await page.$eval('#tab-ready', (e) => (e as HTMLElement).innerText.split('\n')[0]);
console.log(`  ✅ ${report}`);
await browser.close();
