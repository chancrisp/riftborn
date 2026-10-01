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
// Every preview is checked before it is staged: a safe name that starts with its build's version,
// the password gate (the game module loads only after it opens), noindex, and HOST CONFIG giving the
// preview's own address nothing (never scores; feedback and accounts stay off too, the Worker only
// answers riftborn.us and dev.riftborn.us). It gets the dev build's headers (strict CSP with the hash
// of every inline script, X-Robots-Tag noindex), a 404.html and a robots.txt.
//
//   node scripts/pages-previews.mjs   stages every previews/<name>/ into _cf/previews/<name>/ and
//                                     writes _cf/previews/previews.json (what the deploy reads)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOSTS, PAGES_PROJECTS, PRODUCTION_BRANCH } from '../site.config.mjs';
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

/** { scores, feedback, accounts } that the page's HOST CONFIG block sets at `url` (run for real). */
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
  return { scores: sandbox.RIFTBORN_SCORE_API_BASE, feedback: sandbox.RIFTBORN_FEEDBACK_API_BASE, accounts: sandbox.RIFTBORN_ACCOUNT_API_BASE };
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
    for (const [service, base] of Object.entries(services)) if (base) problems.push(`${at}: HOST CONFIG gives ${previewOrigin(name)} ${service} (${base}); a preview never posts scores and has no feedback or accounts`);
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

const scrub = (text, secrets) => secrets.filter(secret => secret && String(secret).length >= 8).reduce((out, secret) => out.split(String(secret)).join('***'), String(text));

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

/** Every preview-environment deployment of the riftborn-dev project (all pages). */
export async function listPreviewDeployments({ token, accountId, project = PAGES_PROJECTS.dev, fetchImpl = fetch, maxPages = 40 }) {
  if (project !== PAGES_PROJECTS.dev) throw new Error(`Previews live only in ${PAGES_PROJECTS.dev}, never ${project}.`);
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await cloudflareApi({ token, accountId, fetchImpl, route: `/pages/projects/${project}/deployments?env=preview&page=${page}&per_page=${PER_PAGE}` });
    const result = Array.isArray(body.result) ? body.result : [];
    all.push(...result);
    const pages = Number(body.result_info?.total_pages);
    if (!result.length || (Number.isFinite(pages) && pages > 0 ? page >= pages : result.length < PER_PAGE)) return all;
  }
  throw new Error(`More than ${maxPages} pages of preview deployments in ${project}.`);
}

/** Deletes one riftborn-dev deployment (force: even while a branch alias points at it). */
export async function deleteDeployment({ token, accountId, project = PAGES_PROJECTS.dev, id, force = false, fetchImpl = fetch }) {
  if (project !== PAGES_PROJECTS.dev) throw new Error(`Previews live only in ${PAGES_PROJECTS.dev}, never ${project}.`);
  if (!/^[0-9a-f-]{8,64}$/i.test(String(id))) throw new Error(`Not a deployment id: ${JSON.stringify(id)}`);
  await cloudflareApi({ token, accountId, fetchImpl, method: 'DELETE', route: `/pages/projects/${project}/deployments/${id}${force ? '?force=true' : ''}` });
}

const branchOf = deployment => deployment?.deployment_trigger?.metadata?.branch || '';
const previewDeployments = (deployments, branch) => deployments
  .filter(deployment => deployment?.environment === 'preview' && branchOf(deployment) === branch)
  .sort((a, b) => String(b.created_on || '').localeCompare(String(a.created_on || '')));

/** True when the newest deployment of the preview's branch succeeded with this exact staged build. */
export function isUnchanged(deployments, preview) {
  const [latest] = previewDeployments(deployments, preview.name);
  return Boolean(latest && latest.latest_stage?.status === 'success' &&
    String(latest.deployment_trigger?.metadata?.commit_message || '').includes(`${DIGEST_TAG}${String(preview.digest).slice(0, 16)}`));
}

/** A deployment this tool made (its commit message is previewCommitMessage's). */
export const madeByPreviews = deployment => String(deployment?.deployment_trigger?.metadata?.commit_message || '').startsWith(`Preview ${branchOf(deployment)}: `);

/**
 * The deployments to delete -> [{ id, branch, force, why }]. Only preview-environment deployments
 * that this tool made (madeByPreviews), on a branch other than the production one, are ever
 * considered (anything else in riftborn-dev is left alone):
 *   a branch not in previews/   every deployment (force: its alias goes too, the link stops working)
 *   a current preview           the deployments older than its newest successful one (not forced:
 *                               the alias stays on the newest)
 */
export function cleanupPlan(deployments, names) {
  const current = new Set(names);
  const ours = deployments.filter(deployment => deployment?.environment === 'preview' && madeByPreviews(deployment));
  const branches = new Set(ours.map(branchOf));
  const plan = [];
  for (const branch of [...branches].sort()) {
    if (!branch || branch === PRODUCTION_BRANCH) continue;
    const list = previewDeployments(ours, branch);
    if (!current.has(branch)) {
      for (const deployment of list) plan.push({ id: deployment.id, branch, force: true, why: 'preview removed' });
      continue;
    }
    const newest = list.findIndex(deployment => deployment.latest_stage?.status === 'success');
    if (newest === -1) continue;
    for (const deployment of list.slice(newest + 1)) plan.push({ id: deployment.id, branch, force: false, why: 'older build' });
  }
  return plan;
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
    process.exitCode = 1;
  }
}
