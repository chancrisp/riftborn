// Local preview uses the same score handler and schema as the deployed Worker.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import worker from './worker.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const dist=path.join(root,'dist');
fs.mkdirSync(path.join(root,'.sites-runtime'),{recursive:true});
const sqlite=new DatabaseSync(path.join(root,'.sites-runtime','preview.sqlite'));
sqlite.exec('CREATE TABLE IF NOT EXISTS preview_migrations (name TEXT PRIMARY KEY)');
for(const file of fs.readdirSync(path.join(root,'drizzle')).filter(f=>f.endsWith('.sql')).sort()){
 if(sqlite.prepare('SELECT name FROM preview_migrations WHERE name=?').get(file))continue;
 sqlite.exec('BEGIN');
 try{sqlite.exec(fs.readFileSync(path.join(root,'drizzle',file),'utf8'));sqlite.prepare('INSERT INTO preview_migrations VALUES (?)').run(file);sqlite.exec('COMMIT')}catch(error){sqlite.exec('ROLLBACK');throw error}
}
const env={DB:{prepare(sql){
 let values=[];
 return {bind(...v){values=v;return this},async run(){return sqlite.prepare(sql).run(...values)},async all(){return {results:sqlite.prepare(sql).all(...values)}}};
}}};
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.ttf':'font/ttf'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/scores'){
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2048){res.writeHead(413);res.end('Request too large');return}chunks.push(chunk)}
   const body=['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks);
   const response=await worker.fetch(new Request(url,{method:req.method,headers:req.headers,body}),env);
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
  const relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname).slice(1);
  const file=path.resolve(dist,relative),type=types[path.extname(file)];
  if(!file.startsWith(dist+path.sep)||relative.split(/[\\/]/).some(p=>p.startsWith('.')||p==='server')||!type||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return}
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:fs.readFileSync(file));
 }catch(error){console.error(error);res.writeHead(500);res.end('Preview unavailable')}
});
server.listen(Number(process.env.PORT)||4173,'127.0.0.1',()=>console.log('Riftborn preview: http://127.0.0.1:'+server.address().port));
function stop(){server.close(()=>{sqlite.close();process.exit(0)})}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
