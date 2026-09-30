import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.resolve(root, '_site');
if (!output.startsWith(root + path.sep)) throw new Error('Refusing to build outside the repository');

const apiBase = (process.env.RIFTBORN_SCORE_API_BASE || '').trim().replace(/\/+$/, '');
if (process.env.CI && !/^https:\/\//i.test(apiBase)) {
  throw new Error('Set the GitHub Actions repository variable RIFTBORN_SCORE_API_BASE to the deployed HTTPS Worker origin.');
}
if (apiBase && !/^https:\/\//i.test(apiBase)) throw new Error('RIFTBORN_SCORE_API_BASE must use HTTPS.');

const node = process.execPath;
const build = spawnSync(node, ['build.mjs'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
// The rebuilt game (Riftborn Reborn, site/live/) is the site root; the original game built
// from this repo's source above is kept playable at /classic/.
const live = path.join(root, 'live');
const classic = path.join(output, 'classic');
const hasLive = fs.existsSync(path.join(live, 'index.html'));
const gameDir = hasLive ? classic : output;
fs.mkdirSync(gameDir, { recursive: true });
for (const entry of fs.readdirSync(path.join(root, 'dist'), { withFileTypes: true })) {
  if (entry.name === 'server' || entry.name === '.openai') continue;
  fs.cpSync(path.join(root, 'dist', entry.name), path.join(gameDir, entry.name), { recursive: true });
}
if (hasLive) fs.cpSync(live, output, { recursive: true });
// The password-gated test build of the next version.
const dev = path.join(root, 'dev');
if (fs.existsSync(dev)) fs.cpSync(dev, path.join(output, 'dev'), { recursive: true });
// The private player-feedback inbox (noindex; every read needs the Worker's admin key).
const inbox = path.join(root, 'feedback');
if (fs.existsSync(inbox)) fs.cpSync(inbox, path.join(output, 'feedback'), { recursive: true });
const edit = (file, change) => {
  const html = fs.readFileSync(file, 'utf8');
  const next = change(html);
  if (next === html) throw new Error(`${file}: expected markup not found`);
  fs.writeFileSync(file, next);
};
// The root game reads the leaderboard Worker origin from the repository variable.
const config = `<script>window.RIFTBORN_SCORE_API_BASE=${JSON.stringify(apiBase)};</script>`;
edit(path.join(output, 'index.html'), html => html.replace('</body>', `${config}</body>`));
// The classic edition has no leaderboard: its buttons and score messages are hidden, score
// requests are answered on the device (nothing is sent or queued), and it links to the new game.
if (hasLive) {
  const classicHead = `<style>#menuLeaderboard,#pauseLeaderboard,#retryScore,#scoreSave{display:none!important}
.classic-note{position:fixed;left:12px;bottom:10px;z-index:60;font:11px "Crypt Pixel","Courier New",monospace;letter-spacing:.08em;color:#ece7ca;opacity:.72;text-decoration:none}.classic-note:hover,.classic-note:focus-visible{opacity:1}</style>
<script>/* Classic edition: no leaderboard. */window.RIFTBORN_SCORE_API_BASE="";(function(){var f=window.fetch;window.fetch=function(u,o){var url=typeof u==="string"?u:(u&&u.url)||"";if(url.indexOf("/api/scores")!==-1){var post=String((o&&o.method)||(u&&u.method)||"GET").toUpperCase()==="POST";return Promise.resolve(new Response(JSON.stringify(post?{saved:true}:{scores:[]}),{status:post?201:200,headers:{"Content-Type":"application/json"}}));}return f.apply(this,arguments);};})();</script>`;
  edit(path.join(classic, 'index.html'), html => html
    .replace('</head>', `${classicHead}</head>`)
    .replace('</body>', '<a class="classic-note" href="../">CLASSIC EDITION · PLAY RIFTBORN 2.0 ›</a></body>'));
}
fs.writeFileSync(path.join(output, '.nojekyll'), '');
console.log(`Built GitHub Pages package at _site/ (${hasLive ? 'Riftborn Reborn at the root, original at /classic/' : 'original game at the root'}; ${apiBase ? 'Worker API configured' : 'same-origin API mode'}).`);
