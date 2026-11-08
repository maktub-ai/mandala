import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,mkdtemp,open,opendir,realpath,rm,stat} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,normalize,parse,relative,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';
import {isCli,runtimeIds} from '../shared/runtimes';
import type {Cli,Config} from '../shared/types';
import {DomainError} from '../shared/workspace-contracts';

export type WorkDiscoveryInput = {runtimes?:Cli[];includePaths?:string[];excludePaths?:string[];limit?:number};
// Host-only injection. These fields must never be accepted from a model/tool request.
export type WorkDiscoveryHost = {userHome?:string;codexHome?:string;ompAgentDir?:string;now?:()=>Date};
export type WorkDiscoverySource = {runtime:Cli;status:'ok'|'missing'|'unsupported'|'unavailable';reason:string;scanned:number;skipped:number;truncated:boolean};
export type WorkDiscoveryMetric = {runtime:Cli;sessionCount:number;tokenCount:number|null;pinned:boolean|null;lastActivity:string;activitySource:'thread_updated_at'|'session_header'};
export type WorkDiscoveryCandidate = {directory:string;repositoryRoot:string|null;workspacePaths:string[];exists:boolean;lastActivity:string|null;runtimes:WorkDiscoveryMetric[];provenance:('codex_sqlite'|'omp_session_header'|'manual')[]};
export type WorkDiscoveryResult = {
 selection:{basis:'user_selected'|'registered_runtimes';runtimes:Cli[]};generatedAt:string;windowStart:string;
 sources:WorkDiscoverySource[];candidates:WorkDiscoveryCandidate[];notices:string[];
};
type Observation = {path:string;runtime?:Cli;lastActivity:string|null;tokenCount:number|null;pinned:boolean|null;provenance:WorkDiscoveryCandidate['provenance'][number]};
const runFile=promisify(execFile),maxRows=10000,maxFiles=2000,maxPrefix=64*1024,maxDirectories=500;
const validPath=(value:unknown):value is string=>typeof value==='string'&&value.length<=4096&&isAbsolute(value)&&!/[\x00-\x1f\x7f]/.test(value);
const within=(path:string,root:string)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep);
const errorCode=(error:unknown)=>(error as NodeJS.ErrnoException).code;
function validate(config:Pick<Config,'runtimes'>,input:WorkDiscoveryInput) {
 const invalid=()=>{throw new DomainError('invalid_work_discovery_input',422,'invalid_work_discovery_input');};
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['runtimes','includePaths','excludePaths','limit'].includes(key)))invalid();
 const runtimes=input.runtimes===undefined?config.runtimes??[]:input.runtimes;
 if(!Array.isArray(runtimes)||runtimes.length>runtimeIds.length||!runtimes.every(isCli))invalid();
 for(const paths of [input.includePaths,input.excludePaths])if(paths!==undefined&&(!Array.isArray(paths)||paths.length>100||!paths.every(validPath)))invalid();
 if(input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>100))invalid();
 return [...new Set(runtimes)];
}
const sourceFor=(runtime:Cli):WorkDiscoverySource=>({runtime,status:'ok',reason:'metadata_only',scanned:0,skipped:0,truncated:false});
function unavailable(source:WorkDiscoverySource,error:unknown){source.status=errorCode(error)==='ENOENT'?'missing':'unavailable';source.reason=error instanceof Error&&['native_snapshot_size_limit','native_snapshot_unstable','native_rollback_journal_present'].includes(error.message)?error.message:source.status==='missing'?'native_metadata_missing':'native_metadata_unreadable';}
function timestamp(value:unknown):string|null {
 const time=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
 return Number.isFinite(time)&&Math.abs(time)<8.64e15?new Date(time).toISOString():null;
}
async function entries(path:string,limit:number):Promise<{names:string[];truncated:boolean}> {
 const names:string[]=[];let truncated=false;
 for await(const entry of await opendir(path)){if(names.length===limit){truncated=true;break;}names.push(entry.name);}
 return {names:names.sort(),truncated};
}

// SQLite readOnly still writes WAL readmarks and can create native sidecars. Query a
// private, bounded, stable copy instead; never copy SHM or open the native database.
async function snapshotDatabase(path:string):Promise<{directory:string;path:string}> {
 const fingerprint=(s:Awaited<ReturnType<typeof stat>>|null)=>s&&[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
 const metadata=async(file:string)=>lstat(file).catch(error=>{if(errorCode(error)==='ENOENT')return null;throw error;});
 for(let attempt=0;attempt<2;attempt++) {
  if(await metadata(path+'-journal'))throw new Error('native_rollback_journal_present');
  const files=[path,path+'-wal'],before=await Promise.all(files.map(metadata));
  if(!before[0])throw Object.assign(new Error('missing'),{code:'ENOENT'});
  if(before.some(s=>s&&!s.isFile()))throw new Error('native_metadata_unreadable');
  if(before.reduce((sum,s)=>sum+(s?.size??0),0)>128*1024*1024)throw new Error('native_snapshot_size_limit');
  const directory=await mkdtemp(join(tmpdir(),'mandala-work-discovery-')),copy=join(directory,'state.sqlite');
  try {
   for(let i=0;i<files.length;i++) {
    const original=before[i];if(!original)continue;
    const input=await open(files[i],constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
     if(fingerprint(await input.stat())!==fingerprint(original))throw new Error('native_snapshot_unstable');
     const output=await open(copy+(i?'-wal':''),'wx',0o600);
     try {
      const buffer=Buffer.alloc(128*1024);let offset=0;
      while(offset<original.size) {
       const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,original.size-offset),offset);
       if(!bytesRead)throw new Error('native_snapshot_unstable');
       await output.writeFile(buffer.subarray(0,bytesRead));offset+=bytesRead;
      }
     }finally{await output.close();}
    }finally{await input.close();}
   }
   const after=await Promise.all(files.map(metadata));
   if(await metadata(path+'-journal'))throw new Error('native_rollback_journal_present');
   if(before.some((s,i)=>fingerprint(s)!==fingerprint(after[i])))throw new Error('native_snapshot_unstable');
   return {directory,path:copy};
  }catch(error){await rm(directory,{recursive:true,force:true});if(attempt===1||!(error instanceof Error)||error.message!=='native_snapshot_unstable')throw error;}
 }
 throw new Error('native_snapshot_unstable');
}

async function codex(root:string,source:WorkDiscoverySource,start:number,end:number):Promise<Observation[]> {
 const observations:Observation[]=[];let db:DatabaseSync|undefined,snapshot:{directory:string;path:string}|undefined;
 try {
  const listing=await entries(root,10000);source.truncated=listing.truncated;
  const names=listing.names.filter(name=>/^state_\d+\.sqlite$/.test(name)).sort((a,b)=>Number(b.slice(6,-7))-Number(a.slice(6,-7)));
  if(!names.length){source.status='missing';source.reason='codex_state_database_missing';return [];}
  const path=join(root,names[0]);
  if(!(await lstat(path)).isFile()){source.status='unsupported';source.reason='codex_database_link_or_layout';return [];}
  snapshot=await snapshotDatabase(path);
  db=new DatabaseSync(snapshot.path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100');
  const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(row=>String(row.name)));
  const dates=['updated_at_ms','updated_at','created_at_ms','created_at'].filter(name=>columns.has(name));
  if(!columns.has('cwd')||!columns.has('id')||!dates.length){source.status='unsupported';source.reason='codex_threads_schema_unsupported';return [];}
  const time=dates.map(name=>name.endsWith('_ms')?`${name}/1000.0`:name),activity=time.length>1?`COALESCE(${time.join(',')})`:time[0];
  const pin=columns.has('is_pinned')?'is_pinned':columns.has('pinned')?'pinned':'NULL';
  const filters=[`${activity}>=?`,`${activity}<=?`];
  if(columns.has('archived'))filters.push('COALESCE(archived,0)=0');
  for(const column of ['source','thread_source'])if(columns.has(column))filters.push(`instr(lower(COALESCE(${column},'')),'subagent')=0`);
  for(const column of ['parent_thread_id','attached_thread_parent_id'])if(columns.has(column))filters.push(`(${column} IS NULL OR ${column}='')`);
  const rows=db.prepare(`SELECT cwd,${activity} AS activity,${columns.has('tokens_used')?'tokens_used':'NULL'} AS tokens,${pin} AS pinned FROM threads WHERE ${filters.join(' AND ')} ORDER BY activity DESC,id ASC LIMIT ?`).all(start/1000,end/1000,maxRows+1);
  source.truncated ||= rows.length>maxRows;source.scanned=Math.min(rows.length,maxRows);
  for(const row of rows.slice(0,maxRows)) {
   const lastActivity=timestamp(typeof row.activity==='number'?row.activity*1000:null);
   if(!validPath(row.cwd)||!lastActivity){source.skipped++;continue;}
   observations.push({path:row.cwd,runtime:'codex',lastActivity,tokenCount:typeof row.tokens==='number'&&Number.isSafeInteger(row.tokens)&&row.tokens>=0?row.tokens:null,pinned:row.pinned===1?true:row.pinned===0?false:null,provenance:'codex_sqlite'});
  }
  source.reason='codex_thread_metadata';
 }catch(error){unavailable(source,error);}finally{db?.close();if(snapshot)await rm(snapshot.directory,{recursive:true,force:true});}
 return observations;
}

async function omp(root:string,source:WorkDiscoverySource,start:number,end:number):Promise<Observation[]> {
 const observations:Observation[]=[],files:string[]=[],seen=new Set<string>();let enumerated=0,supported=0,readable=0,flat=false;
 try {
  const sessions=join(root,'sessions'),buckets=await entries(sessions,maxFiles);source.truncated=buckets.truncated;
  for(const name of buckets.names) {
   const bucket=join(sessions,name);
   if(!(await lstat(bucket)).isDirectory()){source.skipped++;flat ||= name.endsWith('.jsonl');continue;}
   for await(const item of await opendir(bucket)) {
    if(++enumerated>10000||files.length>=maxFiles){source.truncated=true;break;}
    if(!item.isFile()||!item.name.endsWith('.jsonl')){source.skipped++;continue;}
    files.push(join(bucket,item.name));
   }
   if(source.truncated&&(files.length>=maxFiles||enumerated>10000))break;
  }
  for(const path of files.sort()) {
   source.scanned++;
   try {
    // O_NOFOLLOW prevents native-session symlinks from redirecting the metadata read.
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let text:string,prefixTruncated:boolean;
    try{const buffer=Buffer.alloc(maxPrefix),{bytesRead}=await handle.read(buffer,0,maxPrefix,0);text=buffer.subarray(0,bytesRead).toString('utf8');prefixTruncated=(await handle.stat()).size>bytesRead;if(prefixTruncated&&!text.endsWith('\n'))text=text.slice(0,text.lastIndexOf('\n')+1);}finally{await handle.close();}
    readable++;const lines=text.split('\n',3);let first:Record<string,unknown>;
    try{first=JSON.parse(lines[0]);}catch{source.skipped++;if(prefixTruncated&&!lines[0])source.truncated=true;continue;}
    const header=first?.type==='title'?(lines[1]?JSON.parse(lines[1]):null):first;
    if(!header){source.truncated ||= prefixTruncated;source.skipped++;continue;}
    const lastActivity=timestamp(first?.type==='title'?first.updatedAt:header.timestamp)??timestamp(header.timestamp);
    if(header.type!=='session'||typeof header.id!=='string'||header.id.length>512||!header.id||!validPath(header.cwd)||!lastActivity){source.skipped++;continue;}
    supported++;
    if(Date.parse(lastActivity)<start||Date.parse(lastActivity)>end||seen.has(header.id)){source.skipped++;continue;}
    seen.add(header.id);observations.push({path:header.cwd,runtime:'omp',lastActivity,tokenCount:null,pinned:null,provenance:'omp_session_header'});
   }catch{source.skipped++;}
  }
  source.reason='omp_session_headers';
  if(!supported&&(source.scanned||flat)){
   source.status=source.scanned&&!readable?'unavailable':'unsupported';
   source.reason=source.status==='unavailable'?'native_metadata_unreadable':flat&&!source.scanned?'omp_session_layout_unsupported':'omp_header_layout_unsupported';
  }
 }catch(error){unavailable(source,error);}
 return observations;
}

// Resolve existing ancestors too: an absent child under a symlink must still obey exclusions.
async function canonical(path:string):Promise<string> {
 const suffix:string[]=[];let current=normalize(path);
 for(;;) {
  try{return join(await realpath(current),...suffix.reverse());}catch(error){if(!['ENOENT','ENOTDIR'].includes(errorCode(error)??''))return normalize(path);}
  if(dirname(current)===current)return normalize(path);suffix.push(basename(current));current=dirname(current);
 }
}
async function repository(path:string):Promise<string|null> {
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 try {
  const {stdout}=await runFile('git',['-C',path,'rev-parse','--path-format=absolute','--show-toplevel','--git-common-dir'],{timeout:750,maxBuffer:16384,encoding:'utf8',windowsHide:true,env:{...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}});
  const [top,common]=stdout.trim().split('\n');if(!validPath(top)||!validPath(common))return null;
  // A standard linked worktree shares the original repository's .git directory.
  return canonical(basename(common)==='.git'?dirname(common):top);
 }catch{return null;}
}
function internal(path:string,userHome:string,managedRoots:string[],temporary:string[]) {
 if(path===parse(path).root||path===userHome||managedRoots.some(root=>within(path,root)))return true;
 return temporary.some(root=>within(path,root)&&/^(?:mana-(?:system|catalog)-|mandala-(?:cli|skill)-)/.test(relative(root,path).split(sep)[0]));
}

export async function discoverWorkDirectories(config:Pick<Config,'runtimes'>,input:WorkDiscoveryInput={},host:WorkDiscoveryHost={}):Promise<WorkDiscoveryResult> {
 const runtimes=validate(config,input),now=host.now?.()??new Date(),start=now.getTime()-90*86400000;
 const userHome=await canonical(host.userHome??homedir());
 const roots={codex:host.codexHome??(host.userHome===undefined?process.env.CODEX_HOME:undefined)??join(userHome,'.codex'),omp:host.ompAgentDir??(host.userHome===undefined?process.env.PI_CODING_AGENT_DIR:undefined)??join(userHome,'.omp/agent')};
 const notices=['metadata_only: discovered paths grant no filesystem access or permission; activity does not establish responsibility.',
  'metrics: sessionCount counts observed sessions active in the last 90 days, not messages or calls; token counts are cumulative for those sessions, not window-specific cost; unknown metrics are null.',
  'source_counts: scanned counts matching database rows or session files read according to source layout. skipped includes rejected entries and excluded observations; these counters are not a complete session inventory.',
  'activity: timestamps use native thread or session-header metadata, never file mtime or verified last human activity.',
  'snapshot: database and WAL copies are limited to 128 MiB combined; a changing snapshot is retried once, then reported unavailable. Any rollback journal, including a persistent inactive journal, makes the source unavailable.',
  'layouts: each selected adapter reads one native metadata root; custom profiles require a trusted explicit native root. repositoryRoot=null means Git identity was not established.',
  'scope: only selected native metadata layouts are inspected; no repository contents, transcripts, credentials or native configuration are returned.'];
 if(!runtimes.length)notices.push('No native runtimes were selected or registered; only manually supplied paths are considered.');
 const sources=runtimes.map(sourceFor),observations:Observation[]=[];
 for(const source of sources) {
  if(source.runtime!=='codex'&&source.runtime!=='omp'){source.status='unsupported';source.reason='adapter_not_implemented';continue;}
  if(source.runtime==='omp'&&host.userHome===undefined&&host.ompAgentDir===undefined&&process.env.OMP_PROFILE&&!process.env.PI_CODING_AGENT_DIR){source.status='unsupported';source.reason='omp_profile_layout_unsupported';continue;}
  const root=roots[source.runtime];
  if(!validPath(root)){source.status='unsupported';source.reason='native_root_must_be_absolute';continue;}
  observations.push(...await(source.runtime==='codex'?codex(root,source,start,now.getTime()):omp(root,source,start,now.getTime())));
 }
 const managed=[join(userHome,'.mandala'),join(userHome,'.open-mana')];
 if(host.userHome===undefined){const home=process.env.MANDALA_HOME??process.env.OPEN_MANA_HOME;if(home&&validPath(home))managed.push(home);}
 const managedRoots=await Promise.all(managed.map(canonical)),temporary=await Promise.all([tmpdir(),'/tmp'].map(canonical));
 const excluded=await Promise.all((input.excludePaths??[]).map(canonical));
 observations.unshift(...(input.includePaths??[]).map(path=>({path,lastActivity:null,tokenCount:null,pinned:null,provenance:'manual' as const})));
 // Manual roots first, then most recent native observations. Bound metadata/Git probes separately.
 const paths=new Map<string,Observation[]>();
 for(const observation of observations.sort((a,b)=>(a.provenance==='manual'?0:1)-(b.provenance==='manual'?0:1)||(b.lastActivity??'').localeCompare(a.lastActivity??'')||a.path.localeCompare(b.path))) {
  const path=normalize(observation.path),existing=paths.get(path);
  if(existing)existing.push(observation);
  else if(paths.size<maxDirectories)paths.set(path,[observation]);
  else if(!notices.some(n=>n.startsWith('directory_limit:')))notices.push(`directory_limit: only ${maxDirectories} distinct observed paths were resolved.`);
 }
 const resolved:{path:string;root:string|null;exists:boolean;items:Observation[]}[]=[],pending=[...paths];let next=0;
 await Promise.all(Array.from({length:4},async()=>{
  while(next<pending.length) {
   const [raw,items]=pending[next++],path=await canonical(raw);
   if(internal(path,userHome,managedRoots,temporary)||excluded.some(root=>within(path,root))){for(const item of items){const source=sources.find(s=>s.runtime===item.runtime);if(source)source.skipped++;}continue;}
   const exists=await stat(path).then(s=>s.isDirectory(),()=>false),root=exists?await repository(path):null;
   resolved.push({path,root,exists,items});
  }
 }));
 const grouped=new Map<string,WorkDiscoveryCandidate>();
 for(const item of resolved.sort((a,b)=>a.path.localeCompare(b.path))) {
  const directory=item.root??item.path;let candidate=grouped.get(directory);
  if(!candidate){candidate={directory,repositoryRoot:item.root,workspacePaths:[],exists:item.exists,lastActivity:null,runtimes:[],provenance:[]};grouped.set(directory,candidate);}
  candidate.exists ||= item.exists;
  if(!candidate.workspacePaths.includes(item.path))candidate.workspacePaths.push(item.path);
  for(const observation of item.items) {
   if(!candidate.provenance.includes(observation.provenance))candidate.provenance.push(observation.provenance);
   if(observation.lastActivity&&(!candidate.lastActivity||observation.lastActivity>candidate.lastActivity))candidate.lastActivity=observation.lastActivity;
   if(!observation.runtime||!observation.lastActivity)continue;
   let metric=candidate.runtimes.find(m=>m.runtime===observation.runtime);
   if(!metric){metric={runtime:observation.runtime,sessionCount:0,tokenCount:0,pinned:false,lastActivity:observation.lastActivity,activitySource:observation.runtime==='codex'?'thread_updated_at':'session_header'};candidate.runtimes.push(metric);}
   metric.sessionCount++;metric.tokenCount=metric.tokenCount===null||observation.tokenCount===null?null:metric.tokenCount+observation.tokenCount;
   if(metric.tokenCount!==null&&!Number.isSafeInteger(metric.tokenCount))metric.tokenCount=null;
   metric.pinned=metric.pinned===true||observation.pinned===true?true:metric.pinned===null||observation.pinned===null?null:false;
   if(observation.lastActivity>metric.lastActivity)metric.lastActivity=observation.lastActivity;
  }
 }
 for(const candidate of grouped.values()){candidate.workspacePaths.sort();candidate.provenance.sort();candidate.runtimes.sort((a,b)=>a.runtime.localeCompare(b.runtime));}
 const candidates=[...grouped.values()].sort((a,b)=>(b.lastActivity??'').localeCompare(a.lastActivity??'')||a.directory.localeCompare(b.directory)),limit=input.limit??50;
 if(candidates.length>limit)notices.push(`candidate_limit: showing ${limit} of ${candidates.length} resolved candidates.`);
 if(sources.some(s=>s.truncated))notices.push('source_limit: native metadata was truncated; counts are a partial inventory. Codex <=10000 rows, OMP <=2000 files and <=64KiB header prefix per file.');
 return {selection:{basis:input.runtimes===undefined?'registered_runtimes':'user_selected',runtimes},generatedAt:now.toISOString(),windowStart:new Date(start).toISOString(),sources,candidates:candidates.slice(0,limit),notices};
}
