import {createMessageReference} from '../server/composer-references';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
import { createMemoryRuntime } from '../server/memory-runtime';
import { createSessionManager } from '../server/sessions';
import type { CodexClient } from '../server/codex';
import { businessCliContext } from './business-cli-context';
import { fixtureMemoryEmbed } from './e2e/helpers/memory-embedding';

const root={userId:'local'},cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
async function setup(kind:'private'|'profile',reader:''|'a'|'b',forward=false){
 const home=mkdtempSync(join(tmpdir(),'memory-native-scope-')),store=openStore(home),config=(await readConfig(home)).config;
 config.agents=['a','b'].map(id=>({id,name:id,instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}));
 const projectId=kind==='profile'?'p':'';
 config.projects=projectId?[{id:projectId,name:'Project',agentIds:['a','b'],cwd:home,resources:[],mcp:[],skills:[]}]:[];
 const runtime=createMemoryRuntime({verifyOutput:false,schedule:false,home,store,loadConfig:async()=>config,generate:async()=>'[]',embed:fixtureMemoryEmbed});
 let manager:ReturnType<typeof createSessionManager>|undefined,token='';
 cleanups.push(async()=>{await manager?.close();await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});
 await runtime.initialize();await runtime.reading(root);
 const collection=runtime.memory.ensureCollection(root,{projectId:projectId||null,agentId:'a'}),sourceChat=store.createConversation({projectId,agentId:'a',cli:'codex',model:null});
 const text='Agent A deployment checklist is private.',event=store.appendEvent(sourceChat.id,'user',{text});store.appendEvent(sourceChat.id,'status',{status:'idle'});
 const source=runtime.memory.captureConversation(root,{collectionId:collection.id,conversationId:sourceChat.id,trigger:'explicit',kind:'request'}).sources[0];
 const proposal={collectionId:collection.id,layer:'L1' as const,pipeline:'request' as const,contentType:'fact' as const,text,operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted' as const};
 let record=runtime.memory.applyProposal(root,proposal,collection.generation,'evidence_extract')!;
 if(kind==='profile'){
  const scene=runtime.memory.applyProposal(root,{...proposal,layer:'L2',semanticKey:'scene.deployment',support:[],dependencies:[{recordId:record.recordId,revision:record.revision}]},collection.generation,'layer_summary')!;
  record=runtime.memory.applyProposal(root,{...proposal,layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine',support:[],dependencies:[{recordId:scene.recordId,revision:scene.revision}]},collection.generation,'layer_summary',{profileScope:{projectId,agentId:'a'}})!;
 }
 const factory=async():Promise<CodexClient>=>({getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async params=>{token=businessCliContext(params.instructions).token;return 'native';},resumeThread:async()=>{},startTurn:async()=>'turn',interrupt:async()=>{},replyApproval(){},close(){}});
 manager=createSessionManager(store,async()=>config,factory,undefined,home,undefined,undefined,runtime);
 const chat=await manager.create(projectId,reader,undefined,'codex');
 const selected=forward?await createMessageReference({home,store,manager,config,principal:root,conversationId:chat.id},{sourceConversationId:sourceChat.id,eventId:event.id,text:'deployment checklist'}):null;
 await manager.send(chat.id,'deployment',[],selected?[{id:selected.id}]:[]);
 const privateTask=manager.taskService.createTask(root,{goal:'Private task',assigneeAgentId:'a'},'private-task');
 return {runtime,manager,token,record,text,sourceChat,privateTask,store,home,config,chat,event,selected};
}
for(const kind of ['private','profile'] as const)for(const reader of ['','a','b'] as const)test(`${kind} known-ID native read uses the exact recipient slot (${reader||'agentless'})`,async()=>{
 const s=await setup(kind,reader),search=await s.manager.callBoundTool(s.token,'memory_search',{query:'deployment'},'search') as {items:{recordId:string}[]};
 expect(s.runtime.memory.read(root,s.record.recordId).text).toBe(s.text);
 if(reader==='a'){
  expect(search.items.map(r=>r.recordId)).toContain(s.record.recordId);
  await expect(s.manager.callBoundTool(s.token,'memory_read',{recordId:s.record.recordId},'read')).resolves.toMatchObject({recordId:s.record.recordId,text:s.text});
 }else{
  expect(search.items.map(r=>r.recordId)).not.toContain(s.record.recordId);
  await expect(s.manager.callBoundTool(s.token,'memory_read',{recordId:s.record.recordId},'read')).rejects.toMatchObject({status:403});
 }
});

test('explicit forwarded excerpt grants no subsequent private history, Task or Memory access',async()=>{
 const s=await setup('private','b',true);
 await expect(s.manager.callBoundTool(s.token,'conversation_history',{conversationId:s.sourceChat.id},'after-reference-history')).rejects.toMatchObject({status:403});
 await expect(s.manager.callBoundTool(s.token,'task_read',{taskId:s.privateTask.id},'after-reference-task')).rejects.toMatchObject({status:403});
 await expect(s.manager.callBoundTool(s.token,'memory_read',{recordId:s.record.recordId},'after-reference-memory')).rejects.toMatchObject({status:403});
 expect(s.manager.taskService.getTask(root,s.privateTask.id).participantAgentIds).toEqual([]);
});

for(const recipient of ['b',''] as const)test(`a forwarded selection refuses new private memory provenance for ${recipient||'agentless'} recipients`,async()=>{
 const s=await setup('private',recipient,true);
 s.store.appendEvent(s.sourceChat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:s.record.recordId,revision:s.record.revision}]});
 await expect(createMessageReference({home:s.home,store:s.store,manager:s.manager,config:s.config,principal:root,conversationId:s.chat.id},{sourceConversationId:s.sourceChat.id,eventId:s.event.id,text:'deployment checklist'})).rejects.toMatchObject({status:403});
});
