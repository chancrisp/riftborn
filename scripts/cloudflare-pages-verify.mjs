// After a launched Cloudflare Pages deploy: proves that https://riftborn.us and
// https://dev.riftborn.us really serve the build that was just deployed before github.io becomes
// handoff pages (in .github/workflows/pages.yml the github.io deploy needs the cloudflare job, and
// this is that job's last step). Wrangler reporting success is not enough: the custom domains, DNS
// and certificates are dashboard settings, and if riftborn.us is not attached, has lapsed or is
// still provisioning, every old link would send players to a host that fails.
// Checks, retried for about three minutes (the new deployment propagating):
//   riftborn.us/version.json      the build in _cf/live/version.json
//   riftborn.us/ and /classic/    200 and they read the hand-over (#rb_migrate=)
//   dev.riftborn.us/              200 and reads the hand-over; version.json = _cf/dev/version.json
// GET requests only; nothing is written anywhere.
//   node scripts/cloudflare-pages-verify.mjs
//   node scripts/cloudflare-pages-verify.mjs --previews   the per-branch preview links just deployed
//       (.github/workflows/previews.yml): each https://<name>.riftborn-dev.pages.dev/ answers 200
//       with the password gate and its version.json is the staged build (_cf/previews/previews.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOSTS, MIGRATION } from '../site.config.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
/** What every page that receives a hand-over contains (the game's MOVE CAPTURE, the classic importer). */
export const HANDOFF_READER = `#${MIGRATION.param}=`;

/** The builds just deployed: { live, dev } from _cf/<output>/version.json (null when absent). */
export function expectedBuilds(base = root) {
  const read = output => {
    try {
      const build = JSON.parse(fs.readFileSync(path.join(base, '_cf', output, 'version.json'), 'utf8')).build;
      return typeof build === 'string' && build ? build : null;
    } catch {
      return null;
    }
  };
  return { live: read('live'), dev: read('dev') };
}

async function get(fetchImpl, url, timeoutMs) {
  const fresh = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
  try {
    const response = await fetchImpl(fresh, {
      redirect: 'manual', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs)
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { status: 0, text: '', error: error?.name === 'TimeoutError' ? 'timed out' : String(error?.cause?.code || error?.message || error) };
  }
}

/** One round of checks. -> problems ([] when everything is served as deployed). */
export async function checkOnce({ live = HOSTS.live, dev = HOSTS.dev, expected, fetchImpl = fetch, timeoutMs = 15000 }) {
  const problems = [];
  const page = async (url, { reader = true } = {}) => {
    const result = await get(fetchImpl, url, timeoutMs);
    if (result.status !== 200) problems.push(`${url}: ${result.error || 'HTTP ' + result.status}`);
    else if (reader && !result.text.includes(HANDOFF_READER)) problems.push(`${url}: does not read the hand-over (${HANDOFF_READER})`);
    return result;
  };
  const version = async (origin, build) => {
    const url = `${origin}/version.json`;
    const result = await page(url, { reader: false });
    if (result.status !== 200) return;
    let served = null;
    try { served = JSON.parse(result.text).build; } catch { served = null; }
    if (served !== build) problems.push(`${url}: serves build ${JSON.stringify(served)}, just deployed ${JSON.stringify(build)}`);
  };
  if (!expected?.live) problems.push('_cf/live/version.json has no build to compare with');
  else await version(live, expected.live);
  await page(`${live}/`);
  await page(`${live}/classic/`);
  await page(`${dev}/`);
  if (expected?.dev) await version(dev, expected.dev);
  return problems;
}

/** One round of checks of the preview links -> problems ([] when each serves its staged build). */
export async function checkPreviewsOnce({ previews = [], fetchImpl = fetch, timeoutMs = 15000 }) {
  const problems = [];
  for (const preview of previews) {
    const page = await get(fetchImpl, `${preview.origin}/`, timeoutMs);
    if (page.status !== 200) problems.push(`${preview.origin}/: ${page.error || 'HTTP ' + page.status}`);
    else if (!page.text.includes('id="devGate"')) problems.push(`${preview.origin}/: no password gate`);
    const version = await get(fetchImpl, `${preview.origin}/version.json`, timeoutMs);
    if (version.status !== 200) { problems.push(`${preview.origin}/version.json: ${version.error || 'HTTP ' + version.status}`); continue; }
    let served = null;
    try { served = JSON.parse(version.text).build; } catch { served = null; }
    if (served !== preview.build) problems.push(`${preview.origin}/version.json: serves build ${JSON.stringify(served)}, just deployed ${JSON.stringify(preview.build)}`);
  }
  return problems;
}

/** Retries checkOnce (or `check`) until it passes or `attempts` run out. -> { ok, problems, attempts } */
export async function verifyDeployment({ attempts = 18, delayMs = 10000, log = () => {}, check = checkOnce, ...options } = {}) {
  let problems = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    problems = await check(options);
    if (!problems.length) return { ok: true, problems, attempts: attempt };
    log(`Attempt ${attempt}/${attempts}: ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return { ok: false, problems, attempts };
}

async function mainPreviews() {
  let previews = [];
  try {
    previews = JSON.parse(fs.readFileSync(path.join(root, '_cf', 'previews', 'previews.json'), 'utf8')).previews || [];
  } catch {
    throw new Error('_cf/previews/previews.json is missing: run node scripts/pages-previews.mjs first.');
  }
  if (!previews.length) { console.log('No preview links to check.'); return; }
  console.log(`Checking ${previews.map(preview => `${preview.origin}/ (build ${preview.build})`).join(', ')}.`);
  const result = await verifyDeployment({ previews, check: checkPreviewsOnce, attempts: 12, log: message => console.log(message) });
  if (!result.ok) {
    console.error(`The preview links do not serve their builds:\n  - ${result.problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Every preview link serves its build behind the password gate (attempt ${result.attempts}).`);
}

async function main() {
  const expected = expectedBuilds();
  console.log(`Checking ${HOSTS.live} (build ${expected.live}) and ${HOSTS.dev} (build ${expected.dev}) before github.io hands players over.`);
  const result = await verifyDeployment({ expected, log: message => console.log(message) });
  if (!result.ok) {
    console.error(`riftborn.us / dev.riftborn.us do not serve this deploy:\n  - ${result.problems.join('\n  - ')}\nThe github.io hand-over is NOT published (players stay on the old address, their progress is safe). Check the custom domains, DNS and certificates in the Cloudflare dashboard, then re-run.`);
    process.exitCode = 1;
    return;
  }
  console.log(`riftborn.us and dev.riftborn.us serve this deploy (attempt ${result.attempts}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--previews')) {
    try { await mainPreviews(); } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else await main();
}
