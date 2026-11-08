import type { ConversationReferenceSummary, ReferenceDocument } from '../shared/conversation-references';
import type { VersionRef } from '../shared/workspace-contracts';
import { DomainError } from '../shared/workspace-contracts';
import type { Store } from './store';
import type { createAssets } from './assets';
import type { createAttachmentAssets } from './attachment-assets';
import type { createTasks } from './tasks';
import type { MemoryStore } from './memory-store';
import { memoryHistoryReferences } from './memory-runtime';
import { workspacePrincipal } from './workspace-identity';

// Conversation lineage is distinct from a project's catalog or prepared context.
export function createConversationReferences({store,assets,attachments,tasks,memory,authorize}:{
 store:Store;assets:ReturnType<typeof createAssets>;attachments:ReturnType<typeof createAttachmentAssets>;
 tasks:Pick<ReturnType<typeof createTasks>,'listLinkedTasks'|'getTask'>;memory?:MemoryStore;authorize:(id:string)=>void;
}) {
 const root=workspacePrincipal(store),limit=100;
 return (id:string,memoryKinds:('request'|'session')[]=['request','session']):ConversationReferenceSummary=>{
  authorize(id);const chat=store.getConversation(id)!;
  const documents=new Map<string,ReferenceDocument>();
  const add=(ref:VersionRef,relation:ReferenceDocument['relations'][number])=>{
   try{
    const version=assets.getAuthorizedVersion(root,ref),asset=assets.getAuthorizedAsset(root,ref.assetId);
    const key=ref.assetId+'@'+ref.versionId,previous=documents.get(key);
    if(previous){if(!previous.relations.includes(relation))previous.relations.push(relation);return;}
    const attachment=store.database.prepare("SELECT attachment_id FROM attachment_asset_links WHERE user_id=? AND asset_id=? AND version_id=? AND state='imported'").get(root.userId,ref.assetId,ref.versionId);
    documents.set(key,{...ref,title:asset.title,ordinal:version.ordinal,relations:[relation],files:version.files.map((file,index)=>({name:file.path,fileId:String(index)})),runId:version.provenance.runId,...(attachment?{attachmentId:attachment.attachment_id as string}:{})});
   }catch(error){if(!(error instanceof DomainError))throw error;}
  };
  for(const ref of attachments.lineage(root,id,authorize).refs)add(ref,'input');
  for(const event of store.listEvents(id,0)){
   if(event.kind!=='metadata')continue;
   const data=event.data as {actualUse?:string;sourceVersions?:VersionRef[];memoryRecall?:string;status?:string;entries?:VersionRef[]};
   if(data.actualUse==='acknowledged')for(const ref of data.sourceVersions??[])add(ref,'context');
   if(data.memoryRecall&&data.status==='completed')for(const ref of data.entries??[])if(ref.assetId&&ref.versionId)add(ref,'context');
  }
  const outputRows=store.database.prepare(`SELECT v.asset_id,v.id FROM asset_versions v
   WHERE EXISTS (SELECT 1 FROM file_execution_scopes s WHERE s.invocation_id=json_extract(v.data,'$.provenance.runId') AND s.user_id=? AND s.conversation_id=?)
   OR EXISTS (SELECT 1 FROM task_runs r JOIN work_tasks t ON t.id=r.task_id WHERE r.id=json_extract(v.data,'$.provenance.runId') AND t.owner_user_id=? AND (json_extract(r.routing,'$.executionConversationId')=? OR json_extract(r.routing,'$.destinationConversationId')=?))
   ORDER BY v.rowid DESC LIMIT ?`).all(root.userId,id,root.userId,id,id,limit+1);
  for(const row of outputRows)add({assetId:row.asset_id as string,versionId:row.id as string},'output');
  const memories:ConversationReferenceSummary['memories']=[];
  if(memory&&memoryKinds.includes('request'))memory.withAuthorityQuery(()=>{
   const scope={projectId:chat.projectId||null,agentId:chat.agentId||null},reader={...root,...scope.agentId?{agentId:scope.agentId}:{}};
   const current=memory.profile(reader,scope);if(!current)return;
   const refs=memoryHistoryReferences(store,id).filter(ref=>ref.recordId===current.recordId&&ref.revision<=current.revision);
   const history=memory.history(reader,{projectId:scope.projectId,items:refs}),supplied=refs.at(-1);
   const provided=supplied&&history.items.some(ref=>ref.recordId===current.recordId)&&memory.compatibleRevision(supplied,current);
   memories.push({recordId:current.recordId,revision:current.revision,text:current.text,relation:provided?'provided':'available',...supplied?{suppliedRevision:supplied.revision}:{}});
  });
  const linkedTasks=new Map(tasks.listLinkedTasks(root,id).map(task=>[task.id,task]));
  for(const row of store.database.prepare("SELECT DISTINCT t.id FROM work_tasks t JOIN task_runs r ON r.task_id=t.id WHERE t.owner_user_id=? AND (json_extract(r.routing,'$.executionConversationId')=? OR json_extract(r.routing,'$.destinationConversationId')=?)").all(root.userId,id,id)){
   const task=tasks.getTask(root,row.id as string);linkedTasks.set(task.id,task);
  }
  const linked=[...linkedTasks.values()].map(({id,goal,state})=>({id,goal,state}));
  authorize(id);
  return {tasks:linked.slice(0,limit),documents:[...documents.values()].slice(0,limit),memories:memories.slice(0,limit),truncated:outputRows.length>limit||documents.size>limit||memories.length>limit||linked.length>limit};
 };
}
