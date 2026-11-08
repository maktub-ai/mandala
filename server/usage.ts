import { createHash } from 'node:crypto';
import type { Store } from './store';
import type { RpcMessage } from './rpc';
import { DomainError } from '../shared/workspace-contracts';
import type { UsageContext, UsageExecution, UsageTokens, UsageQuery, UsageSummary, UsageCoverageCounts, UsageGroup } from '../shared/usage';
import type { SystemGenerator } from './system-tasks';

const fields = ['inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens'] as const;
const empty = ():UsageTokens => ({inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null,cacheWriteInputTokens:null,reasoningOutputTokens:null});
const zero = ():UsageTokens => ({inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0});
const number = (value:unknown):number|null => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const counts = ():UsageCoverageCounts => ({observed:0,partial:0,unknown:0,total:0});
function add(target:UsageTokens,value:UsageTokens) { for(const field of fields)if(value[field]!==null)target[field]=(target[field]??0)+value[field]!; }
const initialized = new WeakSet<Store>();
function ensure(store:Store) {
 if(initialized.has(store))return;
 store.database.exec(`CREATE TABLE IF NOT EXISTS usage_executions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS usage_observations(identity TEXT PRIMARY KEY,execution_id TEXT NOT NULL,observed_at TEXT NOT NULL,data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS usage_executions_updated ON usage_executions(json_extract(data,'$.updatedAt'));
 CREATE INDEX IF NOT EXISTS usage_observations_time ON usage_observations(observed_at);`);
 initialized.add(store);
}
function codexTokens(value:any):UsageTokens|null {
 if(!value||number(value.inputTokens)===null||number(value.outputTokens)===null)return null;
 const input=number(value.inputTokens)!,output=number(value.outputTokens)!;
 const cached=number(value.cachedInputTokens),write=number(value.cacheWriteInputTokens),reasoning=number(value.reasoningOutputTokens);
 if(cached!==null&&cached>input||write!==null&&write>input||reasoning!==null&&reasoning>output)return null;
 return {inputTokens:input,outputTokens:output,totalTokens:input+output,cachedInputTokens:cached,cacheWriteInputTokens:write,reasoningOutputTokens:reasoning};
}
function ompTokens(value:any):UsageTokens|null {
 if(!value)return null;
 const input=number(value.input),output=number(value.output),read=number(value.cacheRead),write=number(value.cacheWrite);
 // OMP 18.6.1 input excludes cached input; a missing cache field leaves input unknown.
 if(input===null||output===null||read===null||write===null)return null;
 const reasoning=number(value.reasoningTokens);
 if(reasoning!==null&&reasoning>output)return null;
 return {inputTokens:input+read+write,outputTokens:output,totalTokens:input+read+write+output,cachedInputTokens:read,cacheWriteInputTokens:write,reasoningOutputTokens:reasoning};
}

// One recorder per native client. Restored snapshots are baseline-only while no
// platform invocation is active; native histories are never copied into usage.
export function createUsageRecorder(store:Store) {
 ensure(store);
 const baselines=new Map<string,UsageTokens|null>(),models=new Map<string,string>(),restoring=new Set<string>(),reportedModels=new Set<string>();
 let active:UsageExecution|undefined;
 const save=()=>{if(active)store.database.prepare('INSERT INTO usage_executions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(active.executionId,JSON.stringify(active));};
 const reason=(value:string)=>{if(active&&!active.reasons.includes(value))active.reasons.push(value);};
 const coverage=()=>{if(active)active.coverage=active.totals.totalTokens===null?'unknown':active.reasons.length?'partial':'observed';};
 const record=(identity:string,tokens:UsageTokens|null,at:string,source:UsageExecution['source'],snapshot?:UsageTokens|null,model=active?.model??null)=>{
  if(!active)return;
  const inserted=store.database.prepare('INSERT OR IGNORE INTO usage_observations VALUES (?,?,?,?)').run(identity,active.executionId,at,JSON.stringify({tokens,snapshot,model,source}));
  if(!inserted.changes)return;
  if(tokens)add(active.totals,tokens);
  active.updatedAt=at;active.source=source;coverage();save();
 };
 return {
  begin(context:UsageContext,at=new Date().toISOString()) {
   reportedModels.clear();
   const existing=store.database.prepare('SELECT data FROM usage_executions WHERE id=?').get(context.executionId);
   active=existing?JSON.parse(existing.data as string):{...context,model:context.model??null,startedAt:at,updatedAt:at,status:'running',nativeSessionId:null,nativeTurnId:null,source:null,coverage:'unknown',totals:empty(),reasons:[]};save();
  },
  event(event:RpcMessage,at=new Date().toISOString()) {
   const p=event.params??{},thread=p.threadId,method=event.method?.replace(/^openmana\//,'mandala/');
   if(method==='mandala/usageBaseline'&&typeof thread==='string') {
    baselines.set(thread,p.fresh?zero():null);if(p.fresh)restoring.delete(thread);else restoring.add(thread);if(typeof p.model==='string')models.set(thread,p.model);return;
   }
   if(method==='mandala/usageModel'&&typeof thread==='string') {if(typeof p.model==='string'){models.set(thread,p.model);if(active?.nativeSessionId===thread){active.model=p.model;save();}}return;}
   if(method==='turn/started'&&active&&typeof thread==='string'&&typeof p.turn?.id==='string') {
    if(active.nativeSessionId&&active.nativeSessionId!==thread||active.nativeTurnId&&active.nativeTurnId!==p.turn.id)return;
    restoring.delete(thread);active.nativeSessionId=thread;active.nativeTurnId=p.turn.id;active.model=models.get(thread)??active.model;save();return;
   }
   if(method==='thread/tokenUsage/updated') {
    const current=codexTokens(p.tokenUsage?.total);
    if(!active||!active.nativeSessionId) {if(typeof thread==='string'&&restoring.has(thread))baselines.set(thread,current);return;}
    if(active.cli!=='codex'||thread!==active.nativeSessionId||p.turnId!==active.nativeTurnId)return;
    const identity='codex:'+thread+':'+p.turnId+':'+createHash('sha256').update(JSON.stringify(current)).digest('hex');
    // A replay of an already observed snapshot must not rewind the baseline.
    // Unseen lower counters still take the rollback path below.
    if(store.database.prepare('SELECT 1 FROM usage_observations WHERE identity=?').get(identity))return;
    const previous=baselines.get(thread),last=codexTokens(p.tokenUsage?.last);
    let delta:UsageTokens|null=null;
    if(!current)reason('invalid_native_usage');
    else if(!previous)reason('missing_baseline');
    else if(fields.some(field=>current[field]!==null&&previous[field]!==null&&current[field]!<previous[field]!))reason('counter_rollback');
    else if(last?.totalTokens===0&&current.totalTokens!==previous.totalTokens)reason('context_estimate');
    else {delta=empty();for(const field of fields)if(current[field]!==null&&previous[field]!==null)delta[field]=current[field]!-previous[field]!;}
    if(current)baselines.set(thread,current);
    record(identity,delta,at,'codex:session-delta',current);return;
   }
   if(method==='mandala/usageMessage'&&active?.cli==='omp'&&thread===active.nativeSessionId&&p.turnId===active.nativeTurnId) {
    if(typeof p.model==='string'){reportedModels.add(p.model);active.model=reportedModels.size===1?p.model:null;}
    if(typeof p.messageId!=='string'||!p.messageId){reason('missing_message_identity');coverage();save();return;}
    let tokens=ompTokens(p.usage);
    // OMP's provider/error initial messages contain zero counters even when no
    // provider usage payload arrived; RPC does not expose sawUsagePayload.
    if(tokens?.totalTokens===0){tokens=null;reason('empty_native_usage');}
    else if(!tokens)reason('missing_native_usage');
    record('omp:'+thread+':'+p.turnId+':'+p.messageId,tokens,at,'omp:message_end',undefined,typeof p.model==='string'?p.model:active.model);
   }
  },
  bind(nativeSessionId:string,nativeTurnId:string) {restoring.delete(nativeSessionId);if(active){active.nativeSessionId=nativeSessionId;active.nativeTurnId=nativeTurnId;active.model=models.get(nativeSessionId)??active.model;save();}},
  finish(status:UsageExecution['status'],at=new Date().toISOString(),diagnostic?:string) {
   if(!active)return;active.status=status;active.updatedAt=at;if(diagnostic)reason(diagnostic);if(active.totals.totalTokens===null)reason('no_usage_reported');coverage();save();active=undefined;
  },
 };
}
export type UsageObserver = { event:(event:RpcMessage)=>void; bind:(threadId:string,turnId:string)=>void };
// Startup has no live native subscription. Preserve counters without claiming completion.
export function recoverUsage(store:Store) {
 ensure(store);
 for(const row of store.database.prepare("SELECT id,data FROM usage_executions WHERE json_extract(data,'$.status')='running'").all()) {
  const execution=JSON.parse(row.data as string) as UsageExecution;
  execution.status='interrupted';
  if(!execution.reasons.includes('service_restarted'))execution.reasons.push('service_restarted');
  if(execution.coverage==='observed')execution.coverage='partial';
  store.database.prepare('UPDATE usage_executions SET data=? WHERE id=?').run(JSON.stringify(execution),row.id as string);
 }
}
export async function meterGeneration(store:Store,generate:SystemGenerator,context:UsageContext,config:Parameters<SystemGenerator>[0],prompt:string,signal:AbortSignal):Promise<string> {
 const recorder=createUsageRecorder(store);recorder.begin(context);
 const abort=()=>recorder.finish('interrupted');signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted)abort();
 try {const value=await generate(config,prompt,signal,recorder);recorder.finish(signal.aborted?'interrupted':'completed');return value;}
 catch(error){recorder.finish(signal.aborted?'interrupted':'failed');throw error;}
 finally {signal.removeEventListener('abort',abort);}
}

function dateInZone(time:string,formatter:Intl.DateTimeFormat) {
 const parts=formatter.formatToParts(new Date(time));
 return ['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');
}
function midnight(date:string,timeZone:string) {
 const target=Date.parse(date+'T00:00:00.000Z');let before=target-2*86400000,after=target+2*86400000;
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
 // Midnight may be skipped by DST. Find the date's first valid instant rather
 // than resolving a nonexistent 00:00 to the preceding local date.
 while(after-before>1) {
  const middle=Math.floor((before+after)/2),parts=formatter.formatToParts(new Date(middle));
  const localDate=['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');
  if(localDate<date)before=middle;else after=middle;
 }
 return new Date(after).toISOString();
}
const shiftDate=(date:string,days:number)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
export function getUsage(store:Store,query:UsageQuery,options?:{canReadExecution?:(execution:UsageExecution)=>boolean}):UsageSummary {
 ensure(store);const now=query.now??new Date().toISOString();let today:string,formatter:Intl.DateTimeFormat;
 try {if(!['today','week'].includes(query.period)||!Number.isFinite(Date.parse(now)))throw new Error();formatter=new Intl.DateTimeFormat('en-CA',{timeZone:query.timeZone,year:'numeric',month:'2-digit',day:'2-digit'});today=dateInZone(now,formatter);}
 catch {throw new DomainError('invalid_usage_query',422,'A valid period and IANA time zone are required');}
 const dates=Array.from({length:query.period==='today'?1:7},(_,i)=>shiftDate(today,i-(query.period==='today'?0:6)));
 const start=midnight(dates[0],query.timeZone),end=midnight(shiftDate(today,1),query.timeZone);
 const observations=new Map<string,{at:string;tokens:UsageTokens|null;model:string|null}[]>();
 const filters:string[]=[],scopeArgs:string[]=[];
 for(const key of ['projectId','agentId','cli'] as const)if(query[key]){filters.push(`json_extract(e.data,'$.${key}')=?`);scopeArgs.push(query[key]!);}
 const scope=filters.length?' AND '+filters.join(' AND '):'';
 for(const row of store.database.prepare('SELECT o.execution_id,o.observed_at,o.data FROM usage_observations o JOIN usage_executions e ON e.id=o.execution_id WHERE o.observed_at>=? AND o.observed_at<?'+scope+' ORDER BY o.observed_at').all(start,end,...scopeArgs)) {
  const values=observations.get(row.execution_id as string)??[];values.push({at:row.observed_at as string,...JSON.parse(row.data as string)});observations.set(row.execution_id as string,values);
 }
 const rows=(store.database.prepare("SELECT data FROM usage_executions WHERE ((json_extract(data,'$.startedAt')<? AND json_extract(data,'$.updatedAt')>=?) OR id IN (SELECT execution_id FROM usage_observations WHERE observed_at>=? AND observed_at<?))"+scope.replaceAll('e.data','data')).all(end,start,start,end,...scopeArgs).map(row=>JSON.parse(row.data as string)) as UsageExecution[])
  .filter(row=>(row.startedAt<end&&row.updatedAt>=start||observations.has(row.executionId))&&(!query.projectId||row.projectId===query.projectId)&&(!query.agentId||row.agentId===query.agentId)&&(!query.cli||row.cli===query.cli)&&(!query.model||(observations.has(row.executionId)?observations.get(row.executionId)!.some(o=>o.model===query.model):row.model===query.model))&&(!options?.canReadExecution||options.canReadExecution(row)));
 const totals=empty(),coverage=counts(),daily=dates.map(date=>({date,totals:empty(),coverage:counts()}));
 const groups:UsageSummary['groups']={category:[],cli:[],model:[],project:[],agent:[],stage:[],reviewStage:[],callKind:[]};
 const groupMaps=Object.fromEntries(Object.keys(groups).map(key=>[key,new Map<string|null,UsageGroup>()])) as Record<keyof typeof groups,Map<string|null,UsageGroup>>;
 for(const row of rows) {
  const recorded=empty(),values=(observations.get(row.executionId)??[]).filter(o=>!query.model||o.model===query.model).map(o=>({...o,date:dateInZone(o.at,formatter)}));
  const startedDate=dateInZone(row.startedAt,formatter);
  for(const value of values)if(value.tokens)add(recorded,value.tokens);
  row.totals=recorded;add(totals,recorded);coverage[row.coverage]++;coverage.total++;
  for(const bucket of daily) {
   const matches=values.filter(o=>o.date===bucket.date);
   if(matches.length||startedDate===bucket.date) {bucket.coverage[row.coverage]++;bucket.coverage.total++;for(const value of matches)if(value.tokens)add(bucket.totals,value.tokens);}
  }
  for(const dimension of Object.keys(groups) as (keyof typeof groups)[]) {
   if(dimension==='model') {
    const byModel=new Map<string|null,UsageTokens>();
    for(const value of values){const tokens=byModel.get(value.model)??empty();if(value.tokens)add(tokens,value.tokens);byModel.set(value.model,tokens);}
    if(!byModel.size)byModel.set(row.model,empty());
    for(const [key,tokens]of byModel){const map=groupMaps.model,group=map.get(key)??{key,totals:empty(),coverage:counts()};add(group.totals,tokens);group.coverage[row.coverage]++;group.coverage.total++;map.set(key,group);}
    continue;
   }
   const key=dimension==='project'?row.projectId??null:dimension==='agent'?row.agentId??null:row[dimension]??null;
   const map=groupMaps[dimension],group=map.get(key)??{key,totals:empty(),coverage:counts()};
   add(group.totals,recorded);group.coverage[row.coverage]++;group.coverage.total++;map.set(key,group);
  }
 }
 for(const dimension of Object.keys(groups) as (keyof typeof groups)[])groups[dimension]=[...groupMaps[dimension].values()];
 return {window:{start,end,timeZone:query.timeZone,period:query.period},generatedAt:now,totals,coverage,daily,groups,recent:rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100)};
}
