// Builds every static output of Riftborn from this repository:
//   _site/     GitHub Pages (https://chancrisp.github.io/riftborn/)
//   _cf/live/  Cloudflare Pages project "riftborn"      (https://riftborn.us/)
//   _cf/dev/   Cloudflare Pages project "riftborn-dev"  (https://dev.riftborn.us/)
// Hosts, project names and the LAUNCHED switch come from site.config.mjs.
//
// Before launch (LAUNCHED = false):
//   _site     the game exactly as today: Riftborn at the root, the original at /classic/, the
//             password-gated test build at /dev/, the feedback inbox at /feedback/, /privacy/.
//   _cf/live  only /privacy/ (Google's OAuth setup needs it live) and a root page that sends
//             visitors to the github.io game, so nobody starts fresh on riftborn.us early.
//   _cf/dev   the password-gated test build (dev/), on its own origin.
// After launch (LAUNCHED = true):
//   _cf/live  the game at /, the original at /classic/, /privacy/.
//   _site     handoff pages that move each player's saved data to riftborn.us (root, /classic/,
//             /dev/ -> dev.riftborn.us, 404.html for every unknown path), /privacy/ redirects, and
//             the feedback inbox stays at /feedback/.
// Each Cloudflare output gets a _headers file (strict CSP with the hash of every inline script,
// HSTS and friends, cache rules) generated from its final HTML.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HOSTS, MIGRATION, ciLaunchRefusals, resolveSiteConfig } from '../site.config.mjs';
import { buildHeaders, inlineScripts } from './pages-headers.mjs';
import { classicImportScript, classicLoaderScript, handoffPage, notFoundPage, prelaunchPage, redirectPage } from './pages-templates.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const inCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const config = resolveSiteConfig(process.env);

// RIFTBORN_PAGES_OUT (local tests only): build into another folder instead of the repository.
const outOverride = (process.env.RIFTBORN_PAGES_OUT || '').trim();
if (outOverride && inCi) throw new Error('RIFTBORN_PAGES_OUT is for local tests only.');
const outBase = outOverride ? path.resolve(outOverride) : root;
const siteOut = path.join(outBase, '_site');
const cfOut = path.join(outBase, '_cf');
const cfLive = path.join(cfOut, 'live');
const cfDev = path.join(cfOut, 'dev');
if (!outOverride && !siteOut.startsWith(root + path.sep)) throw new Error('Refusing to build outside the repository');

const apiBase = (process.env.RIFTBORN_SCORE_API_BASE || '').trim().replace(/\/+$/, '');
if (inCi && !/^https:\/\//i.test(apiBase)) {
  throw new Error('Set the GitHub Actions repository variable RIFTBORN_SCORE_API_BASE to the deployed HTTPS Worker origin.');
}
if (apiBase && !/^https:\/\//i.test(apiBase)) throw new Error('RIFTBORN_SCORE_API_BASE must use HTTPS.');
// A launch without the Cloudflare deploy, or from a branch other than main, would hand players
// over to a site nobody deployed (or split them between two live sites): refused in CI.
const refusals = ciLaunchRefusals({ launched: config.launched, env: process.env });
if (refusals.length) throw new Error(refusals.join('\n'));

const live = path.join(root, 'live');
const dev = path.join(root, 'dev');
const inbox = path.join(root, 'feedback');
const privacy = path.join(root, 'privacy');
const hasLive = fs.existsSync(path.join(live, 'index.html'));
const hasDev = fs.existsSync(path.join(dev, 'index.html'));

// Launch safety: players must never lose progress. The builds that receive the handoff must know
// the new host, and every page a github.io handoff sends players to must read the hand-over
// (checked on the final outputs below). A real launch refuses to build without them; a locally
// forced test build only warns.
function launchReport(problems) {
  if (!problems.length) return;
  const message = 'Launch check:\n  - ' + problems.join('\n  - ');
  if (config.launchedForReal) throw new Error(message + '\nRefusing to build the launch (players would lose progress).');
  console.warn(message + '\n(Forced test build: continuing.)');
}
function launchCheck() {
  const problems = [];
  const liveHost = new URL(HOSTS.live).host;
  const read = dir => {
    let text = '';
    const visit = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.(html|js)$/.test(entry.name)) text += fs.readFileSync(file, 'utf8');
      }
    };
    visit(dir);
    return text;
  };
  if (!hasLive) problems.push('live/ has no index.html (nothing to serve at riftborn.us)');
  else if (!read(live).includes(liveHost)) problems.push(`live/ build does not know its host ${liveHost} (scores, feedback and accounts would be off)`);
  if (!hasDev) problems.push('dev/ has no index.html (nothing to serve at dev.riftborn.us)');
  launchReport(problems);
}
if (config.launched) launchCheck();

const node = process.execPath;
const build = spawnSync(node, ['build.mjs'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);

const edit = (file, change) => {
  const html = fs.readFileSync(file, 'utf8');
  const next = change(html);
  if (next === html) throw new Error(`${file}: expected markup not found`);
  fs.writeFileSync(file, next);
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

// The rebuilt game (Riftborn Reborn, live/) at the root of `dest`; the original game built from
// this repo's source (dist/) at /classic/ (or at the root when there is no live/ build).
// moveImport (riftborn.us after launch): /classic/ receives the old /riftborn/classic/ hand-over.
function copyGame(dest, { moveImport = false } = {}) {
  const classic = path.join(dest, 'classic');
  const gameDir = hasLive ? classic : dest;
  fs.mkdirSync(gameDir, { recursive: true });
  for (const entry of fs.readdirSync(path.join(root, 'dist'), { withFileTypes: true })) {
    if (entry.name === 'server' || entry.name === '.openai') continue;
    copy(path.join(root, 'dist', entry.name), path.join(gameDir, entry.name));
  }
  if (hasLive) copy(live, dest);
  // The classic edition has no leaderboard: its buttons and score messages are hidden, score
  // requests are answered on the device (nothing is sent or queued), and it links to the new game.
  if (hasLive) {
    const classicHead = `<style>#menuLeaderboard,#pauseLeaderboard,#retryScore,#scoreSave{display:none!important}
.classic-note{position:fixed;left:12px;bottom:10px;z-index:60;font:11px "Crypt Pixel","Courier New",monospace;letter-spacing:.08em;color:#ece7ca;opacity:.72;text-decoration:none}.classic-note:hover,.classic-note:focus-visible{opacity:1}</style>
<script>/* Classic edition: no leaderboard. */window.RIFTBORN_SCORE_API_BASE="";(function(){var f=window.fetch;window.fetch=function(u,o){var url=typeof u==="string"?u:(u&&u.url)||"";if(url.indexOf("/api/scores")!==-1){var post=String((o&&o.method)||(u&&u.method)||"GET").toUpperCase()==="POST";return Promise.resolve(new Response(JSON.stringify(post?{saved:true}:{scores:[]}),{status:post?201:200,headers:{"Content-Type":"application/json"}}));}return f.apply(this,arguments);};})();</script>`;
    edit(path.join(classic, 'index.html'), html => html
      .replace('</head>', `${classicHead}</head>`)
      .replace('</body>', '<a class="classic-note" href="../">CLASSIC EDITION · PLAY RIFTBORN 2.0 ›</a></body>'));
    if (moveImport) addClassicImport(path.join(classic, 'index.html'));
  }
}

// The classic page's hand-over import (pages-templates.mjs classicImportScript): first in <head>,
// and the classic game's module only starts once the import is done (it reads localStorage as
// soon as it loads).
function addClassicImport(file) {
  const hosts = [...new Set([new URL(HOSTS.live).hostname, new URL(config.live).hostname, ...MIGRATION.receive.localHosts])];
  const { style, script } = classicImportScript({ migration: MIGRATION, hosts });
  edit(file, html => {
    const charset = '<meta charset="utf-8">';
    const modules = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)];
    if (html.split(charset).length !== 2 || modules.length !== 1 || html.split('</body>').length !== 2) {
      throw new Error(`${file}: expected one <meta charset>, one game module script and one </body> (found ${modules.length} module scripts)`);
    }
    return html
      .replace(charset, () => `${charset}<style>${style}</style><script>${script}</script>`)
      .replace(modules[0][0], () => '')
      .replace('</body>', () => `<script>${classicLoaderScript({ src: modules[0][1] })}</script></body>`);
  });
}

const reset = dir => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
};
reset(siteOut);
fs.rmSync(cfOut, { recursive: true, force: true });
// Every URL a github.io handoff page sends players to (launched builds).
const handoffTargets = new Set();
fs.mkdirSync(cfLive, { recursive: true });

// ---- GitHub Pages (_site) ------------------------------------------------------------------------
if (!config.launched) {
  copyGame(siteOut);
  // The password-gated test build of the next version.
  if (hasDev) copy(dev, path.join(siteOut, 'dev'));
  // The public privacy policy (canonical https://riftborn.us/privacy/; this copy until launch).
  if (fs.existsSync(privacy)) copy(privacy, path.join(siteOut, 'privacy'));
  // The root game reads the leaderboard Worker origin from the repository variable.
  const scoreConfig = `<script>window.RIFTBORN_SCORE_API_BASE=${JSON.stringify(apiBase)};</script>`;
  edit(path.join(siteOut, 'index.html'), html => html.replace('</body>', `${scoreConfig}</body>`));
} else {
  // Handoff pages: each moves the player's saved data on this origin to the new host.
  const liveRoot = config.live + '/';
  const handoff = (file, target) => {
    handoffTargets.add(target);
    write(path.join(siteOut, file), handoffPage({ target, migration: MIGRATION }));
  };
  handoff('index.html', liveRoot);
  handoff('classic/index.html', config.live + '/classic/');
  handoff('dev/index.html', config.dev + '/');
  write(path.join(siteOut, 'privacy', 'index.html'), redirectPage({ target: config.live + '/privacy/', title: 'Riftborn privacy policy has moved' }));
  // GitHub Pages serves a project's 404.html for every unknown path under /riftborn/.
  handoff('404.html', liveRoot);
}
// The private player-feedback inbox (noindex; every read needs the Worker's admin key) stays on
// github.io for good, away from the game origin.
if (fs.existsSync(inbox)) copy(inbox, path.join(siteOut, 'feedback'));
fs.writeFileSync(path.join(siteOut, '.nojekyll'), '');

// ---- Cloudflare Pages: riftborn.us (_cf/live) ------------------------------------------------------
if (config.launched) {
  copyGame(cfLive, { moveImport: true });
  write(path.join(cfLive, '_redirects'), '# Old GitHub Pages paths typed on the new domain.\n/riftborn/* /:splat 301\n/riftborn /  301\n');
} else {
  write(path.join(cfLive, 'index.html'), prelaunchPage({ legacyUrl: config.legacyUrl, param: MIGRATION.param }));
  const font = [path.join(live, 'assets', 'crypt-pixel.ttf'), path.join(root, 'dist', 'assets', 'crypt-pixel.ttf')].find(file => fs.existsSync(file));
  if (font) write(path.join(cfLive, 'assets', 'crypt-pixel.ttf'), fs.readFileSync(font)); // the privacy page's heading font
}
if (fs.existsSync(privacy)) copy(privacy, path.join(cfLive, 'privacy'));
// Unknown paths: a 404.html also stops Pages from serving the root page for every path.
write(path.join(cfLive, '404.html'), config.launched ? notFoundPage() : prelaunchPage({ legacyUrl: config.legacyUrl, param: MIGRATION.param }));

// ---- Cloudflare Pages: dev.riftborn.us (_cf/dev) ----------------------------------------------------
if (hasDev) {
  copy(dev, cfDev);
  write(path.join(cfDev, '404.html'), notFoundPage());
  write(path.join(cfDev, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
} else {
  console.warn('No dev/ build: _cf/dev not built.');
}

// GitHub Pages markers mean nothing to Cloudflare Pages.
for (const dir of [cfLive, cfDev]) fs.rmSync(path.join(dir, '.nojekyll'), { force: true });

// Launch safety, on the final outputs: every page a handoff sends players to exists and reads the
// hand-over in an inline script (it has to run before any module reads localStorage, and take the
// fragment off the address bar at once).
if (config.launched) {
  const reader = `#${MIGRATION.param}=`;
  const problems = [];
  for (const target of handoffTargets) {
    const url = new URL(target);
    const dir = url.origin === config.live ? cfLive : url.origin === config.dev ? cfDev : null;
    const file = dir && path.join(dir, ...url.pathname.split('/').filter(Boolean), 'index.html');
    if (!file || !fs.existsSync(file)) problems.push(`${target}: handoff target has no page in the Cloudflare outputs`);
    else if (!inlineScripts(fs.readFileSync(file, 'utf8')).some(text => text.includes(reader))) {
      problems.push(`${target}: handoff target cannot import handed-over progress (no inline "${reader}" reader in ${path.relative(outBase, file).split(path.sep).join('/')})`);
    }
  }
  launchReport(problems);
}

// ---- security headers, from the final HTML ------------------------------------------------------------
const connect = [config.api, config.workersDev];
const outputs = [[cfLive, { connect }], ...(hasDev ? [[cfDev, { connect, noindex: true }]] : [])];
const summary = [];
for (const [dir, options] of outputs) {
  const { text, hashes, htmlFiles } = buildHeaders(dir, options);
  fs.writeFileSync(path.join(dir, '_headers'), text);
  summary.push(`${path.relative(outBase, dir).split(path.sep).join('/')} (${htmlFiles.length} pages, ${hashes.length} inline script hashes)`);
}

const mode = config.launched ? 'LAUNCHED' : 'pre-launch';
const overrides = config.testOverrides.length ? ` [test overrides: ${config.testOverrides.join(', ')}]` : '';
console.log(`Built Riftborn Pages outputs (${mode})${overrides}:`);
console.log(`  _site/ (GitHub Pages): ${config.launched ? 'handoff pages to ' + config.live + ', feedback inbox' : (hasLive ? 'Riftborn Reborn at the root, original at /classic/' : 'original game at the root') + (apiBase ? ', Worker API configured' : ', same-origin API mode')}`);
console.log(`  ${summary.join('\n  ')}`);
