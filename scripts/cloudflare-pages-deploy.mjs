// Deploys the Cloudflare Pages outputs built by scripts/build-pages.mjs with Wrangler:
//   _cf/live     -> project "riftborn"           (https://riftborn.us)
//   _cf/dev      -> project "riftborn-dev"       (https://dev.riftborn.us)
// and, with --feedback, only the feedback inbox:
//   _cf/feedback -> project "riftborn-feedback"  (https://feedback.riftborn.us; its custom domain is
//                   connected by scripts/cloudflare-pages-domains.mjs)
// Each project is created first (production branch main); "already exists" is fine.
// Run by .github/workflows/pages.yml (only on main, and only when the repository variable
// CF_PAGES_ENABLED is 1), with CLOUDFLARE_API_TOKEN (secret) and CLOUDFLARE_ACCOUNT_ID (variable):
// the game's two by the "cloudflare" job, the inbox by its own "feedback" job, so a problem with the
// inbox never stops the game's deploy, its check or the github.io handoff.
//
// Wrangler runs with the production API token, so it is never fetched at deploy time: it is
// exact-pinned in tools/wrangler/package.json + package-lock.json (integrity hashes), installed by
// the job with `npm ci --prefix tools/wrangler --ignore-scripts`, run from there with this Node (no
// npx, no shell), and handed only the environment it needs (wranglerEnv) instead of all of it.
//
//   node scripts/cloudflare-pages-deploy.mjs --dry-run              prints the plan; runs nothing
//   node scripts/cloudflare-pages-deploy.mjs --feedback --dry-run   the same for the inbox
//
// --previews (the "previews" job of .github/workflows/previews.yml, after node scripts/pages-previews.mjs):
// the per-branch preview links instead. Each _cf/previews/<name> becomes a branch deployment of
// project "riftborn-dev" (--branch <name>, never main: that is dev.riftborn.us), served at
// https://<name>.riftborn-dev.pages.dev/; a preview already served as staged is not redeployed
// (PREVIEW_REDEPLOY=1 redeploys all). Then, through the Cloudflare API with the same token, the
// preview deployments this made for a branch no longer in previews/ are deleted (its link stops
// working), and so are the older deployments of each current preview. Production deployments, and
// any deployment this did not make, are never touched. Each removed branch's link is then checked
// (plain GETs, about a minute): one that still serves its old build gets a "preview removed" page
// deployed over it (the tombstone, scripts/pages-previews.mjs), kept and never redeployed by later
// runs. Every previews/<name> removed in git history is checked as well. The cleanup is reported as
// GitHub annotations ("Preview cleanup": readable on the run page without signing in) and in the
// job summary.
//   node scripts/cloudflare-pages-deploy.mjs --previews --dry-run   the plan; nothing is called
//   node scripts/cloudflare-pages-deploy.mjs --previews --dry-run --deployments=<listing.json>
//       the exact deletions, link checks and tombstones for a saved deployment listing (an array,
//       or the API's { result: [...] })
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGES_PROJECTS, PRODUCTION_BRANCH } from '../site.config.mjs';
import {
  PREVIEWS_DIR, TOMBSTONES_OUT, aliasNameProblem, annotationLines, branchOf, deleteDeployment, isUnchanged, linkGone, listPreviewDeployments,
  madeByPreviews, previewCleanup, previewCommitMessage, previewNameProblem, previewOrigin, readStagedPreviews, removedPreviewNames, scrubPublic,
  stageTombstone, tombstoneCommitMessage, waitForAlias
} from './pages-previews.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WRANGLER_DIR = 'tools/wrangler';
/** The pinned Wrangler version (tools/wrangler/package.json; the lockfile pins the whole tree). */
export const WRANGLER_VERSION = JSON.parse(fs.readFileSync(path.join(root, WRANGLER_DIR, 'package.json'), 'utf8')).dependencies.wrangler;
const WRANGLER_BIN = path.join(root, WRANGLER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/**
 * [project, output] per deploy: the game's two (riftborn.us first: the github.io handoff waits for
 * it), and the feedback inbox on its own (another job, which nothing waits for).
 */
export const DEPLOY_OUTPUTS = Object.freeze({
  game: Object.freeze([[PAGES_PROJECTS.live, '_cf/live'], [PAGES_PROJECTS.dev, '_cf/dev']]),
  feedback: Object.freeze([[PAGES_PROJECTS.feedback, '_cf/feedback']])
});

/** The Wrangler commands for one deploy (`site`: game or feedback), in order. */
export function deployPlan({ sha = '', message = '', site = 'game' } = {}) {
  const outputs = DEPLOY_OUTPUTS[site];
  if (!outputs) throw new Error(`Unknown deploy ${site}: ${Object.keys(DEPLOY_OUTPUTS).join(' or ')}.`);
  const commit = [
    ...(/^[0-9a-f]{7,40}$/i.test(sha) ? ['--commit-hash', sha] : []),
    ...(message ? ['--commit-message', String(message).split('\n')[0].slice(0, 100)] : []),
    '--commit-dirty=true'
  ];
  return outputs.map(([project, dir]) => ({
    project,
    dir,
    create: ['pages', 'project', 'create', project, '--production-branch', PRODUCTION_BRANCH],
    deploy: ['pages', 'deploy', dir, '--project-name', project, '--branch', PRODUCTION_BRANCH, ...commit]
  }));
}

/**
 * The Wrangler command per staged preview: a branch deployment of riftborn-dev, whose alias is
 * https://<name>.riftborn-dev.pages.dev/. A name that is not a safe alias (or is the production
 * branch, which would replace dev.riftborn.us) is refused.
 */
export function previewDeployPlan(previews, { sha = '' } = {}) {
  return previews.map(preview => {
    const problem = previewNameProblem(preview.name);
    if (problem || preview.name === PRODUCTION_BRANCH) throw new Error(problem || `Refusing to deploy a preview to ${PRODUCTION_BRANCH}.`);
    const dir = `_cf/previews/${preview.name}`;
    return {
      name: preview.name,
      dir,
      deploy: ['pages', 'deploy', dir, '--project-name', PAGES_PROJECTS.dev, '--branch', preview.name,
        ...(/^[0-9a-f]{7,40}$/i.test(sha) ? ['--commit-hash', sha] : []), '--commit-message', previewCommitMessage(preview), '--commit-dirty=true']
    };
  });
}

// What Wrangler may see: the Cloudflare credentials plus what a process needs to run (paths,
// home and temp folders, CI, proxies). Every other variable (GitHub tokens, other secrets) stays out.
const PASS_THROUGH = [
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CI',
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'
];
export function wranglerEnv(env = process.env) {
  const out = {};
  for (const name of PASS_THROUGH) if (env[name] !== undefined) out[name] = env[name];
  out.WRANGLER_SEND_METRICS = 'false';
  return out;
}

/** Why this environment must not deploy to production ([] when it may). */
export function deployRefusals(env = process.env) {
  const refusals = [];
  if ((env.CI || env.GITHUB_ACTIONS) && env.GITHUB_REF !== `refs/heads/${PRODUCTION_BRANCH}`) {
    refusals.push(`Refusing to deploy ${env.GITHUB_REF || 'an unknown ref'} to production: only refs/heads/${PRODUCTION_BRANCH} deploys riftborn.us, dev.riftborn.us and feedback.riftborn.us.`);
  }
  if (!env.CLOUDFLARE_API_TOKEN) refusals.push('Set the CLOUDFLARE_API_TOKEN secret (it needs Cloudflare Pages: Edit).');
  if (!/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) refusals.push('Set the CLOUDFLARE_ACCOUNT_ID repository variable.');
  return refusals;
}

const alreadyExists = output => /already exists|8000002/i.test(output);

function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, WRANGLER_DIR, 'node_modules', 'wrangler', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function wrangler(args) {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: root, encoding: 'utf8', env: wranglerEnv(process.env), shell: false, maxBuffer: 64 * 1024 * 1024
  });
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? result.error.message : ''}`;
  return { ok: result.status === 0, output };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const plan = deployPlan({ sha: process.env.COMMIT_SHA || process.env.GITHUB_SHA, message: process.env.COMMIT_MESSAGE, site: process.argv.includes('--feedback') ? 'feedback' : 'game' });
  for (const step of plan) {
    if (!fs.existsSync(path.join(root, step.dir, 'index.html')) || !fs.existsSync(path.join(root, step.dir, '_headers'))) {
      if (!dryRun) throw new Error(`${step.dir} is missing or incomplete: run npm run build:pages first.`);
    }
  }
  if (dryRun) {
    for (const step of plan) console.log(`wrangler@${WRANGLER_VERSION} ${step.create.join(' ')}\nwrangler@${WRANGLER_VERSION} ${step.deploy.join(' ')}`);
    return;
  }
  const refusals = deployRefusals(process.env);
  if (refusals.length) throw new Error(refusals.join('\n'));
  const installed = installedVersion();
  if (installed !== WRANGLER_VERSION) {
    throw new Error(`Wrangler ${WRANGLER_VERSION} is not installed in ${WRANGLER_DIR} (found ${installed || 'none'}): run npm ci --prefix ${WRANGLER_DIR} --ignore-scripts.`);
  }
  for (const step of plan) {
    const created = wrangler(step.create);
    if (created.ok) console.log(`Created Cloudflare Pages project ${step.project}.`);
    else if (alreadyExists(created.output)) console.log(`Cloudflare Pages project ${step.project} already exists.`);
    else throw new Error(`Could not create Cloudflare Pages project ${step.project}:\n${created.output}`);
    const deployed = wrangler(step.deploy);
    process.stdout.write(deployed.output);
    if (!deployed.ok) throw new Error(`Deploying ${step.dir} to ${step.project} failed.`);
    console.log(`Deployed ${step.dir} to Cloudflare Pages project ${step.project}.`);
  }
}

/**
 * The Wrangler command that puts the "preview removed" page (stageTombstone) on branch `name` of
 * riftborn-dev, so its alias stops serving the old build. Refused for the production branch (that
 * is dev.riftborn.us) and anything that is not a branch alias.
 */
export function tombstonePlan(name, { sha = '' } = {}) {
  const problem = aliasNameProblem(name);
  if (problem) throw new Error(`Refusing a "preview removed" page: ${problem}.`);
  const dir = `${TOMBSTONES_OUT}/${name}`;
  return {
    name,
    dir,
    deploy: ['pages', 'deploy', dir, '--project-name', PAGES_PROJECTS.dev, '--branch', name,
      ...(/^[0-9a-f]{7,40}$/i.test(sha) ? ['--commit-hash', sha] : []), '--commit-message', tombstoneCommitMessage(name), '--commit-dirty=true']
  };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** How long a removed branch's link is watched after its deletions (and after a tombstone): about a minute. */
export const LINK_WAIT = Object.freeze({ attempts: 12, delayMs: 5000 });
const waitSeconds = wait => Math.round(((wait.attempts - 1) * wait.delayMs) / 1000);

/** One line about a deployment listing: preview deployments per branch, and how many this did not make. */
export function listingReport(deployments, { source = '' } = {}) {
  const info = deployments.listing;
  const ours = deployments.filter(deployment => deployment?.environment === 'preview' && madeByPreviews(deployment));
  const counts = new Map();
  for (const deployment of ours) counts.set(branchOf(deployment), (counts.get(branchOf(deployment)) || 0) + 1);
  const otherCounts = new Map();
  for (const deployment of deployments) {
    if (ours.includes(deployment)) continue;
    const branch = branchOf(deployment) || '(no branch)';
    otherCounts.set(branch, (otherCounts.get(branch) || 0) + 1);
  }
  const others = deployments.length - ours.length;
  const how = info ? ` (${plural(info.pages, 'page')}${info.totalCount !== null ? `, Cloudflare total_count ${info.totalCount}` : ''}${info.duplicates ? `, ${info.duplicates} listed twice` : ''})` : '';
  const byBranch = map => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([branch, count]) => `${branch} ${count}`).join(', ');
  return `Listed ${plural(deployments.length, 'preview deployment')} in ${PAGES_PROJECTS.dev}${source}${how}: ${byBranch(counts) || 'none made by this workflow'}${others ? `; ${others} not made by this workflow (left alone): ${byBranch(otherCounts)}` : ''}.`;
}

/**
 * --previews: deploys the staged previews (_cf/previews under `base`), removes stale ones, checks
 * that each removed preview's link stopped serving it (a "preview removed" page goes over any that
 * did not), and reports all of it as GitHub annotations plus the job summary; a run that stops early
 * (a refusal, a failed deploy, a Cloudflare API error) reports what it had found and done so far
 * plus the reason (an error annotation) before failing.
 * Everything that reaches outside is injectable for tests: run (Wrangler), fetchImpl (Cloudflare
 * API), aliasFetch (the plain GETs of the preview links: never given the token), removedNames (git
 * history), sleep. dryRun prints the plan and calls nothing; with `deployments` (a saved listing) it
 * prints the exact deletions, link checks and tombstones for that listing.
 */
export async function deployPreviews({
  base = root, env = process.env, dryRun = false, run = wrangler, fetchImpl = fetch, aliasFetch = fetch,
  removedNames = removedPreviewNames, deployments: saved = null, sleep, linkWait = LINK_WAIT,
  installed = installedVersion, log = console.log, warn = console.warn
} = {}) {
  const staged = readStagedPreviews(base);
  const sha = env.COMMIT_SHA || env.GITHUB_SHA || '';
  const plan = previewDeployPlan(staged.previews, { sha });
  for (const step of plan) {
    if (!fs.existsSync(path.join(base, step.dir, 'index.html')) || !fs.existsSync(path.join(base, step.dir, '_headers'))) {
      throw new Error(`${step.dir} is missing or incomplete: run node scripts/pages-previews.mjs first.`);
    }
  }
  const names = staged.previews.map(preview => preview.name);
  const readHistory = () => {
    try { return { ...removedNames(base), error: null }; } catch (error) { return { names: [], shallow: false, error: String(error?.message || error) }; }
  };
  if (dryRun) {
    for (const step of plan) log(`wrangler@${WRANGLER_VERSION} ${step.deploy.join(' ')}   (unless already served as staged)`);
    log(`then delete the preview deployments made here in ${PAGES_PROJECTS.dev} for any branch but: ${names.join(', ') || '(none)'} (and older builds of those)`);
    const history = readHistory();
    const tombstone = name => `wrangler@${WRANGLER_VERSION} ${tombstonePlan(name, { sha }).deploy.join(' ')}`;
    if (!saved) {
      log(`then check each removed branch's link (https://<branch>.${PAGES_PROJECTS.dev}.pages.dev/version.json, cache-busted, and the page) for up to ${waitSeconds(linkWait)}s (only 404/410 counts as gone); one that still serves a build (any) gets a "preview removed" page:`);
      log(`  wrangler@${WRANGLER_VERSION} pages deploy ${TOMBSTONES_OUT}/<branch> --project-name ${PAGES_PROJECTS.dev} --branch <branch> --commit-message ${tombstoneCommitMessage('<branch>')} --commit-dirty=true`);
      log('  a removed branch whose newest deployment is that page keeps it (only older deployments are deleted; it is never deployed again)');
    }
    log(history.error
      ? `previews removed in git history: unknown (${history.error}); only the branches Cloudflare lists would be checked`
      : `previews removed in git history (their links are checked on every run, even when Cloudflare lists nothing for them): ${history.names.join(', ') || '(none)'}${history.shallow ? ' (shallow history: only what it holds)' : ''}`);
    if (!saved) {
      log('(dry run: Cloudflare was not called; --deployments=<file> plans the exact deletions from a saved deployment listing)');
      return { dryRun: true, cleanup: null };
    }
    const cleanup = previewCleanup(saved, names, { known: history.names });
    log(listingReport(saved, { source: ' (saved listing, before this run\'s deploys)' }));
    for (const item of cleanup.deletions) log(`delete ${item.id} of ${item.branch} (${item.force ? 'forced' : 'not forced'}: ${item.why})`);
    for (const entry of cleanup.removed) {
      const origin = `${previewOrigin(entry.branch)}/`;
      if (entry.check === 'wait') log(`check ${origin} for up to ${waitSeconds(linkWait)}s after its deletions; if it still serves a build${entry.oldBuild ? ` (last deployed: ${entry.oldBuild})` : ''}: ${tombstone(entry.branch)}`);
      else if (entry.tombstone) log(`check ${origin} once (its newest deployment ${entry.tombstone} is its "preview removed" page: kept, never deployed again)`);
      else if (entry.foreign) log(`check ${origin} once (removed in git history; ${plural(entry.foreign, 'deployment')} not recognised as made here, never deleted, e.g. ${entry.foreignSample}); if it still serves a build: ${tombstone(entry.branch)}`);
      else log(`check ${origin} once (removed in git history, nothing listed); if it still serves a build: ${tombstone(entry.branch)}`);
    }
    log(`current previews: ${cleanup.current.map(entry => `${entry.branch} (${plural(entry.older, 'older build')} to delete)`).join(', ') || '(none)'}`);
    log('(dry run: Cloudflare was not called)');
    return { dryRun: true, cleanup };
  }
  const secrets = [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID];
  const notes = [];
  const note = (level, message) => notes.push({ level, message: scrubPublic(message, secrets) });
  const rows = [];
  const removed = new Set();
  const tombstoned = [];
  let reported = false;
  // What the run found and did, as annotations ("Preview cleanup") and the job summary: once, at the
  // end, or when the run stops early (so an error never hides what was already found and deleted).
  const report = ({ stopped = false } = {}) => {
    if (reported) return;
    reported = true;
    if (env.GITHUB_ACTIONS === 'true') for (const line of annotationLines(notes, { secrets })) log(line);
    else for (const item of notes) log(`${item.level}: Preview cleanup: ${item.message}`);
    const summary = [
      `### Preview links (${PAGES_PROJECTS.dev})`, '',
      ...(rows.length
        ? ['| Preview | Build | Link | |', '| --- | --- | --- | --- |', ...rows.map(([preview, state]) => `| ${preview.name} | ${preview.version ? 'v' + preview.version + ' ' : ''}${preview.build} | ${preview.origin}/ | ${state} |`)]
        : [stopped ? 'The run stopped before any preview was deployed.' : 'No previews staged.']),
      ...(removed.size ? ['', `Removed: ${[...removed].join(', ')}`] : []),
      ...(tombstoned.length ? ['', `"Preview removed" page deployed: ${tombstoned.join(', ')}`] : []),
      '', '#### Preview cleanup', '',
      ...notes.map(item => `- ${item.level === 'notice' ? '' : `${item.level.toUpperCase()}: `}${item.message}`)
    ].join('\n') + '\n';
    log(summary);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  };
  try {
    const refusals = deployRefusals(env);
    if (refusals.length) throw new Error(refusals.join('\n'));
    const version = installed();
    if (version !== WRANGLER_VERSION) {
      throw new Error(`Wrangler ${WRANGLER_VERSION} is not installed in ${WRANGLER_DIR} (found ${version || 'none'}): run npm ci --prefix ${WRANGLER_DIR} --ignore-scripts.`);
    }
    const api = { token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, project: PAGES_PROJECTS.dev, fetchImpl };
    const redeploy = env.PREVIEW_REDEPLOY === '1';
    if (plan.length) {
      const created = run(['pages', 'project', 'create', PAGES_PROJECTS.dev, '--production-branch', PRODUCTION_BRANCH]);
      if (!created.ok && !alreadyExists(created.output)) throw new Error(`Could not create Cloudflare Pages project ${PAGES_PROJECTS.dev}:\n${created.output}`);
      const before = await listPreviewDeployments(api);
      for (const step of plan) {
        const preview = staged.previews.find(entry => entry.name === step.name);
        if (!redeploy && isUnchanged(before, preview)) {
          log(`${preview.origin}/ already serves build ${preview.build} as staged: not redeployed.`);
          rows.push([preview, 'unchanged']);
          continue;
        }
        const deployed = run(step.deploy);
        log(deployed.output.trimEnd());
        if (!deployed.ok) throw new Error(`Deploying ${step.dir} to ${PAGES_PROJECTS.dev} (branch ${step.name}) failed.`);
        log(`Deployed ${step.dir}: ${preview.origin}/`);
        rows.push([preview, 'deployed']);
      }
    }
    // After the deploys, so the newest deployment of each current preview is the one kept.
    const listed = await listPreviewDeployments(api);
    note('notice', listingReport(listed));
    const history = readHistory();
    if (history.error) note('warning', `Could not read the previews removed in git history (${history.error}): only the branches Cloudflare lists are checked.`);
    else if (history.shallow) note('warning', 'This checkout has shallow git history: previews removed before it are not re-checked (previews.yml checks out with fetch-depth: 0).');
    const cleanup = previewCleanup(listed, names, { known: history.names });
    const failures = [];
    const tallies = new Map();
    const tally = branch => {
      if (!tallies.has(branch)) tallies.set(branch, { forced: 0, plain: 0, failed: 0 });
      return tallies.get(branch);
    };
    for (const item of cleanup.deletions) {
      const count = tally(item.branch);
      try {
        await deleteDeployment({ ...api, id: item.id, force: item.force });
        if (item.force) { count.forced++; removed.add(item.branch); } else count.plain++;
        log(`Deleted deployment ${item.id} of ${item.branch} (${item.why}).`);
      } catch (error) {
        count.failed++;
        if (item.force) {
          failures.push(`${item.branch}: ${error.message}`);
          note('warning', `${item.branch}: could not delete deployment ${item.id} (forced): ${error.message}`);
        } else {
          warn(`Could not delete an older build of ${item.branch} (${error.message}); it stays reachable only by its own deployment address.`);
          note('warning', `${item.branch}: could not delete deployment ${item.id} (${item.why}): ${error.message}. It stays reachable only by its own deployment address; the next run tries again.`);
        }
      }
    }

    // Did each removed preview's link stop serving it? Plain GETs (aliasFetch never sees the token).
    const watch = (entry, wait) => waitForAlias({ name: entry.branch, oldBuild: entry.oldBuild, fetchImpl: aliasFetch, ...(sleep ? { sleep } : {}), ...(wait ? linkWait : { attempts: 1 }) });
    const checked = await Promise.all(cleanup.removed.map(async entry => [entry, await watch(entry, entry.check === 'wait')]));
    const aliases = {};
    const settled = [];
    const tombstones = [];
    for (const [entry, result] of checked) {
      aliases[entry.branch] = result.state;
      const origin = `${previewOrigin(entry.branch)}/`;
      const served = result.build ? `build ${result.build}` : entry.oldBuild ? `build ${entry.oldBuild}` : 'a build';
      const count = tally(entry.branch);
      if (entry.check === 'wait') {
        const head = `${entry.branch} (not in ${PREVIEWS_DIR}/): found ${plural(entry.found, 'deployment')}, deleted ${count.forced} (forced)${count.failed ? `, ${count.failed} could not be deleted` : ''}.`;
        if (linkGone(result)) note('notice', `${head} ${origin} no longer serves ${entry.oldBuild ? `build ${entry.oldBuild}` : 'it'} (${result.detail}; after ${result.seconds}s).`);
        else if (result.state === 'serving') {
          note('warning', `${head} But ${origin} still serves ${served} after ${result.seconds}s (${result.detail}): deploying a "preview removed" page over it.`);
          tombstones.push(entry);
        } else note('warning', `${head} Could not check ${origin} (${result.detail}; after ${result.seconds}s); the next run checks it again.`);
      } else if (entry.tombstone) {
        if (linkGone(result)) settled.push(`${entry.branch} ("preview removed" page${count.plain ? `, ${plural(count.plain, 'older deployment')} deleted` : ''})`);
        else if (result.state === 'serving') note('warning', `${entry.branch}: its newest deployment (${entry.tombstone}) is the "preview removed" page, yet ${origin} still serves ${served} (${result.detail}). Not deployed again; check the branch in the Cloudflare dashboard.`);
        else note('warning', `${entry.branch}: could not check ${origin} (${result.detail}); the next run checks it again.`);
      } else if (linkGone(result)) {
        settled.push(`${entry.branch} (${result.state === 'tombstone' ? '"preview removed" page' : `gone: ${result.detail}`})`);
      } else if (result.state === 'serving' && entry.foreign) {
        // The name was a preview of this repo, so its link is retired all the same; the tombstone
        // only moves the alias, the unrecognised deployments are never deleted.
        note('warning', `${entry.branch}: removed from ${PREVIEWS_DIR}/ (git history), yet ${origin} still serves ${served} (${result.detail}); Cloudflare lists ${plural(entry.foreign, 'deployment')} of it not recognised as made by this workflow (newest: ${entry.foreignSample}), left in place: deploying a "preview removed" page over it.`);
        tombstones.push(entry);
      } else if (result.state === 'serving') {
        note('warning', `${entry.branch}: removed from ${PREVIEWS_DIR}/ (git history) and Cloudflare lists no deployment of it made here, yet ${origin} still serves ${served} (${result.detail}): deploying a "preview removed" page over it.`);
        tombstones.push(entry);
      } else note('warning', `${entry.branch}: removed from ${PREVIEWS_DIR}/ (git history); could not check ${origin} (${result.detail}); the next run checks it again.`);
    }

    // The fallback: a "preview removed" page on each branch whose link still serves its old build.
    for (const entry of tombstones) {
      const origin = `${previewOrigin(entry.branch)}/`;
      let deployed;
      try {
        const step = tombstonePlan(entry.branch, { sha });
        stageTombstone(entry.branch, base);
        deployed = run(step.deploy);
      } catch (error) {
        failures.push(`${entry.branch}: could not deploy its "preview removed" page (${error.message})`);
        note('warning', `${entry.branch}: could not deploy the "preview removed" page (${error.message}); ${origin} may still serve the old build.`);
        continue;
      }
      log(deployed.output.trimEnd());
      if (!deployed.ok) {
        failures.push(`${entry.branch}: deploying its "preview removed" page failed`);
        note('warning', `${entry.branch}: deploying the "preview removed" page failed; ${origin} may still serve the old build.`);
        continue;
      }
      tombstoned.push(entry.branch);
      log(`Deployed the "preview removed" page: ${origin}`);
      const result = await watch(entry, true);
      aliases[entry.branch] = result.state;
      if (linkGone(result)) note('notice', `${entry.branch}: "preview removed" page deployed (commit message "${tombstoneCommitMessage(entry.branch)}"); ${origin} ${result.state === 'tombstone' ? 'now serves it' : `no longer serves the old build (${result.detail})`} after ${result.seconds}s. Later runs keep it and never deploy it again.`);
      else note('warning', `${entry.branch}: "preview removed" page deployed, but after ${result.seconds}s ${origin} ${result.state === 'serving' ? 'still serves the old build' : 'could not be checked'} (${result.detail}); the next run checks it again.`);
    }

    if (settled.length) note('notice', `Removed previews already settled (link checked): ${settled.join(', ')}.`);
    note('notice', names.length
      ? `Current previews: ${cleanup.current.map(entry => {
        const done = tally(entry.branch).plain;
        const older = !entry.found ? 'no deployment listed' : !entry.older ? 'newest kept, no older builds' : done === entry.older ? `newest kept, ${plural(done, 'older build')} removed` : `newest kept, ${done} of ${plural(entry.older, 'older build')} removed`;
        return `${entry.branch} (${older})`;
      }).join(', ')}.`
      : `No previews staged: every preview link made by this workflow is removed.`);
    if (failures.length) note('error', `Could not remove ${plural(failures.length, 'preview')} (their links may still work): ${failures.join('; ')}`);
    report();
    if (failures.length) throw new Error(`Could not remove these previews (their links may still work):\n  - ${failures.join('\n  - ')}`);
    return { rows: rows.map(([preview, state]) => [preview.name, state]), removed: [...removed], tombstoned, aliases };
  } catch (error) {
    // Stopped early (a refusal, a failed deploy, a Cloudflare API error or timeout on a listing):
    // the reason goes on the run page as well, after whatever was found and done so far.
    if (!reported) {
      const message = String(error?.message || error);
      note('error', `The preview run stopped early: ${message.length > 1500 ? `${message.slice(0, 1500)}...` : message}`);
      report({ stopped: true });
    }
    throw error;
  }
}

/** The value of --name=<value> or --name <value> in `argv` (null when absent). */
const option = (argv, name) => {
  const at = argv.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (at === -1) return null;
  return argv[at].includes('=') ? argv[at].slice(argv[at].indexOf('=') + 1) : argv[at + 1] || null;
};

/** A saved deployment listing: an array of deployments, or a Cloudflare API body ({ result: [...] }). */
export function readSavedListing(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(json) ? json : json?.result;
  if (!Array.isArray(list)) throw new Error(`${file}: not a deployment listing (an array, or a Cloudflare API body with result: [...])`);
  return list;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--previews')) {
      const dryRun = process.argv.includes('--dry-run');
      const listing = option(process.argv, '--deployments');
      if (listing && !dryRun) throw new Error('--deployments is for --dry-run only.');
      await deployPreviews({ dryRun, deployments: listing ? readSavedListing(listing) : null });
    } else main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
