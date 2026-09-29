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
for (const entry of fs.readdirSync(path.join(root, 'dist'), { withFileTypes: true })) {
  if (entry.name === 'server' || entry.name === '.openai') continue;
  fs.cpSync(path.join(root, 'dist', entry.name), path.join(output, entry.name), { recursive: true });
}
// The rebuilt game (Riftborn Reborn) ships as a password-gated test build at /dev/ beside the live game.
const dev = path.join(root, 'dev');
if (fs.existsSync(dev)) fs.cpSync(dev, path.join(output, 'dev'), { recursive: true });
const index = path.join(output, 'index.html');
let html = fs.readFileSync(index, 'utf8');
const config = `<script>window.RIFTBORN_SCORE_API_BASE=${JSON.stringify(apiBase)};</script>`;
html = html.replace('</body>', `${config}</body>`);
fs.writeFileSync(index, html);
fs.writeFileSync(path.join(output, '.nojekyll'), '');
console.log(`Built GitHub Pages package at _site/ (${apiBase ? 'Worker API configured' : 'same-origin API mode'}).`);
