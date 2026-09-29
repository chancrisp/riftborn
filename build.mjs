import fs from 'node:fs';
import path from 'node:path';
// Keep the existing static source layout, but only embed public game assets.
const root=path.resolve('dist'),assets={};
function readAsset(file){const relative=path.relative(root,file).replaceAll(path.sep,'/');const ext=path.extname(file);const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ttf':'font/ttf'}[ext];if(type){const binary=['.png','.ttf'].includes(ext);assets['/'+relative]={body:fs.readFileSync(file,binary?'base64':'utf8'),type,binary}}}
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else readAsset(f)}}
for(const f of ['index.html','campaign.js','terrain-visuals.js','audio-effects.js','landmarks.js','mastery.js','game.js','score-api.js','combat-feedback.js','warnings.js','occlusion.js','upgrades.js','score-outbox.js','run-history.js','simulation.js','profile.js','challenges.js','dash-traits.js','trials.js','progression.js','combat-effects.js','ballistics.js','retro.js','monsters.js','graphics.js','soundtrack.js','storm.js','tutorial.js','encounters.js','terrain.js','scenery.js','rules.js','preferences.js','style.css','menus.css','retro.css'])readAsset(path.join(root,f));walk(path.join(root,'vendor'));walk(path.join(root,'assets'));
fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});
const scoreApi=fs.readFileSync('server/scores-api.js','utf8').replace('export async function handleScores','async function handleScores');
const worker=fs.readFileSync('server/worker.js','utf8').replace("import { handleScores } from './scores-api.js';", '');
fs.writeFileSync('dist/server/index.js','const ASSETS='+JSON.stringify(assets)+';\n'+scoreApi+'\n'+worker);
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
fs.cpSync('drizzle','dist/.openai/drizzle',{recursive:true});
console.log('Built game Worker with '+Object.keys(assets).length+' public assets and D1 migrations.');
