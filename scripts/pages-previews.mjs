// Preview links: the password-gated test build of one source branch, staged by the source repo's
// .tools/deploy-preview.mjs into previews/<name>/ and published by .github/workflows/previews.yml as
// a branch deployment of the Cloudflare Pages project "riftborn-dev"
// (scripts/cloudflare-pages-deploy.mjs --previews), with a stable address:
//   https://<name>.riftborn-dev.pages.dev/
// next to dev.riftborn.us (the release candidate: that project's production branch), never in its
// place. <name> always starts with the version of the build inside it, v<major>-<minor>-<patch>
// (2.4.0 -> v2-4-0), plus an optional tag for side-by-side previews of one version (v2-4-0-logo); a
// folder whose name does not start with its build's version is refused, so a link never shows
// another version. previews/ is the whole truth for the links this tool makes: a folder removed there
// has its deployments deleted, so its link stops working (nothing else in riftborn-dev is touched).
// Production (riftborn.us, dev.riftborn.us, github.io) never reads previews/
// (scripts/build-pages.mjs), and pages.yml ignores pushes that only change previews/.
//
// Deleting is not trusted on its own (2026-10-01: v2-3-1-looks kept serving its old build after its
// folder went, with nothing in the run to say why). After the deletions the removed branch's link is
// checked (version.json and the page, cache-busted) for about a minute (only 404/410 counts as gone);
// if it still serves a build (any), a "preview removed" page (the tombstone: plain HTML, noindex,
// version.json {"removed":true}, commit message "Preview <name>: removed") is deployed to that
// branch, which moves its alias off the old build. A removed branch whose newest deployment is its tombstone is done: the tombstone stays,
// only older deployments are deleted, and it is never deployed again. A branch staged again deploys
// over its tombstone as usual. Every previews/<name> ever removed in git history is checked too, so a
// link Cloudflare no longer lists a deployment for (but still serves) is caught as well. Everything
// is reported as GitHub annotations ("Preview cleanup"), readable without signing in.
//
// Every preview is checked before it is staged: a safe name that starts with its build's version,
// the password gate (the game module loads only after it opens), noindex, and HOST CONFIG giving the
// preview's own address nothing (never scores, not even leaderboard reads; feedback and accounts
// stay off too, the Worker only answers riftborn.us and dev.riftborn.us). It gets the dev build's
// headers (strict CSP with the hash of every inline script, X-Robots-Tag noindex), a 404.html and a
// robots.txt.
//
//   node scripts/pages-previews.mjs   stages every previews/<name>/ into _cf/previews/<name>/ and
//                                     writes _cf/previews/previews.json (what the deploy reads)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOSTS, PAGES_PROJECTS, PRODUCTION_BRANCH } from '../site.config.mjs';
import { fetchFresh } from './cloudflare-pages-verify.mjs';
import { buildHeaders, inlineScripts } from './pages-headers.mjs';
import { notFoundPage } from './pages-templates.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const PREVIEWS_DIR = 'previews';
export const PREVIEWS_OUT = '_cf/previews';
export const PREVIEW_NAME_MAX = 28;
// What the deploy writes into each preview deployment's commit message, so the next run can tell
// that a preview is already served as staged (and skip redeploying it).
export const DIGEST_TAG = 'digest ';

const PREVIEW_NAME = /^v\d+-\d+-\d+(-[a-z][a-z0-9]*)?$/;

/**
 * Why `name` cannot be a preview (null when it can). The same rule as the source repo's
 * .tools/deploy-preview.mjs: v<major>-<minor>-<patch> of the build, optionally followed by one tag
 * (lowercase letters and digits, starting with a letter): v2-4-0, v2-4-0-logo. It is used as is for
 * the Cloudflare branch alias (at most 28 characters), so it is never the production branch (a
 * deploy to it replaces dev.riftborn.us) and never 8 hex digits (Cloudflare's per-deployment
 * addresses look like that); those two keep their own messages.
 */
export function previewNameProblem(name) {
  const text = String(name ?? '');
  if (text === PRODUCTION_BRANCH) return `preview name "${text}" is the production branch of ${PAGES_PROJECTS.dev} (dev.riftborn.us)`;
  if (/^[0-9a-f]{8}$/.test(text)) return `preview name "${text}" looks like a Cloudflare deployment id`;
  if (!PREVIEW_NAME.test(text) || text.length > PREVIEW_NAME_MAX) {
    return `preview name ${JSON.stringify(text)}: use v<major>-<minor>-<patch> of the build, optionally -<tag> (lowercase letters and digits, starting with a letter), at most ${PREVIEW_NAME_MAX} characters, e.g. v2-4-0 or v2-4-0-logo`;
  }
  return null;
}

/** What every preview name of a build of `version` starts with: 2.4.0 -> v2-4-0 (null when `version` is not MAJOR.MINOR.PATCH). */
export const previewNamePrefix = version => (/^\d+\.\d+\.\d+$/.test(String(version ?? '')) ? `v${String(version).split('.').join('-')}` : null);

/** Why the preview `name` cannot hold a build of `version` (null when it is v<version> or v<version>-<tag>). The same rule as the source repo's. */
export function previewVersionProblem(name, version) {
  const prefix = previewNamePrefix(version);
  if (!prefix) return `version ${JSON.stringify(version ?? null)} is not MAJOR.MINOR.PATCH`;
  const text = String(name ?? '');
  if (text !== prefix && !text.startsWith(`${prefix}-`)) return `preview name ${JSON.stringify(text)} does not start with ${prefix}, the version of its build (v${version})`;
  return null;
}

/** The preview's address: the branch alias of the riftborn-dev project. */
export const previewOrigin = name => `https://${name}.${PAGES_PROJECTS.dev}.pages.dev`;

const storage = () => {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => void map.set(key, String(value)), removeItem: key => void map.delete(key) };
};

/**
 * { scores, reads, feedback, accounts } that the page's HOST CONFIG block sets at `url` (run for
 * real). reads (v2.3.1, RIFTBORN_SCORE_READ_BASE) is where the leaderboards are read; the game reads
 * from the score base when it is absent or "" (builds before 2.3.1 never set it), and so does this.
 */
export function hostServices(html, url) {
  const blocks = inlineScripts(html).filter(script => script.includes('HOST CONFIG'));
  if (blocks.length !== 1) throw new Error(`expected one HOST CONFIG block, found ${blocks.length}`);
  const u = new URL(url);
  const sandbox = {
    location: { href: u.href, origin: u.origin, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash },
    URLSearchParams, localStorage: storage(), sessionStorage: storage()
  };
  sandbox.window = sandbox;
  vm.runInNewContext(blocks[0], sandbox, { timeout: 1000 });
  const scores = sandbox.RIFTBORN_SCORE_API_BASE;
  return { scores, reads: sandbox.RIFTBORN_SCORE_READ_BASE || scores, feedback: sandbox.RIFTBORN_FEEDBACK_API_BASE, accounts: sandbox.RIFTBORN_ACCOUNT_API_BASE };
}

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** Problems with the preview folder `dir` named `name` ([] when it may be published). */
export function previewProblems(dir, name) {
  const at = `${PREVIEWS_DIR}/${name}`;
  const nameProblem = previewNameProblem(name);
  if (nameProblem) return [`${at}: ${nameProblem}`];
  const indexFile = path.join(dir, 'index.html');
  if (!fs.existsSync(indexFile)) return [`${at}: no index.html`];
  const problems = [];
  const version = readJson(path.join(dir, 'version.json'));
  const info = readJson(path.join(dir, 'preview.json'));
  if (typeof version?.build !== 'string' || !version.build) problems.push(`${at}: version.json has no build`);
  // The link carries the version: the name must start with v<version> of the build in the folder.
  const hasVersion = Boolean(previewNamePrefix(version?.version));
  if (!hasVersion) problems.push(`${at}: version.json has no version (MAJOR.MINOR.PATCH)`);
  else {
    const versionProblem = previewVersionProblem(name, version.version);
    if (versionProblem) problems.push(`${at}: ${versionProblem}: restage it with the source repo's .tools/deploy-preview.mjs`);
  }
  if (!info) problems.push(`${at}: no preview.json (stage previews with the source repo's .tools/deploy-preview.mjs)`);
  else {
    if (info.name !== name) problems.push(`${at}: preview.json is for ${JSON.stringify(info.name)}`);
    if (version?.build && info.build !== version.build) problems.push(`${at}: preview.json build ${JSON.stringify(info.build)} is not version.json's ${JSON.stringify(version.build)}`);
    if (hasVersion && info.version !== version.version) problems.push(`${at}: preview.json version ${JSON.stringify(info.version ?? null)} is not version.json's ${JSON.stringify(version.version)}`);
  }
  const html = fs.readFileSync(indexFile, 'utf8');
  if (!html.includes('id="devGate"') || !inlineScripts(html).some(script => script.includes('riftborn-dev-gate'))) problems.push(`${at}: index.html has no password gate`);
  if (/<script\b(?=[^>]*\btype=["']?module)(?=[^>]*\bsrc=)[^>]*>/i.test(html) || /<link\b[^>]*rel=["']?modulepreload/i.test(html)) problems.push(`${at}: index.html loads the game before the password gate opens`);
  if (!html.includes('<meta name="robots" content="noindex,nofollow">')) problems.push(`${at}: index.html is not noindex`);
  try {
    const services = hostServices(html, `${previewOrigin(name)}/`);
    for (const [service, base] of Object.entries(services)) if (base) problems.push(`${at}: HOST CONFIG gives ${previewOrigin(name)} ${service} (${base}); a preview never posts or reads scores and has no feedback or accounts`);
  } catch (error) {
    problems.push(`${at}: HOST CONFIG: ${error.message}`);
  }
  return problems;
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, base, out);
    else out.push(path.relative(base, file).split(path.sep).join('/'));
  }
  return out.sort();
}

/** SHA-256 over every file of a staged preview (names and contents) except preview.json. */
export function previewDigest(dir) {
  const hash = crypto.createHash('sha256');
  for (const file of walk(dir)) {
    if (file === 'preview.json') continue;
    hash.update(`${file}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

/**
 * Checks and stages every previews/<name>/ of `base` into `out`/_cf/previews/<name>/ (nothing else
 * under `out` is touched). Any problem in any preview stops it with every problem listed.
 * -> { project, previews: [{ name, origin, version, build, digest, dir }] } (also written to
 * _cf/previews/previews.json)
 */
export function stagePreviews({ base = root, out = base } = {}) {
  const from = path.join(base, PREVIEWS_DIR);
  const to = path.join(out, ...PREVIEWS_OUT.split('/'));
  const names = fs.existsSync(from) ? fs.readdirSync(from, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
  const problems = names.flatMap(name => previewProblems(path.join(from, name), name));
  if (problems.length) throw new Error(`Previews not published:\n  - ${problems.join('\n  - ')}`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  const connect = [HOSTS.api, HOSTS.workersDev]; // the same policy as dev.riftborn.us
  const previews = names.map(name => {
    const dir = path.join(to, name);
    fs.cpSync(path.join(from, name), dir, { recursive: true });
    fs.rmSync(path.join(dir, '.nojekyll'), { force: true });
    fs.writeFileSync(path.join(dir, '404.html'), notFoundPage());
    fs.writeFileSync(path.join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    fs.writeFileSync(path.join(dir, '_headers'), buildHeaders(dir, { connect, noindex: true }).text);
    const digest = previewDigest(dir);
    const info = { ...readJson(path.join(dir, 'preview.json')), digest };
    fs.writeFileSync(path.join(dir, 'preview.json'), JSON.stringify(info, null, 2) + '\n');
    return { name, origin: previewOrigin(name), version: info.version || '', build: info.build, digest, dir: `${PREVIEWS_OUT}/${name}` };
  });
  const staged = { project: PAGES_PROJECTS.dev, previews };
  fs.writeFileSync(path.join(to, 'previews.json'), JSON.stringify(staged, null, 2) + '\n');
  return staged;
}

/** The staged list (_cf/previews/previews.json under `base`). */
export function readStagedPreviews(base = root) {
  const staged = readJson(path.join(base, ...PREVIEWS_OUT.split('/'), 'previews.json'));
  if (!staged || !Array.isArray(staged.previews)) throw new Error(`${PREVIEWS_OUT}/previews.json is missing: run node scripts/pages-previews.mjs first.`);
  if (staged.project !== PAGES_PROJECTS.dev) throw new Error(`${PREVIEWS_OUT}/previews.json is for project ${JSON.stringify(staged.project)}, not ${PAGES_PROJECTS.dev}.`);
  for (const preview of staged.previews) {
    const problem = previewNameProblem(preview.name) || previewVersionProblem(preview.name, preview.version);
    if (problem) throw new Error(problem);
  }
  return staged;
}

/** The deployment's commit message: which build, plus the digest the next run compares with. */
export const previewCommitMessage = preview => `Preview ${preview.name}: ${preview.version ? 'v' + preview.version + ' ' : ''}build ${preview.build} ${DIGEST_TAG}${String(preview.digest).slice(0, 16)}`;

// ---- Cloudflare Pages deployments of riftborn-dev (REST API, Cloudflare Pages: Edit token) --------

export const CF_API = 'https://api.cloudflare.com/client/v4';

/** `text` with every secret (8+ characters) replaced by ***. */
export const scrub = (text, secrets) => secrets.filter(secret => secret && String(secret).length >= 8).reduce((out, secret) => out.split(String(secret)).join('***'), String(text));

/**
 * For anything written where others read it (annotations, the job summary): scrub(), plus anything
 * shaped like a credential even when it was not passed in (a bearer token, a 32-hex account id).
 * Deployment ids (UUIDs), builds and digests are not secrets and stay readable.
 */
export const scrubPublic = (text, secrets = []) => scrub(text, secrets)
  .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer ***')
  .replace(/(?<![0-9a-f-])[0-9a-f]{32}(?![0-9a-f-])/gi, '***');

/** One Cloudflare API call -> the JSON body. Errors never carry the token or the account id. */
export async function cloudflareApi({ token, accountId, route, method = 'GET', fetchImpl = fetch, timeoutMs = 30000 }) {
  const where = `${method} /accounts/***${route.split('?')[0]}`;
  let response;
  let body = null;
  try {
    response = await fetchImpl(`${CF_API}/accounts/${accountId}${route}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    body = await response.json().catch(() => null);
  } catch (error) {
    throw new Error(scrub(`Cloudflare API ${where}: ${error?.name === 'TimeoutError' ? 'timed out' : String(error?.cause?.code || error?.message || error)}`, [token, accountId]));
  }
  if (!response.ok || body?.success !== true) {
    const detail = (Array.isArray(body?.errors) ? body.errors : []).map(error => `${error.code}: ${error.message}`).join('; ');
    throw new Error(scrub(`Cloudflare API ${where}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`, [token, accountId]));
  }
  return body;
}

const PER_PAGE = 25;
const number = value => (value === null || value === undefined || value === '' ? NaN : Number(value));

/**
 * Every preview-environment deployment of the riftborn-dev project (all pages, each id once). The
 * array also carries a non-enumerable `listing` ({ pages, totalCount, duplicates }) for the report.
 * Assumptions, hardened where the API leaves room:
 * - env=preview returns the deployments of every non-production branch, wrangler direct uploads
 *   included (newest first). An entry without `environment` is taken as preview (it came from an
 *   env=preview listing); the cleanup still never touches a production one or the production branch.
 * - Paging: result_info.total_pages when given; else total_count with the per_page Cloudflare says
 *   it used (it may cap ours); else a page shorter than that per_page is the last. A deployment seen
 *   twice (pages shifting while a deploy lands) is kept once.
 * - Whatever a listing still misses is caught by the link check (previewCleanup's `known`).
 */
export async function listPreviewDeployments({ token, accountId, project = PAGES_PROJECTS.dev, fetchImpl = fetch, maxPages = 40 }) {
  if (project !== PAGES_PROJECTS.dev) throw new Error(`Previews live only in ${PAGES_PROJECTS.dev}, never ${project}.`);
  const byId = new Map();
  const listing = { pages: 0, totalCount: null, duplicates: 0 };
  for (let page = 1; page <= maxPages; page++) {
    const body = await cloudflareApi({ token, accountId, fetchImpl, route: `/pages/projects/${project}/deployments?env=preview&page=${page}&per_page=${PER_PAGE}` });
    const result = Array.isArray(body.result) ? body.result : [];
    listing.pages = page;
    for (const deployment of result) {
      const key = deployment?.id ? String(deployment.id) : `#unidentified-${byId.size}`;
      if (byId.has(key)) { listing.duplicates++; continue; }
      byId.set(key, deployment && typeof deployment === 'object' && !deployment.environment ? { ...deployment, environment: 'preview' } : deployment);
    }
    const info = body.result_info || {};
    const totalPages = number(info.total_pages);
    const totalCount = number(info.total_count);
    const perPage = number(info.per_page) > 0 ? number(info.per_page) : PER_PAGE;
    if (Number.isFinite(totalCount)) listing.totalCount = totalCount;
    const last = !result.length || (Number.isFinite(totalPages) && totalPages > 0 ? page >= totalPages
      : Number.isFinite(totalCount) && totalCount >= 0 ? page * perPage >= totalCount
        : result.length < perPage);
    if (last) {
      const all = [...byId.values()];
      Object.defineProperty(all, 'listing', { value: listing, enumerable: false });
      return all;
    }
  }
  throw new Error(`More than ${maxPages} pages of preview deployments in ${project}.`);
}

/** Deletes one riftborn-dev deployment (force: even while a branch alias points at it). */
export async function deleteDeployment({ token, accountId, project = PAGES_PROJECTS.dev, id, force = false, fetchImpl = fetch }) {
  if (project !== PAGES_PROJECTS.dev) throw new Error(`Previews live only in ${PAGES_PROJECTS.dev}, never ${project}.`);
  if (!/^[0-9a-f-]{8,64}$/i.test(String(id))) throw new Error(`Not a deployment id: ${JSON.stringify(id)}`);
  await cloudflareApi({ token, accountId, fetchImpl, method: 'DELETE', route: `/pages/projects/${project}/deployments/${id}${force ? '?force=true' : ''}` });
}

const messageOf = deployment => String(deployment?.deployment_trigger?.metadata?.commit_message || '').trim();
const ALIAS = new RegExp(`^https://([a-z0-9][a-z0-9-]*)\\.${PAGES_PROJECTS.dev.replace(/[-.]/g, '\\$&')}\\.pages\\.dev/?$`);
/**
 * The deployment's branch: deployment_trigger.metadata.branch (what wrangler's --branch sets on a
 * direct upload); failing that its branch alias (only the newest deployment of a branch has one);
 * failing that the name in this tool's commit message ("Preview <name>: ...").
 */
export function branchOf(deployment) {
  const branch = deployment?.deployment_trigger?.metadata?.branch;
  if (branch) return String(branch);
  for (const alias of Array.isArray(deployment?.aliases) ? deployment.aliases : []) {
    const match = ALIAS.exec(String(alias));
    if (match && !/^[0-9a-f]{8}$/.test(match[1])) return match[1];
  }
  return /^Preview (\S+): /.exec(messageOf(deployment))?.[1] || '';
}

const previewDeployments = (deployments, branch) => deployments
  .filter(deployment => deployment?.environment === 'preview' && branchOf(deployment) === branch)
  .sort((a, b) => String(b.created_on || '').localeCompare(String(a.created_on || '')));

/** True when the newest deployment of the preview's branch succeeded with this exact staged build. */
export function isUnchanged(deployments, preview) {
  const [latest] = previewDeployments(deployments, preview.name);
  return Boolean(latest && latest.latest_stage?.status === 'success' &&
    messageOf(latest).includes(`${DIGEST_TAG}${String(preview.digest).slice(0, 16)}`));
}

/** A deployment this tool made (its commit message is previewCommitMessage's or tombstoneCommitMessage's). */
export const madeByPreviews = deployment => messageOf(deployment).startsWith(`Preview ${branchOf(deployment)}: `);

// ---- the tombstone: what a removed preview's link shows when deleting its deployments did not stop it

export const TOMBSTONES_OUT = '_cf/preview-tombstones';
/** The tombstone deployment's commit message (how the next run recognises it). */
export const tombstoneCommitMessage = name => `Preview ${name}: removed`;
/** A deployment that is the "preview removed" page of its branch. */
export const isTombstone = deployment => Boolean(deployment) && madeByPreviews(deployment) && messageOf(deployment) === tombstoneCommitMessage(branchOf(deployment));
/** The build a preview deployment holds, from its commit message ("... build <build> digest ..."; null when none). */
export const buildOf = deployment => /\bbuild (\S+)/.exec(messageOf(deployment))?.[1] || null;

/**
 * Why `name` cannot be a branch alias this tool deploys a tombstone to (null when it can): any
 * name a preview ever had, including ones from before the version names (lowercase letters, digits
 * and inner dashes, at most 28 characters), never the production branch and never 8 hex digits.
 */
export function aliasNameProblem(name) {
  const text = String(name ?? '');
  if (text === PRODUCTION_BRANCH) return `"${text}" is the production branch of ${PAGES_PROJECTS.dev} (dev.riftborn.us)`;
  if (/^[0-9a-f]{8}$/.test(text)) return `"${text}" looks like a Cloudflare deployment id`;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(text) || text.length > PREVIEW_NAME_MAX) return `${JSON.stringify(text)} is not a branch alias of ${PAGES_PROJECTS.dev}`;
  return null;
}

const TOMBSTONE_STYLE = 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0912;color:#e8e4f5;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:24px 16px;text-align:center}h1{margin:0 0 12px;color:#8f5bff;font-size:1.4rem}a{color:#b896ff}code{color:#fff}';
const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

/** The tombstone's files for branch `name`: no script, nothing to gate, noindex, version.json says removed. */
export function tombstoneFiles(name) {
  const problem = aliasNameProblem(name);
  if (problem) throw new Error(problem);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Riftborn preview removed</title>
<style>${TOMBSTONE_STYLE}</style>
</head>
<body>
<main>
<h1>This preview was removed</h1>
<p>The Riftborn preview <code>${escapeHtml(name)}</code> is no longer available.</p>
<p><a href="${escapeHtml(HOSTS.live)}/">Play Riftborn</a></p>
</main>
</body>
</html>
`;
  const style = `'sha256-${crypto.createHash('sha256').update(TOMBSTONE_STYLE).digest('base64')}'`;
  return {
    'index.html': html,
    '404.html': html,
    'version.json': JSON.stringify({ preview: name, removed: true, build: null }) + '\n',
    'robots.txt': 'User-agent: *\nDisallow: /\n',
    '_headers': ['/*',
      '  Cache-Control: no-store',
      `  Content-Security-Policy: default-src 'none'; style-src ${style}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      '  X-Robots-Tag: noindex, nofollow',
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: no-referrer', ''].join('\n')
  };
}

/** Writes the tombstone of `name` into `base`/_cf/preview-tombstones/<name>/ -> that folder (relative, as Wrangler gets it). */
export function stageTombstone(name, base = root) {
  const files = tombstoneFiles(name);
  const dir = path.join(base, ...TOMBSTONES_OUT.split('/'), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  return `${TOMBSTONES_OUT}/${name}`;
}

// ---- the cleanup ------------------------------------------------------------------------------------

/**
 * What the cleanup does, from the preview deployments (listPreviewDeployments), the staged preview
 * `names` and `known` (preview names removed in git history: removedPreviewNames). Only
 * preview-environment deployments that this tool made (madeByPreviews), on a branch other than the
 * production one, are ever deleted (anything else in riftborn-dev is left alone):
 *   a branch not in previews/   every deployment (force: its alias goes too, the link stops working),
 *                               then its link is checked for about a minute (check "wait")
 *     ...whose newest deployment is its tombstone (succeeded): done. The tombstone stays, the older
 *                               deployments go (not forced: the alias is on the tombstone), and the
 *                               link is checked once; the tombstone is never deployed again
 *   a current preview           the deployments older than its newest successful one (not forced:
 *                               the alias stays on the newest); over a tombstone too, once staged again
 *   a known removed name        with nothing of this tool's listed: the link is checked once (it may
 *                               still serve a build Cloudflare no longer lists, or one whose commit
 *                               message this tool does not recognise: `foreign`, never deleted)
 * -> { deletions: [{ id, branch, force, why }],
 *      removed: [{ branch, found, ids, tombstone, oldBuild, check: 'wait' | 'once', fromHistory, foreign, foreignSample }],
 *      current: [{ branch, found, older }] }
 */
export function previewCleanup(deployments, names, { known = [] } = {}) {
  const current = new Set(names);
  const previews = deployments.filter(deployment => deployment?.environment === 'preview');
  const ours = previews.filter(madeByPreviews);
  const branches = new Set(ours.map(branchOf));
  const deletions = [];
  const removed = [];
  const kept = new Map();
  for (const branch of [...branches].sort()) {
    if (!branch || branch === PRODUCTION_BRANCH) continue;
    const list = previewDeployments(ours, branch);
    // What its link last served: the newest preview build that deployed (a failed one never held
    // the alias). Only named in the report: the link check counts any build served as serving.
    const oldBuild = buildOf(list.find(deployment => !isTombstone(deployment) && deployment.latest_stage?.status === 'success'));
    const ids = list.map(deployment => deployment.id);
    if (!current.has(branch)) {
      const [newest] = list;
      if (isTombstone(newest) && newest.latest_stage?.status === 'success') {
        for (const deployment of list.slice(1)) deletions.push({ id: deployment.id, branch, force: false, why: 'older than its "preview removed" page' });
        removed.push({ branch, found: list.length, ids, tombstone: newest.id, oldBuild, check: 'once', fromHistory: false, foreign: 0 });
        continue;
      }
      for (const deployment of list) deletions.push({ id: deployment.id, branch, force: true, why: 'preview removed' });
      removed.push({ branch, found: list.length, ids, tombstone: null, oldBuild, check: 'wait', fromHistory: false, foreign: 0 });
      continue;
    }
    const newest = list.findIndex(deployment => deployment.latest_stage?.status === 'success');
    const older = newest === -1 ? [] : list.slice(newest + 1);
    for (const deployment of older) deletions.push({ id: deployment.id, branch, force: false, why: 'older build' });
    kept.set(branch, { branch, found: list.length, older: older.length });
  }
  for (const branch of [...new Set(known)].sort()) {
    if (current.has(branch) || branches.has(branch) || aliasNameProblem(branch)) continue;
    // Deployments on that branch that this tool does not recognise as its own (another commit
    // message): never deleted, but named in the report (they may be why a link kept serving).
    const others = previewDeployments(previews, branch);
    const sample = others[0] ? `${others[0].id} "${messageOf(others[0]).slice(0, 80) || '(no commit message)'}"` : null;
    removed.push({ branch, found: 0, ids: [], tombstone: null, oldBuild: null, check: 'once', fromHistory: true, foreign: others.length, foreignSample: sample });
  }
  const currentList = [...current].sort().map(branch => kept.get(branch) || { branch, found: 0, older: 0 });
  return { deletions, removed, current: currentList };
}

/** The deployments to delete -> [{ id, branch, force, why }] (previewCleanup's deletions). */
export const cleanupPlan = (deployments, names) => previewCleanup(deployments, names).deletions;

const runGit = (args, cwd) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(String(result.stderr || result.error?.message || `git ${args[0]} failed`).trim().split('\n')[0]);
  return result.stdout;
};

/**
 * Every previews/<name> folder ever removed in this checkout's git history -> { names, shallow }.
 * Trees only (no blobs: works in previews.yml's blobless checkout), renames off so git never needs
 * file contents. `shallow` is true when the history is cut short (only what it holds is seen).
 */
export function removedPreviewNames(base = root, { git = runGit } = {}) {
  const shallow = git(['rev-parse', '--is-shallow-repository'], base).trim() === 'true';
  const out = git(['log', '--no-renames', '--diff-filter=D', '--name-only', '--format=', '--', `${PREVIEWS_DIR}/*/index.html`, `${PREVIEWS_DIR}/*/preview.json`], base);
  const at = new RegExp(`^${PREVIEWS_DIR}/([^/]+)/(?:index\\.html|preview\\.json)$`);
  const names = [...new Set(out.split(/\r?\n/).map(line => at.exec(line.trim())?.[1]).filter(Boolean))].sort();
  return { names, shallow };
}

// ---- the link check -----------------------------------------------------------------------------------

// What Cloudflare answers on a branch alias with no deployment behind it (checked 2026-10-01: 404 for
// the page and version.json of a made-up riftborn-dev alias).
const GONE = new Set([404, 410]);

/**
 * What https://<name>.riftborn-dev.pages.dev/ serves now (version.json and the page, cache-busted;
 * plain GETs, no credentials). Only asked about removed previews, whose link should serve nothing, so
 * any build counts: the alias can stick to an older deployment than the newest listed (the newest
 * failed) or to one the listing missed. `oldBuild` (the newest build that deployed) only names it in
 * the detail. Never throws. -> { state, build, detail }:
 *   tombstone  version.json says removed (the "preview removed" page)
 *   serving    version.json serves a build (any), or the page still holds a password-gated build
 *   removed    version.json and the page both answer 404 or 410
 *   error      anything else (a failed request, a 5xx, a redirect, an unexpected answer): not shown to
 *              be gone, so waitForAlias keeps checking and the run warns instead of calling it removed
 */
export async function aliasState({ name, oldBuild = null, fetchImpl = fetch, timeoutMs = 15000 }) {
  try {
    const origin = previewOrigin(name);
    const [version, page] = await Promise.all([fetchFresh(fetchImpl, `${origin}/version.json`, timeoutMs), fetchFresh(fetchImpl, `${origin}/`, timeoutMs)]);
    const http = result => (result.status ? `HTTP ${result.status}` : String(result.error || 'no answer'));
    let info = null;
    if (version.status === 200) { try { info = JSON.parse(version.text); } catch { info = null; } }
    if (info?.removed === true) return { state: 'tombstone', build: null, detail: 'it serves the "preview removed" page' };
    const build = typeof info?.build === 'string' && info.build ? info.build : null;
    if (build) return { state: 'serving', build, detail: `version.json serves build ${build}${oldBuild && build !== oldBuild ? `; the newest deployed build listed was ${oldBuild}` : ''}` };
    if (page.status === 200 && String(page.text).includes('id="devGate"')) return { state: 'serving', build: null, detail: `version.json ${http(version)}, but the page still serves a password-gated build` };
    const answers = `version.json ${http(version)}, page ${http(page)}`;
    return { state: GONE.has(version.status) && GONE.has(page.status) ? 'removed' : 'error', build: null, detail: answers };
  } catch (error) {
    return { state: 'error', build: null, detail: String(error?.message || error) };
  }
}

/** True when the link no longer serves the preview (gone, or showing its tombstone). */
export const linkGone = result => result.state === 'removed' || result.state === 'tombstone';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** aliasState until linkGone or `attempts` run out (about a minute by default). -> its last result + { attempts, seconds } */
export async function waitForAlias({ attempts = 12, delayMs = 5000, sleep = pause, now = Date.now, ...options }) {
  const start = now();
  let result = { state: 'error', build: null, detail: 'not checked' };
  let attempt = 0;
  while (attempt < attempts) {
    attempt++;
    result = await aliasState(options);
    if (linkGone(result)) break;
    if (attempt < attempts) await sleep(delayMs);
  }
  return { ...result, attempts: attempt, seconds: Math.round((now() - start) / 1000) };
}

// ---- annotations (GitHub workflow commands: shown on the run page, readable without signing in) ----

const escapeData = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = text => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
/** "::notice title=...::message" (or warning / error), scrubbed (scrubPublic) and escaped. */
export function workflowCommand(level, title, message, secrets = []) {
  if (!['notice', 'warning', 'error'].includes(level)) throw new Error(`Unknown annotation level ${level}`);
  return `::${level} title=${escapeProperty(scrubPublic(title, secrets))}::${escapeData(scrubPublic(message, secrets))}`;
}
// GitHub shows at most 10 annotations of each level per step: the rest are folded into the 10th.
const ANNOTATIONS_PER_LEVEL = 10;
/** The annotation lines for `notes` ([{ level, message }]), at most 10 per level. */
export function annotationLines(notes, { title = 'Preview cleanup', secrets = [] } = {}) {
  const lines = [];
  for (const level of ['error', 'warning', 'notice']) {
    const messages = notes.filter(note => note.level === level).map(note => note.message);
    const shown = messages.length > ANNOTATIONS_PER_LEVEL
      ? [...messages.slice(0, ANNOTATIONS_PER_LEVEL - 1), `${messages.length - ANNOTATIONS_PER_LEVEL + 1} more: ${messages.slice(ANNOTATIONS_PER_LEVEL - 1).join(' | ')}`]
      : messages;
    for (const message of shown) lines.push(workflowCommand(level, title, message, secrets));
  }
  return lines;
}

function main() {
  // RIFTBORN_PAGES_OUT (local tests only), as in scripts/build-pages.mjs.
  const outOverride = (process.env.RIFTBORN_PAGES_OUT || '').trim();
  if (outOverride && (process.env.CI || process.env.GITHUB_ACTIONS)) throw new Error('RIFTBORN_PAGES_OUT is for local tests only.');
  const staged = stagePreviews({ out: outOverride ? path.resolve(outOverride) : root });
  if (!staged.previews.length) console.log(`No previews in ${PREVIEWS_DIR}/: nothing to publish (any preview links left in ${PAGES_PROJECTS.dev} are removed by the deploy).`);
  for (const preview of staged.previews) console.log(`${PREVIEWS_OUT}/${preview.name}: v${preview.version || '?'} build ${preview.build} -> ${preview.origin}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error.message);
    // On the run page too (readable without signing in): a staging failure means no deploy and no cleanup.
    if (process.env.GITHUB_ACTIONS === 'true') console.log(workflowCommand('error', 'Preview links', error.message));
    process.exitCode = 1;
  }
}
