import nacl from 'tweetnacl';
import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComposerReferenceItem } from '../shared/composer-references';
import { requestJson } from './api';

export const ComposerDraftIdentity = createContext('fixture');
export const useComposerDraftIdentity = () => useContext(ComposerDraftIdentity);

export type ComposerDraftScope = {kind:'chat'|'task'; conversationId:string; taskId?:string; projectId?:string; agentId?:string};
export type PendingComposerSubmission = {
 conversationId:string; commandKey:string; draftFingerprint?:string; action:'queue'|'continue'|'interrupt';
 body:{text:string;attachments:string[];references:string[]};
 recovery:{attempted:boolean;stopAttempted:boolean;stopConfirmed:boolean;expectedExecutionId?:string;rejectionMessage?:string};
};
type AttachmentName = {name:string;size:number;type:string;lastModified:number};
export type ComposerDraftValue = {text:string;files:File[];references:ComposerReferenceItem[];missingAttachments:AttachmentName[]};
type StoredDraft = {text:string;references:ComposerReferenceItem[];attachments:AttachmentName[]};
type Stored<T> = {revision:number;updatedAt?:string} & T;
type CacheValue = {draft?:StoredDraft;files?:File[];pending?:PendingComposerSubmission|null;revision?:number;pendingRevision?:number;unsaved?:boolean};
const emptyDraft = ():ComposerDraftValue => ({text:'',files:[],references:[],missingAttachments:[]});
const scopeKey = (scope:ComposerDraftScope) => JSON.stringify(scope.kind === 'task' ? {kind:scope.kind,taskId:scope.taskId,conversationId:scope.conversationId} : scope.conversationId ? {kind:scope.kind,conversationId:scope.conversationId} : scope);
export function composerDraftFingerprint(value:ComposerDraftValue):string {
 const bytes=nacl.hash(new TextEncoder().encode(JSON.stringify({text:value.text,references:value.references.map(item=>item.id),attachments:[...value.files.map(file=>({name:file.name,size:file.size,type:file.type,lastModified:file.lastModified})),...value.missingAttachments]})));
 return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function clearAcceptedComposerDraft(value:ComposerDraftValue,fingerprint?:string):ComposerDraftValue {
 return fingerprint&&composerDraftFingerprint(value)===fingerprint?{text:'',files:[],references:[],missingAttachments:[]}:value;
}
let database:Promise<IDBDatabase>|undefined;
function browserDatabase() {
 return database ??= new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('mandala-composer-drafts',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
  request.onsuccess=()=>resolve(request.result); request.onerror=()=>{database=undefined;reject(request.error);};
 });
}
async function cacheRead(key:string):Promise<CacheValue|undefined> {
 const db=await browserDatabase();return new Promise((resolve,reject)=>{const request=db.transaction('drafts').objectStore('drafts').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
async function cacheWrite(key:string,value:CacheValue) {
 const db=await browserDatabase();return new Promise<void>((resolve,reject)=>{const transaction=db.transaction('drafts','readwrite');transaction.objectStore('drafts').put(value,key);transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);});
}
async function cachePatch(key:string,patch:Partial<CacheValue>) {
 const db=await browserDatabase();return new Promise<void>((resolve,reject)=>{
  const transaction=db.transaction('drafts','readwrite'),store=transaction.objectStore('drafts'),read=store.get(key);
  read.onsuccess=()=>store.put({...read.result,...patch},key);transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
 });
}
const metadata=(file:File):AttachmentName=>({name:file.name,size:file.size,type:file.type,lastModified:file.lastModified});
const serialize=(value:ComposerDraftValue):StoredDraft=>({text:value.text,references:value.references,attachments:[...value.files.map(metadata),...value.missingAttachments]});
const restore=(value:StoredDraft|null|undefined,files:File[]=[]):ComposerDraftValue=>{
 if(!value)return emptyDraft();
 const metadata=value.attachments??[],available=files.filter(file=>file instanceof File&&metadata.some(item=>file.name===item.name&&file.size===item.size&&file.type===item.type&&file.lastModified===item.lastModified));
 return {text:value.text,references:(value.references??[]).map(item=>({...item,name:item.name??item.id,source:item.source??'',detail:item.detail??'',status:item.status??''})),files:available,missingAttachments:metadata.filter(item=>!available.some(file=>file.name===item.name&&file.size===item.size&&file.type===item.type&&file.lastModified===item.lastModified))};
};

/** Local HOME is authoritative; IndexedDB is a truthful offline buffer and remote authority. */
export function useComposerDraft(scope:ComposerDraftScope, identity:string, remote=false, enabled=true) {
 const key=scopeKey(scope);
 const session=useMemo(()=>({loaded:false,revision:0,pendingRevision:0,cacheKey:'',cache:{} as CacheValue,chain:Promise.resolve(),conflicted:false,latest:emptyDraft(),preloadTextChanged:false,preloadReferencesChanged:false,preloadReplace:false,sequence:0,savedSequence:0,completion:null as {revision:number;fingerprint:string}|null,pendingUpdate:null as {revision:number;pending:PendingComposerSubmission|null}|null,redirects:new Map<string,{revision:number;cacheKey:string;cache:CacheValue}>()}),[key,identity,remote,enabled]);
 const active=useRef(session);active.current=session;
 const [value,setValueState]=useState<ComposerDraftValue>(emptyDraft),[loaded,setLoaded]=useState(false),[status,setStatus]=useState<'loading'|'saving'|'saved'|'buffered'|'error'|'conflict'>('loading'),[error,setError]=useState(''),[pending,setPendingState]=useState<PendingComposerSubmission|null>(null);
 const report=useCallback((state:typeof status,message='')=>{if(active.current===session){setStatus(state);setError(message);}},[session]);
 const buffer=useCallback(async(next:ComposerDraftValue)=>{
  if(!session.cacheKey)return;
  session.cache={...session.cache,draft:serialize(next),revision:session.revision,unsaved:!remote,files:next.files};
  await cacheWrite(session.cacheKey,session.cache);
 },[session,remote]);
 const save=useCallback(async(next:ComposerDraftValue,requireDurable=false)=>{
  if(!session.loaded||!enabled||!session.cacheKey)return;
  const serial=session.sequence,serialized=serialize(next);
  if(remote){try{await buffer(next);}catch(reason){report('error',(reason as Error).message);throw reason;}session.savedSequence=serial;report('saved');return;}
  if(session.conflicted){if(requireDurable)throw Error('Draft changed in another window');return;}
  report('saving');
  const work=session.chain.catch(()=>{}).then(async()=>{
   if(serial>0&&serial<=session.savedSequence)return;
   try{await buffer(session.latest);}catch(reason){report('error',(reason as Error).message);if(requireDurable&&next.files.length)throw reason;}
   const saved=await requestJson<Stored<{draft:StoredDraft}>>('/api/drafts/entry',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:JSON.parse(key),expectedRevision:session.revision,draft:serialized})});
   session.revision=saved.revision;session.savedSequence=serial;session.conflicted=false;
   if(serial===session.sequence){session.cache={...session.cache,draft:serialized,revision:saved.revision,unsaved:false};await cacheWrite(session.cacheKey,session.cache).catch(()=>{});report('saved');}
  });session.chain=work;
  try {await work;}catch(reason){session.conflicted=(reason as {status?:number}).status===409;report(session.conflicted?'conflict':'buffered',(reason as Error).message);if(requireDurable)throw reason;}
 },[session,key,enabled,remote,buffer,report]);
 useLayoutEffect(()=>{
  setLoaded(false);setStatus('loading');setError('');setValueState(emptyDraft());setPendingState(null);
  if(!enabled)return;
  const completed=(event:Event)=>{
   const detail=(event as CustomEvent<{identity:string;key:string;revision:number;fingerprint:string;waitUntil:(promise:Promise<void>)=>void}>).detail;
   if(detail.identity!==identity||detail.key!==key)return;session.completion=detail;
   if(!session.loaded)return;
   session.revision=detail.revision;const next=clearAcceptedComposerDraft(session.latest,detail.fingerprint);session.latest=next;session.sequence++;
   if(active.current===session)setValueState({...next});detail.waitUntil(save(next,true));
  };
  const pendingUpdated=(event:Event)=>{
   const detail=(event as CustomEvent<{identity:string;key:string;revision:number;pending:PendingComposerSubmission|null}>).detail;
   if(detail.identity!==identity||detail.key!==key||detail.revision<session.pendingRevision)return;
   session.pendingUpdate=detail;session.pendingRevision=detail.revision;session.cache={...session.cache,pending:detail.pending,pendingRevision:detail.revision};
   if(session.loaded&&active.current===session)setPendingState(detail.pending);
  };
  addEventListener('mandala-draft-pending',pendingUpdated);
  addEventListener('mandala-draft-completed',completed);
  void (async()=>{
   let device='remote';
   if(!remote){try{device=(await requestJson<{deviceId:string}>('/api/drafts/meta')).deviceId;localStorage.setItem('mandala-draft-device:'+identity,device);}catch{device=localStorage.getItem('mandala-draft-device:'+identity)??'';}}
   session.cacheKey=JSON.stringify([remote?'remote':'local',identity,device,key]);
   const storedBuffer=await cacheRead(session.cacheKey).catch(()=>undefined);
   let draft=storedBuffer?.draft,receipt=storedBuffer?.pending??null,state:typeof status=remote?'saved':'buffered',message='';
   session.revision=storedBuffer?.revision??0;session.pendingRevision=storedBuffer?.pendingRevision??0;
   if(!remote){try{
    const query='?scope='+encodeURIComponent(key);
    const [stored,recovery]=await Promise.all([requestJson<Stored<{draft:StoredDraft|null}>>('/api/drafts/entry'+query),requestJson<Stored<{pending:PendingComposerSubmission|null}>>('/api/drafts/pending'+query)]);
    session.revision=stored.revision;session.pendingRevision=recovery.revision;
    if(storedBuffer?.unsaved&&storedBuffer.revision!==stored.revision){state='conflict';message='draft_revision_conflict';session.conflicted=true;session.revision=storedBuffer.revision??0;}
    else{draft=storedBuffer?.unsaved?storedBuffer.draft:stored.draft??undefined;state=storedBuffer?.unsaved?'buffered':'saved';}
    receipt=recovery.pending;
   }catch(reason){message=(reason as Error).message;}}
   if(session.pendingUpdate&&session.pendingUpdate.revision>=session.pendingRevision){receipt=session.pendingUpdate.pending;session.pendingRevision=session.pendingUpdate.revision;}
   session.cache={draft,pending:receipt,revision:session.revision,pendingRevision:session.pendingRevision,unsaved:state==='buffered',files:storedBuffer?.files??[]};
   const incoming=session.latest,restored=restore(draft,storedBuffer?.files);
   if(session.preloadReplace)session.latest=incoming;
   else if(session.sequence){
    const same=(a:AttachmentName,b:AttachmentName)=>a.name===b.name&&a.size===b.size&&a.type===b.type&&a.lastModified===b.lastModified;
    const files=[...restored.files,...incoming.files];
    const missing=[...restored.missingAttachments,...incoming.missingAttachments].filter(item=>!files.some(file=>same(metadata(file),item)));
    session.latest={...restored,text:session.preloadTextChanged?incoming.text:restored.text,files,missingAttachments:missing,references:session.preloadReferencesChanged?[...new Map([...restored.references,...incoming.references].map(item=>[item.id,item])).values()]:restored.references};
   }else session.latest=restored;
   if(session.completion&&session.revision<=session.completion.revision){session.latest=clearAcceptedComposerDraft(session.latest,session.completion.fingerprint);session.revision=session.completion.revision;}session.loaded=true;
   if(session.sequence){try{await buffer(session.latest);}catch(reason){state='error';message=(reason as Error).message;}if(active.current!==session)void save(session.latest);}
   if(active.current===session){setValueState(session.latest);setPendingState(receipt);setLoaded(true);setStatus(state);setError(message);}
  })().catch(reason=>{if(active.current===session){setLoaded(true);report('error',(reason as Error).message);}});
  return()=>{removeEventListener('mandala-draft-completed',completed);removeEventListener('mandala-draft-pending',pendingUpdated);if(session.loaded&&session.sequence!==session.savedSequence)void save(session.latest);};
 },[session,key,identity,remote,enabled,save,buffer,report]);
 const setValue=useCallback((next:ComposerDraftValue|((old:ComposerDraftValue)=>ComposerDraftValue))=>{
  const previous=session.latest,updated=typeof next==='function'?next(previous):next;if(!session.loaded){session.preloadTextChanged||=updated.text!==previous.text;session.preloadReferencesChanged||=updated.references!==previous.references;}session.latest=updated;session.sequence++;
  if(active.current===session){setValueState(updated);report('saving');}
  // Commit browser bytes immediately; a scope switch must not wait for the HTTP debounce.
  const serial=session.sequence;void buffer(updated).then(()=>{if(remote&&serial===session.sequence){session.savedSequence=serial;report('saved');}}).catch(reason=>report('error',(reason as Error).message));
 },[session,buffer,report,remote]);
 useEffect(()=>{if(!loaded||!session.loaded||session.sequence===session.savedSequence)return;const timer=setTimeout(()=>void save(session.latest),180);return()=>clearTimeout(timer);},[value,loaded,session,save]);
 const savePending=useCallback(async(next:PendingComposerSubmission|null,targetConversationId?:string)=>{
  if(!session.loaded||!session.cacheKey)throw Error('Draft recovery is still loading');
  let pendingKey=key,holder:{revision:number;cacheKey:string;cache:CacheValue}|null=null;
  if(targetConversationId && JSON.parse(key).kind==='chat' && JSON.parse(key).conversationId!==targetConversationId){
   pendingKey=scopeKey({kind:'chat',conversationId:targetConversationId});holder=session.redirects.get(pendingKey)??null;
   if(!holder){const parts=JSON.parse(session.cacheKey);parts[3]=pendingKey;const saved=await requestJson<Stored<{pending:PendingComposerSubmission|null}>>('/api/drafts/pending?scope='+encodeURIComponent(pendingKey));holder={revision:saved.revision,cacheKey:JSON.stringify(parts),cache:{pending:saved.pending,pendingRevision:saved.revision}};session.redirects.set(pendingKey,holder);}
  }
  let nextCache:CacheValue;
  if(remote){nextCache={...session.cache,pending:next};session.cache=nextCache;await cacheWrite(session.cacheKey,nextCache);}
  else{
   const saved=await requestJson<Stored<{pending:PendingComposerSubmission|null}>>('/api/drafts/pending',{method:next?'PUT':'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:JSON.parse(pendingKey),expectedRevision:holder?holder.revision:session.pendingRevision,...next?{pending:next}:{}})});
   if(holder){holder.revision=saved.revision;holder.cache={...holder.cache,pending:next,pendingRevision:saved.revision};await cachePatch(holder.cacheKey,{pending:next,pendingRevision:saved.revision}).catch(()=>{});dispatchEvent(new CustomEvent('mandala-draft-pending',{detail:{identity,key:pendingKey,revision:saved.revision,pending:next}}));}else{session.pendingRevision=saved.revision;nextCache={...session.cache,pending:next,pendingRevision:saved.revision};session.cache=nextCache;await cacheWrite(session.cacheKey,nextCache).catch(()=>{});}
  }
  if(!holder&&active.current===session)setPendingState(next);
 },[session,key,remote,identity]);
 const reload=useCallback(async()=>{
  if(remote)return;
  const stored=await requestJson<Stored<{draft:StoredDraft|null}>>('/api/drafts/entry?scope='+encodeURIComponent(key));
  session.revision=stored.revision;session.conflicted=false;session.sequence=0;session.savedSequence=0;session.latest=restore(stored.draft);session.cache={...session.cache,draft:stored.draft??undefined,revision:stored.revision,unsaved:false};await cacheWrite(session.cacheKey,session.cache);
  if(active.current===session){setValueState(session.latest);report('saved');}
 },[session,key,remote,report]);
 const clearStoredIfMatch=useCallback(async(fingerprint?:string)=>{
  if(remote)throw Error('Local recovery only');
  const stored=await requestJson<Stored<{draft:StoredDraft|null}>>('/api/drafts/entry?scope='+encodeURIComponent(key));
  let savedRevision=stored.revision;
  if(fingerprint&&stored.draft&&composerDraftFingerprint(restore(stored.draft))===fingerprint){const cleared=await requestJson<Stored<{draft:null}>>('/api/drafts/entry',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:JSON.parse(key),expectedRevision:stored.revision})});savedRevision=cleared.revision;}
  const matched=!!fingerprint&&composerDraftFingerprint(session.latest)===fingerprint;
  if(matched)session.latest=emptyDraft();session.revision=savedRevision;session.cache={...session.cache,draft:serialize(session.latest),revision:savedRevision,unsaved:!matched};await cacheWrite(session.cacheKey,session.cache);
  if(active.current===session){setValueState(session.latest);report(matched?'saved':'buffered');}
 },[session,key,remote,report]);
 const completeConversation=useCallback(async(conversationId:string,fingerprint?:string)=>{
  if(!fingerprint)throw Error('The original draft snapshot is unavailable. Inspect history before resolving recovery.');
  const targetKey=scopeKey({kind:'chat',conversationId}),query='?scope='+encodeURIComponent(targetKey),stored=await requestJson<Stored<{draft:StoredDraft|null}>>('/api/drafts/entry'+query);
  if(!stored.draft||composerDraftFingerprint(restore(stored.draft))!==fingerprint)return;
  const saved=await requestJson<Stored<{draft:null}>>('/api/drafts/entry',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:JSON.parse(targetKey),expectedRevision:stored.revision})});
  const pending:Promise<void>[]=[];dispatchEvent(new CustomEvent('mandala-draft-completed',{detail:{identity,key:targetKey,revision:saved.revision,fingerprint,waitUntil:(promise:Promise<void>)=>pending.push(promise)}}));await Promise.all(pending);
 },[identity]);
 const copyToConversation=useCallback(async(conversationId:string,pending?:PendingComposerSubmission)=>{
  const targetKey=scopeKey({kind:'chat',conversationId}),query='?scope='+encodeURIComponent(targetKey),serial=session.sequence;
  const selectedFiles=session.latest.files,selected=serialize(session.latest);
  const work=session.chain.catch(()=>{}).then(async()=>{
   const [existing,recovery]=await Promise.all([requestJson<Stored<{draft:StoredDraft|null}>>('/api/drafts/entry'+query),requestJson<Stored<{pending:PendingComposerSubmission|null}>>('/api/drafts/pending'+query)]);
   const saved=await requestJson<{source:Stored<{draft:null}>;target:Stored<{draft:StoredDraft}>;pending:Stored<{pending:PendingComposerSubmission|null}>}>('/api/drafts/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:JSON.parse(key),expectedRevision:session.revision,targetConversationId:conversationId,targetExpectedRevision:existing.revision,draft:selected,...pending?{pending,targetPendingExpectedRevision:recovery.revision}:{}})});
   session.revision=saved.source.revision;session.savedSequence=serial;
   if(session.sequence===serial){session.latest=emptyDraft();session.cache={...session.cache,draft:undefined,files:[],revision:session.revision,unsaved:false};}
   else session.cache={...session.cache,revision:session.revision,unsaved:true};
   await cacheWrite(session.cacheKey,session.cache).catch(()=>{});const parts=JSON.parse(session.cacheKey);parts[3]=targetKey;await cacheWrite(JSON.stringify(parts),{draft:saved.target.draft,files:selectedFiles,revision:saved.target.revision,pending:saved.pending.pending,pendingRevision:saved.pending.revision,unsaved:false}).catch(()=>{});
   if(active.current===session)setValueState(session.latest);
  });session.chain=work;await work;
 },[session,key]);
 const replaceValue=useCallback((next:ComposerDraftValue)=>{if(!session.loaded)session.preloadReplace=true;setValue(next);},[session,setValue]);
 return {value,setValue,replaceValue,loaded,ready:session.loaded,status,error,pending,savePending,clearStoredIfMatch,completeConversation,copyToConversation,flush:()=>save(session.latest,true),reload};
}
