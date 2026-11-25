import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,linkSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isBlueprintPlanId,type BlueprintModule,type BlueprintRecord,type BlueprintRecordInput,type BlueprintSummary} from '../shared/blueprint';
import {DomainError} from '../shared/workspace-contracts';
import {planHistory} from './blueprint-history';

export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const invalid=()=>new DomainError('blueprint_invalid',422,'Invalid or unsupported blueprint data');
export function planDirectory(id:string,create=false) {
 if(!isBlueprintPlanId(id))throw invalid();
 const home=process.env.OMINO_HOME??join(homedir(),'.omino');
 if(!isAbsolute(home))throw invalid();
 if(create)mkdirSync(home,{recursive:true,mode:0o700});
 const base=join(realpathSync(home),'projects');
 if(create&&!existsSync(base))mkdirSync(base,{mode:0o700});
 if(!lstatSync(base).isDirectory())throw invalid();
 const directory=join(base,id);
 if(existsSync(directory)&&!lstatSync(directory).isDirectory())throw invalid();
 return directory;
}
function safeDirectory(root:string,path:string) {
 if(!lstatSync(path).isDirectory()||realpathSync(path)!==path||relative(root,path).startsWith('..'))throw invalid();
}
function textFile(root:string,rel:string,optional=false):string {
 const path=join(root,rel);safeDirectory(root,dirname(path));
 let fd:number;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
 try{if(!fstatSync(fd).isFile())throw invalid();return readFileSync(fd,'utf8');}finally{closeSync(fd);}
}
export function atomicText(path:string,content:string,exclusive=false) {
 const temp=join(dirname(path),'.write-'+randomUUID()+'.tmp');
 try{writeFileSync(temp,content,{flag:'wx',mode:0o600});if(exclusive)linkSync(temp,path);else renameSync(temp,path);}finally{rmSync(temp,{force:true});}
}
type Note={id:string;kind:string;title:string;fields:Record<string,string>;sections:Record<string,string>;file:string;mtime:string};
type HistoryEntry={ts:string;summary:string;notes:{id:string;op:string}[]};
export function loadPlan(root:string) {
 safeDirectory(root,root);
 const notes=new Map<string,Note>();
 const parse=(file:string,kind:string)=>{
  const raw=textFile(root,file).replace(/\r\n?/g,'\n'), match=/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(raw);
  if(!match)throw invalid();
  const fields:Record<string,string>=Object.create(null);
  for(const line of match[1].split('\n').filter(line=>line.trim())){
   const entry=/^([a-z_]+):(.*)$/.exec(line);
   if(!entry||Object.hasOwn(fields,entry[1]))throw invalid();
   fields[entry[1]]=entry[2].trim().replace(/^(["'])([\s\S]*)\1$/,'$2');
  }
  const {id,title}=fields;
  if(!id||!/^[a-z0-9][a-z0-9-]*$/.test(id)||id!==basename(file,'.md')||!title||kind!==fields.kind||notes.has(id))throw invalid();
  const sections:Record<string,string>=Object.create(null);
  for(const section of match[2].matchAll(/^##[ \t]+(.+?)\s*$\n?([\s\S]*?)(?=^##[ \t]+|(?![\s\S]))/gm))sections[section[1].toLowerCase()]=section[2].trim();
  notes.set(id,{id,title,kind,fields,sections,file,mtime:statSync(join(root,file)).mtime.toISOString()});
 };
 parse('project.md','intent');
 for(const [directory,kind] of [['stages','stage'],['work','work'],['decisions','decision'],['ideas','idea']]){
  const path=join(root,directory);if(!existsSync(path))continue;safeDirectory(root,path);
  for(const name of readdirSync(path).sort())if(name.endsWith('.md'))parse(directory+'/'+name,kind);
 }
 for(const n of notes.values()){
  const f=n.fields;
  if(n.kind==='stage'&&(!/^-?\d+$/.test(f.level)||!['planned','active','closed'].includes(f.status)))throw invalid();
  if(n.kind==='work'&&(notes.get(f.stage)?.kind!=='stage'||!['planned','doing','done','verified','dropped'].includes(f.status)||f.status==='verified'&&f.source!=='tool'))throw invalid();
  if(n.kind==='decision'&&!/^\d{4}-\d{2}-\d{2}$/.test(f.date))throw invalid();
  if(n.kind==='idea'&&!['open','deferred','adopted','dropped'].includes(f.idea_state))throw invalid();
  if(f.source&&!['user','agent','tool','file'].includes(f.source))throw invalid();
  if(f.parent&&notes.get(f.parent)?.kind!=='work')throw invalid();
  for(const field of ['requires','before','refs','supersedes','affects']){
   if(f[field]===undefined)continue;
   if(!f[field].startsWith('[')||!f[field].endsWith(']')||refs(f[field]).some(id=>!notes.has(id)||id===n.id))throw invalid();
  }
 }
 const metadata=JSON.parse(textFile(root,'omino.json',true)||'{}') as {lanes?:Record<string,string>;status?:string;repos?:string[]};
 const state=JSON.parse(textFile(root,'state.json',true)||'{"version":1,"notes":{}}') as {version:number;notes:Record<string,{hash:string;file:string;status:string|null}>};
 if(state.version!==1||!state.notes||typeof state.notes!=='object'||Array.isArray(state.notes))throw invalid();
 const history=textFile(root,'changes.jsonl',true).split('\n').filter(Boolean).map(line=>JSON.parse(line) as HistoryEntry);
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)
  ||metadata.repos!==undefined&&(!Array.isArray(metadata.repos)||metadata.repos.some(r=>typeof r!=='string'))
  ||metadata.lanes!==undefined&&(!metadata.lanes||typeof metadata.lanes!=='object'||Array.isArray(metadata.lanes)||Object.values(metadata.lanes).some(l=>typeof l!=='string'))
  ||history.some(h=>!h||typeof h.ts!=='string'||typeof h.summary!=='string'||!Array.isArray(h.notes)||h.notes.some(n=>!n||typeof n.id!=='string')))throw invalid();
 return {notes,metadata,state,history};
}
type Plan=ReturnType<typeof loadPlan>;
const list=(text:string|undefined)=>text?.split('\n').map(line=>line.replace(/^[-*] /,'').trim()).filter(Boolean)??[];
const refs=(text:string|undefined)=>text?.replace(/^\[|\]$/g,'').split(',').map(id=>id.trim().replace(/^['"]|['"]$/g,'')).filter(Boolean)??[];
const quoted=(text:string)=>text.split('\n').map(line=>'> '+line).join('\n');
const unquote=(text:string)=>text.split('\n').map(line=>line.replace(/^> ?/,'')).join('\n');
const decisionParagraphs=(text:string)=>text.split(/\n(?=- )/).map(paragraph=>paragraph.replace(/^- /,'').replace(/\n  /g,'\n'));
export function summarize(plan:Plan):BlueprintSummary {
 const times=new Map<string,string>();
 for(const change of plan.history)for(const note of change.notes??[])times.set(note.id,change.ts);
 const lanes=new Map<string,string[]>();
 for(const lane of Object.values(plan.metadata.lanes??{}))if(typeof lane==='string'&&lane)lanes.set(lane,[]);
 const records:BlueprintRecord[]=[];
 const noteLanes=new Map<string,string[]>();
 for(const note of plan.notes.values()){
  const f=note.fields,sections=note.sections;
  // A decision written alongside its result remains a standard public decision note.
  // The project feed shows its parent result once, with the decisions attached.
  if(note.kind==='decision'&&/^record-[a-f0-9]{32}-decision-\d+$/.test(note.id)&&refs(f.affects).some(id=>plan.notes.has(id)))continue;
  const related=new Set([f.lane,...list(sections.modules)].filter(Boolean));
  for(const ref of [...refs(f.affects),...refs(f.refs)]){const lane=plan.notes.get(ref)?.fields.lane;if(lane)related.add(lane);}
  noteLanes.set(note.id,[...related]);
  if(note.kind==='work')for(const lane of related){const statuses=lanes.get(lane)??[];statuses.push(f.status);lanes.set(lane,statuses);}
  const generated=/^record-[a-f0-9]{32}$/.test(note.id);
  const decision=note.kind==='decision',result=decision?sections.now??note.title:generated&&sections.progress?unquote(sections.progress):sections.progress;
  if(!decision&&(note.kind!=='work'||!result&&!['done','verified'].includes(f.status)))continue;
  const decisions=generated&&sections.decisions?decisionParagraphs(sections.decisions):list(sections.decisions);
  records.push({id:note.id,title:note.title,result:result||note.title,decisions:decision?[result??note.title]:decisions,lanes:[...related],at:times.get(note.id)??f.date??note.mtime});
 }
 for(const change of plan.history){
  if(!change.summary||!change.ts||!change.notes?.length)continue;
  if(change.notes.every(n=>n.op==='created')&&change.notes.some(n=>/^record-[a-f0-9]{32}(?:$|-decision-)/.test(n.id)))continue;
  if(change.notes.some(n=>n.id==='project')&&change.summary==='Confirm project modules')continue;
  const affected=change.notes.filter(n=>['work','decision'].includes(plan.notes.get(n.id)?.kind??''));
  if(!affected.length||records.some(r=>affected.some(n=>n.id===r.id)&&r.result===change.summary&&r.at===change.ts))continue;
  const id='change-'+hash(JSON.stringify([change.ts,change.summary,change.notes])).slice(0,24);
  records.push({id,title:change.summary,result:change.summary,decisions:[],lanes:[...new Set(affected.flatMap(n=>noteLanes.get(n.id)??[]))],at:change.ts});
 }
 records.sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id));
 const modules:BlueprintModule[]=[...lanes].map(([lane,statuses])=>({lane,status:statuses.includes('doing')?'active':statuses.some(s=>['done','verified'].includes(s))?statuses.every(s=>['done','verified','dropped'].includes(s))?'done':'active':'planned',records:records.filter(record=>record.lanes.includes(lane))}));
 return {title:plan.notes.get('project')!.title,modules,records};
}
export async function withPlanLock<T>(root:string,operation:()=>Promise<T>):Promise<T>{
 const lock=join(root,'.lock'),started=Date.now();
 for(;;){
  try{mkdirSync(lock,{mode:0o700});break;}catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   try{safeDirectory(root,lock);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
   try{const owner=JSON.parse(textFile(root,'.lock/owner'));
    if(Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH'){rmSync(lock,{recursive:true});continue;}}}
   }catch{if(existsSync(lock)&&Date.now()-statSync(lock).mtimeMs>60000){rmSync(lock,{recursive:true,force:true});continue;}}
   if(Date.now()-started>10000)throw new DomainError('blueprint_busy',409,'Blueprint is busy; retry');
   await delay(40);
  }
 }
 try{writeFileSync(join(lock,'owner'),JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'});return await operation();}
 finally{rmSync(lock,{force:true,recursive:true});}
}
type NewNote={file:string;id:string;status:string|null;text:string};
function note(file:string,fields:Record<string,string|number>,body:string):NewNote{
 const entries=Object.entries(fields).map(([key,value])=>key+': '+(key!=='affects'&&typeof value==='string'&&/^[|>{[\d"']/.test(value)?'"'+value+'"':value));
 return {file,id:String(fields.id),status:fields.status?String(fields.status):null,text:'---\n'+entries.join('\n')+'\n---\n\n'+body.trim()+'\n'};
}
function persistNotes(root:string,state:Plan['state'],history:HistoryEntry[],notes:NewNote[],summary:string,source:'agent'|'user',initialize=false) {
 const files=[...notes.map(note=>note.file),'changes.jsonl','state.json',...(initialize?['omino.json','.gitignore']:[])];
 const commit=planHistory(root,files,initialize);
 for(const item of notes){
  const path=join(root,item.file);
  if(!existsSync(dirname(path)))mkdirSync(dirname(path),{mode:0o700});
  safeDirectory(root,dirname(path));
  try{atomicText(path,item.text,true);}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||textFile(root,item.file)!==item.text)throw new DomainError('blueprint_record_conflict',409,'The record has different content');}
  state.notes[item.id]={hash:hash(item.text).slice(0,16),file:item.file,status:item.status};
 }
 if(!history.some(event=>event.notes.some(change=>change.id===notes.at(-1)!.id&&change.op==='created'))){
  const existing=textFile(root,'changes.jsonl',true);
  const entry=JSON.stringify({ts:new Date().toISOString(),source,summary,notes:notes.map(n=>({id:n.id,op:'created'}))});
  atomicText(join(root,'changes.jsonl'),existing+(existing&&!existing.endsWith('\n')?'\n':'')+entry+'\n');
 }
 atomicText(join(root,'state.json'),JSON.stringify(state,null,2)+'\n');
 commit?.(summary);
}
const stageNote=(id:string,level:number,source:'user'|'agent')=>note('stages/'+id+'.md',{id,kind:'stage',title:'Project work',level,status:'active',source},'');
export function initializePlan(root:string,id:string,title:string,modules:string[],paths:string[],repos:string[]){
 writeFileSync(join(root,'omino.json'),JSON.stringify({id,repos},null,2)+'\n',{flag:'wx'});
 writeFileSync(join(root,'.paths.json'),JSON.stringify(Object.fromEntries(paths.map(path=>[path,new Date().toISOString()])),null,2)+'\n',{flag:'wx'});
 writeFileSync(join(root,'.gitignore'),'.lock/\n.paths.json\nview.html\nsummary.json\ninbox.jsonl\n.serve.json\n.hooks.json\n.live.json\n',{flag:'wx'});
 const notes=[note('project.md',{id:'project',kind:'intent',title:title.replace(/[\r\n]+/g,' ')},'## Purpose\n\n'+title),stageNote('s1',1,'user')];
 for(const [i,lane] of modules.entries()){
  const key='module-'+String(i+1).padStart(3,'0');
  notes.push(note('work/'+key+'.md',{id:key,kind:'work',title:lane,stage:'s1',lane,order:i+1,status:'planned',source:'user'},''));
 }
 persistNotes(root,{version:1,notes:{}},[],notes,'Confirm project modules','user',true);
}
export function appendRecord(root:string,plan:Plan,input:BlueprintRecordInput,key:string):BlueprintRecord{
 if(plan.metadata.status==='closed')throw new DomainError('blueprint_closed',409,'This plan is closed');
 const id='record-'+hash(key).slice(0,32),summary=summarize(plan),prior=summary.records.find(record=>record.id===id);
 if(prior&&(prior.result!==input.result||JSON.stringify(prior.decisions)!==JSON.stringify(input.decisions)||JSON.stringify(prior.lanes)!==JSON.stringify(input.lanes)))throw new DomainError('blueprint_record_conflict',409,'The record has different content');
 if(prior&&plan.state.notes[id]&&plan.history.some(entry=>entry.notes?.some(n=>n.id===id&&n.op==='created')))return prior;
 if(input.lanes.some(lane=>!summary.modules.some(module=>module.lane===lane)))throw new DomainError('blueprint_lane_missing',422,'Unknown blueprint module');
 const notes:NewNote[]=[];
 const stages=[...plan.notes.values()].filter(n=>n.kind==='stage');
 let stage=plan.notes.get(id)?.fields.stage??stages.find(n=>n.fields.status==='active')?.id??stages.find(n=>n.fields.status==='planned')?.id;
 const newStage='stage-'+hash(key).slice(0,16);
 if(!stage){stage=newStage;notes.push(stageNote(stage,Math.max(0,...stages.map(n=>Number(n.fields.level)||0))+1,'agent'));}
 else if(stage===newStage&&!plan.state.notes[stage])notes.push(stageNote(stage,Number(plan.notes.get(stage)!.fields.level),'agent'));
 const title=input.result.split('\n')[0].slice(0,150);
 const fields={id,kind:'work',title,stage,status:'done',source:'agent',basis:hash('').slice(0,8)+'.'+hash('').slice(0,8),...(input.lanes[0]?{lane:input.lanes[0]}:{})};
 const body=['## Progress\n\n'+quoted(input.result),...input.decisions.length?['## Decisions\n\n'+input.decisions.map(x=>'- '+x.replace(/\n/g,'\n  ')).join('\n')]:[],...input.lanes.length?['## Modules\n\n'+input.lanes.map(x=>'- '+x).join('\n')]:[]].join('\n\n');
 notes.push(note('work/'+id+'.md',fields,body));
 for(const [index,decision] of input.decisions.entries()){
  const key=id+'-decision-'+(index+1),date=plan.notes.get(key)?.fields.date??new Date().toISOString().slice(0,10);
  notes.push(note('decisions/'+key+'.md',{id:key,kind:'decision',title:decision.split('\n')[0].slice(0,150),date,source:'agent',affects:'['+id+']'},'## Now\n\n'+quoted(decision)));
 }
 persistNotes(root,plan.state,plan.history,notes,title,'agent');
 return summarize(loadPlan(root)).records.find(r=>r.id===id)!;
}
