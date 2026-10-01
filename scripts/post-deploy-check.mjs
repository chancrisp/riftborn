// After every deploy: opens https://riftborn.us/ the way a player would, in headless Chrome, and
// fails if the live game is not healthy. Run by .github/workflows/post-deploy-check.yml when the
// "Build and deploy" workflow (pages.yml) finishes on main, or by hand from that workflow's page.
// What it expects comes from the deployed commit itself (this checkout): live/version.json, and what
// the committed live/index.html carries. A build without link-preview tags (2.2.1 and older, e.g.
// after a rollback) is not asked for them; every build must match its version, boot and show its menu.
// Checks:
//   riftborn.us/version.json   the build committed in live/version.json of this checkout
//   riftborn.us/               boots with zero console errors and zero uncaught exceptions; the menu
//                              shows the title and START RUN; SETTINGS opens and closes again
//   Open Graph / Twitter tags  each tag the committed page has is served (og:url the live root), and
//                              the card image it names answers 200; not checked for a page without them
//   key files                  every same-origin file the committed and the served index.html link
//                              (icons, preloads, the CSS, the game bundle) plus /classic/ and /privacy/
//                              answer 200, and the served page still links everything the committed one does
//   dev.riftborn.us/           the password gate shows (it is never opened); version.json is the
//                              build committed in dev/version.json
// Every HTTP GET is tried up to 3 times (backing off) on a timeout, a network error, 408, 429 or 5xx,
// so one slow edge never pages anyone. Overlapping deploys: when something fails and main has moved
// on (a newer Build and deploy run is still going, or riftborn.us already serves the newer
// live/version.json on main), the result is "superseded" and the run passes without an alert: the
// newer deploy's own check covers riftborn.us (GitHub API, read only; only inside GitHub Actions).
// Never a scored run, never a sound: START RUN is only read, never clicked; before the page loads,
// audio is muted (riftborn-reborn-preferences-v1 {muted:true,master:0}, plus Chrome's --mute-audio)
// and the welcome popup counts as answered; every request from the page other than GET, HEAD or
// OPTIONS is blocked and reported (a menu that only loads has nothing to send). Results go to GitHub
// annotations and the job summary; any problem exits 1 (and the workflow's alert job pings the
// feedback Discord channel). Reads only; nothing is written anywhere.
//
//   npm ci --prefix tools/post-deploy-check --ignore-scripts      once (pinned Playwright, no browser:
//                                                                 it drives the installed Chrome or Edge)
//   node scripts/post-deploy-check.mjs                            riftborn.us + dev.riftborn.us
//   node scripts/post-deploy-check.mjs --live http://localhost:8791 --dev http://localhost:8792
//                                                                 local builds (scripts/serve-cf.mjs)
//   node scripts/post-deploy-check.mjs --dry-run                  offline: what the committed live/ and
//                                                                 dev/ expect, and whether every file the
//                                                                 committed page links is in live/
//   --base <dir>                                                  compare with another checkout's live/
//                                                                 and dev/ (e.g. an older release)
//   node scripts/post-deploy-check.mjs --alert                    the alert job: posts ALERT_TEXT to
//                                                                 DISCORD_WEBHOOK_URL, one line
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOSTS } from '../site.config.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const PLAYWRIGHT_DIR = 'tools/post-deploy-check';

/** Set in the page's localStorage before any of its scripts run: silent, and no first-visit popup. */
export const PRELOAD_STORAGE = Object.freeze({
  'riftborn-reborn-preferences-v1': JSON.stringify({ muted: true, master: 0 }),
  'riftborn-reborn-welcome-v1': '1'
});
/** And in its sessionStorage: this visit's patch notes count as shown (they would open over the menu). */
export const PRELOAD_SESSION = Object.freeze({ 'riftborn-reborn-whats-new-visit-v1': '1' });
/**
 * Console errors and failed requests that come from outside the build, reported as warnings rather
 * than failures. Keep this list short and remove an entry as soon as its cause is fixed.
 */
export const TOLERATED = Object.freeze([
  {
    pattern: /static\.cloudflareinsights\.com\/beacon\.min\.js/,
    reason: 'Cloudflare Web Analytics injects its beacon into every HTML page and the site CSP blocks it ' +
      '(players get the same console error; the CSP stays as it is): turn off the automatic Web ' +
      'Analytics setup on both Pages projects, then delete this entry'
  }
]);
/** The link-preview tags checked (Discord, iMessage, X and the rest), each only when the committed page has it. */
export const SOCIAL_TAGS = Object.freeze(['og:type', 'og:url', 'og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:image']);
/** The live site's other pages, checked for 200 next to the files index.html links. */
export const EXTRA_PAGES = Object.freeze(['/classic/', '/privacy/']);
/** The deploy workflow (pages.yml) whose newer runs on main supersede this check. */
export const DEPLOY_WORKFLOW = 'pages.yml';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_ANNOTATIONS = 8; // GitHub shows 10 error annotations per step; the rest go to the log
/** Every HTTP GET: this many tries, waiting RETRY_BACKOFF_MS, then twice that, between them. */
export const GET_TRIES = 3;
const RETRY_BACKOFF_MS = 2000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (tests/post-deploy-check.mjs)

/** The builds this checkout committed: { live, dev } from <output>/version.json (null when absent). */
export function expectedVersions(base = root) {
  const read = output => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(base, output, 'version.json'), 'utf8'));
      return value && typeof value.build === 'string' && value.build ? value : null;
    } catch {
      return null;
    }
  };
  return { live: read('live'), dev: read('dev') };
}

/** Why a served version.json is not the committed one (null when it is): every committed field must match. */
export function versionProblem(servedText, expected) {
  let served;
  try { served = JSON.parse(servedText); } catch { return 'is not JSON'; }
  if (!served || typeof served !== 'object') return 'is not a JSON object';
  const differs = Object.keys(expected).filter(key => served[key] !== expected[key]);
  if (!differs.length) return null;
  return `serves v${served.version} (build ${served.build}), the commit has v${expected.version} (build ${expected.build})`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = value => value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name) => ENTITIES[name]);
const attributes = tag => {
  const out = {};
  for (const match of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[match[1].toLowerCase()] = decode(match[3] ?? match[4]);
  return out;
};

/** <meta property|name="..." content="..."> -> Map(name -> content); the first of each name wins. */
export function metaTags(html) {
  const tags = new Map();
  for (const [tag] of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const name = (attrs.property || attrs.name || '').toLowerCase();
    if (name && attrs.content !== undefined && !tags.has(name)) tags.set(name, attrs.content);
  }
  return tags;
}

/**
 * Problems with the social tags of the live page ([] when link previews are complete). `required`:
 * the tags to check (the ones the committed page has, pageExpectations().social).
 */
export function socialProblems(tags, liveOrigin = HOSTS.live, required = SOCIAL_TAGS) {
  const problems = [];
  const missing = required.filter(name => !(tags.get(name) || '').trim());
  if (missing.length) problems.push(`missing ${missing.join(', ')} (link previews break)`);
  const url = tags.get('og:url');
  if (required.includes('og:url') && url && url !== `${HOSTS.live}/` && url !== `${liveOrigin}/`) problems.push(`og:url is ${url}, not ${HOSTS.live}/`);
  for (const name of ['og:image', 'twitter:image']) {
    const value = tags.get(name);
    if (required.includes(name) && value && !/^https:\/\/[^/]+\//.test(value)) problems.push(`${name} is not an absolute https:// URL: ${value}`);
  }
  return problems;
}

/** The card images the social tags name, without duplicates. */
export function socialImages(tags) {
  return [...new Set(['og:image', 'twitter:image'].map(name => tags.get(name)).filter(value => /^https?:\/\//.test(value || '')))];
}

/**
 * Same-origin files the page links in its markup: icons, preloads, module preloads, stylesheets,
 * scripts, images and <source srcset> candidates. -> absolute URLs, without duplicates.
 */
export function linkedFiles(html, pageUrl) {
  const page = new URL(pageUrl);
  const found = new Set();
  const add = value => {
    if (!value || /^(data|blob|javascript|mailto):/i.test(value)) return;
    let url;
    try { url = new URL(value, page); } catch { return; }
    if (url.origin === page.origin) { url.hash = ''; found.add(url.href); }
  };
  for (const [tag] of String(html).matchAll(/<(link|script|img|source)\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const kind = tag.slice(1).split(/[\s>]/)[0].toLowerCase();
    if (kind === 'link') {
      const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
      if (rel.some(r => ['icon', 'apple-touch-icon', 'preload', 'modulepreload', 'stylesheet', 'manifest'].includes(r))) add(attrs.href);
    } else {
      add(attrs.src);
      for (const candidate of (attrs.srcset || '').split(',')) add(candidate.trim().split(/\s+/)[0]);
    }
  }
  return [...found];
}

/**
 * What a committed live/index.html promises, so the check asks a build only for what it shipped:
 *   social      the SOCIAL_TAGS it carries ([] for a page from before the social card, e.g. 2.2.1)
 *   cardImages  the card image URLs its og:image / twitter:image name
 *   files       every same-origin file it links (icons, preloads, CSS, the game bundle) as
 *               path + query, e.g. /js/riftborn.9a695e9391.js
 */
export function pageExpectations(html) {
  const tags = metaTags(html);
  const page = 'https://committed.invalid/';
  return {
    social: SOCIAL_TAGS.filter(name => (tags.get(name) || '').trim()),
    cardImages: socialImages(tags),
    files: linkedFiles(html, page).map(url => { const u = new URL(url); return u.pathname + u.search; })
  };
}

/** pageExpectations() of <base>/live/index.html, or null when the checkout has no live page. */
export function committedPage(base = root) {
  let html;
  try { html = fs.readFileSync(path.join(base, 'live', 'index.html'), 'utf8'); } catch { return null; }
  return pageExpectations(html);
}

/**
 * Files the committed page links that its own live/ folder lacks ([] when complete): the offline
 * half of "key files" (--dry-run, tests).
 */
export function missingCommittedFiles(base = root, expect = committedPage(base)) {
  if (!expect) return ['live/index.html'];
  return expect.files.filter(file => !fs.existsSync(path.join(base, 'live', ...decodeURIComponent(file.split('?')[0]).split('/').filter(Boolean))));
}

/** True when served (a parsed version.json) carries every field of build. */
export const sameBuild = (served, build) => Boolean(served && build) && versionProblem(JSON.stringify(served), build) === null;

/**
 * Why this check is superseded by a newer deploy ('' when it is not): main has moved past the
 * checked commit and either a Build and deploy run for it is still going, or a site already serves
 * the newer build that main's live/ (or dev/) version.json names.
 *   checkedSha  the commit this check compares with (the deployed one)
 *   expected    { live, dev } that commit's version.json files
 *   newer       { sha, live, dev, running } main's head, its version.json files and how many
 *               deploy runs for another commit are not finished (newerDeploy())
 *   served      { live, dev } the version.json each site serves now (parsed, or null)
 *   sites       { live, dev } host names for the message
 */
export function supersededReason({ checkedSha, expected = {}, newer, served = {}, sites = {} }) {
  if (!checkedSha || !newer?.sha || newer.sha === checkedSha) return '';
  const short = newer.sha.slice(0, 7);
  const reasons = [];
  for (const output of ['live', 'dev']) {
    const theirs = newer[output];
    if (!theirs?.build || sameBuild(theirs, expected[output])) continue; // main has the same build: nothing newer here
    if (sameBuild(served[output], theirs)) reasons.push(`${sites[output] || output} serves v${theirs.version} (build ${theirs.build}), the newer ${output}/version.json on main (${short})`);
  }
  if (newer.running > 0) reasons.push(`a newer deploy of main (${short}) is still running`);
  return reasons.join('; ');
}

/** [real, tolerated] for a list of error or request lines (TOLERATED decides). */
export function splitTolerated(lines, tolerated = TOLERATED) {
  const real = [];
  const known = [];
  for (const line of lines) (tolerated.some(entry => entry.pattern.test(line)) ? known : real).push(line);
  return [real, known];
}
const toleratedNote = (known, tolerated = TOLERATED) => {
  if (!known.length) return '';
  const reasons = [...new Set(tolerated.filter(entry => known.some(line => entry.pattern.test(line))).map(entry => entry.reason))];
  return `${known.length} known, not from the build: ${reasons.join('; ')}`;
};

/** True when a file (not a page) came back as HTML: a missing file behind a catch-all page. */
export const servedAsPage = (url, contentType) => !/(\/|\.html?)$/i.test(new URL(url).pathname) && /^text\/html/i.test(contentType || '');

/** True for requests the check never lets the page send (anything that could write). */
export const isWriteRequest = method => !READ_METHODS.has(String(method).toUpperCase());

/** Accepts only a Discord webhook URL, so a mistyped secret never sends the alert anywhere else. */
export const isDiscordWebhook = value => /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(String(value || '').trim());

/** One line of text, any webhook URL removed, at most `max` characters (for logs, annotations, Discord). */
export function scrub(text, max = 400) {
  let s = String(text);
  s = s.replace(/https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\S*/gi, '[webhook url]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
export const escData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const escProp = s => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * The run's result as GitHub sees it:
 *   annotations  workflow commands (::error / ::warning / ::notice), errors capped per step
 *   summary      Markdown for $GITHUB_STEP_SUMMARY
 *   alert        the one-line Discord alert ('' when everything passed)
 * `checks` is [{ site, name, ok, detail, warning }] in the order they ran. `superseded` (a
 * supersededReason()): a newer deploy took over, so nothing failed is reported as a problem, there
 * is no alert, and the run passes.
 */
export function report({ checks, expected, live = HOSTS.live, runUrl = '', superseded = '' }) {
  const build = expected?.live ? `committed v${expected.live.version} (build ${expected.live.build})` : 'no committed build';
  const host = new URL(live).host;
  const cell = text => scrub(text, 300).replace(/\|/g, '\\|');
  if (superseded) {
    const headline = `${host}, ${build}: superseded, ${superseded}; that deploy's own check covers it`;
    const summary = [
      '### Post-deploy check: superseded',
      '',
      headline + '.',
      '',
      '| | Site | Check | Detail |',
      '| --- | --- | --- | --- |',
      ...checks.map(check => `| ${check.ok ? 'ok' : 'superseded'} | ${check.site} | ${cell(check.name)} | ${cell(check.ok ? check.warning || check.detail || '' : check.detail)} |`),
      ''
    ].join('\n');
    return { annotations: [`::notice title=Post-deploy check superseded::${escData(scrub(headline, 1000))}`], summary, alert: '', ok: true, superseded: true };
  }
  const failed = checks.filter(check => !check.ok);
  const warned = checks.filter(check => check.ok && check.warning);
  const annotations = [];
  failed.slice(0, MAX_ANNOTATIONS).forEach(check => {
    annotations.push(`::error title=${escProp(`Post-deploy check: ${check.site}`)}::${escData(scrub(`${check.name}: ${check.detail}`))}`);
  });
  if (failed.length > MAX_ANNOTATIONS) annotations.push(`::error title=Post-deploy check::${failed.length - MAX_ANNOTATIONS} more problem(s) in the job summary`);
  warned.slice(0, MAX_ANNOTATIONS).forEach(check => {
    annotations.push(`::warning title=${escProp(`Post-deploy check: ${check.site}`)}::${escData(scrub(`${check.name}: ${check.warning}`))}`);
  });
  const headline = failed.length
    ? `${host}, ${build}: ${failed.length} problem${failed.length === 1 ? '' : 's'}`
    : `${host}, ${build}: healthy, ${checks.length} checks passed`;
  annotations.push(`::notice title=Post-deploy check::${escData(scrub(headline, 1000))}`);
  const summary = [
    `### Post-deploy check: ${failed.length ? 'FAILED' : 'passed'}`,
    '',
    headline + '.',
    '',
    '| | Site | Check | Detail |',
    '| --- | --- | --- | --- |',
    ...checks.map(check => `| ${check.ok ? (check.warning ? 'warn' : 'ok') : '**FAIL**'} | ${check.site} | ${cell(check.name)} | ${cell(check.ok ? check.warning || check.detail || '' : check.detail)} |`),
    ''
  ].join('\n');
  const alert = failed.length
    ? scrub(`Riftborn post-deploy check FAILED: ${headline}. First: ${failed[0].site} ${failed[0].name}: ${failed[0].detail}`, 400) + (runUrl ? ` ${runUrl}` : '')
    : '';
  return { annotations, summary, alert, ok: !failed.length, superseded: false };
}

/** The Discord message: plain text, and it can never ping anyone. */
export const discordPayload = text => ({ content: scrub(text, 1900), allowed_mentions: { parse: [] } });

// ---------------------------------------------------------------------------------------------
// Network and browser checks

/** A status worth another try: no answer (timeout, network error), 408, 429 or any 5xx. */
export const retryable = status => status === 0 || status === 408 || status === 429 || status >= 500;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One HTTP GET -> { status, type, text, bytes, tries, error? } (status 0: no answer). Tried up to
 * `tries` times while the answer is retryable(), waiting backoffMs, 2 x backoffMs, ... in between.
 * `fresh` adds a cache-busting ?t= (the sites); API calls pass fresh: false.
 */
export async function get(url, { timeoutMs = 20000, tries = GET_TRIES, backoffMs = RETRY_BACKOFF_MS, fresh = true, headers = {}, fetchImpl = fetch, sleep = pause } = {}) {
  let result;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const target = fresh ? url + (url.includes('?') ? '&' : '?') + 't=' + Date.now() : url;
    try {
      const response = await fetchImpl(target, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      const body = Buffer.from(await response.arrayBuffer());
      result = { status: response.status, type: response.headers.get('content-type') || '', text: body.toString('utf8'), bytes: body.length };
    } catch (error) {
      result = { status: 0, type: '', text: '', bytes: 0, error: error?.name === 'TimeoutError' ? 'timed out' : String(error?.cause?.code || error?.message || error) };
    }
    result.tries = attempt;
    if (!retryable(result.status) || attempt === tries) break;
    await sleep(backoffMs * 2 ** (attempt - 1));
  }
  return result;
}
const statusText = result => `${result.error || `HTTP ${result.status}`}${result.tries > 1 ? ` (${result.tries} tries)` : ''}`;
const shortUrl = url => { const u = new URL(url); return u.pathname + u.search; };
const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };

/** version.json against the commit, retried a little (a deploy can take a moment to reach every edge). */
export async function checkVersion(origin, expected, { attempts = 3, delayMs = 10000, getImpl = get } = {}) {
  const url = `${origin}/version.json`;
  let detail = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await getImpl(url);
    detail = result.status !== 200 ? statusText(result) : versionProblem(result.text, expected);
    if (!detail) return { ok: true, detail: `v${expected.version} (build ${expected.build})${attempt > 1 ? `, on try ${attempt}` : ''}` };
    if (attempt < attempts) await pause(delayMs);
  }
  return { ok: false, detail };
}

/**
 * The live page's markup, social tags and linked files over plain HTTP, against what the committed
 * page promises (`expect`: pageExpectations() of the deployed commit's live/index.html). -> checks
 */
export async function checkLiveFiles(live, expect, { getImpl = get } = {}) {
  const checks = [];
  const site = new URL(live).host;
  const page = await getImpl(`${live}/`);
  if (page.status !== 200) return [{ site, name: 'game page', ok: false, detail: statusText(page) }];
  // A local run (--live http://localhost:...) checks its own copy of the card image, not riftborn.us.
  const local = url => (live !== HOSTS.live && url.startsWith(`${HOSTS.live}/`) ? live + url.slice(HOSTS.live.length) : url);
  const tags = metaTags(page.text);
  if (expect.social.length) {
    const social = socialProblems(tags, live, expect.social);
    checks.push({ site, name: 'Open Graph and Twitter tags', ok: !social.length, detail: social.length ? social.join('; ') : `${expect.social.length} tags, og:title "${tags.get('og:title')}"` });
  } else {
    checks.push({ site, name: 'Open Graph and Twitter tags', ok: true, detail: 'not required: the committed live/index.html has none (a build from before the social card)' });
  }
  if (expect.cardImages.length) {
    for (const image of [...new Set([...socialImages(tags), ...expect.cardImages].map(local))]) {
      const result = await getImpl(image);
      const ok = result.status === 200 && /^image\//.test(result.type) && result.bytes > 0;
      checks.push({ site, name: `card image ${shortUrl(image)}`, ok, detail: ok ? `${result.type}, ${Math.round(result.bytes / 1024)} KiB` : result.status === 200 ? `not an image (${result.type || 'no type'})` : statusText(result) });
    }
  }
  const served = linkedFiles(page.text, `${live}/`);
  const committed = expect.files.map(file => new URL(file, `${live}/`).href);
  const files = [...new Set([...committed, ...served, ...EXTRA_PAGES.map(p => `${live}${p}`)])];
  const unlinked = committed.filter(file => !served.includes(file)).map(shortUrl);
  const failures = unlinked.length ? [`the served page does not link ${unlinked.join(', ')} (the committed one does: an old cached page?)`] : [];
  for (const file of files) {
    const result = await getImpl(file);
    if (result.status !== 200) failures.push(`${shortUrl(file)} ${statusText(result)}`);
    else if (servedAsPage(file, result.type)) failures.push(`${shortUrl(file)} answers with an HTML page, not the file`);
  }
  checks.push({ site, name: 'key files', ok: !failures.length, detail: failures.length ? failures.join('; ') : `${files.length} files and pages answer 200` });
  return checks;
}

/**
 * The checkout this run compares with, as GitHub knows it: { repo, token, sha } inside GitHub Actions
 * (GITHUB_REPOSITORY, GITHUB_TOKEN, the checked-out commit), else null (no superseded detection).
 */
export function githubContext(base = root, env = process.env) {
  if (!env.GITHUB_ACTIONS || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) return null;
  let sha = '';
  try { sha = execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  return /^[0-9a-f]{40}$/.test(sha) ? { repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN || '', sha } : null;
}

/**
 * main as it is now, from the GitHub API (read only) -> { sha, live, dev, running } or null when
 * GitHub cannot say: main's head commit, its live/ and dev/ version.json (null when absent), and how
 * many runs of the deploy workflow on main for another commit than `sha` are not finished.
 */
export async function newerDeploy({ repo, token, sha }, { getImpl = get, workflow = DEPLOY_WORKFLOW } = {}) {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'riftborn-post-deploy-check', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const json = async (url, accept) => {
    const result = await getImpl(url, { fresh: false, headers: accept ? { ...headers, Accept: accept } : headers });
    return result.status === 200 ? parseJson(result.text) : null;
  };
  const main = await json(`${api}/branches/main`);
  const head = main?.commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(head || '')) return null;
  if (head === sha) return { sha: head, live: null, dev: null, running: 0 };
  const runs = await json(`${api}/actions/workflows/${workflow}/runs?branch=main&per_page=20`);
  const running = (Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : []).filter(run => run.status !== 'completed' && run.head_sha !== sha).length;
  const version = output => json(`${api}/contents/${output}/version.json?ref=${head}`, 'application/vnd.github.raw+json');
  return { sha: head, live: await version('live'), dev: await version('dev'), running };
}

/** supersededReason() for this run, asking GitHub and both sites ('' when not superseded or unknown). */
async function checkSuperseded({ github, expected, live, dev, getImpl = get }) {
  if (!github) return '';
  const newer = await newerDeploy(github, { getImpl });
  if (!newer || newer.sha === github.sha) return '';
  const served = {};
  for (const [output, origin] of [['live', live], ['dev', dev]]) {
    const result = await getImpl(`${origin}/version.json`);
    served[output] = result.status === 200 ? parseJson(result.text) : null;
  }
  return supersededReason({ checkedSha: github.sha, expected, newer, served, sites: { live: new URL(live).host, dev: new URL(dev).host } });
}

/** Playwright from tools/post-deploy-check, driving an installed Chrome (or Edge, or Playwright's own Chromium). */
export async function launchBrowser({ channel = process.env.CHECK_BROWSER_CHANNEL } = {}) {
  const entry = path.join(root, PLAYWRIGHT_DIR, 'node_modules', 'playwright-core', 'index.mjs');
  if (!fs.existsSync(entry)) throw new Error(`Playwright is not installed: run npm ci --prefix ${PLAYWRIGHT_DIR} --ignore-scripts`);
  const { chromium } = await import(pathToFileURL(entry).href);
  // Software WebGL (no GPU on the runner) and no sound whatever the page asks for.
  const args = ['--mute-audio', '--autoplay-policy=user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const tried = [];
  for (const option of channel ? [channel] : ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch({ channel: option, headless: true, args });
    } catch (error) {
      tried.push(`${option || 'playwright chromium'}: ${scrub(error.message, 160)}`);
    }
  }
  throw new Error(`No browser to drive (install Google Chrome or Edge): ${tried.join(' | ')}`);
}

/**
 * Opens one page in a fresh, muted context with writes blocked. -> { page, context, events }
 * events: errors (console errors and uncaught exceptions), blocked (write requests stopped), bad
 * (same-origin responses >= 400 and failed requests).
 */
async function openPage(browser, url) {
  const origin = new URL(url).origin;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', serviceWorkers: 'block' });
  await context.addInitScript(({ origin, storage, session }) => {
    if (location.origin !== origin) return;
    try { for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value); } catch {}
    try { for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value); } catch {}
  }, { origin, storage: PRELOAD_STORAGE, session: PRELOAD_SESSION });
  const events = { errors: [], blocked: [], bad: [] };
  const aborted = new Set();
  await context.route('**/*', route => {
    const request = route.request();
    if (isWriteRequest(request.method())) {
      events.blocked.push(`${request.method()} ${request.url()}`);
      aborted.add(request);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('console', message => {
    // Requests this check blocked log ERR_BLOCKED_BY_CLIENT; they are reported as 'nothing sent' instead.
    if (message.type() !== 'error' || message.text().includes('ERR_BLOCKED_BY_CLIENT')) return;
    const where = message.location()?.url;
    events.errors.push(`console: ${message.text()}${where ? ` (${shortUrl(where)})` : ''}`);
  });
  page.on('pageerror', error => events.errors.push(`uncaught: ${error.message}`));
  page.on('requestfailed', request => {
    if (!aborted.has(request)) events.bad.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', response => {
    if (response.status() >= 400 && new URL(response.url()).origin === origin) events.bad.push(`${response.request().method()} ${response.url()} HTTP ${response.status()}`);
  });
  return { page, context, events };
}

/** One try at the live game in the browser. -> { checks, problems } (problems: why this try failed) */
async function browseLive(browser, live, outDir) {
  const site = new URL(live).host;
  const checks = [];
  const { page, context, events } = await openPage(browser, `${live}/`);
  const step = async (name, run) => {
    if (checks.some(check => !check.ok)) return; // an earlier step failed: the rest would only time out
    try {
      const detail = await run();
      checks.push({ site, name, ok: true, detail });
    } catch (error) {
      checks.push({ site, name, ok: false, detail: scrub(error.message.split('\n')[0], 300) });
    }
  };
  const started = Date.now();
  try {
    await step('page loads', async () => {
      const response = await page.goto(`${live}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!response || response.status() !== 200) throw new Error(`HTTP ${response?.status() ?? 'no response'}`);
      return `HTTP 200, "${await page.title()}"`;
    });
    await step('menu shows START RUN', async () => {
      // The button reads LOADING THE RIFT… (disabled) until the world is built. Read, never clicked.
      await page.waitForFunction(() => {
        const start = document.getElementById('start');
        return start && !start.disabled && start.getClientRects().length > 0 && start.textContent.replace(/\s+/g, ' ').trim().toUpperCase() === 'START RUN';
      }, null, { timeout: 90000, polling: 250 });
      return `ready after ${((Date.now() - started) / 1000).toFixed(1)} s`;
    });
    await step('menu shows the title', async () => {
      const title = await page.evaluate(() => {
        const h1 = document.querySelector('#menu h1, h1.brand-title');
        if (!h1) return { found: false };
        const box = h1.getBoundingClientRect();
        const labels = [h1.textContent, ...[...h1.querySelectorAll('[aria-label]')].map(el => el.getAttribute('aria-label'))].join(' ');
        const images = [...h1.querySelectorAll('img')];
        return {
          found: true,
          visible: box.width > 0 && box.height > 0 && getComputedStyle(h1).visibility !== 'hidden',
          named: /RIFT\s*BORN/i.test(labels.replace(/\s+/g, '')),
          images: images.length,
          broken: images.filter(img => !img.complete || !img.naturalWidth).map(img => img.currentSrc || img.src)
        };
      });
      if (!title.found) throw new Error('no title heading in the menu');
      if (!title.visible) throw new Error('the title heading is not visible');
      if (!title.named) throw new Error('the title does not read RIFTBORN');
      if (title.broken.length) throw new Error(`title image(s) did not load: ${title.broken.map(shortUrl).join(', ')}`);
      return title.images ? `RIFTBORN, ${title.images} image(s) loaded` : 'RIFTBORN';
    });
    await step('SETTINGS opens and closes', async () => {
      // A menu button that never starts a run: proves the menu answers clicks.
      await page.click('#menuSettings', { timeout: 10000 });
      await page.waitForSelector('#settings:not(.hidden)', { state: 'visible', timeout: 10000 });
      await page.click('#closeSettings', { timeout: 10000 });
      await page.waitForSelector('#settings', { state: 'hidden', timeout: 10000 });
      return 'opened and closed';
    });
    // Late errors (the demo run behind the menu keeps playing) show up within a few seconds.
    await page.waitForTimeout(4000);
    await step('still on the menu, muted', async () => {
      const state = await page.evaluate(() => {
        let prefs = null;
        try { prefs = JSON.parse(localStorage.getItem('riftborn-reborn-preferences-v1') || 'null'); } catch {}
        const menu = document.getElementById('menu');
        const style = menu && getComputedStyle(menu);
        const shown = !!menu && !menu.classList.contains('hidden') && style.display !== 'none' && style.visibility !== 'hidden' && menu.getBoundingClientRect().height > 0;
        return { menu: shown && document.body.classList.contains('menu-open'), muted: prefs?.muted === true };
      });
      if (!state.menu) throw new Error('the menu is gone (did a run start?)');
      if (!state.muted) throw new Error('the muted preference did not hold');
      return 'menu open, sound muted';
    });
    const [errors, knownErrors] = splitTolerated(events.errors);
    const [bad, knownBad] = splitTolerated(events.bad);
    checks.push({
      site, name: 'zero console errors', ok: !errors.length, warning: toleratedNote(knownErrors),
      detail: errors.length ? `${errors.length}: ${errors.slice(0, 3).join(' | ')}` : 'none, no uncaught exceptions'
    });
    checks.push({
      site, name: 'no failed requests', ok: !bad.length, warning: toleratedNote(knownBad),
      detail: bad.length ? `${bad.length}: ${bad.slice(0, 3).join(' | ')}` : 'every request answered'
    });
    checks.push({
      site, name: 'nothing sent', ok: !events.blocked.length,
      detail: events.blocked.length ? `the menu tried to send ${events.blocked.slice(0, 3).join(' | ')} (blocked)` : 'no POST/PUT/DELETE from the page'
    });
  } finally {
    if (checks.some(check => !check.ok) && outDir) {
      try {
        fs.mkdirSync(outDir, { recursive: true });
        await page.screenshot({ path: path.join(outDir, `${site}-${Date.now()}.png`) });
      } catch {}
    }
    await context.close();
  }
  return { checks, problems: checks.filter(check => !check.ok) };
}

/** The test build: the password gate shows (never opened); errors there are warnings. -> checks */
async function browseDevGate(browser, dev) {
  const site = new URL(dev).host;
  const { page, context, events } = await openPage(browser, `${dev}/`);
  try {
    const response = await page.goto(`${dev}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!response || response.status() !== 200) return [{ site, name: 'password gate shows', ok: false, detail: `HTTP ${response?.status() ?? 'no response'}` }];
    await page.waitForSelector('#devGate', { state: 'visible', timeout: 20000 });
    await page.waitForSelector('#devGatePass', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(1500);
    const [noise, known] = splitTolerated([...events.errors, ...events.bad, ...events.blocked.map(b => `sent ${b} (blocked)`)]);
    const warning = [noise.length ? `${noise.length} error(s) on the gate page: ${noise.slice(0, 3).join(' | ')}` : '', toleratedNote(known)].filter(Boolean).join('; ');
    return [{ site, name: 'password gate shows', ok: true, detail: 'gate and password field visible', warning }];
  } catch (error) {
    return [{ site, name: 'password gate shows', ok: false, detail: scrub(error.message.split('\n')[0], 300) }];
  } finally {
    await context.close();
  }
}

/** Every check, in order. -> { checks, expected, superseded } (superseded: supersededReason(), or '') */
export async function runChecks({ live = HOSTS.live, dev = HOSTS.dev, base = root, outDir, log = () => {}, github = githubContext(base) } = {}) {
  const expected = expectedVersions(base);
  const expect = committedPage(base);
  const checks = [];
  const liveSite = new URL(live).host;
  const devSite = new URL(dev).host;
  const superseded = async () => {
    const reason = await checkSuperseded({ github, expected, live, dev });
    if (reason) log(`Superseded: ${reason}.`);
    return reason;
  };
  log(`Checking ${live} (committed v${expected.live?.version} build ${expected.live?.build}) and ${dev} (v${expected.dev?.version} build ${expected.dev?.build}).`);
  log(expect ? `The committed live/index.html has ${expect.social.length ? `${expect.social.length} social tags` : 'no social tags (not required)'}, ${expect.cardImages.length} card image(s) and links ${expect.files.length} same-origin file(s).` : 'This checkout has no live/index.html.');
  log(github ? `Superseded detection: on (checked commit ${github.sha.slice(0, 7)}, ${github.repo}).` : 'Superseded detection: off (only inside GitHub Actions).');
  if (expected.live) checks.push({ site: liveSite, name: 'version.json', ...(await checkVersion(live, expected.live)) });
  else checks.push({ site: liveSite, name: 'version.json', ok: false, detail: 'live/version.json in this checkout has no build to compare with' });
  // A different build on riftborn.us: if a newer deploy already took over, its own check covers it.
  if (!checks[0].ok) {
    const reason = await superseded();
    if (reason) return { checks, expected, superseded: reason };
  }
  if (expect) checks.push(...(await checkLiveFiles(live, expect)));
  else checks.push({ site: liveSite, name: 'game page', ok: false, detail: 'live/index.html is not in this checkout: nothing to compare the served page with' });
  log(`HTTP checks done (${checks.filter(c => c.ok).length}/${checks.length} passed); starting the browser.`);
  let browser;
  try {
    browser = await launchBrowser();
    log(`Browser: ${browser.version()}`);
  } catch (error) {
    checks.push({ site: liveSite, name: 'browser', ok: false, detail: scrub(error.message, 400) });
  }
  if (browser) {
    try {
      // One retry with a fresh context, so a network blip does not page anyone; a pass on the second
      // try is still reported as a warning with what went wrong first.
      let first = await browseLive(browser, live, outDir);
      if (first.problems.length) {
        log(`First browser try failed (${first.problems.map(p => p.name).join(', ')}); trying once more.`);
        const second = await browseLive(browser, live, outDir);
        if (!second.problems.length) {
          const note = `passed on the second try; first try: ${first.problems.map(p => `${p.name}: ${p.detail}`).join(' | ')}`;
          second.checks[0] = { ...second.checks[0], warning: note };
        }
        first = second;
      }
      checks.push(...first.checks);
      checks.push(...(await browseDevGate(browser, dev)));
    } finally {
      await browser.close();
    }
  }
  if (expected.dev) checks.push({ site: devSite, name: 'version.json', ...(await checkVersion(dev, expected.dev)) });
  else checks.push({ site: devSite, name: 'version.json', ok: true, detail: '', warning: 'dev/version.json is not in this checkout; not compared' });
  // Something failed: a deploy for a later commit may have landed (or started) while this ran.
  if (checks.some(check => !check.ok)) {
    const reason = await superseded();
    if (reason) return { checks, expected, superseded: reason };
  }
  return { checks, expected, superseded: '' };
}

/**
 * The offline half (--dry-run): what the committed live/ and dev/ expect, and whether every file
 * the committed page links is in live/. Nothing is fetched. -> { lines, ok }
 */
export function dryRun(base = root) {
  const expected = expectedVersions(base);
  const expect = committedPage(base);
  const missing = missingCommittedFiles(base, expect);
  const lines = [
    `live/version.json: ${expected.live ? `v${expected.live.version} (build ${expected.live.build}, built ${expected.live.builtAt || '?'})` : 'MISSING or without a build'}`,
    `dev/version.json:  ${expected.dev ? `v${expected.dev.version} (build ${expected.dev.build})` : 'not in this checkout (dev not compared)'}`
  ];
  if (expect) {
    lines.push(`social tags required: ${expect.social.length ? expect.social.join(', ') : 'none (the committed page has no Open Graph or Twitter tags)'}`);
    lines.push(`card images: ${expect.cardImages.length ? expect.cardImages.join(', ') : 'none required'}`);
    lines.push(`key files (${expect.files.length} linked by the committed page, plus ${EXTRA_PAGES.join(' and ')}): ${expect.files.join(', ')}`);
  }
  lines.push(missing.length ? `MISSING from live/: ${missing.join(', ')}` : 'every file the committed page links is in live/');
  lines.push('always: version.json match, the page boots with zero console errors, the menu shows the title and START RUN, SETTINGS opens and closes');
  return { lines, ok: Boolean(expected.live) && !missing.length };
}

// ---------------------------------------------------------------------------------------------
// Entry points

/** The alert job: one line to the feedback channel's webhook; never prints the webhook URL. */
export async function sendAlert({ webhook = process.env.DISCORD_WEBHOOK_URL, text = process.env.ALERT_TEXT, fetchImpl = fetch } = {}) {
  if (!String(text || '').trim()) return { sent: false, note: 'no alert text: nothing to send' };
  if (!String(webhook || '').trim()) return { sent: false, note: 'DISCORD_WEBHOOK_URL is not set for this job: no Discord alert' };
  if (!isDiscordWebhook(webhook)) return { sent: false, note: 'DISCORD_WEBHOOK_URL is not a Discord webhook URL: no alert sent' };
  try {
    const response = await fetchImpl(String(webhook).trim(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(discordPayload(text)), signal: AbortSignal.timeout(15000)
    });
    return response.ok ? { sent: true, note: `Discord alert sent (HTTP ${response.status})` } : { sent: false, note: `Discord answered HTTP ${response.status}: no alert` };
  } catch (error) {
    return { sent: false, note: `Discord alert failed: ${error?.name === 'TimeoutError' ? 'timed out' : scrub(error?.cause?.code || error?.message || error, 120)}` };
  }
}

function flag(name) {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  const url = new URL(value || 'x:'); // throws on a missing or broken value
  if (!/^https?:$/.test(url.protocol) || url.origin !== value) throw new Error(`${name} must be an exact http(s) origin without a path, e.g. http://localhost:8791`);
  return value;
}

async function main() {
  const env = process.env;
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
  if (process.argv.includes('--alert')) {
    const text = String(env.ALERT_TEXT || '');
    const result = await sendAlert({ text: runUrl && text && !text.includes('/actions/runs/') ? `${text} ${runUrl}` : text });
    console.log(result.sent ? result.note : `::warning title=Post-deploy alert::${escData(result.note)}`);
    return;
  }
  const baseAt = process.argv.indexOf('--base');
  const base = baseAt < 0 ? root : path.resolve(process.argv[baseAt + 1] || '');
  if (baseAt >= 0 && (!process.argv[baseAt + 1] || process.argv[baseAt + 1].startsWith('--') || !fs.existsSync(path.join(base, 'live')))) {
    throw new Error('--base needs a checkout folder that has live/ (and usually dev/), e.g. --base ../riftborn-2.2.1');
  }
  if (process.argv.includes('--dry-run')) {
    const { lines, ok } = dryRun(base);
    console.log(`Post-deploy check, dry run (offline; nothing fetched) against ${base}:`);
    for (const line of lines) console.log(`  ${line}`);
    if (!ok) process.exitCode = 1;
    return;
  }
  const live = flag('--live') || HOSTS.live;
  const dev = flag('--dev') || HOSTS.dev;
  const outDir = process.env.CHECK_OUT_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'riftborn-post-deploy-check');
  const { checks, expected, superseded } = await runChecks({ live, dev, base, outDir, log: message => console.log(scrub(message, 1000)) });
  const result = report({ checks, expected, live, runUrl, superseded });
  for (const check of checks) console.log(`${check.ok ? (check.warning ? 'warn' : ' ok ') : superseded ? 'skip' : 'FAIL'}  ${check.site}  ${check.name}: ${scrub(check.ok ? check.warning || check.detail : check.detail, 600)}`);
  if (process.env.GITHUB_ACTIONS) {
    for (const line of result.annotations) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary + '\n');
    if (process.env.GITHUB_OUTPUT && result.alert) fs.appendFileSync(process.env.GITHUB_OUTPUT, `alert=${result.alert.replace(/[\r\n]+/g, ' ')}\n`);
  }
  if (superseded) {
    console.log(`Post-deploy check superseded: ${scrub(superseded, 600)}. Not a failure; the newer deploy's own check covers it.`);
    return;
  }
  if (!result.ok) {
    console.error(`Post-deploy check FAILED (${checks.filter(c => !c.ok).length} problem(s)).${fs.existsSync(outDir) ? ` Screenshots: ${outDir}` : ''}`);
    process.exitCode = 1;
    return;
  }
  console.log('Post-deploy check passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(scrub(error?.message || error, 2000));
    process.exitCode = 1;
  }
}
