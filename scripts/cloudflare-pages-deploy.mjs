// Deploys the Cloudflare Pages outputs built by scripts/build-pages.mjs with Wrangler:
//   _cf/live -> project "riftborn"      (https://riftborn.us)
//   _cf/dev  -> project "riftborn-dev"  (https://dev.riftborn.us)
// Each project is created first (production branch main); "already exists" is fine.
// Run by the "cloudflare" job of .github/workflows/pages.yml (only on main, and only when the
// repository variable CF_PAGES_ENABLED is 1), with CLOUDFLARE_API_TOKEN (secret) and
// CLOUDFLARE_ACCOUNT_ID (variable).
//
// Wrangler runs with the production API token, so it is never fetched at deploy time: it is
// exact-pinned in tools/wrangler/package.json + package-lock.json (integrity hashes), installed by
// the job with `npm ci --prefix tools/wrangler --ignore-scripts`, run from there with this Node (no
// npx, no shell), and handed only the environment it needs (wranglerEnv) instead of all of it.
//
//   node scripts/cloudflare-pages-deploy.mjs --dry-run   prints the plan; runs nothing
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGES_PROJECTS, PRODUCTION_BRANCH } from '../site.config.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WRANGLER_DIR = 'tools/wrangler';
/** The pinned Wrangler version (tools/wrangler/package.json; the lockfile pins the whole tree). */
export const WRANGLER_VERSION = JSON.parse(fs.readFileSync(path.join(root, WRANGLER_DIR, 'package.json'), 'utf8')).dependencies.wrangler;
const WRANGLER_BIN = path.join(root, WRANGLER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** The Wrangler commands, in order: riftborn.us first (the github.io handoff waits for it). */
export function deployPlan({ sha = '', message = '' } = {}) {
  const outputs = [[PAGES_PROJECTS.live, '_cf/live'], [PAGES_PROJECTS.dev, '_cf/dev']];
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
    refusals.push(`Refusing to deploy ${env.GITHUB_REF || 'an unknown ref'} to production: only refs/heads/${PRODUCTION_BRANCH} deploys riftborn.us and dev.riftborn.us.`);
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
  const plan = deployPlan({ sha: process.env.COMMIT_SHA || process.env.GITHUB_SHA, message: process.env.COMMIT_MESSAGE });
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
