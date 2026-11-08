import {isSystemAgent} from './conversation-context';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Config,DisplayEvent,SkillSource} from '../shared/types';
import {DomainError,type Principal} from '../shared/workspace-contracts';
import type {Store} from './store';
import {memoryHistoryReferences} from './memory-runtime';

// Receipt summaries can carry protected context even when they have no asset versions.
export function hasReceiptConversationHistory(store:Store,id:string):boolean {
 return !!store.database.prepare("SELECT id FROM events WHERE conversationId=? AND superseded=0 AND (kind='user' AND json_extract(data,'$.source.kind')='coordination' OR kind='metadata' AND json_extract(data,'$.receiptContext')=1) LIMIT 1").get(id);
}

// The host owns Task/Memory history authorization. All Store connections for this
// workspace use the same live authority; without it protected history fails closed.
const authorities=new Map<string,{authorize:(principal:Principal,id:string)=>void;readScope?:<T>(read:()=>T)=>T}>();
const evidenceReads=new WeakMap<Store,{config:Config;validated:Set<string>}>();
// Configuration hydration is synchronous after its file read. Share repeated
// evidence checks only inside that snapshot, never across reads or awaits.
export function withSkillEvidenceRead<T>(store:Store,config:Config,read:()=>T):T{
 const previous=evidenceReads.get(store);
 evidenceReads.set(store,{config,validated:new Set()});
 const scope=authorities.get(store.home)?.readScope;
 try{return scope?scope(read):read();}finally{if(previous)evidenceReads.set(store,previous);else evidenceReads.delete(store);}
}
export function registerSkillConversationRead(store:Store,authorize:(principal:Principal,id:string)=>void,readScope?:<T>(read:()=>T)=>T){
 const authority={authorize,readScope};authorities.set(store.home,authority);
 return ()=>{if(authorities.get(store.home)===authority)authorities.delete(store.home);};
}
// Provenance records where evidence was used; it does not grant project membership.
export function skillEvidenceProject(store:Store,principal:Principal,projectId:string):string{
 if(!principal.agentId)return '';
 let config:Config;try{config=JSON.parse(readFileSync(join(store.home,'config.json'),'utf8')) as Config;}catch{throw new DomainError('skill_evidence_unavailable',403,'Skill configuration authority unavailable');}
 if(principal.userId!==store.ownerUserId||!config.agents.some(agent=>agent.id===principal.agentId))throw new DomainError('forbidden',403,'Skill source identity is unavailable');
 const project=config.projects.find(project=>project.id===projectId);return project&&(project.agentIds.includes(principal.agentId)||isSystemAgent(config,principal.agentId))?projectId:'';
}
export function assertSkillEvidence(store:Store,source:SkillSource|undefined,creatorAgentId:string|undefined,reader:Principal,config?:Config){
 if(!source?.conversationId)return;
 const query=evidenceReads.get(store);
 config??=query?.config;
 const key=JSON.stringify([source,creatorAgentId,reader]),cache=query?.config===config?query:undefined;
 if(cache?.validated.has(key))return;
 try{config??=JSON.parse(readFileSync(join(store.home,'config.json'),'utf8')) as Config;}catch{throw new DomainError('skill_evidence_unavailable',403,'Skill configuration authority unavailable');}
 const chat=store.getConversation(source.conversationId),sourceAgent=source.agentId??creatorAgentId;
 const events=new Map<number,DisplayEvent>(),ids=[...new Set(source.eventIds??[])];
 // Evidence is pinned to event IDs. Unrelated transcript payloads are not part of
 // this check; keep reads bounded without caching across authorization calls.
 for(let offset=0;offset<ids.length;offset+=500){
  const batch=ids.slice(offset,offset+500);
  for(const row of store.database.prepare('SELECT id,conversationId,kind,data,createdAt FROM events WHERE conversationId=? AND superseded=0 AND id IN ('+batch.map(()=>'?').join(',')+')').all(source.conversationId,...batch)){
   const event={...row,data:JSON.parse(row.data as string)} as DisplayEvent;events.set(event.id,event);
  }
 }
 if(!chat||chat.agentId!==sourceAgent||source.projectId!==undefined&&source.projectId!==chat.projectId||!config.agents.some(agent=>agent.id===chat.agentId)||chat.projectId&&!config.projects.find(project=>project.id===chat.projectId)?.agentIds.includes(chat.agentId)||source.eventIds?.some(id=>!events.has(id)||source.eventFingerprints?.[id]&&createHash('sha256').update(JSON.stringify(events.get(id))).digest('hex')!==source.eventFingerprints[id]))throw new DomainError('skill_source_replaced',403,'Original Skill evidence is unavailable');
 const authority=authorities.get(store.home);
 const principals:Principal[]=[...[...new Set([sourceAgent,creatorAgentId].filter((id):id is string=>!!id))].map(agentId=>({userId:store.ownerUserId,agentId})),reader];
 for(const principal of principals){
  if(principal.userId!==store.ownerUserId||principal.agentId!==undefined&&principal.agentId!==chat.agentId)throw new DomainError('forbidden',403,'Original dialogue is outside the current Agent scope');
  if(authority)authority.authorize(principal,chat.id);
  else if(hasReceiptConversationHistory(store,chat.id)||memoryHistoryReferences(store,chat.id).length||store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_runs'").get()&&store.listConversationTaskRuns(chat.id).length)throw new DomainError('skill_evidence_unavailable',403,'Conversation history authority unavailable');
 }
 cache?.validated.add(key);
}
