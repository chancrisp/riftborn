import fs from 'node:fs';
import path from 'node:path';
// Keep the existing static source layout, but only embed public game assets.
const root=path.resolve('dist'),assets={};
function readAsset(file){const relative=path.relative(root,file).replaceAll(path.sep,'/');const ext=path.extname(file);const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.txt':'text/plain; charset=utf-8'}[ext];if(type)assets['/'+relative]={body:fs.readFileSync(file,'utf8'),type}}
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else readAsset(f)}}
for(const f of ['index.html','game.js','terrain.js','scenery.js','rules.js','preferences.js','style.css','menus.css'])readAsset(path.join(root,f));walk(path.join(root,'vendor'));
fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});
fs.writeFileSync('dist/server/index.js','const ASSETS='+JSON.stringify(assets)+';\n'+fs.readFileSync('server/worker.js','utf8'));
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
fs.cpSync('drizzle','dist/.openai/drizzle',{recursive:true});
console.log('Built game Worker with '+Object.keys(assets).length+' public assets and D1 migrations.');
