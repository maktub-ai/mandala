import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createAttachmentAssets } from '../server/attachment-assets';
import { workspacePrincipal } from '../server/workspace-identity';
import { createConversationReferences } from '../server/conversation-references';
import { createMemoryStore } from '../server/memory-store';
const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'references-')),store=openStore(home),root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files),attachments=createAttachmentAssets(home,store,files,assets);
 store.database.exec('CREATE TABLE file_execution_scopes(invocation_id TEXT PRIMARY KEY,user_id TEXT,agent_id TEXT,project_id TEXT,conversation_id TEXT)');
 const chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),other=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const authorize=vi.fn((id:string)=>{if(id!==chat.id)throw new Error('forbidden');});
 const taskService=createTasks(store,{assets});
 const tasks={getTask:vi.fn((p,id)=>taskService.getTask(p,id)),listLinkedTasks:vi.fn(()=>[{id:'t',goal:'Linked task',state:'todo'}])} as any;
 const summary=createConversationReferences({store,assets,attachments,tasks,authorize});
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const publish=async(name:string,runId?:string)=>{writeFileSync(join(home,'input'),name);const stage=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'input',manifestPath:name+'.md'}]);const imported=assets.importAsset(root,{kind:'document',title:name,submissionId:stage.submissionId},name);if(runId){const principal={...root,runId},staged=await files.stageFiles(principal,runId,[{allowedRoot:home,relativePath:'input',manifestPath:name+'.md'}]);const version=assets.publishAssetVersion(principal,{assetId:imported.asset.id,expectedHeadVersionId:imported.version.id,...staged,provenance:{runId,sourceVersions:[]}},'run-'+name);return {asset:imported.asset,version};}return imported;};
 return {store,root,assets,attachments,chat,other,authorize,tasks,summary,publish,taskService};
}
test('reference summary follows acknowledged fixed context and real outputs, never whole project bindings or textual IDs',async()=>{
 const f=await fixture(),context=await f.publish('Context'),unused=await f.publish('Unused'),output=await f.publish('Deliverable','run'),elsewhere=await f.publish('Elsewhere','other-run');
 f.assets.bind(f.root,{ownerType:'project',ownerId:'p',assetId:unused.asset.id,versionPolicy:'latest'});
 f.store.appendEvent(f.chat.id,'metadata',{actualUse:'acknowledged',sourceVersions:[{assetId:context.asset.id,versionId:context.version.id}]});
 f.store.appendEvent(f.chat.id,'metadata',{actualUse:'prepared',sourceVersions:[{assetId:unused.asset.id,versionId:unused.version.id}]});
 f.store.appendEvent(f.chat.id,'text',{text:'Published '+elsewhere.asset.id});
 f.store.database.prepare('INSERT INTO file_execution_scopes VALUES (?,?,?,?,?)').run('run',f.root.userId,'a','p',f.chat.id);
 f.store.database.prepare('INSERT INTO file_execution_scopes VALUES (?,?,?,?,?)').run('other-run',f.root.userId,'a','p',f.other.id);
 const result=f.summary(f.chat.id);
 expect(result.tasks).toMatchObject([{id:'t',goal:'Linked task',state:'todo'}]);
 expect(result.documents.map(d=>d.assetId)).toEqual(expect.arrayContaining([context.asset.id,output.asset.id]));
 expect(result.documents).toHaveLength(2);expect(result.documents.find(d=>d.assetId===context.asset.id)).toMatchObject({versionId:context.version.id,relations:['context']});
 expect(result.documents.find(d=>d.assetId===output.asset.id)).toMatchObject({versionId:output.version.id,relations:['output'],runId:'run',files:[{name:'Deliverable.md',fileId:'0'}]});
 expect(()=>f.summary(f.other.id)).toThrow('forbidden');
});
test('accepted attachment versions appear as inputs, while revoked sources do not leak file names',async()=>{
 const f=await fixture(),input=await f.publish('Input'),revoked=await f.publish('Secret');
 f.store.appendEvent(f.chat.id,'user',{text:'Input',attachments:[{id:'upload'}]});
 f.store.database.prepare("INSERT INTO attachment_asset_links VALUES (?,?,?,?,?,?,'imported',?,?,NULL)").run(f.root.userId,f.chat.id,'upload',input.asset.id,input.version.id,'submit','a','p');
 f.store.appendEvent(f.chat.id,'metadata',{actualUse:'acknowledged',sourceVersions:[{assetId:revoked.asset.id,versionId:revoked.version.id}]});
 f.assets.setLifecycle(f.root,revoked.asset.id,'retracted',revoked.asset.revision);
 const result=f.summary(f.chat.id);expect(result.documents).toEqual([expect.objectContaining({assetId:input.asset.id,versionId:input.version.id,attachmentId:'upload',relations:['input']})]);
 expect(JSON.stringify(result)).not.toContain('Secret');
});
function profiles(f:Awaited<ReturnType<typeof fixture>>){
 const memory=createMemoryStore(f.store,{assets:f.assets,tasks:f.taskService,localUserId:f.root.userId,authorizeProject:()=>{}});
 const seed=(projectId:string|null,agentId:string|null,text:string,old?:{recordId:string;revision:number})=>{
  const c=memory.ensureCollection(f.root,{projectId,agentId}),chat=f.store.createConversation({projectId:projectId??'',agentId:agentId??'',cli:'codex',model:null});
  const event=f.store.appendEvent(chat.id,'user',{text});f.store.appendEvent(chat.id,'status',{status:'idle'});
  const source=memory.captureConversation(f.root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
  const p={collectionId:c.id,layer:'L1' as const,contentType:'fact' as const,text,operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'observed' as const,pipeline:'request' as const};
  const fact=memory.applyProposal(f.root,p,c.generation,'evidence_extract')!;
  const scene=memory.applyProposal(f.root,{...p,layer:'L2',semanticKey:'scene.'+fact.recordId,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},c.generation,'layer_summary')!;
  const persona=memory.applyProposal(f.root,{...p,layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine',operation:old?'update':'store',replaces:old?[old]:[],support:[],dependencies:[{recordId:scene.recordId,revision:scene.revision}]},c.generation,'layer_summary',{profileScope:{projectId,agentId}})!;
  return {fact,persona};
 };
 return {memory,seed,summary:createConversationReferences({...f,memory})};
}
test('references use the single current project and Agent profile, ignoring foreign historical and prepared L3',async()=>{
 const f=await fixture(),s=profiles(f),current=s.seed('p','a','Current ERP rules'),foreign=s.seed('p','b','Other Agent rules'),otherProject=s.seed('q','a','Other project rules'),personal=s.seed(null,'a','Private rules');
 f.store.appendEvent(f.chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:foreign.persona.recordId,revision:1},{recordId:otherProject.persona.recordId,revision:1},{recordId:personal.persona.recordId,revision:1}]});
 f.store.appendEvent(f.chat.id,'metadata',{memoryRecall:'prepared',status:'running',entries:[{kind:'memory',recordId:current.persona.recordId,revision:1}]});
 const spy=vi.spyOn(s.memory,'profile'),result=s.summary(f.chat.id);
 expect(result.memories).toEqual([expect.objectContaining({recordId:current.persona.recordId,relation:'available'})]);
 expect(spy).toHaveBeenCalledWith({...f.root,agentId:'a'},{projectId:'p',agentId:'a'});
});
test('one stable profile tracks actual supplied revision and never duplicates generation or a newer body',async()=>{
 const f=await fixture(),s=profiles(f),first=s.seed('p','a','Initial work rules').persona;
 f.store.appendEvent(f.chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:first.recordId,revision:first.revision}]});
 expect(s.summary(f.chat.id).memories).toEqual([expect.objectContaining({recordId:first.recordId,relation:'provided',suppliedRevision:1})]);
 const updated=s.seed('p','a','Updated work rules',first).persona;
 expect(updated.recordId).toBe(first.recordId);
 expect(s.summary(f.chat.id).memories).toEqual([expect.objectContaining({recordId:first.recordId,revision:2,relation:'available',suppliedRevision:1,text:'Updated work rules'})]);
 f.store.appendEvent(f.chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:updated.recordId,revision:updated.revision}]});
 expect(s.summary(f.chat.id).memories).toEqual([expect.objectContaining({recordId:updated.recordId,revision:2,relation:'provided',suppliedRevision:2})]);
});
test('current profile disappears from references when request reading is disabled, evidence is revoked or the profile withdrawn',async()=>{
 const f=await fixture(),s=profiles(f),{fact,persona}=s.seed('p','a','Verified delivery rules');
 expect(s.summary(f.chat.id,[]).memories).toEqual([]);
 expect(s.summary(f.chat.id,['session']).memories).toEqual([]);
 s.memory.retract(f.root,{recordId:fact.recordId,expectedRevision:fact.revision});
 expect(s.summary(f.chat.id).memories).toEqual([]);
 const updated=s.seed('p','a','Replacement delivery rules',{recordId:persona.recordId,revision:2}).persona;
 s.memory.retract(f.root,{recordId:updated.recordId,expectedRevision:updated.revision});
 expect(s.summary(f.chat.id).memories).toEqual([]);
});
test('missing exact pair never falls back to another Agent or an unassigned dimension',async()=>{
 const f=await fixture(),s=profiles(f);s.seed('p',null,'Unassigned Agent rules');s.seed(null,'a','Personal Agent rules');s.seed('p','b','Other Agent rules');
 expect(s.summary(f.chat.id).memories).toEqual([]);
});

test('a task output is associated with its execution and destination conversation, with the bound task visible',async()=>{
 const f=await fixture(),task=f.taskService.createTask(f.root,{goal:'Dispatched work'},'dispatched'),output=await f.publish('Task report','task-run');
 const execution=f.taskService.createExecution(f.root,task.id,{conversationId:f.other.id,agentId:f.other.agentId,projectId:f.other.projectId||null,request:task.goal},'execution');
 f.store.database.prepare("INSERT INTO task_runs (id,task_id,execution_id,attempt,state,artifact_versions,created_at,routing) VALUES (?,?,?,1,'succeeded','[]',?,?)").run('task-run',task.id,execution.id,new Date().toISOString(),JSON.stringify({executionConversationId:f.other.id,destinationConversationId:f.chat.id,mode:'dedicated'}));
 const result=f.summary(f.chat.id);expect(result.tasks).toContainEqual({id:task.id,goal:'Dispatched work',state:'todo'});expect(result.documents).toContainEqual(expect.objectContaining({assetId:output.asset.id,versionId:output.version.id,relations:['output']}));
});
