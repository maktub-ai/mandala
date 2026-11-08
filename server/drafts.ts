import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DraftScope, ComposerDraft, PendingSubmission } from '../shared/drafts';
import { DomainError } from '../shared/workspace-contracts';
import type { SessionManager } from './sessions';
import type { Store } from './store';
import { workspacePrincipal } from './workspace-identity';
import { readJsonBody } from './http-body';
const invalid = (): never => { throw new DomainError('invalid_draft',422,'Invalid draft request'); };
const fields = (value: unknown, allowed: string[]): Record<string, any> => {
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return invalid();
 return value as Record<string, any>;
};
const text = (value: unknown, max: number, empty = true): string => {
 if (typeof value !== 'string' || (!empty && !value.trim()) || Buffer.byteLength(value,'utf8') > max) return invalid();
 return value;
};
const identifier = (value: unknown, empty = false) => text(value,200,empty);
const list = (value: unknown): unknown[] => { if(!Array.isArray(value) || value.length > 100)return invalid();return value; };
const integer = (value: unknown) => { if(!Number.isSafeInteger(value) || (value as number) < 0)return invalid();return value as number; };
function parseDraft(value: unknown): ComposerDraft {
 const data = fields(value,['text','references','attachments']);
 const result: ComposerDraft = {text:text(data.text,1024*1024)};
 if(data.references !== undefined)result.references = list(data.references).map(item => {
  const ref = fields(item,['id','kind','name','source','detail','status','objectId','intent']); text(ref.id,2000,false);
  for(const key of ['kind','name','source','detail','status','objectId'])if(ref[key]!==undefined)text(ref[key],key==='detail'&&ref.kind==='message'?64000:4000);
  if(ref.kind!==undefined && !['skill','mcp','task','agent','project','chat','message','command'].includes(ref.kind))invalid();
  if(ref.intent!==undefined&&(ref.kind!=='chat'||ref.intent!=='inquiry'))invalid();
  return ref as ComposerDraft['references'] extends (infer T)[] | undefined ? T : never;
 });
 if(data.attachments !== undefined)result.attachments = list(data.attachments).map(item => {
  const attachment=fields(item,['name','size','type','lastModified']);
  return {name:text(attachment.name,1000,false),size:integer(attachment.size),type:text(attachment.type,200),lastModified:integer(attachment.lastModified)};
 });
 return result;
}
function parsePending(value: unknown, scope: DraftScope): PendingSubmission {
 const data = fields(value,['conversationId','commandKey','draftFingerprint','action','body','recovery']);
 const conversationId=identifier(data.conversationId);if(conversationId!==scope.conversationId)invalid();
 if(data.draftFingerprint!==undefined&&(typeof data.draftFingerprint!=='string'||!/^[0-9a-f]{128}$/.test(data.draftFingerprint)))invalid();
 const commandKey=identifier(data.commandKey);if(!['queue','continue','interrupt'].includes(data.action))invalid();
 const body=fields(data.body,['text','attachments','references']),recovery=fields(data.recovery,['attempted','stopAttempted','stopConfirmed','expectedExecutionId','rejectionMessage']);
 for(const key of ['attempted','stopAttempted','stopConfirmed'])if(typeof recovery[key]!=='boolean')invalid();
 if(recovery.rejectionMessage!==undefined)text(recovery.rejectionMessage,8000);
 if(recovery.expectedExecutionId!==undefined)identifier(recovery.expectedExecutionId);
 return {conversationId,commandKey,...data.draftFingerprint?{draftFingerprint:data.draftFingerprint}:{},action:data.action,body:{text:text(body.text,1024*1024),attachments:list(body.attachments).map(id=>identifier(id)),references:list(body.references).map(id=>text(id,2000,false))},recovery:recovery as PendingSubmission['recovery']};
}
type Row = {scope: string; record_kind: 'draft'|'pending'; revision: number; data: string|null; updated_at: string};
export function createDrafts(store: Store, manager: Pick<SessionManager,'taskService'|'authorizeConversationRead'>) {
 const db=store.database,p=workspacePrincipal(store);
 db.exec(`CREATE TABLE IF NOT EXISTS local_draft_device (id INTEGER PRIMARY KEY CHECK(id=1), device_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS local_composer_drafts (owner_user_id TEXT NOT NULL, device_id TEXT NOT NULL, scope TEXT NOT NULL, record_kind TEXT NOT NULL CHECK(record_kind IN ('draft','pending')), revision INTEGER NOT NULL, data TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(owner_user_id,device_id,scope,record_kind));`);
 db.prepare('INSERT OR IGNORE INTO local_draft_device VALUES(1,?)').run(randomUUID());
 const deviceId = db.prepare('SELECT device_id FROM local_draft_device WHERE id=1').get()!.device_id as string;
 const scopeOf = (value: unknown, recoveryOnly = false): DraftScope => {
  const data=fields(value,['kind','conversationId','taskId','projectId','agentId']);
  if(!['chat','task'].includes(data.kind))invalid();
  const conversationId=identifier(data.conversationId,true);
  for(const key of ['taskId','projectId','agentId'])if(data[key]!==undefined)identifier(data[key],true);
  if(data.kind==='task') {
   const taskId=identifier(data.taskId),task=manager.taskService.getTask(p,taskId);
   if(conversationId && !recoveryOnly && !task.conversationIds.includes(conversationId))throw new DomainError('invalid_task_target',403,'Conversation does not execute this Task');
   if(conversationId){if(!store.getConversation(conversationId))throw new DomainError('not_found',404,'Conversation not found');manager.authorizeConversationRead(conversationId);}
   return {kind:'task',taskId,conversationId};
  }
  if(data.taskId!==undefined)invalid();
  if(conversationId){if(!store.getConversation(conversationId))throw new DomainError('not_found',404,'Conversation not found');manager.authorizeConversationRead(conversationId);return {kind:'chat',conversationId};}
  return {kind:'chat',conversationId:'',projectId:data.projectId??'',agentId:data.agentId??''};
 };
 const row = (scope: DraftScope,kind:'draft'|'pending') => db.prepare('SELECT * FROM local_composer_drafts WHERE owner_user_id=? AND device_id=? AND scope=? AND record_kind=?').get(store.ownerUserId,deviceId,JSON.stringify(scope),kind) as Row|undefined;
 const record = (value: Row|undefined,kind:'draft'|'pending') => ({revision:value?.revision??0,...value?{updatedAt:value.updated_at}:{},[kind]:value?.data?JSON.parse(value.data):null});
 const get=(input:unknown,kind:'draft'|'pending'='draft') => record(row(scopeOf(input,true),kind),kind);
 const save=(input:unknown,expected:unknown,value:unknown,kind:'draft'|'pending'='draft',remove=false) => {
  const scope=scopeOf(input,remove),expectedRevision=integer(expected),data=remove?null:JSON.stringify(kind==='draft'?parseDraft(value):parsePending(value,scope));
  if(data && Buffer.byteLength(data)>1152*1024)invalid();
  return store.transaction(()=>{
   const current=row(scope,kind);if((current?.revision??0)!==expectedRevision)throw new DomainError('draft_revision_conflict',409,'Draft changed in another window');
   if(remove&&!current)return record(undefined,kind);
   if(data){
    if(kind==='pending' && current?.data){const prior=JSON.parse(current.data) as PendingSubmission,next=JSON.parse(data) as PendingSubmission;if(prior.commandKey!==next.commandKey || prior.draftFingerprint!==next.draftFingerprint || prior.action!==next.action || prior.recovery.expectedExecutionId!==next.recovery.expectedExecutionId || JSON.stringify(prior.body)!==JSON.stringify(next.body))throw new DomainError('pending_submission_exists',409,'Resolve or explicitly clear the existing submission before replacing it');for(const flag of ['attempted','stopAttempted','stopConfirmed'] as const)if(prior.recovery[flag]&&!next.recovery[flag])throw new DomainError('invalid_pending_transition',409,'Submission recovery cannot roll back attempted or confirmed actions');}
    const count=db.prepare('SELECT count(*) AS count FROM local_composer_drafts WHERE owner_user_id=? AND device_id=? AND record_kind=? AND data IS NOT NULL').get(store.ownerUserId,deviceId,kind)!.count as number;
    const bytes=db.prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM local_composer_drafts WHERE owner_user_id=? AND device_id=?').get(store.ownerUserId,deviceId)!.bytes as number;
    if((!current?.data && count>=200)||bytes-(current?.data?Buffer.byteLength(current.data):0)+Buffer.byteLength(data)>16*1024*1024)throw new DomainError('draft_quota_exceeded',409,'Draft storage is full; clear older drafts before saving');
   }
   const updatedAt=new Date().toISOString(),revision=expectedRevision+1;
   db.prepare('INSERT INTO local_composer_drafts VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,device_id,scope,record_kind) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').run(store.ownerUserId,deviceId,JSON.stringify(scope),kind,revision,data,updatedAt);
   return record({scope:JSON.stringify(scope),record_kind:kind,revision,data,updated_at:updatedAt},kind);
  });
 };
 const handoff=(input:unknown,expected:unknown,targetId:unknown,targetExpected:unknown,value:unknown,pendingValue?:unknown,pendingExpected?:unknown)=>{
  const source=scopeOf(input);if(source.kind!=='chat'||source.conversationId)invalid();
  const target=scopeOf({kind:'chat',conversationId:identifier(targetId)}),expectedRevision=integer(expected),targetRevision=integer(targetExpected),data=JSON.stringify(parseDraft(value));
  const pendingData=pendingValue===undefined?null:JSON.stringify(parsePending(pendingValue,target)),pendingRevision=pendingValue===undefined?0:integer(pendingExpected);
  if(Buffer.byteLength(data)>1152*1024||pendingData&&Buffer.byteLength(pendingData)>1152*1024)invalid();
  return store.transaction(()=>{
   const from=row(source,'draft'),to=row(target,'draft'),receipt=row(target,'pending');
   if((from?.revision??0)!==expectedRevision||(to?.revision??0)!==targetRevision)throw new DomainError('draft_revision_conflict',409,'Draft changed in another window');
   if(from?.data===null)return {source:record(from,'draft'),target:record(to,'draft'),pending:record(receipt,'pending')};
   if(pendingData&&((receipt?.revision??0)!==pendingRevision||receipt?.data))throw new DomainError('draft_revision_conflict',409,'The destination Chat already has a pending submission');
   if(pendingData){const count=db.prepare("SELECT count(*) AS count FROM local_composer_drafts WHERE owner_user_id=? AND device_id=? AND record_kind='pending' AND data IS NOT NULL").get(store.ownerUserId,deviceId)!.count as number;if(count>=200)throw new DomainError('draft_quota_exceeded',409,'Draft storage is full');}
   if(to?.data)throw new DomainError('draft_revision_conflict',409,'The destination Chat already has a draft');
   const count=db.prepare("SELECT count(*) AS count FROM local_composer_drafts WHERE owner_user_id=? AND device_id=? AND record_kind='draft' AND data IS NOT NULL").get(store.ownerUserId,deviceId)!.count as number;
   if(count-(from?.data?1:0)+1>200)throw new DomainError('draft_quota_exceeded',409,'Draft storage is full');
   const bytes=db.prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM local_composer_drafts WHERE owner_user_id=? AND device_id=?').get(store.ownerUserId,deviceId)!.bytes as number;
   if(bytes-(from?.data?Buffer.byteLength(from.data):0)+Buffer.byteLength(data)+(pendingData?Buffer.byteLength(pendingData):0)>16*1024*1024)throw new DomainError('draft_quota_exceeded',409,'Draft storage is full');
   const updatedAt=new Date().toISOString(),write=db.prepare('INSERT INTO local_composer_drafts VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,device_id,scope,record_kind) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at');
   write.run(store.ownerUserId,deviceId,JSON.stringify(source),'draft',expectedRevision+1,null,updatedAt);
   write.run(store.ownerUserId,deviceId,JSON.stringify(target),'draft',targetRevision+1,data,updatedAt);
   if(pendingData)write.run(store.ownerUserId,deviceId,JSON.stringify(target),'pending',pendingRevision+1,pendingData,updatedAt);
   return {source:record({scope:JSON.stringify(source),record_kind:'draft',revision:expectedRevision+1,data:null,updated_at:updatedAt},'draft'),target:record({scope:JSON.stringify(target),record_kind:'draft',revision:targetRevision+1,data,updated_at:updatedAt},'draft'),pending:pendingData?record({scope:JSON.stringify(target),record_kind:'pending',revision:pendingRevision+1,data:pendingData,updated_at:updatedAt},'pending'):record(receipt,'pending')};
  });
 };
 const entries=()=>{
  const rows=db.prepare('SELECT * FROM local_composer_drafts WHERE owner_user_id=? AND device_id=? AND data IS NOT NULL ORDER BY updated_at DESC').all(store.ownerUserId,deviceId) as Row[];
  const result:{entries:unknown[];pending:unknown[]}={entries:[],pending:[]};
  for(const value of rows){try{const scope=scopeOf(JSON.parse(value.scope),value.record_kind==='pending');result[value.record_kind==='draft'?'entries':'pending'].push({scope,...record(value,value.record_kind)});}catch(error){if(!(error instanceof DomainError)||![403,404].includes(error.status))throw error;}}
  return result;
 };
 return {deviceId,get,save,handoff,entries};
}
export function createDraftHttp(store:Store,manager:SessionManager){
 const drafts=createDrafts(store,manager);
 return async(req:IncomingMessage,res:ServerResponse,url:URL)=>{
  if(url.pathname!=='/api/drafts'&&!url.pathname.startsWith('/api/drafts/'))return false;
  let result:unknown;const path=url.pathname;
  if(path==='/api/drafts/meta'&&req.method==='GET'&&!url.search)result={deviceId:drafts.deviceId};
  else if(path==='/api/drafts/handoff'&&req.method==='POST'&&!url.search){const data=fields(await readJsonBody(req,{maxBytes:3*1024*1024,contentTypeError:'invalid content type',sizeError:'invalid request size',jsonError:'invalid JSON'}),['scope','expectedRevision','targetConversationId','targetExpectedRevision','draft','pending','targetPendingExpectedRevision']);result=drafts.handoff(data.scope,data.expectedRevision,data.targetConversationId,data.targetExpectedRevision,data.draft,data.pending,data.targetPendingExpectedRevision);}
  else if(path==='/api/drafts'&&req.method==='GET'&&!url.search)result=drafts.entries();
  else if(['/api/drafts/entry','/api/drafts/pending'].includes(path)){
   const kind=path.endsWith('/pending')?'pending':'draft';
   if(req.method==='GET'){
    if([...url.searchParams.keys()].some(key=>key!=='scope')||url.searchParams.getAll('scope').length!==1)invalid();
    let scope:unknown;try{scope=JSON.parse(url.searchParams.get('scope')!);}catch{invalid();}result=drafts.get(scope,kind);
   }else if((req.method==='PUT'||req.method==='DELETE')&&!url.search){
    const data=fields(await readJsonBody(req,{maxBytes:2*1024*1024,contentTypeError:'invalid content type',sizeError:'invalid request size',jsonError:'invalid JSON'}),['scope','expectedRevision',...(req.method==='PUT'?[kind]:[])]);
    result=drafts.save(data.scope,data.expectedRevision,data[kind],kind,req.method==='DELETE');
   }else throw new DomainError('method_not_allowed',405,'Unsupported draft operation');
  }else throw new DomainError('method_not_allowed',405,'Unsupported draft operation');
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return true;
 };
}
