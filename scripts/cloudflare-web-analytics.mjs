// Reads the state of Cloudflare Web Analytics for riftborn.us, WITHOUT changing anything, so the player
// metrics work knows the facts the privacy text and the Cloudflare switch-off depend on:
//   - the zone's plan and whether the account has a Workers paid plan;
//   - which mechanism injects the visit-counting beacon today: the zone's "automatic setup" (Web Analytics,
//     auto_install), the Pages projects' "Metrics" toggle, both, or neither (what the public pages really serve
//     is checked too: a beacon served with no switch found is "unexplained");
//   - whether the deploy token may read and CHANGE Web Analytics (Stage 3 needs "Account Settings Write");
//   - whether Workers Logs of the leaderboard Worker can hold client IP addresses (field NAMES only).
// Nothing is written: every call is a GET, except one POST that asks Cloudflare for the NAMES of logged fields.
// The token is sent to api.cloudflare.com only (the public pages are fetched without it). The output goes to a
// public repository's workflow annotations, so it holds derived facts only: never the token, the account id, a
// zone id, a site tag or token, a Pages tag, a snippet or a token id.
// A missing token permission is named exactly: required reads fail the run (exit 1), optional ones warn.
//   Zone > Zone > Read (riftborn.us)            the zone and its plan
//   Account > Account Settings > Read           the Web Analytics sites (Stage 3 `apply` will need Edit)
//   Account > Cloudflare Pages > Read           each project's Metrics toggle
//   Account > Workers Scripts > Read            the Worker's observability settings
//   optional: Account > Billing > Read; Account > Account API Tokens > Read; Account > Workers Observability > Edit
//
//   node scripts/cloudflare-web-analytics.mjs inspect --dry-run   the plan; nothing is fetched, no token needed
//   node scripts/cloudflare-web-analytics.mjs inspect             with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
//   node scripts/cloudflare-web-analytics.mjs apply [--confirm]    switch Cloudflare's automatic injection OFF for our sites and
//                                                                  print the site token; writes only with --confirm (exit 2 without)
//   node scripts/cloudflare-web-analytics.mjs verify               fetch our hosts and fail when any still serves the beacon (no token)
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOSTS, PAGES_PROJECTS, PRODUCTION_BRANCH } from '../site.config.mjs';
import { API_BASE, ZONE, cloudflareApi, deniedAnswer } from './cloudflare-pages-domains.mjs';

export const WORKER_SCRIPT = 'riftborn-leaderboard';
export const INSPECT_PROJECTS = Object.values(PAGES_PROJECTS);
export const SERVED_URLS = ['https://riftborn.us/', 'https://riftborn.us/privacy/', 'https://dev.riftborn.us/', 'https://feedback.riftborn.us/'];

/** What each kind of read needs from the CLOUDFLARE_API_TOKEN, as the token editor names it. */
export const PERMISSIONS = Object.freeze({
  zone: `Zone > Zone > Read (zone ${ZONE})`,
  webAnalyticsRead: 'Account > Account Settings > Read',
  webAnalyticsWrite: 'Account > Account Settings > Edit',
  pages: 'Account > Cloudflare Pages > Read',
  workers: 'Account > Workers Scripts > Read',
  billing: 'Account > Billing > Read',
  tokens: 'Account > Account API Tokens > Read',
  observability: 'Account > Workers Observability > Edit'
});
const REQUIRED_PERMISSIONS = [PERMISSIONS.zone, PERMISSIONS.webAnalyticsRead, PERMISSIONS.pages, PERMISSIONS.workers];
/** The permission group name a token lists when it may change Web Analytics. */
const WRITE_GROUP = 'Account Settings Write';
const KEYS_QUERY = Object.freeze({ keyNeedle: { value: 'ip|addr|forward|connecting|client', isRegex: true, matchCase: false }, limit: 1000 });
/** A logged field NAME that looks like it holds a client address. */
export const IP_KEY = /(^|[.$_-])(ip|ip[._-]?address|client[._-]?ip|connecting[._-]?ip|forwarded[._-]?for|remote[._-]?addr)($|[._-])/i;
/** The hosts and Pages names whose Web Analytics sites apply may touch (every other site in the account is left alone). */
export const WATCHED_HOSTS = Object.freeze([
  new URL(HOSTS.live).hostname, new URL(HOSTS.dev).hostname, new URL(HOSTS.feedback).hostname,
  ...Object.values(PAGES_PROJECTS).map(project => `${project}.pages.dev`)
]);
const BEACON = /static\.cloudflareinsights\.com\/beacon\.min\.js|data-cf-beacon/;

/** The calls a run makes, in order, for --dry-run (no network, no token). -> lines */
export function inspectPlan() {
  return [
    `GET  /zones?name=${ZONE}   (the zone's plan)`,
    'GET  /accounts/<account>/rum/site_info/list?per_page=100   (Web Analytics sites: automatic setup on? never copies a tag, token or snippet)',
    ...INSPECT_PROJECTS.map(project => `GET  /accounts/<account>/pages/projects/${project}   (Metrics toggle: is a Web Analytics tag set? a 404 is fine)`),
    `GET  /accounts/<account>/workers/scripts/${WORKER_SCRIPT}/settings   (observability and log settings)`,
    'GET  /accounts/<account>/tokens/verify   (optional: the token is active)',
    'GET  /accounts/<account>/tokens/<token id>   (optional: its permission groups; the id is never printed)',
    'GET  /accounts/<account>/subscriptions   (optional: is there a Workers paid plan?)',
    'POST /accounts/<account>/workers/observability/telemetry/keys   (optional: asks for the NAMES of logged fields that look like an IP address; no log content)',
    ...SERVED_URLS.map(url => `GET  ${url}   (no token: does the page serve the Cloudflare beacon?)`),
    `Token permissions: ${Object.values(PERMISSIONS).join('; ')}.`
  ];
}

/** Why this environment must not run it ([] when it may): in CI only main, and credentials must be set. */
export function inspectRefusals(env = process.env) {
  const refusals = [];
  if ((env.CI || env.GITHUB_ACTIONS) && env.GITHUB_REF !== `refs/heads/${PRODUCTION_BRANCH}`) {
    refusals.push(`Refusing to run from ${env.GITHUB_REF || 'an unknown ref'}: only refs/heads/${PRODUCTION_BRANCH} does.`);
  }
  if (!env.CLOUDFLARE_API_TOKEN) refusals.push(`Set the CLOUDFLARE_API_TOKEN secret (it needs ${REQUIRED_PERMISSIONS.join(', ')}).`);
  if (!/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) refusals.push('Set the CLOUDFLARE_ACCOUNT_ID repository variable.');
  return refusals;
}

/**
 * Which mechanism injects the beacon. zoneAutoInstall: the zone's Web Analytics automatic setup (null: unreadable);
 * pagesMetricsOn: the Pages projects with the Metrics toggle on (null: unreadable); servedWithBeacon: public pages that serve it.
 */
export function injectionVerdict({ zoneAutoInstall, pagesMetricsOn, servedWithBeacon }) {
  const zoneOn = zoneAutoInstall === true;
  const pagesOn = Array.isArray(pagesMetricsOn) && pagesMetricsOn.length > 0;
  if (zoneOn && pagesOn) return 'both';
  if (zoneOn) return 'zone';
  if (pagesOn) return 'pages';
  if (zoneAutoInstall === null || pagesMetricsOn === null) return 'unknown';
  return servedWithBeacon.length > 0 ? 'unexplained' : 'none';
}

const describe = answer => answer.status === 0 ? `no answer: ${answer.errors[0]?.[1] || 'unknown error'}` : `HTTP ${answer.status}${answer.errors.length ? ': ' + answer.errors.map(([code, message]) => `${code} ${message}`).join('; ') : ''}`;
const sortedKeys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
const names = list => [...new Set(list.filter(name => typeof name === 'string' && name))].sort();
// The field names a telemetry keys answer holds: strings, or objects naming the key (the shape is a documented gap).
const keyNames = result => names((Array.isArray(result) ? result : result?.keys || []).map(item => typeof item === 'string' ? item : item?.key ?? item?.name ?? item?.keyName));

/**
 * Reads everything above. -> { report, problems }. problems: [{ what, permission, required }] (permission '' when the failure is
 * not a missing permission). Never throws for a denied or failed read: that is a problem in the list.
 */
export async function inspect({ env = process.env, fetchImpl = fetch, log = () => {}, now = () => new Date() } = {}) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const call = cloudflareApi({ token, accountId, fetchImpl, log });
  const silent = cloudflareApi({ token, accountId, fetchImpl, log: () => {} }); // a path that holds a token id is never logged
  const acct = `/accounts/${accountId}`;
  const problems = [];
  // A missing permission is listed once per permission; any other failure is always listed.
  const problem = (required, permission, what, answer) => {
    const denied = deniedAnswer(answer);
    if (denied && problems.some(p => p.denied && p.permission === permission && p.required === required)) return;
    problems.push({ what: denied ? `${what} (${describe(answer)}); add "${permission}" to the token, then re-run the workflow.` : `${what} (${describe(answer)}).`, permission, required, denied });
  };

  // 1. The zone and its plan.
  const zoneAnswer = await call('GET', `/zones?name=${ZONE}`);
  const zone = { name: ZONE, found: false, plan: null, free: null };
  let zonePlanObject = null;
  if (zoneAnswer.success) {
    const found = (zoneAnswer.result || [])[0];
    if (found) {
      zone.found = true;
      zonePlanObject = found.plan || null;
      const text = `${zonePlanObject?.legacy_id || ''} ${zonePlanObject?.name || ''}`;
      zone.plan = /free/i.test(text) ? 'free' : String(zonePlanObject?.legacy_id || zonePlanObject?.name || '').toLowerCase() || null;
      zone.free = zone.plan === null ? null : zone.plan === 'free';
    } else {
      problems.push({ what: `The zone ${ZONE} was not found with this token; add "${PERMISSIONS.zone}" to the token (and check the account).`, permission: PERMISSIONS.zone, required: true, denied: true });
    }
  } else {
    problem(true, PERMISSIONS.zone, `Could not read the zone ${ZONE}`, zoneAnswer);
  }

  // 2. The Web Analytics sites.
  const rumAnswer = await call('GET', `${acct}/rum/site_info/list?per_page=100`);
  const rum = { readable: rumAnswer.success, total: 0, sites: [] };
  let firstRumSite = null;
  if (rumAnswer.success) {
    const list = Array.isArray(rumAnswer.result) ? rumAnswer.result : [];
    firstRumSite = list[0] || null;
    rum.total = list.length;
    rum.sites = list.map(site => ({
      zone: site.ruleset?.zone_name ?? null,
      autoInstall: typeof site.auto_install === 'boolean' ? site.auto_install : null,
      rulesetEnabled: typeof site.ruleset?.enabled === 'boolean' ? site.ruleset.enabled : null,
      hasSnippet: Boolean(site.snippet),
      rules: (site.rules || []).map(rule => ({ host: rule.host, paths: rule.paths, inclusive: rule.inclusive, paused: Boolean(rule.is_paused) }))
    }));
  } else {
    problem(true, PERMISSIONS.webAnalyticsRead, 'Could not read the Web Analytics sites', rumAnswer);
  }
  const zoneAutoInstall = rum.readable ? rum.sites.some(site => site.zone === ZONE && site.autoInstall === true) : null;

  // 3. Each Pages project's Metrics toggle.
  const pages = {};
  let firstBuildConfig = null;
  for (const project of INSPECT_PROJECTS) {
    const answer = await call('GET', `${acct}/pages/projects/${project}`);
    if (answer.success) {
      const tag = answer.result?.build_config?.web_analytics_tag || answer.result?.latest_deployment?.build_config?.web_analytics_tag;
      firstBuildConfig ||= answer.result?.build_config || null;
      pages[project] = { readable: true, exists: true, metricsOn: Boolean(tag) };
    } else if (answer.status === 404) {
      pages[project] = { readable: true, exists: false, metricsOn: null };
    } else {
      pages[project] = { readable: false, exists: null, metricsOn: null };
      problem(true, PERMISSIONS.pages, `Could not read the Pages project ${project}`, answer);
    }
  }
  const pagesReadable = Object.values(pages).some(entry => entry.readable);
  const pagesMetricsOn = INSPECT_PROJECTS.filter(project => pages[project].metricsOn === true);

  // 4. The Worker's observability settings.
  const workerAnswer = await call('GET', `${acct}/workers/scripts/${WORKER_SCRIPT}/settings`);
  const workerLogs = { observability: null, invocationLogs: null, persist: null, headSamplingRate: null, logpush: null, tailConsumers: null, ipFieldNames: null, ipQuestion: 'unknown' };
  if (workerAnswer.success) {
    const settings = workerAnswer.result || {};
    const obs = settings.observability || {};
    workerLogs.observability = obs.enabled ?? null;
    workerLogs.invocationLogs = obs.logs?.invocation_logs ?? null;
    workerLogs.persist = obs.logs?.persist ?? null;
    workerLogs.headSamplingRate = obs.head_sampling_rate ?? null;
    workerLogs.logpush = settings.logpush ?? null;
    workerLogs.tailConsumers = (settings.tail_consumers || []).map(consumer => typeof consumer === 'string' ? consumer : consumer?.service || consumer?.name || 'unnamed');
  } else {
    problem(true, PERMISSIONS.workers, `Could not read the settings of the Worker ${WORKER_SCRIPT}`, workerAnswer);
  }

  // 5. Optional reads: the token, the subscriptions, the names of logged fields.
  const token_ = { status: 'unknown', reads: {}, canChangeWebAnalytics: 'unknown', policyGroups: null };
  const verify = await call('GET', `${acct}/tokens/verify`);
  if (verify.success) {
    token_.status = verify.result?.status || 'unknown';
    const id = verify.result?.id;
    const policies = id ? await silent('GET', `${acct}/tokens/${encodeURIComponent(id)}`) : null;
    if (policies?.success) {
      token_.policyGroups = names((policies.result?.policies || []).flatMap(policy => (policy.permission_groups || []).map(group => group.name)));
      token_.canChangeWebAnalytics = token_.policyGroups.includes(WRITE_GROUP) ? 'yes' : 'no';
    } else if (policies) {
      problem(false, PERMISSIONS.tokens, "Could not read the token's permission groups", policies);
    }
  } else {
    problem(false, PERMISSIONS.tokens, 'Could not verify the token', verify);
  }
  token_.reads = { zone: zoneAnswer.success, webAnalytics: rumAnswer.success, pages: pagesReadable, workers: workerAnswer.success };

  let subscriptions = null;
  let workersPlan = 'unknown';
  const subs = await call('GET', `${acct}/subscriptions`);
  if (subs.success) {
    subscriptions = names((Array.isArray(subs.result) ? subs.result : []).map(sub => sub.rate_plan?.public_name));
    if (subscriptions.some(name => /workers/i.test(name))) workersPlan = 'paid';
  } else {
    problem(false, PERMISSIONS.billing, 'Could not read the subscriptions', subs);
  }

  const keys = await call('POST', `${acct}/workers/observability/telemetry/keys`, KEYS_QUERY);
  if (keys.success) {
    const found = keyNames(keys.result);
    if (found.length === 0) {
      problem(false, PERMISSIONS.observability, 'The logged-field lookup returned no field names (nothing logged yet, or an unexpected answer shape)', { status: 200, errors: [] });
    } else {
      workerLogs.ipFieldNames = found.filter(name => IP_KEY.test(name));
      workerLogs.ipQuestion = workerLogs.ipFieldNames.length > 0 ? 'yes' : 'no';
    }
  } else {
    problem(false, PERMISSIONS.observability, 'Could not read the names of logged fields', keys);
  }

  // 6. What the public pages really serve (no token).
  const served = [];
  for (const url of SERVED_URLS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
      served.push({ url, status: response.status, beacon: BEACON.test(await response.text()) });
    } catch {
      served.push({ url, status: 0, beacon: null });
    }
  }
  const servedWithBeacon = served.filter(entry => entry.beacon === true).map(entry => entry.url);

  const report = {
    at: now().toISOString(),
    zone,
    workersPlan,
    subscriptions,
    rum,
    pages,
    served,
    injection: { zoneAutoInstall, pagesMetricsOn, servedWithBeacon, verdict: injectionVerdict({ zoneAutoInstall, pagesMetricsOn: pagesReadable ? pagesMetricsOn : null, servedWithBeacon }) },
    token: token_,
    workerLogs,
    shapes: {
      zonePlan: sortedKeys(zonePlanObject),
      rumSite: sortedKeys(firstRumSite),
      pagesBuildConfig: sortedKeys(firstBuildConfig),
      workerSettings: workerAnswer.success ? sortedKeys(workerAnswer.result) : []
    }
  };
  return { report, problems };
}

// ---- apply: injection off, site token ----------------------------------------------------------------------------------

const isOurs = site => WATCHED_HOSTS.includes(site.ruleset?.zone_name) || (site.rules || []).some(rule => WATCHED_HOSTS.includes(rule.host));
const siteName = site => site.ruleset?.zone_name || (site.rules || []).find(rule => WATCHED_HOSTS.includes(rule.host))?.host || 'unnamed site';
const isZoneSite = site => site.ruleset?.zone_name === ZONE;

/** Why this environment must not switch injection off ([] when it may): in CI only main, and credentials must be set. */
export function applyRefusals(env = process.env) {
  const refusals = [];
  if ((env.CI || env.GITHUB_ACTIONS) && env.GITHUB_REF !== `refs/heads/${PRODUCTION_BRANCH}`) {
    refusals.push(`Refusing to change Web Analytics from ${env.GITHUB_REF || 'an unknown ref'}: only refs/heads/${PRODUCTION_BRANCH} does.`);
  }
  if (!env.CLOUDFLARE_API_TOKEN) refusals.push(`Set the CLOUDFLARE_API_TOKEN secret (it needs ${[PERMISSIONS.zone, PERMISSIONS.webAnalyticsRead, PERMISSIONS.webAnalyticsWrite].join(', ')}).`);
  if (!/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) refusals.push('Set the CLOUDFLARE_ACCOUNT_ID repository variable.');
  return refusals;
}

function needPermission(answer, what, permission) {
  if (answer.success) return;
  const why = deniedAnswer(answer) ? `; add "${permission}" to the token, then re-run the workflow` : '';
  throw new Error(`Could not ${what} (${describe(answer)})${why}.`);
}

/**
 * Switches Cloudflare's automatic Web Analytics injection OFF for our sites only (the riftborn.us zone site and the Pages
 * names), creating the zone site with injection off when there is none, and returns the zone site's token (public by
 * design: it is printed once as WEB_ANALYTICS_TOKEN=<value>; the API token and account id are never printed).
 * Without confirm nothing is written: ok is false and remaining names what would change. The Pages Metrics toggle has no
 * documented API; any watched site still injecting after the writes is named in remaining and the run is not ok.
 * -> { ok, token, changed: string[], remaining: string[] }
 */
export async function applyWebAnalytics({ env = process.env, fetchImpl = fetch, log = () => {}, confirm = false } = {}) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const call = cloudflareApi({ token: env.CLOUDFLARE_API_TOKEN, accountId, fetchImpl, log });
  const acct = `/accounts/${accountId}`;
  const read = async () => {
    const answer = await call('GET', `${acct}/rum/site_info/list?per_page=100`);
    needPermission(answer, 'read the Web Analytics sites', PERMISSIONS.webAnalyticsRead);
    return Array.isArray(answer.result) ? answer.result : [];
  };
  let sites = await read();
  const ours = sites.filter(isOurs);
  const pending = ours.filter(site => site.auto_install === true);
  const changed = [];
  if (confirm) {
    for (const site of pending) {
      const body = site.ruleset?.zone_tag ? { auto_install: false, zone_tag: site.ruleset.zone_tag } : { auto_install: false };
      needPermission(await call('PUT', `${acct}/rum/site_info/${encodeURIComponent(site.site_tag)}`, body), `switch injection off for ${siteName(site)}`, PERMISSIONS.webAnalyticsWrite);
      changed.push(siteName(site));
    }
    if (!ours.some(isZoneSite)) {
      const zone = await call('GET', `/zones?name=${ZONE}`);
      needPermission(zone, `find the zone ${ZONE}`, PERMISSIONS.zone);
      const zoneTag = zone.result?.[0]?.id;
      if (!zoneTag) throw new Error(`The zone ${ZONE} was not found with this token.`);
      const created = await call('POST', `${acct}/rum/site_info`, { zone_tag: zoneTag, auto_install: false });
      needPermission(created, `create the ${ZONE} Web Analytics site`, PERMISSIONS.webAnalyticsWrite);
      changed.push(`${ZONE} (created)`);
    }
    sites = await read();
  }
  const zoneSite = sites.filter(isOurs).find(isZoneSite);
  const token = zoneSite?.site_token || null;
  const remaining = sites.filter(isOurs).filter(site => site.auto_install === true).map(siteName);
  if (confirm && token) log(`WEB_ANALYTICS_TOKEN=${token}`);
  return { ok: confirm && remaining.length === 0 && Boolean(token), token, changed, remaining };
}

/** Public GitHub workflow-command lines for an apply result: the token (public by design), what changed, what still injects. */
export function applyAnnotations(result) {
  const lines = [];
  lines.push(`::notice title=Web Analytics apply - token::${escData(result.token ? `WEB_ANALYTICS_TOKEN=${result.token}` : 'no site token yet (nothing confirmed)')}`);
  lines.push(`::notice title=Web Analytics apply - changed::${escData(result.changed.length ? result.changed.join(', ') : 'nothing changed')}`);
  lines.push(`::notice title=Web Analytics apply - remaining::${escData(result.remaining.length ? result.remaining.join(', ') : 'none still inject')}`);
  if (!result.ok) lines.push(`::error title=Web Analytics apply::${escData(result.remaining.length ? 'a watched site still has automatic injection on; switch it off in the Cloudflare dashboard' : 'not confirmed, or no site token')}`);
  return lines;
}

/** For each host: does its served page hold the Cloudflare beacon? injected is true, false, or null when the page could not be read. */
export async function verifyNoInjection({ hosts = WATCHED_HOSTS.slice(0, 3), fetchImpl = fetch } = {}) {
  const results = [];
  for (const host of hosts) {
    try {
      const response = await fetchImpl(`https://${host}/?t=${Date.now()}`, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30000) });
      results.push({ host, injected: response.status >= 200 && response.status < 300 ? /cloudflareinsights|data-cf-beacon/i.test(await response.text()) : null });
    } catch {
      results.push({ host, injected: null });
    }
  }
  return results;
}

const escData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
// Compact JSON for one annotation: long arrays cut with "and N more", the whole under 3000 characters.
const compact = value => {
  const text = JSON.stringify(value, (key, item) => Array.isArray(item) && item.length > 12 ? [...item.slice(0, 12), `and ${item.length - 12} more`] : item);
  return text.length > 2700 ? text.slice(0, 2690) + '...' : text;
};

/** GitHub workflow-command lines: one notice per section and a result line, then an error or warning per problem. */
export function renderAnnotations(report, problems) {
  const sections = [
    ['zone', { zone: report.zone, workersPlan: report.workersPlan, subscriptions: report.subscriptions }],
    ['injection', { injection: report.injection, rum: report.rum, pages: report.pages, served: report.served }],
    ['token', report.token],
    ['worker logs', report.workerLogs],
    ['shapes', report.shapes]
  ];
  const lines = sections.map(([name, value]) => `::notice title=Web Analytics inspect - ${name}::${escData(compact(value))}`);
  const required = problems.filter(problem => problem.required);
  lines.push(`::notice title=Web Analytics inspect - result::${escData(`injection ${report.injection.verdict}; ${required.length} required and ${problems.length - required.length} optional problems`)}`);
  for (const problem of problems) {
    if (problem.required && problem.denied) lines.push(`::error title=Cloudflare token permission missing::${escData(problem.what)}`);
    else if (problem.required) lines.push(`::error title=Web Analytics inspect - a read failed::${escData(problem.what)}`);
    else lines.push(`::warning title=Web Analytics inspect - optional read::${escData(problem.what)}`);
  }
  return lines;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const github = Boolean(process.env.GITHUB_ACTIONS);
  const emit = lines => { for (const line of lines) console.log(line); };
  if (command === 'verify') {
    const results = await verifyNoInjection({});
    for (const { host, injected } of results) console.log(`${host}: ${injected === false ? 'clean' : injected === true ? 'BEACON INJECTED' : 'could not be read'}`);
    if (github) emit(results.map(({ host, injected }) => `::${injected === false ? 'notice' : 'error'} title=Web Analytics verify - ${host}::${escData(injected === false ? 'no beacon served' : injected === true ? 'the beacon is still injected' : 'could not be read (unknown, not clean)')}`));
    if (results.some(result => result.injected !== false)) process.exitCode = 1;
    return;
  }
  if (command === 'apply') {
    const confirm = rest.includes('--confirm');
    if (!confirm) {
      const refusals = applyRefusals(process.env);
      if (refusals.length) { for (const refusal of refusals) console.error(refusal); } else {
        const result = await applyWebAnalytics({ confirm: false, log: line => console.log(line) });
        console.log(`Would switch off: ${result.remaining.join(', ') || 'nothing (already off)'}`);
      }
      console.error('apply writes only with --confirm (nothing was changed).');
      process.exitCode = 2;
      return;
    }
    const refusals = applyRefusals(process.env);
    if (refusals.length) {
      for (const refusal of refusals) console.error(github ? `::error title=Web Analytics apply::${escData(refusal)}` : refusal);
      process.exitCode = 1;
      return;
    }
    const result = await applyWebAnalytics({ confirm: true, log: line => console.log(line) });
    if (github) emit(applyAnnotations(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command !== 'inspect') {
    console.error('usage: node scripts/cloudflare-web-analytics.mjs inspect [--dry-run] | apply [--confirm] | verify');
    process.exitCode = 1;
    return;
  }
  if (rest.includes('--dry-run')) {
    console.log('Web Analytics inspect, dry run (nothing is fetched):');
    for (const line of inspectPlan()) console.log(`  ${line}`);
    return;
  }
  const refusals = inspectRefusals(process.env);
  if (refusals.length) {
    for (const refusal of refusals) console.error(github ? `::error title=Web Analytics inspect::${escData(refusal)}` : refusal);
    process.exitCode = 1;
    return;
  }
  const { report, problems } = await inspect({ log: line => console.log(line) });
  for (const line of renderAnnotations(report, problems)) console.log(line);
  if (problems.some(problem => problem.required)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
