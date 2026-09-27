// Upload ownership is claimed in one IndexedDB transaction, across every tab.
// A crash after server acceptance can resend the same immutable ID; the server's
// unique ID makes that retry idempotent. Never evict an unconfirmed run.
export function scoreStore(name='riftborn-score-outbox-v1'){
 let opening;
 const open=()=>opening||(opening=new Promise((resolve,reject)=>{
  const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('runs',{keyPath:'id'});
  r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();opening=null};resolve(r.result)};
  r.onerror=()=>{opening=null;reject(r.error)};r.onblocked=()=>{opening=null;reject(Error('Score storage is blocked'))};
 }).catch(error=>{opening=null;throw error}));
 const transact=async fn=>{const db=await open();return new Promise((resolve,reject)=>{
  const tx=db.transaction('runs',fn?'readwrite':'readonly'),store=tx.objectStore('runs'),request=store.getAll();let result;
  request.onsuccess=()=>{try{const rows=request.result;if(fn){const ids=new Set(rows.map(r=>r.id));result=fn(rows);for(const r of rows){store.put(r);ids.delete(r.id)}for(const id of ids)store.delete(id)}else result=rows}catch(e){tx.abort();reject(e)}};
  tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||Error('Score storage failed'));
 })};
 return {read:()=>transact(),change:fn=>transact(fn)};
}
const clone=x=>JSON.parse(JSON.stringify(x));
const valid=r=>r&&typeof r.id==='string'&&r.payload?.id===r.id&&typeof r.payload.name==='string'&&Number.isFinite(r.payload.score);
export class ScoreOutbox{
 constructor({store=scoreStore(),send,now=Date.now,owner=globalThis.crypto?.randomUUID?.()||String(Math.random())}={}){this.store=store;this.send=send;this.now=now;this.owner=owner;this.memory=[];this.storageFailed=false;this.busy=false;this.saved=0}
 async add(payload){const record={id:payload.id,payload:clone(payload),attempts:0,nextAt:0,status:'pending',leaseUntil:0};
  try{await this.store.change(rows=>{if(!rows.some(r=>r.id===record.id))rows.push(record)})}catch{if(!this.memory.some(r=>r.id===record.id))this.memory.push(record);this.storageFailed=true}
 }
 async list(){let rows=[];try{rows=await this.store.read()}catch{this.storageFailed=true}return [...rows,...this.memory.filter(m=>!rows.some(r=>r.id===m.id))]}
 async retry(){const reset=rows=>{for(const r of rows)if(valid(r)&&!(r.leaseUntil>this.now())){r.status='pending';r.nextAt=0}};reset(this.memory);try{await this.store.change(reset)}catch{this.storageFailed=true}}
 claim(rows){
  for(const r of rows)if(r&&typeof r==='object'){if(!valid(r)){r.status='failed';r.error='Unreadable saved run'}else{if(!Number.isFinite(r.nextAt))r.nextAt=0;if(!Number.isFinite(r.leaseUntil))r.leaseUntil=0}}
  const r=rows.find(r=>valid(r)&&r.status!=='failed'&&!(r.nextAt>this.now())&&!(r.leaseUntil>this.now()));if(!r)return null;
  r.leaseOwner=this.owner;r.leaseUntil=this.now()+30000;r.attempts=Math.min(1e6,(Number.isSafeInteger(r.attempts)&&r.attempts>=0?r.attempts:0)+1);return clone(r);
 }
 async flush(){
  if(this.busy)return;this.busy=true;let inaccessible=false;
  try{
   // Promote a snapshot; an enqueue that happens during this await stays in memory.
   if(this.memory.length){const pending=[...this.memory];try{await this.store.change(rows=>{for(const r of pending)if(!rows.some(x=>x.id===r.id))rows.push(clone(r))});this.memory=this.memory.filter(r=>!pending.includes(r))}catch{inaccessible=true}}
   for(let i=0;i<8;i++){
    let row=null,inMemory=false;
    try{row=await this.store.change(rows=>this.claim(rows))}catch{inaccessible=true}
    // Readable but full storage must not strand the fallback queue.
    if(!row){row=this.claim(this.memory);inMemory=!!row}if(!row)break;
    let response,error;try{response=await this.send(clone(row.payload))}catch(e){error=e}
    const settle=rows=>{const index=rows.findIndex(r=>r.id===row.id&&r.leaseOwner===this.owner);if(index<0)return false;
     if(response?.ok){rows.splice(index,1);return true}
     const r=rows[index];r.leaseUntil=0;r.leaseOwner=null;r.status=response?.status>=400&&response.status<500&&![408,429].includes(response.status)?'failed':'pending';
     r.nextAt=this.now()+Math.min(300000,2000*2**Math.min(8,r.attempts-1));r.error=error?'Connection unavailable':`Server response ${response?.status||0}`;return false;
    };
    if(inMemory){if(settle(this.memory))this.saved++}
    else try{if(await this.store.change(settle))this.saved++}catch{inaccessible=true} // Durable lease expires after an interrupted acknowledgement.
   }
  }finally{this.storageFailed=inaccessible||this.memory.length>0;this.busy=false}
 }
}
