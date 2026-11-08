import type { DatabaseSync } from 'node:sqlite';
import { createOutbox } from './outbox';
import type { WikiPolicy } from '../shared/knowledge-base';
// The terminal event and its enabled reception epochs commit in the same transcript transaction.
export function enqueueWikiCompletion(db:DatabaseSync,conversationId:string,eventId:number){
 if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_bases'").get())return;
 const row=db.prepare('SELECT data FROM conversations WHERE id=?').get(conversationId);if(!row)return;
 const chat=JSON.parse(row.data as string);
 const targets=db.prepare('SELECT data FROM wiki_bases').all().map(row=>JSON.parse(row.data as string) as WikiPolicy).filter(base=>base.reception.enabled&&(base.ownership!=='project'||base.projectId===chat.projectId&&base.maintainerAgentId===chat.agentId)&&(!base.reception.agentId||base.reception.agentId===chat.agentId)&&(!base.reception.projectId||base.reception.projectId===chat.projectId));
 if(!targets.length)return;
 createOutbox(db).enqueueOutbox({type:'wiki.dialogue_completed',aggregateId:conversationId,aggregateRevision:eventId,causationId:'wiki:'+eventId,payload:{conversationId,eventId,agentId:chat.agentId,projectId:chat.projectId,targets:targets.map(base=>({id:base.id,epoch:base.receptionEpoch,after:base.enabledAfter}))}});
}
