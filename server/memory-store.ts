import { memoryTextSource } from './memory-chunks';
import { isObsoleteMemoryError } from '../shared/memory-job-policy';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Store } from './store';
import type { createAssets } from './assets';
import type { createTasks } from './tasks';
import { canUseKnowledge } from '../shared/knowledge-access';
import type { KnowledgeEntry, DisplayEvent } from '../shared/types';
import { DomainError, type Principal } from '../shared/workspace-contracts';
import type { CaptureResult, EvidenceRef, MemoryCollection, MemoryJob, MemoryProposal, MemoryRevision, MemoryRevisionRef, MemorySource, MemoryStatus, MemoryProfileScope } from '../shared/memory';
export const memoryHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export const memoryFail=(code:string,status=409):never=>{throw new DomainError(code,status,code);};
export const lastConversationContentEventId=(store:Store,id:string):number=>Number(store.database.prepare("SELECT id FROM events WHERE conversationId=? AND superseded=0 AND kind IN ('user','text','status') ORDER BY id DESC LIMIT 1").get(id)?.id??0);
export const unicodeLength=(text:string)=>Array.from(text).length;
export const memoryToolFiles=(event:MemorySource['events'][number],quote:string):string[]=>{
 if(event.kind!=='tool')return [];
 const offset=event.text.indexOf(quote),line=event.text.slice(event.text.lastIndexOf('\n',offset-1)+1).split('\n')[0],file=line.match(/^([^:\r\n]+?\.[A-Za-z0-9]+):\d+(?::\d+)?:/)?.[1];
 return (file?[file]:event.origin?.files??[]).map(path=>event.origin?.cwd?posix.resolve(event.origin.cwd,path):posix.normalize(path));
};
export const memoryToolObservationScoped=(event:MemorySource['events'][number],quote:string,text:string):boolean=>{
 const files=memoryToolFiles(event,quote);
 return files.length<=1&&(!files.length||!!event.createdAt&&typeof text==='string'&&text.includes(event.createdAt.slice(0,10))&&files.some(file=>new RegExp('(^|[^A-Za-z0-9_./-])'+file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^A-Za-z0-9_./-])').test(text)));
};
const parse=<T>(data:unknown):T=>JSON.parse(data as string);
// Conservative redaction before durable capture; structured tool arguments are never copied.
const safeText=(text:string)=>text.replace(/(?:Bearer\s+)[\w.+/=-]+/gi,'[REDACTED]').replace(/\b(?:sk-[\w-]{12,}|AKIA[A-Z0-9]{16})\b/g,'[REDACTED]').replace(/((?:\b(?:password|token|secret|credentials?|api[_ -]?key|verification[ _-]?code)\b|验证码|密码|密钥|凭据)(?:\s*[:=：是为]\s*|\s+is\s+|\s+))[^\s,，;；。]+/gi,'$1[REDACTED]');
const assertedQuote=(text:string,quote:string)=>{
 const offset=text.indexOf(quote);if(offset<0)return false;
 const prefix=text.slice(0,offset).split(/[。.!！?？\n]/).at(-1)??'';
 const suffix=/[。.!！?？\n]$/.test(quote)?'':text.slice(offset+quote.length).match(/^[^。.!！?？\n]*[。.!！?？\n]?/)?.[0]??'';
 const sentence=(prefix+quote+suffix).trim();
 return !/[?？]/.test(sentence)&&!/^(如果|假如|例如|比如|if\b|suppose\b|for example\b)/i.test(sentence);
};
const clip=(text:string,max:number)=>unicodeLength(text)<=max?text:Array.from(text).slice(0,max-18).join('')+'…（摘录缩略，见完整来源）';
export function memoryStageSummary(source:MemorySource):string {
 if(source.kind==='task'){
  const t=source.taskSnapshot;if(!t)return clip(source.text,1800);
  return `任务阶段 ${source.taskId} / 修订 ${source.taskRevision}（历史状态）\n目标：${clip(t.goal,350)}\n完成条件：${clip(t.criteria.join('；'),250)}\n该阶段状态：${t.state}；完成方式：${t.completedBy??'未完成'}（checks 仅产物完整性）\n执行尝试 ${t.runs.length} 次：${clip(t.runs.map(r=>`${r.id}：${r.state}；助手摘要（未验证）：${r.summary??''}`).join('\n'),600)}\n回执：${t.receiptCount} 条（结论未验证，详见来源）\n固定来源/产物：${clip(source.versions.map(v=>`${v.assetId}@${v.versionId}`).join('，'),300)}`;
 }

 const user=source.events.filter(e=>e.kind==='user').map(e=>e.text).join('\n');
 const assistant=source.events.filter(e=>e.kind==='text').map(e=>e.text).join('');
 return `对话阶段摘录（${source.observedAt??'时间未知'}；不代表当前状态）\n用户输入：${clip(user,1000)}\n助手答复（未验证结论）：${clip(assistant,650)}\n来源事件：${source.eventIds.join(',')}`.slice(0,2000);
}
export function explicitMemoryKind(text:string):'fact'|'preference'|null {
 const value=text.trim();
 if(/[?？]/.test(value)||/^(请问|如果|假如|例如|比如|if |suppose |for example)/i.test(value))return null;
 if(!/^(请记住|记住|以后|始终|我的偏好|我偏好|我喜欢|I prefer\b|please remember\b|remember\b|always\b)/i.test(value))return null;
 return /(以后|始终|偏好|喜欢|I prefer|always)/i.test(value)?'preference':'fact';
}
const assertionKey=(text:string):string|null=>{
 const normalized=text.normalize('NFKC').toLowerCase().replace(/^(请记住|记住|please remember|remember)[:：\s]*/i,'');
 const match=/^(.*?)(?:使用|采用|选择|用|prefer\s+)(.+)$/.exec(normalized);
 return match?match[1].replace(/\s+/g,'')||'explicit-preference':null;
};
type Options={assets:ReturnType<typeof createAssets>;tasks:ReturnType<typeof createTasks>;localUserId:string;authorizeProject?:(principal:Principal,projectId:string)=>void;authorizeConversationRead?:(principal:Principal,conversationId:string)=>void};
export function createMemoryStore(store:Store, options:Options) {
 const db=store.database;
 // Authorities are always rechecked per synchronous query. Event digests alone
 // survive unrelated writes; transcript revisions include changes from every connection.
 const eventHashes=new Map<string,Map<number,string>>();
 const eventHashVersions=new Map<string,number>(),eventRevision=db.prepare('SELECT revision FROM event_revisions WHERE conversation_id=?');
 let queryCache:{collections:Map<string,MemoryCollection>;sources:Map<string,MemorySource>;rawSources:Map<string,MemorySource>;records:Map<string,MemoryRevision>;eventData:Map<string,{text?:unknown;agentMessage?:unknown;task?:unknown}>;eventHashes:Map<string,Map<number,string>>;permissions:Set<string>;checkedTranscripts:Set<string>}|null=null;
 const authorityQuery=<T>(fn:()=>T):T=>{
  if(queryCache){
   if(db.isTransaction&&queryCache.eventHashes===eventHashes){
    queryCache.eventHashes=new Map();queryCache.checkedTranscripts.clear();
   }
   return fn();
  }
  const transactional=db.isTransaction;
  // Transactional digests stay private and are discarded on exit. Keep the
  // committed cache: rolled-back revisions still describe its original events.
  queryCache={collections:new Map(),sources:new Map(),rawSources:new Map(),records:new Map(),eventData:new Map(),eventHashes:transactional?new Map():eventHashes,permissions:new Set(),checkedTranscripts:new Set()};
  try{return fn();}finally{queryCache=null;}
 };
 const queryKey=(p:Principal,id:string,projectId?:string|null)=>JSON.stringify([p,id,projectId===undefined?'scope-unset':projectId]);
 const atomic=<T>(fn:()=>T):T=>db.isTransaction?fn():store.transaction(fn);
 store.transaction(()=>{db.exec(`
 CREATE TABLE IF NOT EXISTS memory_generation_state(kind TEXT PRIMARY KEY,enabled INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_generation_exclusions(kind TEXT NOT NULL,start_event_id INTEGER NOT NULL,end_event_id INTEGER);
 CREATE TABLE IF NOT EXISTS memory_generation_task_exclusions(task_id TEXT PRIMARY KEY,last_revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_capture_cutoffs(conversation_id TEXT PRIMARY KEY,last_event_id INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_task_capture_cutoffs(task_id TEXT PRIMARY KEY,last_revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_collections(id TEXT PRIMARY KEY REFERENCES assets(id),scope_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_sources(id TEXT PRIMARY KEY,source_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_source_revisions(source_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source_id,revision));
 CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL REFERENCES memory_collections(id),data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS memory_records_legacy_id ON memory_records(json_extract(data,'$.legacyId'));
 CREATE INDEX IF NOT EXISTS memory_records_collection ON memory_records(collection_id);
 CREATE TABLE IF NOT EXISTS memory_revisions(record_id TEXT NOT NULL REFERENCES memory_records(id),revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(record_id,revision));
 CREATE TABLE IF NOT EXISTS memory_suppressions(collection_id TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(collection_id,key));
 CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_uses(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_record_scope(record_id TEXT PRIMARY KEY,project_id TEXT,agent_id TEXT,status TEXT NOT NULL,layer TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS memory_scope_status ON memory_record_scope(status,record_id);
 CREATE INDEX IF NOT EXISTS memory_scope_lookup ON memory_record_scope(project_id,agent_id,status,layer);
 CREATE TABLE IF NOT EXISTS memory_record_links(record_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,PRIMARY KEY(record_id,kind,target_id));
 CREATE INDEX IF NOT EXISTS memory_links_lookup ON memory_record_links(kind,target_id,record_id);
 CREATE TABLE IF NOT EXISTS memory_index(record_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,text TEXT NOT NULL);
 `);db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?,?)').run('memory_core_001',new Date().toISOString());});
 const principal=(p:Principal)=>{
  if(!p?.userId||p.userId!==options.localUserId)memoryFail('forbidden',403);
  if(p.runId){
   if(!p.agentId)memoryFail('incomplete_run_principal',403);
   const run=options.tasks.getRun(p,p.runId),execution=options.tasks.getExecution(p,run.executionId);
   if(execution.agentId!==p.agentId)memoryFail('run_identity_mismatch',403);
  }
 };
 const collection=(p:Principal,id:string,projectId?:string|null):MemoryCollection=>{
  principal(p);const cacheKey=queryKey(p,id,projectId),cached=queryCache?.collections.get(cacheKey);if(cached)return cached;
  const row=db.prepare('SELECT data FROM memory_collections WHERE id=?').get(id);if(!row)memoryFail('memory_collection_not_found',404);const c=parse<MemoryCollection>(row!.data);
  if(c.legacy){
   // Original scope is needed to interpret the Asset's owner policy. The Asset remains the live ACL authority.
   const asset=options.assets.getAuthorizedAsset({userId:p.userId},id);
   const currentProject=p.runId?options.tasks.getExecution(p,options.tasks.getRun(p,p.runId).executionId).projectId:projectId;
   if(p.agentId&&(!canUseKnowledge({...c.legacy,content:'',access:asset.accessPolicy},{agentId:p.agentId,projectId:currentProject??''})))memoryFail('forbidden',403);
  }else {if(c.projectId&&p.agentId&&options.authorizeProject)options.authorizeProject(p,c.projectId);const asset=options.assets.getAuthorizedAsset({userId:p.userId},id);if(p.agentId&&asset.accessPolicy.mode!=='owner')options.assets.getAuthorizedAsset(p,id);else if(c.agentId!==null)options.assets.getAuthorizedAsset(p,id);const currentProject=p.runId?options.tasks.getExecution(p,options.tasks.getRun(p,p.runId).executionId).projectId:projectId;if(c.projectId===null&&p.agentId&&currentProject)options.authorizeProject?.(p,currentProject);if(p.agentId&&currentProject!==undefined&&c.projectId!==null&&c.projectId!==currentProject)memoryFail('scope_mismatch',403);}
  queryCache?.collections.set(cacheKey,c);return c;
 };
 const ensureCollection=(p:Principal,input:{projectId:string|null;agentId:string|null}):MemoryCollection=>{
  principal(p);if(input.projectId===undefined||input.agentId===undefined||p.agentId&&p.agentId!==input.agentId)memoryFail('invalid_memory_scope',403);
  if(input.projectId&&p.agentId)options.authorizeProject?.(p,input.projectId);
  input={...input,agentId:input.projectId?null:input.agentId};
  const key=JSON.stringify([p.userId,input.projectId,input.agentId]);const row=db.prepare('SELECT id FROM memory_collections WHERE scope_key=?').get(key);if(row)return collection(p,row.id as string);
  const asset=options.assets.createAsset(p,{kind:'memory_collection',title:'记忆',owner:{userId:p.userId,...(input.agentId?{agentId:input.agentId}:{})}});
  return store.transaction(()=>{const value={id:asset.id,...input,generation:1};db.prepare('INSERT INTO memory_collections VALUES (?,?,?)').run(value.id,key,JSON.stringify(value));return value;});
 };
 const parseEventData=(value:unknown)=>{
  const key=value as string,cached=queryCache!.eventData.get(key);if(cached)return cached;
  const data=parse<{text?:unknown;agentMessage?:unknown;task?:unknown}>(value);queryCache!.eventData.set(key,data);return data;
 };
 const loadSource=(id:string):MemorySource=>{const cached=queryCache?.rawSources.get(id);if(cached)return cached;const row=db.prepare('SELECT data FROM memory_sources WHERE id=?').get(id);if(!row)memoryFail('memory_source_not_found',404);const source=parse<MemorySource>(row!.data);queryCache?.rawSources.set(id,source);return source;};
 // Verified user assertions cite their quoted events, not unrelated recalled Agent context.
 // This read projection also handles already stored broad evidence without rewriting it.
 const userEvidence=(r:MemoryRevision):EvidenceRef[]=>{
  if(r.layer!=='L1'||r.verification!=='evidence_extract'||!r.support?.length)return r.evidence;
  // A real quote cannot authorize unrelated model-derived text or metadata.
  const text=r.text.trim(),content=[text,...r.semanticKey!==undefined?[r.semanticKey]:[],...r.validUntil!==null?[r.validUntil]:[]];
  if(!text||!r.support.some(ref=>typeof ref.quote==='string'&&content.every(value=>ref.quote.includes(value))))return r.evidence;
  const contains=(e:EvidenceRef,ref:NonNullable<MemoryRevision['support']>[number])=>e.sourceId===ref.sourceId&&(e.startEventId===undefined||ref.eventId>=e.startEventId)&&(e.endEventId===undefined||ref.eventId<=e.endEventId);
  for(const ref of r.support){
   if(!Number.isSafeInteger(ref.eventId)||typeof ref.quote!=='string'||!ref.quote.trim())return r.evidence;
   const source=loadSource(ref.sourceId),event=source.events.find(e=>e.id===ref.eventId);
   const proof=r.evidence.filter(e=>contains(e,ref));
   if(!proof.length||proof.some(e=>e.sourceRevision!==source.revision)||source.kind!=='conversation'||!source.conversationId||!event||event.kind!=='user'||event.contextOnly||!event.text.includes(ref.quote)||!assertedQuote(event.text,ref.quote)||/[?？]/.test(ref.quote)||/^(如果|假如|例如|比如|if\b|suppose\b|for example\b)/i.test(ref.quote.trim()))return r.evidence;
   const original=db.prepare("SELECT data FROM events WHERE id=? AND conversationId=? AND kind='user' AND superseded=0").get(ref.eventId,source.conversationId);
   if(!original)return r.evidence;
   const data=parseEventData(original.data);
   if(typeof data.text!=='string'||!safeText(data.text).includes(ref.quote)||data.agentMessage!=null||data.task!=null)return r.evidence;
  }
  return [...new Map(r.evidence.flatMap(e=>{
   const supports=r.support!.filter(ref=>contains(e,ref));
   return supports.length?supports.map(ref=>({...e,startEventId:ref.eventId,endEventId:ref.eventId})):[e];
  }).map(e=>[JSON.stringify(e),e])).values()];
 };
 const authorizeConversation=(p:Principal,id:string)=>{principal(p);const chat=store.getConversation(id);if(!chat||p.agentId&&p.agentId!==chat.agentId)memoryFail('forbidden',403);const key='conversation:'+queryKey(p,id);if(!queryCache?.permissions.has(key)){options.authorizeConversationRead?.(p,id);queryCache?.permissions.add(key);}return chat!;};
 const sourceBase=(p:Principal,id:string,projectId?:string|null,allowRetracted=false):MemorySource=>authorityQuery(()=>{
  if(p.agentId&&projectId===undefined&&!p.runId)memoryFail('project_scope_required',422);
  const cacheKey=queryKey(p,id,projectId)+(allowRetracted?':rebuild':''),cached=queryCache!.sources.get(cacheKey);if(cached)return cached;
  const s=loadSource(id);collection(p,s.collectionId,projectId);if(s.status==='retracted'&&!allowRetracted)memoryFail('source_retracted');
  if(s.conversationId){const chat=store.getConversation(s.conversationId);if(p.agentId&&chat?.agentId!==p.agentId&&chat?.projectId&&collection(p,s.collectionId,projectId).agentId===null&&options.authorizeProject){options.authorizeProject(p,chat.projectId);}else authorizeConversation(p,s.conversationId);}
  const archived=s.taskResetAuthority;
  if(archived&&(p.userId!==archived.ownerUserId||p.agentId&&!archived.agentIds.includes(p.agentId)))memoryFail('forbidden',403);
  if(s.taskId&&!archived?.taskIds.includes(s.taskId))options.tasks.getTask(p,s.taskId);
  for(const runId of s.runIds)if(!archived?.runIds.includes(runId))options.tasks.getRun(p,runId);
  for(const ref of s.versions)options.assets.getAuthorizedVersion(p,ref);
  if(s.conversationId){
   if(!queryCache!.checkedTranscripts.has(s.conversationId)){
    const revision=Number(eventRevision.get(s.conversationId)?.revision??0);
    if(eventHashVersions.get(s.conversationId)!==revision){queryCache!.eventHashes.delete(s.conversationId);if(queryCache!.eventHashes===eventHashes)eventHashVersions.set(s.conversationId,revision);}
    queryCache!.checkedTranscripts.add(s.conversationId);
   }
   let hashes=queryCache!.eventHashes.get(s.conversationId);if(!hashes){hashes=new Map();queryCache!.eventHashes.set(s.conversationId,hashes);}
   const missing=s.events.filter(event=>!hashes!.has(event.id));
   // Keep each query below SQLite's parameter limit without reading unrelated events.
   for(let offset=0;offset<missing.length;offset+=500){
    const ids=missing.slice(offset,offset+500).map(event=>event.id);
    const rows=db.prepare('SELECT id,conversationId,kind,data,createdAt FROM events WHERE conversationId=? AND superseded=0 AND id IN ('+ids.map(()=>'?').join(',')+')').all(s.conversationId,...ids);
    for(const row of rows)hashes.set(Number(row.id),memoryHash(JSON.stringify({...row,data:parseEventData(row.data)})));
   }
   for(const event of s.events)if(hashes.get(event.id)!==event.hash)memoryFail('source_changed');
  }
  for(const use of s.memoryUses??[]){const row=db.prepare('SELECT run_id,data FROM memory_uses WHERE id=?').get(use.id);if(!row||row.run_id!==use.runId||!s.runIds.includes(use.runId)||memoryHash(row.data as string)!==use.hash)memoryFail('source_changed');}
  queryCache!.sources.set(cacheKey,s);return s;
 });
 const uniqueRefs=(refs:MemoryRevisionRef[]):MemoryRevisionRef[]=>[...new Map(refs.map(r=>[`${r.recordId}:${r.revision}`,r])).values()].sort((a,b)=>a.recordId.localeCompare(b.recordId)||a.revision-b.revision);
 const parseUseRefs=(items:unknown):MemoryRevisionRef[]=>{
  if(!Array.isArray(items)||items.some(item=>!item||typeof item.recordId!=='string'||!item.recordId||!Number.isSafeInteger(item.revision)||item.revision<1))memoryFail('invalid_memory_handoff',422);
  return uniqueRefs((items as MemoryRevisionRef[]).map(({recordId,revision})=>({recordId,revision})));
 };
 const compatibleRevision=(ref:MemoryRevisionRef,current:MemoryRevision):boolean=>{
  if(current.recordId!==ref.recordId)return false;
  if(current.revision===ref.revision)return true;
  if(current.revision<ref.revision)return false;
  const history=db.prepare('SELECT data FROM memory_revisions WHERE record_id=? AND revision>=? AND revision<=? ORDER BY revision').all(ref.recordId,ref.revision,current.revision).map(row=>parse<MemoryRevision>(row.data));
  if(history.length!==current.revision-ref.revision+1)return false;
  const meaning=(r:MemoryRevision)=>JSON.stringify([r.recordId,r.collectionId,r.semanticKey,r.text,r.contentHash,r.status,r.verification,r.layer,r.contentType,r.validUntil,r.effectiveFrom,r.dependencies]);
  const expected=meaning(history[0]);
  return history.every((r,index)=>meaning(r)===expected&&(index===0||r.revisionKind==='evidence_append'));
 };
 const validateMemoryRefs=(p:Principal,c:Pick<MemoryCollection,'projectId'|'agentId'>,refs:MemoryRevisionRef[],visited=new Set<string>())=>{
  // Root-driven capture must honor the actual recipient's current scope and privileges too.
  const origin:Principal={userId:p.userId,...(c.agentId?{agentId:c.agentId}:{})};
  const recipients=p.agentId?[p,...(p.agentId!==c.agentId?[origin]:[])]:[origin];
  for(const recipient of recipients)for(const ref of refs){
   const raw=rawRecord(ref.recordId),parentScope=parse<MemoryCollection>(db.prepare('SELECT data FROM memory_collections WHERE id=?').get(raw.collectionId)!.data);
   if(c.agentId===null&&parentScope.agentId!==null&&!parentScope.legacy)memoryFail('memory_dependency_scope',403);
   const readProject=c.projectId===null&&c.agentId!==null?parentScope.projectId:c.projectId;
   const parent=read(recipient,ref.recordId,readProject,visited),parentCollection=collection(recipient,parent.collectionId,readProject);
   if(parentCollection.projectId!==c.projectId&&!parentCollection.legacy&&!(c.agentId!==null&&c.projectId===null)&&!(parentCollection.projectId===null&&parentCollection.agentId===c.agentId)&&!(parentCollection.projectId===null&&parentCollection.agentId===null&&parent.contentType==='preference'))memoryFail('memory_dependency_scope',403);
   if(!compatibleRevision(ref,parent)||parent.status!=='active'||parent.validUntil&&Date.parse(parent.validUntil)<=Date.now())memoryFail('stale_memory_dependency');
  }
 };
 // Trusted server callers supply the actual conversation scope; Run scope is independently derived.
 const validateReferences=(p:Principal,input:{projectId:string|null;items:MemoryRevisionRef[]}):void=>authorityQuery(()=>{
  principal(p);
  if(input.projectId!==null&&typeof input.projectId!=='string')memoryFail('project_scope_required',422);
  if(p.runId&&options.tasks.getExecution(p,options.tasks.getRun(p,p.runId).executionId).projectId!==input.projectId)memoryFail('scope_mismatch',403);
  validateMemoryRefs(p,{projectId:input.projectId,agentId:p.agentId??null},parseUseRefs(input.items));
 });
 const validateInheritedPermissions=(p:Principal,s:MemorySource,projectId?:string|null,visited=new Set<string>())=>{
  const permissionVisited=new Set<string>(),sourceScope=projectId===undefined?collection(p,s.collectionId).projectId:projectId,cacheKey=queryKey(p,`${s.id}:${s.revision}`,sourceScope);
  if(queryCache?.permissions.has(cacheKey))return;
  const recipients=p.agentId?[p]:[{userId:p.userId,...(s.agentId?{agentId:s.agentId}:{})}];
  const visit=(recipient:Principal,ref:MemoryRevisionRef,scopeProject:string|null|undefined)=>{if(permissionVisited.has(ref.recordId))return;permissionVisited.add(ref.recordId);const r=rawRecord(ref.recordId),c=collection(recipient,r.collectionId,scopeProject),globalPreference=c.projectId===null&&c.agentId===null&&r.contentType==='preference';const evidenceRecipient=globalPreference?{userId:p.userId}:recipient,evidenceProject=globalPreference?undefined:scopeProject,evidenceRefs=userEvidence(r);for(const evidence of evidenceRefs){const inherited=sourceBase(evidenceRecipient,evidence.sourceId,evidenceProject),quotedUser=evidenceRefs!==r.evidence&&evidence.startEventId!==undefined&&evidence.startEventId===evidence.endEventId&&r.support?.some(ref=>ref.sourceId===evidence.sourceId&&ref.eventId===evidence.startEventId);if(!quotedUser)for(const parent of inherited.memoryRefs??[])visit(evidenceRecipient,parent,evidenceProject);}for(const parent of r.dependencies)visit(recipient,parent,scopeProject);};
  for(const recipient of recipients)for(const ref of s.memoryRefs??[])visit(recipient,ref,sourceScope);
  queryCache?.permissions.add(cacheKey);
 };
 const source=(p:Principal,id:string,projectId?:string|null):MemorySource=>authorityQuery(()=>{
  const s=sourceBase(p,id,projectId);if(s.modern){validateInheritedPermissions(p,s,projectId);return s;}validateMemoryRefs(p,{...collection(p,s.collectionId,projectId),agentId:s.agentId??collection(p,s.collectionId,projectId).agentId},s.memoryRefs??[]);return s;
 });
 const validateSource=(p:Principal,ref:EvidenceRef,pending=false,projectId?:string|null,visited=new Set<string>(),permissionsOnly=false)=>authorityQuery(()=>{
  const s=sourceBase(p,ref.sourceId,projectId);if(s.revision!==ref.sourceRevision)memoryFail('source_changed');
  if(ref.startEventId!==undefined&&!s.eventIds.includes(ref.startEventId)||ref.endEventId!==undefined&&!s.eventIds.includes(ref.endEventId)||ref.startEventId!==undefined&&ref.endEventId!==undefined&&ref.startEventId>ref.endEventId)memoryFail('invalid_evidence',422);
  if(pending&&s.taskResetAuthority)memoryFail('source_changed');
  if(pending&&s.taskId&&options.tasks.getTask(p,s.taskId).revision!==s.taskRevision)memoryFail('source_changed');
  const userOnly=ref.startEventId!==undefined&&ref.startEventId===ref.endEventId&&s.events.some(e=>e.id===ref.startEventId&&e.kind==='user');
  if(!userOnly&&(s.modern||permissionsOnly))validateInheritedPermissions(p,s,projectId,visited);
  else if(!userOnly)validateMemoryRefs(p,{...collection(p,s.collectionId,projectId),agentId:s.agentId??collection(p,s.collectionId,projectId).agentId},s.memoryRefs??[],visited);
  return s;
 });
 const saveSource=(key:string,input:Omit<MemorySource,'id'|'revision'>):MemorySource=>{
  const old=db.prepare('SELECT data FROM memory_sources WHERE source_key=?').get(key);const prior=old?parse<MemorySource>(old.data):null;
  if(prior?.status==='retracted'||prior?.fingerprint===input.fingerprint)return prior;
  const s={...input,id:prior?.id??randomUUID(),revision:(prior?.revision??0)+1};
  db.prepare('INSERT INTO memory_sources VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(s.id,key,JSON.stringify(s));db.prepare('INSERT INTO memory_source_revisions VALUES (?,?,?)').run(s.id,s.revision,JSON.stringify(s));store.enqueueOutbox({type:'memory.source_ready',aggregateId:s.id,aggregateRevision:s.revision,causationId:s.fingerprint,payload:{sourceId:s.id,collectionId:s.collectionId}});return s;
 };
 // A regrouped batch is not a new processing unit. Successful publication survives restart.
 const publishedSourceKeys=(collectionId:string,generation:number,extractorVersion:string,includeDiscarded=false):Set<string>=>new Set(db.prepare('SELECT data FROM memory_jobs').all().flatMap(row=>{
  const job=parse<MemoryJob>(row.data);
  return job.collectionId===collectionId&&job.generation===generation&&job.extractorVersion===extractorVersion&&(job.state==='completed'||includeDiscarded&&job.state==='obsolete'&&(job.error==='user_discarded'||isObsoleteMemoryError(job.error)))?job.sourceRefs.map(ref=>`${ref.sourceId}:${ref.sourceRevision}`):[];
 }));
 const enqueue=(p:Principal,c:MemoryCollection,sources:MemorySource[],immediate:boolean,completionWatermarks:NonNullable<MemoryJob['completionWatermarks']>=[],kind?:'request'|'session'):MemoryJob[]=>authorityQuery(()=>{
  const extractorVersion=kind?`${kind}-v2`:'deterministic-v1';
  const blocked:MemoryJob[]=[],eligible:MemorySource[]=[];
  const published=publishedSourceKeys(c.id,c.generation,extractorVersion,true);
  for(const s of sources){
   if(published.has(`${s.id}:${s.revision}`))continue;
   try{validateSource(p,{sourceId:s.id,sourceRevision:s.revision},true,c.projectId);if(!published.has(`${s.id}:${s.revision}`))eligible.push(s);}
   catch(error){
    if(!(error instanceof DomainError))throw error;
    const refs=[{sourceId:s.id,sourceRevision:s.revision}],key=memoryHash(JSON.stringify([c.id,refs,c.generation,'blocked',error.message,completionWatermarks]));
    const prior=db.prepare('SELECT data FROM memory_jobs WHERE dedupe_key=?').get(key);
    if(prior){blocked.push(parse<MemoryJob>(prior.data));continue;}
    const now=new Date().toISOString(),job:MemoryJob={id:randomUUID(),collectionId:c.id,principal:p,sourceRefs:refs,generation:c.generation,state:'obsolete',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:now,createdAt:now,error:error.message,extractorVersion,kind:kind??'request',stage:'extract',conversationId:sources[0]?.conversationId??'',completionWatermarks};
    db.prepare('INSERT INTO memory_jobs VALUES (?,?,?)').run(job.id,key,JSON.stringify(job));blocked.push(job);
   }
  }
  const groups:MemorySource[][]=[];let group:MemorySource[]=[],length=0;
  for(const s of eligible){const size=unicodeLength(memoryTextSource(s).text);if(group.length&&(group.length>=20||length+size>24000)){groups.push(group);group=[];length=0;}group.push(s);length+=size;if(size>24000){groups.push(group);group=[];length=0;}}if(group.length)groups.push(group);
  return [...blocked,...groups.map(batch=>{const refs=batch.map(s=>({sourceId:s.id,sourceRevision:s.revision}));const key=memoryHash(JSON.stringify([c.id,refs,c.generation,extractorVersion,completionWatermarks]));const row=db.prepare('SELECT data FROM memory_jobs WHERE dedupe_key=?').get(key);
   if(row){const job=parse<MemoryJob>(row.data);if(immediate&&job.state==='queued'&&job.attempt===0&&Date.parse(job.availableAt)>Date.now()){job.availableAt=new Date().toISOString();db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(job),job.id);}return job;}
   const refKeys=new Set(refs.map(r=>`${r.sourceId}:${r.sourceRevision}`));
   for(const pendingRow of db.prepare('SELECT data FROM memory_jobs').all()){
    const previous=parse<MemoryJob>(pendingRow.data);
    if(previous.collectionId===c.id&&previous.generation===c.generation&&previous.extractorVersion===extractorVersion&&(!previous.stage||previous.stage==='extract')&&previous.state==='queued'&&previous.sourceRefs.every(r=>refKeys.has(`${r.sourceId}:${r.sourceRevision}`))){previous.state='obsolete';previous.error='coalesced';db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(previous),previous.id);}
   }
   const now=new Date().toISOString(),pending=batch.some(s=>unicodeLength(memoryTextSource(s).text)>24000);const job:MemoryJob={inputVersion:'text-v1',id:randomUUID(),collectionId:c.id,principal:p,sourceRefs:refs,generation:c.generation,state:pending?'pending':'queued',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:new Date(Date.now()+(immediate?0:30000)).toISOString(),createdAt:now,error:pending?'needs_chunking':null,extractorVersion,personaRequested:kind==='request'&&batch.some(source=>source.events.some(event=>event.kind==='user'&&!event.contextOnly&&explicitMemoryKind(event.text)==='preference')),kind:kind??'request',stage:'extract',conversationId:sources[0]?.conversationId??'',completionWatermarks};
   db.prepare('INSERT INTO memory_jobs VALUES (?,?,?)').run(job.id,key,JSON.stringify(job));return job;
  })];
 });
 const captureConversation=(p:Principal,input:{collectionId:string;conversationId:string;trigger:'idle'|'completed'|'explicit';kind?:'request'|'session';manual?:boolean}):CaptureResult=>store.transaction(()=>{
  const c=collection(p,input.collectionId),chat=authorizeConversation(p,input.conversationId);if(c.projectId!==(chat.projectId||null)||c.agentId!==null&&c.agentId!==(chat.agentId||null))memoryFail('scope_mismatch',403);
  const cutoff=Number(db.prepare('SELECT last_event_id FROM memory_capture_cutoffs WHERE conversation_id=?').get(chat.id)?.last_event_id??0);
  const capturedEvents=store.listEvents(chat.id,cutoff);
  const turns:DisplayEvent[][]=[];let current:DisplayEvent[]=[];
  for(const event of capturedEvents){if(event.kind==='user'){current=[event];continue;}if(!current.length)continue;current.push(event);if(event.kind==='status'&&['idle','error','interrupted'].includes((event.data as {status?:string}).status??'')){turns.push(current);current=[];}}
  const linkedRunIds=store.listConversationTaskRuns(chat.id);
  const linkedRuns=linkedRunIds.map(id=>options.tasks.getRun(p,id));
  const taskIds=[...new Set(linkedRuns.map(r=>r.taskId))];
  const runVersions=linkedRuns.flatMap(r=>[...r.artifactVersions,...(options.tasks.getContextSnapshot(p,r.id)?.sourceVersions??[])]).map(({assetId,versionId})=>({assetId,versionId}));
  const excluded=input.kind&&!input.manual?db.prepare('SELECT start_event_id,end_event_id FROM memory_generation_exclusions WHERE kind=?').all(input.kind):[];
  // Compare the whole turn span: a quiet in-flight turn also crosses a zero-event disabled interval.
  const eligibleTurns=turns.filter(events=>!excluded.some(range=>events.at(-1)!.id>Number(range.start_event_id)&&(range.end_event_id===null||events[0].id<=Number(range.end_event_id))));
  const now=new Date().toISOString();const allEvents=capturedEvents;const sources=eligibleTurns.map(events=>{
   const invocationValue=(events[0].data as {invocationId?:unknown}).invocationId;
   const invocationId=typeof invocationValue==='string'&&invocationValue?invocationValue:null;
   const handoffs=invocationId?allEvents.filter(e=>e.kind==='metadata'&&e.id<=events.at(-1)!.id&&(e.data as {memoryUse?:string;invocationId?:string}).memoryUse==='acknowledged'&&(e.data as {invocationId?:string}).invocationId===invocationId):[];
   const memoryRefs=uniqueRefs(handoffs.flatMap(e=>parseUseRefs((e.data as {items?:unknown}).items)));
   const versions=[...runVersions];
   for(const event of capturedEvents){if(event.id>events.at(-1)!.id||event.kind!=='metadata')continue;
    const data=event.data as {memoryRecall?:string;status?:string;entries?:{assetId?:string;versionId?:string}[];actualUse?:string;sourceVersions?:{assetId:string;versionId:string}[]};
    if(data.memoryRecall&&data.status==='completed')for(const ref of data.entries??[])if(ref.assetId&&ref.versionId)versions.push({assetId:ref.assetId,versionId:ref.versionId});
    if(data.actualUse==='acknowledged')versions.push(...(data.sourceVersions??[]).map(({assetId,versionId})=>({assetId,versionId})));
   }
   for(const ref of versions)options.assets.getAuthorizedVersion(p,ref);
   const publicEvents:MemorySource['events']=[...events.filter(e=>['user','text','status','tool'].includes(e.kind)),...handoffs].sort((a,b)=>a.id-b.id).map(e=>({id:e.id,kind:e.kind,text:safeText(e.kind!=='tool'&&typeof(e.data as {text?:unknown})?.text==='string'?(e.data as {text:string}).text:''),hash:memoryHash(JSON.stringify(e)),createdAt:e.createdAt}));
   // Preserve every event id/hash while materializing one logical assistant/tool message.
   let textHead:typeof publicEvents[number]|undefined;
   for(const event of publicEvents){if(event.kind==='text'){if(textHead){textHead.text+=event.text;event.text='';}else textHead=event;}else if(['user','tool'].includes(event.kind))textHead=undefined;}
   const toolGroups=new Map<string,{head:typeof publicEvents[number];output:string;completed:boolean}>();
   for(const event of events.filter(e=>e.kind==='tool')){
    const data=event.data as {method?:string;params?:{itemId?:string;delta?:string;item?:{id?:string;command?:string;cwd?:string;status?:string;exitCode?:number;aggregatedOutput?:string;output?:string;result?:{content?:{type?:string;text?:string}[]}}}};
    const params=data.params,item=params?.item,id=item?.id??params?.itemId;if(!id)continue;
    const captured=publicEvents.find(e=>e.id===event.id)!;captured.text='';
    const group=toolGroups.get(id)??{head:captured,output:'',completed:false};toolGroups.set(id,group);
    if(item?.command){
     const files=[...new Set(item.command.split(/[\s\"'`;|()<>]+/).filter(value=>/^(?:\/|\.\.?\/|[\w-]+\/)[\w./-]+\.(?:tsx?|jsx?|md|sql|py|toml|ya?ml)$/.test(value)&&!/(?:auth|credential|secret|token)/i.test(value)))].slice(0,20);
     if(files.length||item.cwd)group.head.origin={files,...item.cwd?{cwd:safeText(item.cwd)}:{}};
    }
    if(item?.command&&/(?:\.codex\/memories|\bMEMORY\.md\b)/.test(item.command))group.head.contextOnly=true;
    if(/outputDelta$/.test(data.method??'')&&typeof params?.delta==='string')group.output+=params.delta;
    if(data.method==='item/completed'){
     group.completed=item?.status==='completed'&&(item.exitCode===undefined||item.exitCode===0);
     const output=item?.aggregatedOutput??item?.output??item?.result?.content?.filter(c=>c.type==='text').map(c=>c.text??'').join('\n');
     if(typeof output==='string')group.output=output;
    }
   }
   for(const group of toolGroups.values()){
    if(group.completed)group.head.text=safeText(group.output);
    if(!group.head.origin?.files.length&&!/^[^:\r\n]+\.[A-Za-z0-9]+:\d+(?::\d+)?:/m.test(group.head.text))delete group.head.origin;
   }

   const text=publicEvents.filter(e=>e.text).map(e=>`${e.kind==='text'?'助手（未验证）':e.kind==='tool'?'工具结果':'用户'}: ${e.text}`).join('\n');
   const inputSource:Omit<MemorySource,'id'|'revision'>={memoryRefs,invocationId,collectionId:c.id,modern:Boolean(input.kind),agentId:chat.agentId||null,kind:'conversation',conversationId:chat.id,conversationIds:[chat.id],taskIds,taskId:null,taskRevision:null,runIds:linkedRunIds,versions,events:publicEvents,text,observedAt:events[0].createdAt,capturedAt:now,status:unicodeLength(text)>24000?'needs_chunking':'ready',fingerprint:memoryHash(JSON.stringify({events:publicEvents,memoryRefs,invocationId})),eventIds:publicEvents.map(e=>e.id),completionMarker:input.trigger==='completed'?chat.completedAt??null:null};
   return saveSource(`conversation:${c.id}:${chat.id}:${events[0].id}`,inputSource);
  });
  const watermarks=input.trigger==='completed'&&chat.completedAt?[{conversationId:chat.id,lastEventId:lastConversationContentEventId(store,chat.id),completedAt:chat.completedAt}]:[];
  const jobs=enqueue(p,c,sources,input.trigger!=='idle',watermarks,input.kind);return {sources,jobs,pendingReason:jobs.find(j=>j.state==='obsolete')?.error??(jobs.some(j=>j.state==='pending'&&j.error==='needs_chunking')?'needs_chunking':current.length?'incomplete_turn':null)};
 });
 const captureTask=(p:Principal,input:{collectionId:string;taskId:string;trigger:'completed'|'stable';kind?:'request'}):CaptureResult=>store.transaction(()=>{
  const c=collection(p,input.collectionId),task=options.tasks.getTask(p,input.taskId);if(input.kind&&task.revision<=Number(db.prepare('SELECT last_revision FROM memory_generation_task_exclusions WHERE task_id=?').get(task.id)?.last_revision??0))return {sources:[],jobs:[],pendingReason:null};if(task.revision<=Number(db.prepare('SELECT last_revision FROM memory_task_capture_cutoffs WHERE task_id=?').get(task.id)?.last_revision??0))return {sources:[],jobs:[],pendingReason:null};if(c.projectId!==task.projectId||c.agentId!==null&&c.agentId!==task.assigneeAgentId)memoryFail('scope_mismatch',403);
  const runs=options.tasks.listRuns(p,task.id),receipts=options.tasks.listReceipts(p,task.id);
  const memoryUses:{id:string;runId:string;hash:string}[]=[],usedRefs:MemoryRevisionRef[]=[];
  for(const run of runs)for(const row of db.prepare('SELECT id,data FROM memory_uses WHERE run_id=? ORDER BY rowid').all(run.id)){
   const data=parse<{actualUse?:string;items?:unknown}>(row.data);if(data.actualUse!=='provided_to_native')continue;
   usedRefs.push(...parseUseRefs(data.items));memoryUses.push({id:row.id as string,runId:run.id,hash:memoryHash(row.data as string)});
  }
  const memoryRefs=uniqueRefs(usedRefs);if(!input.kind)validateMemoryRefs(p,c,memoryRefs);
  const conversationIds=[...new Set([...runs.flatMap(r=>[r.routing?.executionConversationId,r.routing?.destinationConversationId]),...receipts.map(r=>r.destinationConversationId)].filter((id):id is string=>Boolean(id)))];const versions=[...(task.completion?.artifactVersions??[]),...runs.flatMap(r=>[...r.artifactVersions,...(options.tasks.getContextSnapshot(p,r.id)?.sourceVersions??[])]),...receipts.flatMap(r=>r.artifactVersions)].map(({assetId,versionId})=>({assetId,versionId}));for(const ref of versions)options.assets.getAuthorizedVersion(p,ref);
  const text=safeText(`阶段任务 ${task.id}（修订 ${task.revision}）\n目标：${task.goal}\n完成条件：${task.criteria.map(c=>c.text).join('；')}\n该阶段状态：${task.state}\n完成方式：${task.completion?.completedBy??'未完成'}；checks 仅表示产物完整性检查，不证明业务结论。\n${runs.map(r=>`Run ${r.id}：${r.state}；未验证的助手摘要：${r.summary??''}`).join('\n')}\n${receipts.map(r=>`回执 ${r.id}（未验证结论）：${r.summary}`).join('\n')}\n固定产物：${versions.map(v=>`${v.assetId}@${v.versionId}`).join('，')}`);
  const now=new Date().toISOString(),authorityText=safeText(`Task ${task.id} 修订 ${task.revision}：平台状态 ${task.state}；完成方式 ${task.completion?.completedBy??'未完成'}；固定产物：${versions.map(v=>`${v.assetId}@${v.versionId}`).join('，')}。平台状态与产物完整性检查不证明业务结论。`),authorityEvents=input.kind?[{id:task.revision,kind:'tool',text:authorityText,hash:memoryHash(JSON.stringify({taskId:task.id,revision:task.revision,state:task.state,completedBy:task.completion?.completedBy??null,versions})),createdAt:task.completion?.acceptedAt??now}]:[];const s=saveSource(`task:${c.id}:${task.id}:${task.revision}`,{memoryRefs,memoryUses,collectionId:c.id,modern:Boolean(input.kind),agentId:task.assigneeAgentId,kind:'task',conversationId:null,conversationIds,taskIds:[task.id],taskId:task.id,taskRevision:task.revision,runIds:runs.map(r=>r.id),versions,events:authorityEvents,text,observedAt:task.completion?.acceptedAt??null,capturedAt:now,status:unicodeLength(text)>24000?'needs_chunking':'ready',fingerprint:memoryHash(JSON.stringify({task,runs,receipts,memoryRefs,memoryUses,modern:Boolean(input.kind)})),eventIds:authorityEvents.map(e=>e.id),completionMarker:null,taskSnapshot:{goal:safeText(task.goal),criteria:task.criteria.map(c=>safeText(c.text)),state:task.state,completedBy:task.completion?.completedBy??null,runs:runs.map(r=>({id:r.id,state:r.state,summary:r.summary?safeText(r.summary):null})),receiptCount:receipts.length}});
  if(input.kind)validateInheritedPermissions(p,s,c.projectId);
  return {sources:[s],jobs:enqueue(p,c,[s],true,[],input.kind),pendingReason:s.status==='needs_chunking'?'needs_chunking':null};
 });
 const profileId=(scope:MemoryProfileScope)=>'l3-'+memoryHash(JSON.stringify([options.localUserId,scope.projectId,scope.agentId]));
 const checkProfileScope=(p:Principal,scope:MemoryProfileScope)=>{
  principal(p);if(!scope||(scope.projectId!==null&&typeof scope.projectId!=='string')||(scope.agentId!==null&&typeof scope.agentId!=='string')||p.agentId&&p.agentId!==scope.agentId)memoryFail('profile_scope_mismatch',403);
  if(p.runId&&options.tasks.getExecution(p,options.tasks.getRun(p,p.runId).executionId).projectId!==scope.projectId)memoryFail('profile_scope_mismatch',403);
  if(scope.projectId&&scope.agentId)options.authorizeProject?.({userId:p.userId,agentId:scope.agentId},scope.projectId);
 };
 const redactedProfile=(r:MemoryRevision):MemoryRevision=>({...r,status:'stale',text:'',contentHash:memoryHash(''),evidence:[],dependencies:[],support:[],conversationId:null,conversationIds:[],taskId:null,taskIds:[],sourceAgentIds:[],observedAt:null});
 const rawRecord=(id:string):MemoryRevision=>{const row=db.prepare('SELECT data FROM memory_records WHERE id=?').get(id);if(!row)memoryFail('memory_not_found',404);return parse(row!.data);};
 const read=(p:Principal,id:string,projectId?:string|null,visited=new Set<string>()):MemoryRevision=>authorityQuery(()=>{if(p.agentId&&projectId===undefined&&!p.runId)memoryFail('project_scope_required',422);if(visited.has(id))memoryFail('dependency_cycle');const cacheKey=queryKey(p,id,projectId),cached=queryCache!.records.get(cacheKey);if(cached)return cached;const r=rawRecord(id);if(r.layer==='L3'&&r.profileScope&&p.agentId&&(r.profileScope.agentId!==p.agentId||(projectId!==undefined||p.runId)&&r.profileScope.projectId!==(p.runId?options.tasks.getExecution(p,options.tasks.getRun(p,p.runId).executionId).projectId:projectId)))memoryFail('profile_scope_mismatch',403);collection(p,r.collectionId,projectId);if(p.agentId&&r.legacyId&&r.status!=='active')memoryFail('forbidden',403);if(visited.has(id))memoryFail('dependency_cycle');visited.add(id);const scope=collection(p,r.collectionId,projectId),evidencePrincipal=scope.projectId===null&&scope.agentId===null&&r.contentType==='preference'?{userId:p.userId}:p;for(const e of userEvidence(r)){const globalDependency=r.dependencies.some(d=>{const parent=rawRecord(d.recordId),c=parse<MemoryCollection>(db.prepare('SELECT data FROM memory_collections WHERE id=?').get(parent.collectionId)!.data);return c.projectId===null&&c.agentId===null&&parent.contentType==='preference'&&parent.evidence.some(ref=>ref.sourceId===e.sourceId&&ref.sourceRevision===e.sourceRevision);}),sourcePrincipal=globalDependency?{userId:p.userId}:evidencePrincipal;const evidenceScope=globalDependency?undefined:scope.projectId===null&&scope.agentId!==null?parse<MemoryCollection>(db.prepare('SELECT data FROM memory_collections WHERE id=?').get(loadSource(e.sourceId).collectionId)!.data).projectId:evidencePrincipal===p?projectId:undefined;validateSource(sourcePrincipal,e,false,evidenceScope,visited,['evidence_extract','layer_summary'].includes(r.verification));}validateMemoryRefs(p,collection(p,r.collectionId,projectId),r.dependencies,visited);visited.delete(id);const value=r.status==='active'&&r.validUntil&&Date.parse(r.validUntil)<=Date.now()?{...r,status:'expired' as const}:r;queryCache!.records.set(cacheKey,value);return value;});
 const list=(p:Principal,input:{projectId:string|null;collectionId?:string;taskId?:string;conversationId?:string;status?:MemoryStatus;layer?:MemoryRevision['layer']}):MemoryRevision[]=>authorityQuery(()=>{
  principal(p);if(input.projectId===undefined)memoryFail('project_scope_required',422);const output:MemoryRevision[]=[];
  const filters:string[]=[],filterValues:(string|null)[]=[];
  if(input.collectionId){filters.push('r.collection_id=?');filterValues.push(input.collectionId);}
  if(input.status){filters.push('s.status=?');filterValues.push(input.status);}
  if(input.layer){filters.push('s.layer=?');filterValues.push(input.layer);}
  for(const [kind,target] of [['task',input.taskId],['conversation',input.conversationId]])if(target){filters.push('EXISTS (SELECT 1 FROM memory_record_links l WHERE l.record_id=r.id AND l.kind=? AND l.target_id=?)');filterValues.push(kind!,target);}
  const suffix=filters.length?` AND ${filters.join(' AND ')}`:'',agentFilter=p.agentId?' AND (s.agent_id IS NULL OR s.agent_id=?)':'',agentValues=p.agentId?[p.agentId]:[];
  const modern=(scope:string)=>`SELECT r.id FROM memory_record_scope s INDEXED BY memory_scope_lookup JOIN memory_records r ON r.id=s.record_id WHERE ${scope}${agentFilter}${suffix}`;
  // The frozen legacy policy can authorize other project scopes. Enumerate its collections, then look up their records.
  const legacy=`SELECT r.id FROM memory_collections c CROSS JOIN memory_records r INDEXED BY memory_records_collection JOIN memory_record_scope s ON s.record_id=r.id WHERE c.scope_key>='legacy-scope:' AND c.scope_key<'legacy-scope;' AND r.collection_id=c.id${suffix}`;
  // Reject unrelated modern personal facts before expensive evidence/dependency validation; legacy policy remains separate.
  const nullScope=input.projectId===null?'s.project_id IS NULL':`s.project_id IS NULL AND (${p.agentId?'s.agent_id IS NOT NULL OR ':''}(s.agent_id IS NULL AND json_extract(r.data,'$.contentType')='preference'))`;
  const sql=[modern('s.project_id=?'),modern(nullScope),legacy].join(' UNION '),values=[input.projectId,...agentValues,...filterValues,...agentValues,...filterValues,...filterValues];
  for(const row of db.prepare(sql).all(...values))try{const r=read(p,row.id as string,input.projectId),c=collection(p,r.collectionId,input.projectId);if(c.projectId!==input.projectId&&!(c.projectId===null&&c.agentId===p.agentId)&&!(c.projectId===null&&c.agentId===null&&r.contentType==='preference')&&c.legacy?.scope!=='global'&&!(c.legacy&&p.agentId))continue;output.push(r);}catch(error){if(!(error instanceof DomainError))throw error;}

  return output;
 });
 // Rebuild access checks ownership/source permission without treating stale dependencies as facts.
 const readForRebuild=(p:Principal,id:string,projectId:string|null):MemoryRevision=>{
  const r=rawRecord(id);collection(p,r.collectionId,projectId);
  for(const ref of r.evidence){const global=r.dependencies.some(d=>{const dep=rawRecord(d.recordId),scope=collection(p,dep.collectionId,projectId);return scope.projectId===null&&scope.agentId===null&&dep.contentType==='preference'&&dep.evidence.some(e=>e.sourceId===ref.sourceId);});const own=collection(p,r.collectionId,projectId),evidenceScope=own.projectId===null&&own.agentId!==null?collection({userId:p.userId},loadSource(ref.sourceId).collectionId).projectId:projectId;sourceBase(global?{userId:p.userId}:p,ref.sourceId,global?undefined:evidenceScope,true);}
  for(const ref of r.dependencies)collection(p,rawRecord(ref.recordId).collectionId,projectId);
  if(!['L2','L3'].includes(r.layer)||r.status!=='stale')memoryFail('invalid_rebuild');if(r.layer==='L3'&&(!r.profileScope||p.agentId&&r.profileScope.agentId!==p.agentId))memoryFail('profile_scope_mismatch',403);return r;
 };
 // Current reads never fall back to a different agent or to an old project-wide L3.
 const profile=(p:Principal,scope:MemoryProfileScope,allowStale=false):MemoryRevision|null=>authorityQuery(()=>{
  checkProfileScope(p,scope);const id=profileId(scope),row=db.prepare('SELECT data FROM memory_records WHERE id=?').get(id);if(!row)return null;
  const r=parse<MemoryRevision>(row.data);if(r.profileScope?.projectId!==scope.projectId||r.profileScope?.agentId!==scope.agentId)memoryFail('profile_scope_mismatch',403);
  try{const value=allowStale&&r.status==='stale'?readForRebuild(p,id,scope.projectId):read(p,id,scope.projectId);return value.status==='active'||allowStale&&value.status==='stale'?value:null;}catch(error){if(error instanceof DomainError&&['stale_memory_dependency','source_changed','source_unavailable','source_retracted','forbidden','memory_not_found'].includes(error.code)){if(allowStale&&['active','stale'].includes(r.status)){collection(p,r.collectionId,scope.projectId);return redactedProfile(r);}return null;}throw error;}
 });
 const staleScenes=(p:Principal,projectId:string|null,collectionId?:string):MemoryRevision[]=>authorityQuery(()=>{
  principal(p);const records:MemoryRevision[]=[];
  for(const row of db.prepare("SELECT r.id FROM memory_record_scope s INDEXED BY memory_scope_status JOIN memory_records r ON r.id=s.record_id WHERE s.status='stale' AND s.layer='L2'"+(collectionId?' AND r.collection_id=?':'')).all(...collectionId?[collectionId]:[]))try{const r=readForRebuild(p,row.id as string,projectId);if(r.semanticKey?.startsWith('scene.'))records.push(r);}catch(error){if(!(error instanceof DomainError))throw error;}
  return records;
 });
 const projectRecord=(r:MemoryRevision)=>{
  const c=parse<MemoryCollection>(db.prepare('SELECT data FROM memory_collections WHERE id=?').get(r.collectionId)!.data);
  db.prepare('INSERT INTO memory_record_scope VALUES (?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET project_id=excluded.project_id,agent_id=excluded.agent_id,status=excluded.status,layer=excluded.layer').run(r.recordId,c.projectId,c.agentId,r.status,r.layer);
  db.prepare('DELETE FROM memory_record_links WHERE record_id=?').run(r.recordId);
  for(const [kind,targets] of [['task',[r.taskId,...(r.taskIds??[])]],['conversation',[r.conversationId,...(r.conversationIds??[])]]] as const)for(const id of new Set(targets.filter(Boolean)))db.prepare('INSERT OR IGNORE INTO memory_record_links VALUES (?,?,?)').run(r.recordId,kind,id!);
 };
 for(const row of db.prepare('SELECT data FROM memory_records WHERE id NOT IN (SELECT record_id FROM memory_record_scope)').all())projectRecord(parse<MemoryRevision>(row.data));
 const saveRecord=(r:MemoryRevision)=>atomic(()=>{projectRecord(r);db.prepare('INSERT INTO memory_records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.recordId,r.collectionId,JSON.stringify(r));db.prepare('INSERT INTO memory_revisions VALUES (?,?,?)').run(r.recordId,r.revision,JSON.stringify(r));db.prepare('INSERT INTO memory_index VALUES (?,?,?) ON CONFLICT(record_id) DO UPDATE SET revision=excluded.revision,text=excluded.text').run(r.recordId,r.revision,r.text);store.enqueueOutbox({type:'memory.record_changed',aggregateId:r.recordId,aggregateRevision:r.revision,causationId:r.contentHash,payload:{recordId:r.recordId,collectionId:r.collectionId,status:r.status}});});
 const bump=(p:Principal,id:string)=>{const c=collection(p,id);c.generation++;db.prepare('UPDATE memory_collections SET data=? WHERE id=?').run(JSON.stringify(c),id);return c.generation;};
 const suppressionTextKey=(text:string)=>`text:${memoryHash(text.normalize('NFKC').trim())}`;
 const textSuppressed=(collectionId:string,text:string)=>Boolean(db.prepare('SELECT 1 FROM memory_suppressions WHERE collection_id=? AND key=?').get(collectionId,suppressionTextKey(text)));
 const suppressionKey=(text:string,evidence:EvidenceRef[])=>memoryHash(JSON.stringify([text.normalize('NFKC').trim(),evidence.map(e=>[e.sourceId,e.sourceRevision])]));
 const applyProposal=(p:Principal,proposal:MemoryProposal,generation:number,verified:'source_extract'|'stage_summary'|'evidence_extract'|'layer_summary'|null=null,decision:{conflictResolved?:boolean;profileScope?:MemoryProfileScope}={}):MemoryRevision|null=>{
  principal(p);const original=collection(p,proposal.collectionId),ownerAgent=proposal.scope==='agent'?(proposal.operation==='retract'?collection(p,rawRecord(proposal.replaces[0]?.recordId).collectionId,original.projectId).agentId:sourceBase(p,proposal.evidence[0]?.sourceId,original.projectId).agentId):null;
  if(proposal.scope==='agent'&&!ownerAgent)memoryFail('agent_scope_required',422);
  const targetCollection=proposal.scope==='user'?ensureCollection({userId:p.userId},{projectId:null,agentId:null}):proposal.scope==='agent'?ensureCollection({userId:p.userId},{projectId:null,agentId:ownerAgent!}):null;
  return atomic(()=>{
  let c=collection(p,proposal.collectionId);if(c.generation!==generation)memoryFail('generation_changed');
  if(!['L1','L2','L3'].includes(proposal.layer)||!['fact','preference','decision','procedure','constraint','open_issue'].includes(proposal.contentType)||!['store','update','merge','skip','retract'].includes(proposal.operation)||typeof proposal.text!=='string'||!proposal.text.trim()||unicodeLength(proposal.text)>12000||!Array.isArray(proposal.evidence)||proposal.operation!=='retract'&&!proposal.evidence.length&&verified!=='layer_summary'||!Array.isArray(proposal.replaces)||proposal.validUntil!==null&&!Number.isFinite(Date.parse(proposal.validUntil)))memoryFail('invalid_proposal',422);
  if(proposal.operation==='retract'){
   c=targetCollection??c;
   if(verified!=='layer_summary'||proposal.layer!=='L2'||!proposal.replaces.length)memoryFail('invalid_retraction',422);
   for(const ref of proposal.replaces){const raw=rawRecord(ref.recordId),r=raw.status==='stale'?readForRebuild(p,ref.recordId,c.projectId):read(p,ref.recordId,c.projectId);if(r.layer!=='L2'||r.collectionId!==c.id||r.revision!==ref.revision||!['active','stale'].includes(r.status))memoryFail('revision_conflict');invalidateDerived(r);suppress(r);saveRecord({...r,status:'retracted',revision:r.revision+1,revisionKind:'retraction'});}return null;
  }
  const profileScope=proposal.layer==='L3'?(decision.profileScope??{projectId:c.projectId,agentId:p.agentId??c.agentId}):undefined;
  let previousProfile:MemoryRevision|undefined;
  if(profileScope){
   checkProfileScope(p,profileScope);if(profileScope.projectId!==c.projectId||c.legacy||c.agentId!==(c.projectId===null?profileScope.agentId:null)||proposal.scope&&proposal.scope!=='collection'||verified!=='layer_summary'||proposal.semanticKey!==undefined&&proposal.semanticKey!=='persona.operating-doctrine')memoryFail('profile_scope_mismatch',422);
   const row=db.prepare('SELECT data FROM memory_records WHERE id=?').get(profileId(profileScope));previousProfile=row?parse<MemoryRevision>(row.data):undefined;
   if(previousProfile&&proposal.operation==='store')memoryFail('profile_update_required',422);
   if(proposal.replaces.some(ref=>ref.recordId!==profileId(profileScope)))memoryFail('profile_scope_mismatch',422);
  }
  proposal={...proposal,text:safeText(proposal.text),semanticKey:(profileScope?'persona.operating-doctrine':proposal.semanticKey)?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ')};
  const explicitDependencies=proposal.dependencies??[];
  const dependencyRecords=verified==='layer_summary'?explicitDependencies.map(ref=>read(p,ref.recordId,(targetCollection??c).projectId)):[];
  if(verified==='layer_summary')validateMemoryRefs(p,targetCollection??c,explicitDependencies);
  // Owner confirmations are durable proof in their own right; do not invent conversation evidence.
  if(verified==='layer_summary'&&!proposal.evidence.length){
   const confirmed=(r:MemoryRevision):boolean=>r.layer==='L1'?['user_confirmation','user_correction'].includes(r.verification):r.verification==='layer_summary'&&r.dependencies.length>0&&r.dependencies.every(ref=>confirmed(read(p,ref.recordId,(targetCollection??c).projectId)));
   if(!dependencyRecords.length||!dependencyRecords.every(confirmed))memoryFail('unsupported_summary',422);
  }
  const sources=proposal.evidence.map(e=>{const captured=loadSource(e.sourceId),cross=captured.collectionId!==c.id,dependency=cross&&dependencyRecords.find(r=>r.evidence.some(ref=>ref.sourceId===e.sourceId&&ref.sourceRevision===e.sourceRevision));if(cross&&!dependency)memoryFail('scope_mismatch',403);const refPrincipal=cross?{userId:p.userId}:p;return validateSource(refPrincipal,e,true,cross?undefined:c.projectId,new Set(),verified==='evidence_extract'||verified==='layer_summary');});if(proposal.scope==='agent'&&sources.some(s=>s.agentId!==ownerAgent))memoryFail('agent_scope_mismatch',403);
  if(proposal.operation==='skip'){
   if(verified!=='layer_summary')return null;
   const refs=proposal.replaces;
   if(refs.length!==1)memoryFail('unsupported_no_change',422);
   const existing=read(p,refs[0].recordId,(targetCollection??c).projectId);
   if(existing.revision!==refs[0].revision||existing.status!=='active'||!['layer_summary','user_correction'].includes(existing.verification)||existing.collectionId!==(targetCollection??c).id||existing.layer!==proposal.layer||existing.contentType!==proposal.contentType||existing.semanticKey!==proposal.semanticKey||existing.text!==proposal.text||existing.validUntil!==proposal.validUntil||!explicitDependencies.length||explicitDependencies.some(ref=>!existing.dependencies.some(old=>old.recordId===ref.recordId&&compatibleRevision(old,rawRecord(ref.recordId)))))memoryFail('unsupported_no_change',422);
   validateMemoryRefs(p,targetCollection??c,existing.dependencies);
   return existing;
  }
  if(textSuppressed(profileScope?profileId(profileScope):c.id,proposal.text)||verified==='stage_summary'&&sources.some(s=>s.events.some(e=>e.text&&textSuppressed(c.id,e.text))))return null;
  if(db.prepare('SELECT 1 FROM memory_suppressions WHERE collection_id=? AND key=?').get(profileScope?profileId(profileScope):c.id,suppressionKey(proposal.text,proposal.evidence)))return null;
  const supports=(proposal.support??[]).map(ref=>{const captured=sources.find(s=>s.id===ref.sourceId),event=captured?.events.find(e=>e.id===ref.eventId);if(!event||event.contextOnly||!['user','tool'].includes(event.kind)||!ref.quote?.trim()||!event.text.includes(ref.quote)||event.kind==='user'&&(/[?？]/.test(ref.quote)||!assertedQuote(event.text,ref.quote)||/^(如果|假如|例如|比如|if\b|suppose\b|for example\b)/i.test(ref.quote.trim()))||!proposal.evidence.some(e=>e.sourceId===ref.sourceId&&(e.startEventId===undefined||ref.eventId>=e.startEventId)&&(e.endEventId===undefined||ref.eventId<=e.endEventId)))memoryFail('unsupported_extract',422);return {ref,event:event!};});
  if(verified==='evidence_extract'&&(proposal.layer!=='L1'||!supports.length))memoryFail('unsupported_extract',422);
  if(verified==='evidence_extract'&&!supports.some(s=>s.event.kind==='user')&&supports.some(({ref,event})=>!memoryToolObservationScoped(event,ref.quote,proposal.text)))memoryFail('tool_observation_scope_required',422);
  const explicitChange=proposal.explicitChange===true&&supports.some(s=>s.event.kind==='user'&&/(现在|改为|更正|纠正|不再|改用|更新|替换|actually|instead|changed?|correct|no longer|now)/i.test(s.ref.quote));
  if(proposal.scope==='user'){
   const userSupport=supports.filter(s=>s.event.kind==='user'),universal=/(所有项目|全部项目|跨项目|所有(?:代理|Agent)|通用|一般回答|all projects|across projects|all agents|in general|general (?:replies|responses))/i;
   if(proposal.contentType!=='preference'||!userSupport.some(s=>/(偏好|喜欢|以后|始终|prefer|always)/i.test(s.ref.quote))||userSupport.some(s=>/(本项目|这个项目|此项目|本任务|这个任务|此任务|项目.{0,20}(?:偏好|喜欢)|(?:this|current|the) (?:project|task)|for .{1,30} project)/i.test(s.event.text)&&!universal.test(s.event.text)))memoryFail('unsupported_user_scope',422);
   c=targetCollection!;
  }
  if(proposal.scope==='agent')c=targetCollection!;
  else if(proposal.scope!=='user'&&supports.some(s=>s.event.kind==='user'&&/(个人经验|私有经验|私人经验|仅供我|不要共享|个人记忆|private experience|personal experience|do not share|for me only)/i.test(s.event.text)))memoryFail('agent_scope_required',422);
  const old=proposal.replaces.map(ref=>{const raw=rawRecord(ref.recordId),r=profileScope?profile(p,profileScope,true)!:verified==='layer_summary'&&raw.status==='stale'?readForRebuild(p,ref.recordId,c.projectId):read(p,ref.recordId,c.projectId);if(!r||r.collectionId!==c.id||r.layer!==proposal.layer||r.revision!==ref.revision||r.status!=='active'&&!(verified==='layer_summary'&&['L2','L3'].includes(r.layer)&&r.status==='stale'))memoryFail('revision_conflict');return r;});
  if(proposal.operation==='store'&&old.length||proposal.operation!=='store'&&!old.length)memoryFail('invalid_replacement',422);
  const dependencies=uniqueRefs([...(proposal.dependencies??[]),...(verified==='stage_summary'?sources.flatMap(s=>s.memoryRefs??[]):[])]);
  if(dependencies.some(d=>old.some(r=>r.recordId===d.recordId)))memoryFail('dependency_cycle');
  validateMemoryRefs(p,c,dependencies);
  // Only server-generated exact extracts/summaries qualify. A model's certainty is never authority.
  if(verified==='source_extract'&&!sources.some(s=>s.events.some(e=>e.kind==='user'&&safeText(e.text)===proposal.text&&explicitMemoryKind(e.text)!==null)))memoryFail('unsupported_extract',422);
  if(verified==='stage_summary'&&!(proposal.layer==='L2'&&sources.length===1&&proposal.text===safeText(memoryStageSummary(sources[0]))))memoryFail('unsupported_summary',422);
  if(profileScope&&dependencyRecords.some(r=>r.layer!=='L2'||!r.semanticKey?.startsWith('scene.')))memoryFail('profile_scene_required',422);
  if(verified==='layer_summary'&&(proposal.layer==='L1'||!dependencies.length||proposal.layer==='L3'&&proposal.contentType==='preference'&&!supports.some(s=>s.event.kind==='user')))memoryFail('unsupported_summary',422);
  const semanticKey=proposal.semanticKey?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  const duplicate=list(p,{projectId:c.projectId,collectionId:c.id}).find(r=>(!profileScope||r.recordId===profileId(profileScope))&&r.status==='active'&&r.layer===proposal.layer&&r.contentType===proposal.contentType&&r.text===proposal.text&&(proposal.validUntil===null||r.validUntil===proposal.validUntil)&&(r.semanticKey===semanticKey||verified!=='layer_summary'&&(!r.semanticKey||!semanticKey)));
  if(duplicate){
   if(dependencies.some(d=>d.recordId===duplicate.recordId))memoryFail('dependency_cycle');
   // Verified identical user extracts can corroborate corrected/legacy records without changing their authority label.
   // Shadow suggestions never add provenance to an active record.
   const corroborates=['source_extract','evidence_extract'].includes(verified??'')&&['user_correction','user_confirmation','legacy_user_managed'].includes(duplicate.verification);
   if(!verified||duplicate.verification!==verified&&!corroborates)return duplicate;
   const evidence=[...new Map([...duplicate.evidence,...proposal.evidence].map(e=>[JSON.stringify(e),e])).values()];
   const dependenciesAdded=dependencies.some(ref=>!duplicate.dependencies.some(old=>old.recordId===ref.recordId));
   if(evidence.length===duplicate.evidence.length&&!dependenciesAdded&&(!proposal.pipeline||duplicate.pipelines?.includes(proposal.pipeline)))return duplicate;
   if(dependenciesAdded)invalidateDerived(duplicate);
   const merged={...duplicate,pipelines:[...new Set([...(duplicate.pipelines??[]),...(proposal.pipeline?[proposal.pipeline]:[])])],sourceAgentIds:[...new Set([...(duplicate.sourceAgentIds??[]),...sources.flatMap(s=>s.agentId?[s.agentId]:[])])],support:[...new Map([...(duplicate.support??[]),...(proposal.support??[])].map(ref=>[JSON.stringify(ref),ref])).values()],revisionKind:'evidence_append' as const,revision:duplicate.revision+1,evidence,dependencies:uniqueRefs([...duplicate.dependencies,...dependencies.filter(ref=>!duplicate.dependencies.some(old=>old.recordId===ref.recordId))]),conversationIds:[...new Set([...(duplicate.conversationIds??[]),...sources.flatMap(s=>s.conversationIds??[])])],taskIds:[...new Set([...(duplicate.taskIds??[]),...sources.flatMap(s=>s.taskIds??[])])],extractedAt:new Date().toISOString()};
   saveRecord(merged);return merged;
  }
  if(!decision.conflictResolved&&old.some(r=>verified!=='layer_summary'&&r.contentType!==proposal.contentType||semanticKey&&r.semanticKey&&r.semanticKey!==semanticKey))memoryFail('invalid_replacement',422);
  const key=assertionKey(proposal.text);
  const conflict=(verified==='source_extract'&&key!==null||verified==='evidence_extract'&&Boolean(semanticKey))&&list(p,{projectId:c.projectId,collectionId:c.id,status:'active'}).some(r=>r.layer===proposal.layer&&r.text!==proposal.text&&(verified==='evidence_extract'?r.semanticKey===semanticKey:assertionKey(r.text)===key));
  const userConfirmed=old.some(r=>r.verification==='user_confirmation'||r.verification==='user_correction'&&r.legacyLevel==='L3');
  const autoChange=!userConfirmed&&(verified==='layer_summary'&&old.length>0||verified==='evidence_extract'&&old.length>0&&(decision.conflictResolved&&old.every(r=>r.verification!=='user_correction')||proposal.operation==='update'&&explicitChange||proposal.operation==='merge'&&old.every(r=>r.evidence.every(e=>supports.some(s=>s.ref.sourceId===e.sourceId)))));
  const status=verified&&(!old.length&&!conflict||autoChange)?'active':'proposed';
  if(profileScope&&old.some(r=>r.verification==='user_confirmation'||r.verification==='user_correction'))memoryFail('profile_user_correction_requires_review',409);
  if(autoChange)for(const previous of old){invalidateDerived(previous);if(!profileScope)saveRecord({...previous,revision:previous.revision+1,status:'superseded',revisionKind:'correction'});}const now=new Date().toISOString();const r:MemoryRevision={revisionKind:previousProfile?'correction':'created',recordId:profileScope?profileId(profileScope):randomUUID(),revision:(previousProfile?.revision??0)+1,...profileScope?{profileScope}:{},collectionId:c.id,semanticKey,pipelines:[...new Set([...(autoChange?old.flatMap(r=>r.pipelines??[]):[]),...(proposal.pipeline?[proposal.pipeline]:[])])],support:proposal.support,sourceAgentIds:[...new Set(sources.flatMap(s=>s.agentId?[s.agentId]:[]))],layer:proposal.layer,contentType:proposal.contentType,text:proposal.text,status,evidence:proposal.evidence,dependencies,observedAt:sources[0]?.observedAt??null,effectiveFrom:now,validUntil:proposal.validUntil,extractedAt:now,verification:verified??'unverified',taskId:sources.find(s=>s.taskId)?.taskId??null,conversationId:sources.find(s=>s.conversationId)?.conversationId??null,conversationIds:[...new Set(sources.flatMap(s=>s.conversationIds??[]))],taskIds:[...new Set(sources.flatMap(s=>s.taskIds??[]))],contentHash:memoryHash(proposal.text)};saveRecord(r);return r;
 });};
 const manageRecord=(p:Principal,id:string)=>{if(p.agentId||p.runId)memoryFail('forbidden',403);return read(p,id);};
 const confirm=(_p:Principal,_input:{recordId:string;expectedRevision:number}):MemoryRevision=>memoryFail('legacy_memory_confirmation_retired',410);
 const queueLegacyContext=(p:Principal,collectionId:string)=>{
  const c=collection(p,collectionId),now=new Date().toISOString();
  const job:MemoryJob={id:randomUUID(),collectionId,principal:p,sourceRefs:[],generation:c.generation,state:'queued',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:now,createdAt:now,error:null,extractorVersion:'confirmed-legacy-v1',kind:'request',stage:'scene',personaRequested:true,manualPriority:true};
  db.prepare('INSERT OR IGNORE INTO memory_jobs VALUES (?,?,?)').run(job.id,memoryHash(JSON.stringify([collectionId,c.generation,'confirmed-legacy-context'])),JSON.stringify(job));
 };
 const repairLegacyContexts=(p:Principal)=>store.transaction(()=>{
  principal(p);if(p.agentId||p.runId)memoryFail('forbidden',403);
  let repaired=0;const changed=new Set<string>();
  for(const r of listAll(p))if(r.legacyId&&r.legacyLevel==='L3'&&r.layer==='L3'&&!r.semanticKey&&!r.dependencies.length&&['user_confirmation','user_correction'].includes(r.verification)){
   invalidateDerived(r);saveRecord({...r,layer:'L1',revision:r.revision+1,revisionKind:'correction'});changed.add(r.collectionId);repaired++;
  }
  for(const id of changed){bump(p,id);queueLegacyContext(p,id);}
  return {repaired};
 });
 const retireUnscopedProfiles=(p:Principal)=>store.transaction(()=>{
  principal(p);if(p.agentId||p.runId)memoryFail('forbidden',403);
  const key='memory_l3_project_agent_001';if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return {retired:0};
  let retired=0;
  for(const row of db.prepare('SELECT data FROM memory_records').all()){
   const r=parse<MemoryRevision>(row.data);
   if(r.layer==='L3'&&!r.profileScope&&['active','proposed'].includes(r.status)){invalidateDerived(r);saveRecord({...r,status:'stale',revision:r.revision+1,revisionKind:'invalidation'});retired++;}
  }
  for(const row of db.prepare('SELECT data FROM memory_jobs').all()){
   const job=parse<MemoryJob>(row.data);
   if(job.stage==='profile'&&!job.profileScope&&['queued','pending','running'].includes(job.state))db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'obsolete',error:'profile_scope_migrated',leaseToken:job.leaseToken+1,leaseUntil:null}),job.id);
  }
  db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(key,new Date().toISOString());return {retired};
 });
 const suppress=(r:MemoryRevision)=>{db.prepare('INSERT OR IGNORE INTO memory_suppressions VALUES (?,?)').run(r.profileScope?profileId(r.profileScope):r.collectionId,suppressionKey(r.text,r.evidence));db.prepare('INSERT OR IGNORE INTO memory_suppressions VALUES (?,?)').run(r.profileScope?profileId(r.profileScope):r.collectionId,suppressionTextKey(r.text));};
 const invalidateDerived=(old:MemoryRevision)=>{
  const invalid=new Set([old.recordId]);let changed=true;
  while(changed){changed=false;for(const row of db.prepare('SELECT data FROM memory_records').all()){
   const r=parse<MemoryRevision>(row.data);if(invalid.has(r.recordId)||r.status!=='active')continue;
   if(r.dependencies.some(d=>invalid.has(d.recordId))||r.verification==='stage_summary'&&r.evidence.some(e=>old.evidence.some(o=>o.sourceId===e.sourceId&&o.sourceRevision===e.sourceRevision))){saveRecord({...r,revisionKind:'invalidation',revision:r.revision+1,status:'stale'});invalid.add(r.recordId);changed=true;}
  }}
 };
 const unadoptedLegacy=(r:MemoryRevision)=>r.verification==='legacy_user_managed'&&(r.status==='proposed'||r.legacy?.status==='candidate');
 const correct=(p:Principal,input:{recordId:string;expectedRevision:number;text:string}):MemoryRevision=>store.transaction(()=>{const old=manageRecord(p,input.recordId);if(old.revision!==input.expectedRevision)memoryFail('revision_conflict');if(unadoptedLegacy(old))memoryFail('legacy_memory_confirmation_retired',410);if(!input.text?.trim()||unicodeLength(input.text)>6000)memoryFail('invalid_memory_text',422);suppress(old);invalidateDerived(old);const now=new Date().toISOString();const next={...old,...old.legacyLevel==='L3'?{pipelines:['request','session'] as ('request'|'session')[]}:{},revisionKind:'correction' as const,revision:old.revision+1,text:safeText(input.text),status:'active' as const,verification:'user_correction' as const,effectiveFrom:now,extractedAt:now,contentHash:memoryHash(safeText(input.text))};saveRecord(next);bump(p,old.collectionId);if(old.legacyLevel==='L3')queueLegacyContext(p,old.collectionId);return next;});
 const retract=(p:Principal,input:{recordId:string;expectedRevision:number}):void=>store.transaction(()=>{const old=manageRecord(p,input.recordId);if(old.revision!==input.expectedRevision)memoryFail('revision_conflict');suppress(old);invalidateDerived(old);saveRecord({...old,revisionKind:'retraction',revision:old.revision+1,status:'retracted'});bump(p,old.collectionId);if(old.legacyLevel==='L3')queueLegacyContext(p,old.collectionId);});
 const restore=(p:Principal,input:{recordId:string;expectedRevision:number}):MemoryRevision=>store.transaction(()=>{
  const old=manageRecord(p,input.recordId);if(old.revision!==input.expectedRevision||old.status!=='retracted')memoryFail('revision_conflict');if(unadoptedLegacy(old))memoryFail('legacy_memory_confirmation_retired',410);
  db.prepare('DELETE FROM memory_suppressions WHERE collection_id=? AND key=?').run(old.profileScope?profileId(old.profileScope):old.collectionId,suppressionKey(old.text,old.evidence));
  db.prepare('DELETE FROM memory_suppressions WHERE collection_id=? AND key=?').run(old.profileScope?profileId(old.profileScope):old.collectionId,suppressionTextKey(old.text));
  const next={...old,revisionKind:'restore' as const,revision:old.revision+1,status:'active' as const};saveRecord(next);bump(p,old.collectionId);if(old.legacyLevel==='L3')queueLegacyContext(p,old.collectionId);return next;
 });
 const retractSource=(p:Principal,input:{sourceId:string;expectedRevision:number}):void=>store.transaction(()=>{
  principal(p);if(p.agentId||p.runId)memoryFail('forbidden',403);const s=loadSource(input.sourceId);collection(p,s.collectionId);if(s.revision!==input.expectedRevision)memoryFail('revision_conflict');
  const next={...s,revision:s.revision+1,status:'retracted' as const,text:'',events:[]};db.prepare('UPDATE memory_sources SET data=? WHERE id=?').run(JSON.stringify(next),s.id);db.prepare('INSERT INTO memory_source_revisions VALUES (?,?,?)').run(s.id,next.revision,JSON.stringify(next));for(const row of db.prepare('SELECT id FROM memory_records').all()){const r=rawRecord(row.id as string);if(r.status==='active'&&r.evidence.some(ref=>ref.sourceId===s.id)){suppress(r);invalidateDerived(r);saveRecord({...r,status:'stale',revision:r.revision+1,revisionKind:'invalidation'});}}bump(p,s.collectionId);
 });
 const importLegacy=(p:Principal,entries:KnowledgeEntry[])=>{principal(p);if(p.agentId||p.runId)memoryFail('forbidden',403);let imported=0;
  for(const entry of entries){if(entry.kind!=='memory')continue;const prior=db.prepare("SELECT data FROM memory_records WHERE json_extract(data,'$.legacyId')=?").get(entry.id);if(prior){if(parse<MemoryRevision>(prior.data).contentHash!==memoryHash(entry.content))memoryFail('legacy_content_conflict');continue;}
   const key=`legacy-scope:${memoryHash(JSON.stringify([entry.scope,entry.projectId??null,entry.agentId??null,entry.access??{mode:'owner'}]))}`;
   const existing=db.prepare('SELECT data FROM memory_collections WHERE scope_key=?').get(key);
   let c:MemoryCollection;
   if(existing)c=parse(existing.data);
   else {
    const asset=options.assets.createAsset(p,{kind:'memory_collection',title:'旧版记忆',owner:{userId:p.userId,...(entry.agentId?{agentId:entry.agentId}:{})}});if(entry.access)options.assets.setAccess(p,asset.id,entry.access,asset.revision);
    c={id:asset.id,projectId:entry.projectId??null,agentId:entry.agentId??null,generation:1,legacy:(({content,...metadata})=>metadata)(entry)};db.prepare('INSERT INTO memory_collections VALUES (?,?,?)').run(c.id,key,JSON.stringify(c));
   }
   saveRecord({revisionKind:'created',recordId:randomUUID(),revision:1,collectionId:c.id,layer:'L1',contentType:entry.level==='L4'?'preference':entry.level==='L3'?'procedure':'fact',text:entry.content,status:entry.status==='active'?'active':'proposed',evidence:[],dependencies:[],observedAt:null,effectiveFrom:entry.createdAt,validUntil:null,extractedAt:entry.updatedAt,verification:'legacy_user_managed',taskId:null,conversationId:entry.sourceConversationId??null,legacyId:entry.id,legacy:(({content,...metadata})=>metadata)(entry),legacyLevel:entry.level,contentHash:memoryHash(entry.content)});imported++;
  }return {imported};
 };
 const listAll=(p:Principal,input:{taskId?:string;conversationId?:string;status?:MemoryStatus}={}):MemoryRevision[]=>authorityQuery(()=>{
  principal(p);if(p.agentId||p.runId)memoryFail('forbidden',403);
  let from='memory_records r';const filters:string[]=[],values:string[]=[];
  const links=[['task',input.taskId],['conversation',input.conversationId]].filter((item):item is [string,string]=>Boolean(item[1]));
  if(links.length){from='memory_record_links l INDEXED BY memory_links_lookup JOIN memory_records r ON r.id=l.record_id';filters.push('l.kind=? AND l.target_id=?');values.push(...links[0]);for(const [kind,target] of links.slice(1)){filters.push('EXISTS (SELECT 1 FROM memory_record_links other WHERE other.record_id=r.id AND other.kind=? AND other.target_id=?)');values.push(kind,target);}}
  if(input.status){from=links.length?`${from} JOIN memory_record_scope s ON s.record_id=r.id`:'memory_record_scope s INDEXED BY memory_scope_status JOIN memory_records r ON r.id=s.record_id';if(input.status==='expired'){filters.push("(s.status='expired' OR (s.status='active' AND datetime(json_extract(r.data,'$.validUntil'))<=datetime(?)))");values.push(new Date().toISOString());}else{filters.push('s.status=?');values.push(input.status);}}
  const sql=`SELECT r.id FROM ${from}${filters.length?` WHERE ${filters.join(' AND ')}`:''}`;
  return db.prepare(sql).all(...values).flatMap(row=>{try{const r=read(p,row.id as string);return input.status&&r.status!==input.status?[]:[r];}catch(error){if(error instanceof DomainError)return [];throw error;}});

 });
 const history=(p:Principal,input:{projectId:string|null;items:MemoryRevisionRef[]})=>authorityQuery(()=>{
  principal(p);const items:MemoryRevisionRef[]=[],notices:{recordId:string;revision:number;status:string;text?:string}[]=[];
  for(const ref of parseUseRefs(input.items)){
   const row=db.prepare('SELECT data FROM memory_records WHERE id=?').get(ref.recordId);
   if(!row){notices.push({...ref,status:'removed'});continue;}
   const current=parse<MemoryRevision>(row.data);collection(p,current.collectionId,input.projectId);
   if(current.status!=='active'){notices.push({recordId:current.recordId,revision:current.revision,status:current.status});continue;}
   try{const r=read(p,ref.recordId,input.projectId);if(r.status!=='active'){notices.push({recordId:r.recordId,revision:r.revision,status:r.status});continue;}if(!compatibleRevision(ref,r))notices.push({recordId:r.recordId,revision:r.revision,status:'corrected',text:r.text});items.push({recordId:r.recordId,revision:r.revision});}
   catch(error){if(!(error instanceof DomainError)||error.status===403)throw error;notices.push({recordId:current.recordId,revision:current.revision,status:'unavailable'});}
  }
  return {items,notices};
 });
 const collections=(p:Principal):MemoryCollection[]=>{principal(p);return db.prepare('SELECT id FROM memory_collections').all().flatMap(row=>{try{return [collection(p,row.id as string)];}catch{return [];}});};
 return {store,options,withAuthorityQuery:authorityQuery,enqueue,publishedSourceKeys,principal,collection,collections,listAll,ensureCollection,profile,profileId,captureConversation,captureTask,source,validateSource,validateReferences,compatibleRevision,history,list,read,staleScenes,applyProposal,confirm,correct,repairLegacyContexts,retireUnscopedProfiles,retract,restore,retractSource,importLegacy};
}
export type MemoryStore=ReturnType<typeof createMemoryStore>;
