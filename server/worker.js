// Bundled by build.mjs with the game's public assets. No runtime file-system access.
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
function database(env){if(!env.DB)throw new Error('Score database unavailable');return env.DB}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/scores'){
   try{
    const db=database(env);
    if(request.method==='GET'){
     const result=await db.prepare('SELECT name, score, stage, played_at, kills, wave, seconds, death_mode FROM scores ORDER BY score DESC, wave DESC, seconds DESC LIMIT 25').all();
     return json({scores:result.results.map(row=>({...row,death_mode:row.death_mode==null?null:row.death_mode===1}))});
    }
    if(request.method!=='POST')return json({error:'Method not allowed'},405);
    if(request.headers.get('Sec-Fetch-Site')==='cross-site')return json({error:'Forbidden'},403);
    if(!(request.headers.get('Content-Type')||'').startsWith('application/json'))return json({error:'JSON required'},415);
    const text=await request.text();if(text.length>2048)return json({error:'Request too large'},413);
    let p;try{p=JSON.parse(text)}catch{return json({error:'Invalid JSON'},400)}
    const integer=(v,max)=>Number.isInteger(v)&&v>=0&&v<=max;
    if(!p||typeof p.id!=='string'||!(/^[0-9a-f-]{36}$/i).test(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.trim().length>16||!integer(p.score,100000000)||!integer(p.kills,1000000)||!integer(p.seconds,86400)||p.seconds<1||!integer(p.wave,2881)||p.wave!==1+Math.floor(p.seconds/30))return json({error:'Invalid run'},400);
    if(p.stage!==undefined&&(!integer(p.stage,5)||p.stage<1))return json({error:'Invalid stage'},400);
    if(p.played_at!==undefined&&(!Number.isSafeInteger(p.played_at)||p.played_at<0||p.played_at>Date.now()+300000))return json({error:'Invalid run date'},400);
    if(p.death_mode!==undefined&&typeof p.death_mode!=='boolean')return json({error:'Invalid run mode'},400);
    const now=Date.now();
    await db.prepare('INSERT INTO scores (id,name,score,kills,wave,seconds,created_at,stage,played_at,death_mode) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(p.id,p.name.trim(),p.score,p.kills,p.wave,p.seconds,now,p.stage??null,p.played_at??now,p.death_mode===undefined?null:Number(p.death_mode)).run();
    return json({saved:true});
   }catch(error){console.error('Leaderboard request failed',error);return json({error:'Leaderboard temporarily unavailable'},503)}
  }
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const path=url.pathname==='/'?'/index.html':url.pathname;
  const asset=ASSETS[path];if(!asset)return new Response('Not found',{status:404});
  return new Response(request.method==='HEAD'?null:asset.binary?Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)):asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
 }
};
