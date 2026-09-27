// Older records with unknown mode/version do not form a comparison baseline.
export function compareRun(run,runs,bests={}){
 const prior=runs.filter(r=>r.id!==run.id&&typeof r.death_mode==='boolean'&&r.death_mode===run.death_mode&&r.gameplay_version&&r.gameplay_version===run.gameplay_version);
 const savedBest=bests[run.gameplay_version+':'+(run.death_mode?'death':'normal')];if(!prior.length&&!Number.isFinite(savedBest))return [];
 const previous=prior[0],lines=[];
 if(run.score>Math.max(savedBest||0,...prior.map(r=>r.score)))lines.push('PERSONAL BEST');
 if(!previous)return lines;
 const delta=run.score-previous.score,stage=Number.isFinite(run.stage)&&Number.isFinite(previous.stage)?run.stage-previous.stage:NaN;
 lines.push(`${delta>=0?'+':''}${delta} score${Number.isFinite(stage)?' · '+(stage>=0?'+':'')+stage+' stages':''} vs previous ${run.death_mode?'Death':'Normal'} run`);
 if(run.outcome==='victory'&&previous.outcome==='victory'&&Number.isFinite(previous.seconds)&&run.seconds!==previous.seconds){const d=run.seconds-previous.seconds;lines.push(`${Math.abs(d)}s ${d<0?'faster':'slower'} completion`)}
 return lines;
}
