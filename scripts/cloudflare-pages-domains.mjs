// Connects Cloudflare Pages projects to their custom domains through the Cloudflare API, with the
// same calls that connected riftborn.us and dev.riftborn.us (a one-off job on 2026-09-30, since
// removed): the Pages custom domain (POST /accounts/{account}/pages/projects/{project}/domains),
// then a proxied CNAME in the riftborn.us zone (<host> -> the project's pages.dev subdomain, read
// from the project). Today that is feedback.riftborn.us -> project "riftborn-feedback" (the feedback
// inbox); the game's two domains are connected already and left alone.
// Idempotent, so it runs on every deploy of main, right after the inbox deploys (job "feedback" of
// .github/workflows/pages.yml, never on another branch or a pull request): a domain already on the
// project and a record already pointing at it are left as they are ("already exists" is fine), and
// anything else already at that name is never touched (the run fails and says what is there). A
// domain still pending (Cloudflare checking the record and issuing the certificate, usually minutes)
// is reported, not a failure. The CNAME target is the pages.dev name read from the project, never a
// guess: if it cannot be read, nothing is changed.
// A missing token permission fails the run with the exact permission to add to the
// CLOUDFLARE_API_TOKEN (Cloudflare answers 401/403, codes 10000 / 9109):
//   Account > Cloudflare Pages > Edit       the project and its custom domains (the deploy needs it too)
//   Zone > Zone > Read, riftborn.us         finding the zone
//   Zone > DNS > Edit, riftborn.us          reading and adding the CNAME
// Prints Cloudflare's status codes and messages only: never the token, and the account id is masked.
//
//   node scripts/cloudflare-pages-domains.mjs --dry-run   the plan; nothing is fetched, no token needed
//   node scripts/cloudflare-pages-domains.mjs             with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOSTS, PAGES_PROJECTS, PRODUCTION_BRANCH } from '../site.config.mjs';

export const API_BASE = 'https://api.cloudflare.com/client/v4';
/** The zone every Riftborn host lives in. */
export const ZONE = new URL(HOSTS.live).hostname;
/** Each Pages project and the custom domain it must answer on. */
export const CUSTOM_DOMAINS = Object.freeze([
  Object.freeze({ project: PAGES_PROJECTS.feedback, host: new URL(HOSTS.feedback).hostname })
]);
/** What each kind of call needs from the CLOUDFLARE_API_TOKEN, as the token editor names it. */
export const PERMISSIONS = Object.freeze({
  pages: 'Account > Cloudflare Pages > Edit',
  zone: `Zone > Zone > Read (zone ${ZONE})`,
  dns: `Zone > DNS > Edit (zone ${ZONE})`
});
/** Written into the comment of every DNS record this adds. */
export const RECORD_COMMENT = 'Riftborn Cloudflare Pages (scripts/cloudflare-pages-domains.mjs)';
// Pages custom domain states that will not fix themselves.
const BROKEN = new Set(['error', 'blocked', 'deactivated']);
// A project's own pages.dev name, as the project read returns it (the only CNAME target this makes).
const PAGES_DEV_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.pages\.dev$/;

/** The calls a run makes, in order, for --dry-run (no network, no token). -> lines */
export function domainPlan(domains = CUSTOM_DOMAINS) {
  const lines = [];
  for (const { project, host } of domains) {
    const pages = `/accounts/<account>/pages/projects/${project}`;
    lines.push(
      `${host} -> Cloudflare Pages project ${project}`,
      `  GET  ${pages}   (its pages.dev subdomain: the CNAME target; if none can be read, the run stops here)`,
      `  GET  ${pages}/domains   (is ${host} on the project already?)`,
      `  POST ${pages}/domains {"name":"${host}"}   (only if not; "already exists" is fine)`,
      `  GET  /zones?name=${ZONE}`,
      `  GET  /zones/<zone>/dns_records?name=${host}`,
      `  POST /zones/<zone>/dns_records {"type":"CNAME","name":"${host}","content":"<subdomain>","proxied":true}   (only if no record is there; any other record there is never changed: the run stops)`,
      `  GET  ${pages}/domains/${host}   (active, or pending while Cloudflare checks the record and issues the certificate)`
    );
  }
  lines.push(`Token permissions: ${Object.values(PERMISSIONS).join('; ')}.`);
  return lines;
}

/** Why this environment must not change production domains ([] when it may): in CI only main. */
export function domainRefusals(env = process.env) {
  const refusals = [];
  if ((env.CI || env.GITHUB_ACTIONS) && env.GITHUB_REF !== `refs/heads/${PRODUCTION_BRANCH}`) {
    refusals.push(`Refusing to change custom domains from ${env.GITHUB_REF || 'an unknown ref'}: only refs/heads/${PRODUCTION_BRANCH} does.`);
  }
  if (!env.CLOUDFLARE_API_TOKEN) refusals.push(`Set the CLOUDFLARE_API_TOKEN secret (it needs ${Object.values(PERMISSIONS).join(', ')}).`);
  if (!/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) refusals.push('Set the CLOUDFLARE_ACCOUNT_ID repository variable.');
  return refusals;
}

/** A problem the owner has to fix (a token permission, a conflicting record); `permission` when a permission is missing. */
export class DomainError extends Error {
  constructor(message, { permission = '' } = {}) {
    super(message);
    this.permission = permission;
  }
}

const describe = answer => answer.status === 0 ? `no answer: ${answer.errors[0]?.[1] || 'unknown error'}` : `HTTP ${answer.status}${answer.errors.length ? ': ' + answer.errors.map(([code, message]) => `${code} ${message}`).join('; ') : ''}`;
/** True when Cloudflare refused the token itself for this call (no permission, or no access to that resource). */
export const deniedAnswer = answer => answer.status === 401 || answer.status === 403 || answer.errors.some(([code]) => code === 10000 || code === 9109);

/**
 * The Cloudflare API with one token. -> call(method, path, body) resolving to
 * { status, success, errors: [[code, message]], result }. Every call is logged with the account id masked.
 */
export function cloudflareApi({ token, accountId, fetchImpl = fetch, log = () => {} }) {
  return async (method, apiPath, body) => {
    let answer;
    try {
      const response = await fetchImpl(API_BASE + apiPath, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000)
      });
      const json = await response.json().catch(() => ({}));
      answer = { status: response.status, success: json.success === true, errors: (json.errors || []).map(error => [error.code, error.message]), result: json.result };
    } catch (error) {
      answer = { status: 0, success: false, errors: [[0, error?.name === 'TimeoutError' ? 'timed out' : String(error?.cause?.code || error?.message || error)]], result: null };
    }
    log(`${method} ${apiPath.split(accountId).join('<account>')} -> ${answer.success ? 'ok' : describe(answer)}`);
    return answer;
  };
}

// A failed call: a permission problem names the permission, anything else says what Cloudflare said.
function failure(answer, what, permission) {
  if (deniedAnswer(answer)) {
    return new DomainError(`The CLOUDFLARE_API_TOKEN may not ${what} (${describe(answer)}). Add the permission "${permission}" to the token, then re-run the workflow.`, { permission });
  }
  return new Error(`Could not ${what} (${describe(answer)}).`);
}

/**
 * Connects one project to its domain. -> { host, project, target, domain: 'added' | 'present',
 * record: 'added' | 'present', status } (status: the Pages domain status, e.g. active or pending).
 * Throws DomainError for anything the owner has to fix.
 */
export async function connectDomain({ project, host }, { call, accountId, log = () => {} }) {
  const pages = `/accounts/${accountId}/pages/projects/${project}`;
  const out = { host, project, target: '', domain: 'present', record: 'present', status: '' };

  const info = await call('GET', pages);
  if (!info.success) {
    if (info.status === 404 || info.errors.some(([code]) => code === 8000007)) {
      throw new Error(`Cloudflare Pages project ${project} does not exist yet: the deploy step before this one creates it (scripts/cloudflare-pages-deploy.mjs --feedback). Re-run once it has deployed.`);
    }
    throw failure(info, `read the Pages project ${project}`, PERMISSIONS.pages);
  }
  // Read, never guessed: pages.dev names are global, so a taken one gets a suffix, and a CNAME to the
  // bare name could point the inbox host at someone else's project. No readable name, no record.
  out.target = String(info.result?.subdomain || '').toLowerCase();
  if (!PAGES_DEV_NAME.test(out.target)) {
    throw new Error(`Could not read the pages.dev name of the Pages project ${project} (Cloudflare answered ${JSON.stringify(info.result?.subdomain ?? null)}). Nothing was changed: no DNS record is made without it. Re-run the workflow; if it persists, check Workers & Pages > ${project} in the Cloudflare dashboard.`);
  }

  const listed = await call('GET', `${pages}/domains`);
  if (!listed.success) throw failure(listed, `read the custom domains of ${project}`, PERMISSIONS.pages);
  if (!(listed.result || []).some(domain => String(domain.name).toLowerCase() === host)) {
    const added = await call('POST', `${pages}/domains`, { name: host });
    if (added.success) out.domain = 'added';
    else if (!added.errors.some(([, message]) => /already/i.test(message || ''))) throw failure(added, `add ${host} to ${project}`, PERMISSIONS.pages);
    log(added.success ? `Added ${host} to ${project}.` : `${host} was already on ${project}.`);
  } else {
    log(`${host} is already on ${project}.`);
  }

  const zones = await call('GET', `/zones?name=${encodeURIComponent(ZONE)}`);
  if (!zones.success) throw failure(zones, `read the ${ZONE} zone`, PERMISSIONS.zone);
  const zone = (zones.result || []).find(entry => entry.name === ZONE);
  if (!zone) {
    throw new DomainError(`The CLOUDFLARE_API_TOKEN cannot see the ${ZONE} zone (Cloudflare lists no such zone for it). Add "${PERMISSIONS.zone}" and "${PERMISSIONS.dns}" to the token, then re-run the workflow.`, { permission: PERMISSIONS.zone });
  }
  const records = await call('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`);
  if (!records.success) throw failure(records, `read the DNS records of ${host}`, PERMISSIONS.dns);
  const here = (records.result || []).filter(record => String(record.name).toLowerCase() === host);
  const ours = here.find(record => record.type === 'CNAME' && String(record.content).toLowerCase() === out.target);
  if (ours) {
    log(`DNS: ${host} CNAME ${out.target} is there${ours.proxied ? ' (proxied)' : ' (DNS only; it still works)'}.`);
  } else if (here.length) {
    const seen = here.map(record => `${record.type} ${record.content}`).join(', ');
    throw new DomainError(`DNS: ${host} already has ${seen}, not a CNAME to ${out.target}. Nothing was changed: remove or fix that record in the ${ZONE} DNS settings (or tell the lead), then re-run the workflow.`);
  } else {
    const created = await call('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: host, content: out.target, proxied: true, ttl: 1, comment: RECORD_COMMENT });
    // 81057 / 81058: the same record exists (added between our read and this write).
    if (created.success) out.record = 'added';
    else if (!created.errors.some(([code]) => code === 81057 || code === 81058)) throw failure(created, `add the DNS record ${host} CNAME ${out.target}`, PERMISSIONS.dns);
    log(created.success ? `DNS: added ${host} CNAME ${out.target} (proxied).` : `DNS: ${host} CNAME ${out.target} was already there.`);
  }

  const domain = await call('GET', `${pages}/domains/${encodeURIComponent(host)}`);
  if (!domain.success) throw failure(domain, `read the status of ${host}`, PERMISSIONS.pages);
  out.status = String(domain.result?.status || 'unknown');
  const detail = [domain.result?.verification_data?.error_message, domain.result?.validation_data?.error_message].filter(Boolean).join('; ');
  if (BROKEN.has(out.status)) {
    throw new Error(`${host} is "${out.status}" on ${project}${detail ? ` (${detail})` : ''}: open Workers & Pages > ${project} > Custom domains in the Cloudflare dashboard, or remove and re-add it, then re-run the workflow.`);
  }
  log(`${host}: ${out.status}${out.status === 'active' ? '' : ' (Cloudflare is checking the record and issuing the certificate; usually minutes)'}${detail ? ` (${detail})` : ''}.`);
  return out;
}

/**
 * Connects every domain in `domains`. Everything that reaches outside is injectable for tests.
 * -> { results, problems } (problems: [{ host, message, permission }]); never throws for a domain problem.
 */
export async function connectDomains({ env = process.env, domains = CUSTOM_DOMAINS, fetchImpl = fetch, log = console.log } = {}) {
  const refusals = domainRefusals(env);
  if (refusals.length) throw new Error(refusals.join('\n'));
  const call = cloudflareApi({ token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, fetchImpl, log });
  const results = [];
  const problems = [];
  for (const domain of domains) {
    try {
      results.push(await connectDomain(domain, { call, accountId: env.CLOUDFLARE_ACCOUNT_ID, log }));
    } catch (error) {
      problems.push({ host: domain.host, message: error.message, permission: error.permission || '' });
    }
  }
  return { results, problems };
}

const escData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log('Custom domains, dry run (nothing is fetched):');
    for (const line of domainPlan()) console.log(`  ${line}`);
    return;
  }
  const { results, problems } = await connectDomains();
  const summary = ['### Custom domains', '', '| Domain | Project | Pages domain | DNS record | Status |', '| --- | --- | --- | --- | --- |',
    ...results.map(r => `| ${r.host} | ${r.project} | ${r.domain} | ${r.host} CNAME ${r.target}: ${r.record} | ${r.status} |`),
    ...problems.map(p => `| ${p.host} | | | | **FAILED**: ${p.message.replace(/\|/g, '\\|')} |`), ''].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  for (const result of results) {
    if (result.status !== 'active' && process.env.GITHUB_ACTIONS) {
      console.log(`::notice title=${result.host} is ${result.status}::${escData(`Connected; Cloudflare is checking the record and issuing the certificate (usually minutes). Until then the post-deploy check reports ${result.host} as not attached yet (a warning).`)}`);
    }
  }
  for (const problem of problems) {
    const title = problem.permission ? 'Cloudflare token permission missing' : `Custom domain ${problem.host}`;
    console.error(process.env.GITHUB_ACTIONS ? `::error title=${title}::${escData(problem.message)}` : `${title}: ${problem.message}`);
  }
  if (problems.length) {
    process.exitCode = 1;
    return;
  }
  console.log(`Custom domains in place: ${results.map(r => `${r.host} (${r.status})`).join(', ')}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
