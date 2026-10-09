// The stats page in a real browser (local only, NOT part of `npm test`: it needs Chrome or Edge and Playwright). Builds the
// feedback output into a temp folder, serves it, answers the Worker's admin stats route with the fixture, and drives the page.
// Playwright: tools/post-deploy-check/node_modules (see scripts/post-deploy-check.mjs launchBrowser), or the folder named by
// PLAYWRIGHT_CORE (the path of its index.mjs) when this work copy has no node_modules there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createPagesServer } from '../scripts/serve-cf.mjs';
import { HOSTS } from '../site.config.mjs';
import { statsResponse } from './fixtures/stats-admin-response.mjs';

const root = path.resolve(import.meta.dirname, '..');
const entry = process.env.PLAYWRIGHT_CORE || path.join(root, 'tools', 'post-deploy-check', 'node_modules', 'playwright-core', 'index.mjs');
assert.ok(fs.existsSync(entry), `Playwright not found at ${entry}: set PLAYWRIGHT_CORE`);
const { chromium } = await import(pathToFileURL(entry).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftborn-metrics-'));
const { CI, GITHUB_ACTIONS, ...baseEnv } = process.env;
const out = path.join(tmp, 'build');
const built = spawnSync(process.execPath, ['scripts/build-pages.mjs'], { env: { ...baseEnv, RIFTBORN_PAGES_OUT: out, RIFTBORN_SCORE_API_BASE: HOSTS.workersDev }, encoding: 'utf8' });
assert.equal(built.status, 0, `build failed:\n${built.stdout}\n${built.stderr}`);

const server = createPagesServer({ root: path.join(out, '_cf', 'feedback'), mode: 'cloudflare' });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const KEY = 'test-key-' + 'x'.repeat(24); // made up; exists only in this test

const apiCalls = [];
let answer = (range) => ({ status: 200, body: statsResponse({ range }) });
let browser;
try {
  browser = await (async () => {
    for (const channel of process.env.CHECK_BROWSER_CHANNEL ? [process.env.CHECK_BROWSER_CHANNEL] : ['chrome', 'msedge', undefined]) {
      try { return await chromium.launch({ channel, headless: true }); } catch { /* try the next */ }
    }
    throw new Error('no browser to drive');
  })();
  const open = async ({ width = 1280, height = 800 } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, serviceWorkers: 'block' });
    const seen = { errors: [], origins: new Set(), apiBeforeUnlock: 0 };
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      seen.origins.add(url.origin);
      if (url.origin === HOSTS.api) {
        const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'Authorization', 'access-control-allow-methods': 'GET, OPTIONS' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        apiCalls.push({ path: url.pathname + url.search, authorization: request.headers().authorization || '' });
        if (!request.headers().authorization) return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{"error":"Unauthorized"}' });
        const range = url.searchParams.get('range');
        const { status, body } = answer(range);
        return route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') seen.errors.push('console: ' + message.text()); });
    page.on('pageerror', error => seen.errors.push('uncaught: ' + error.message));
    return { context, page, seen };
  };
  const visible = (page, selector) => page.locator(selector).isVisible();

  // 1. A fresh load: the key form only, nothing sent.
  {
    const { context, page, seen } = await open();
    apiCalls.length = 0;
    await page.goto(origin + '/metrics/');
    assert.equal(await visible(page, '#login'), true, 'the key form shows');
    assert.equal(await visible(page, '#stats'), false, 'the stats stay hidden');
    assert.equal(apiCalls.length, 0, 'nothing is sent before a key is typed');

    // 2. Unlock: range 30 asks for 30, then the 90-day compare; five figures, the visits link, a drawn trend, six funnel rows.
    await page.fill('#keyInput', KEY);
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#figures .kpi-value:not(:text("—"))');
    assert.deepEqual(apiCalls.map(c => c.path), ['/api/admin/stats?range=30', '/api/admin/stats?range=90'], 'range 30 then its comparison');
    assert.ok(apiCalls.every(c => c.authorization === 'Bearer ' + KEY), 'the key goes only as a Bearer header');
    assert.equal(await page.locator('#figures .kpi').count(), 5);
    assert.equal(await page.getAttribute('#visits', 'href'), 'https://dash.cloudflare.com/');
    assert.ok(await page.locator('#trend svg path.s-line').count() >= 1, 'the trend has a line');
    assert.equal(await page.locator('#funnel svg rect.s-bar, #funnel svg rect.s-drop').count(), 6, 'six funnel rows');
    assert.ok((await page.locator('#health').innerText()).includes('Last report received'), 'the health line shows');
    assert.ok((await page.locator('[data-def="lowerBound"]').innerText()).length > 20, 'the lower-bound note is filled');
    assert.ok((await page.locator('#definitions dt').count()) >= 10, 'definitions are listed');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[style]').length), 0, 'no inline style attributes');
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

    // 3. Table view and CSV.
    await page.click('#tableToggle');
    assert.equal(await visible(page, '#tables'), true);
    assert.equal(await visible(page, '#charts'), false);
    assert.ok((await page.locator('#tables table').count()) >= 5, 'tables are drawn');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
    assert.match(download.suggestedFilename(), /^riftborn-stats-30-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert.ok(csv.startsWith('section,name,count\r\n'), 'the CSV header');
    await page.click('#tableToggle');
    assert.equal(await visible(page, '#charts'), true);

    // 4. Range ALL: exactly one request.
    apiCalls.length = 0;
    await page.click('button[data-range="all"]');
    await page.waitForFunction(() => document.querySelector('button[data-range="all"]').getAttribute('aria-pressed') === 'true');
    await page.waitForTimeout(300);
    assert.deepEqual(apiCalls.map(c => c.path), ['/api/admin/stats?range=all'], 'ALL asks once');

    // 5. A 401 on refresh locks the page and empties the tab's storage.
    answer = () => ({ status: 401, body: { error: 'Unauthorized' } });
    await page.click('#refresh');
    await page.waitForSelector('#login:not([hidden])');
    assert.equal(await page.evaluate(() => sessionStorage.length), 0, 'the key is forgotten');
    assert.equal(await visible(page, '#stats'), false);
    answer = (range) => ({ status: 200, body: statsResponse({ range }) });

    // The one 401 above was asked for: the browser logs a refused request as a console error; anything else is a real error.
    assert.deepEqual(seen.errors.filter(text => !/status of 401/.test(text)), [], 'no console or page errors');
    assert.equal(seen.errors.filter(text => /status of 401/.test(text)).length, 1, 'only the deliberate 401');
    assert.ok([...seen.origins].every(o => o === origin || o === HOSTS.api), 'only the page and the API: ' + [...seen.origins]);
    await context.close();
  }

  // 6. A phone: no sideways scroll.
  {
    const { context, page } = await open({ width: 375, height: 812 });
    await page.goto(origin + '/metrics/');
    await page.fill('#keyInput', KEY);
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#figures .kpi-value:not(:text("—"))');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no horizontal scroll at 375 px');
    await context.close();
  }
} finally {
  await browser?.close();
  server.close();
}
console.log('PASS stats page in a browser: locked shell, unlock, figures, charts, table view, CSV, ranges, 401 lock, phone width.');
