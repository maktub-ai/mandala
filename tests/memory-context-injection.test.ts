import {readConfiguredRuntime} from './configured-runtime';
import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';

import {createMemoryRuntime} from '../server/memory-runtime';
import {createSessionManager} from '../server/sessions';
import type {CodexClient,CodexOptions} from '../server/codex';
import {businessCliContext} from './business-cli-context';

const root={userId:'local'},cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-context-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config,queries:string[]=[];
 const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,verifyOutput:false,generate:async()=>'[]',embed:async texts=>{queries.push(...texts);return texts.map(()=>[1,0]);}});
 await runtime.initialize();
 const collection=runtime.memory.ensureCollection(root,{projectId:null,agentId:null});
 const add=(text:string)=>{
  const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null}),event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
  const source=runtime.memory.captureConversation(root,{collectionId:collection.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
  return runtime.memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted',pipeline:'request'},collection.generation,'evidence_extract')!;
 };
 const fact=add('Deployment uses the approved release checklist.');
 const scene=runtime.memory.applyProposal(root,{collectionId:collection.id,layer:'L2',contentType:'procedure',text:'Deployment scene: verify the release commit before installation.',semanticKey:'scene.release',operation:'store',replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed',pipeline:'request'},collection.generation,'layer_summary')!;
 const profile=runtime.memory.applyProposal(root,{collectionId:collection.id,layer:'L3',contentType:'procedure',text:'Stable working principle: check evidence before reporting completion.',semanticKey:'persona.operating-doctrine',operation:'store',replaces:[],evidence:fact.evidence,dependencies:[{recordId:scene.recordId,revision:scene.revision}],validUntil:null,certainty:'observed',pipeline:'request'},collection.generation,'layer_summary')!;
 let options!:CodexOptions,turn=0,token='',instructions='';
 const capture=(text='')=>{instructions=text;token=businessCliContext(text).token;};
 const factory=async(o:CodexOptions):Promise<CodexClient>=>{options=o;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{capture(p.instructions);return 'native';},resumeThread:async(_id,_mcp,text)=>{capture(text);},startTurn:async()=>`turn-${++turn}`,interrupt:async()=>{},replyApproval(){},close(){}};};
 const manager=createSessionManager(store,async()=>config,factory,undefined,home,undefined,undefined,runtime),chat=await manager.create('','',undefined,'codex');
 cleanups.push(async()=>{await manager.close();await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});
 return {runtime,store,config,manager,chat,queries,add,fact,scene,profile,get instructions(){return instructions;},get token(){return token;},finish(){options.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:`turn-${turn}`,status:'completed'}}});}};
}

test('a pure acknowledgment keeps stable principles without searching historical facts',async()=>{
 const s=await setup();await s.manager.send(s.chat.id,'谢谢！');
 expect(s.queries).toEqual([]);
 expect(s.instructions).toContain(s.profile.text);
 expect(s.instructions).not.toContain(s.fact.text);
});

test('continuing a conversation searches its recent topic instead of only the short follow-up',async()=>{
 const s=await setup();await s.runtime.refreshVectors();await s.manager.send(s.chat.id,'Review the deployment checklist');s.finish();s.queries.length=0;
 await s.manager.send(s.chat.id,'继续');
 expect(s.queries).toHaveLength(1);
 expect(s.queries.every(query=>query.includes('deployment checklist'))).toBe(true);
});

test('acknowledgment turns do not displace the last useful topic for a continuation',async()=>{
 const s=await setup();await s.runtime.refreshVectors();await s.manager.send(s.chat.id,'Review the deployment checklist');s.finish();
 for(let i=0;i<7;i++){await s.manager.send(s.chat.id,'收到');s.finish();}
 s.queries.length=0;await s.manager.send(s.chat.id,'继续');
 expect(s.queries).toHaveLength(1);
 expect(s.queries.every(query=>query.includes('deployment checklist'))).toBe(true);
});

test('automatic memory context keeps the best scene with many facts inside one serialized budget',async()=>{
 const s=await setup();for(let i=0;i<8;i++)s.add(`Deployment fact ${i}: ${'中文说明'.repeat(180)}`);
 await s.manager.send(s.chat.id,'Deployment');
 expect(s.instructions).toContain(s.scene.text);
 const context=s.instructions.match(/<memory_context>\n([\s\S]*?)\n<\/memory_context>/)?.[0];
 expect(context).toBeDefined();expect(Buffer.byteLength(context!,'utf8')).toBeLessThanOrEqual(6000);
 const data=JSON.parse(context!.split('\n').slice(1,-1).join('\n'));
 expect(data.items.length).toBeLessThanOrEqual(8);
 expect(data.items.some((item:{recordId:string})=>item.recordId===s.profile.recordId)).toBe(true);
 const event=s.store.listEvents(s.chat.id,0).filter(e=>e.kind==='metadata'&&(e.data as {memoryUse?:string}).memoryUse==='acknowledged').at(-1);
 expect((event!.data as {items:{recordId:string}[]}).items.map(i=>i.recordId).sort()).toEqual(data.items.map((i:{recordId:string})=>i.recordId).sort());
});

test('Agent search returns an excerpt and read supplies the full record and supporting quote',async()=>{
 const s=await setup(),text='Deployment detail '+ 'long supporting explanation '.repeat(200),record=s.add(text);
 await s.manager.send(s.chat.id,'Deployment');
 const result=await s.manager.callBoundTool(s.token,'memory_search',{query:record.recordId},'find') as {items:{recordId:string;excerpt:string;truncated:boolean;text?:string}[]};
 const hit=result.items.find(item=>item.recordId===record.recordId)!;
 expect(hit).toBeDefined();expect(hit.text).toBeUndefined();expect(hit.excerpt.length).toBeLessThan(text.length);expect(hit.truncated).toBe(true);
 await expect(s.manager.callBoundTool(s.token,'memory_read',{recordId:record.recordId},'read')).resolves.toMatchObject({recordId:record.recordId,text,support:[expect.objectContaining({quote:text})]});
});

test('a derived scene can be read through its dependency to the supporting fact',async()=>{
 const s=await setup();await s.manager.send(s.chat.id,'Deployment');
 const scene=await s.manager.callBoundTool(s.token,'memory_read',{recordId:s.scene.recordId},'scene') as {dependencies:{recordId:string;revision:number}[]};
 expect(scene.dependencies).toEqual([{recordId:s.fact.recordId,revision:s.fact.revision}]);
 await expect(s.manager.callBoundTool(s.token,'memory_read',{recordId:scene.dependencies[0].recordId},'fact')).resolves.toMatchObject({revision:s.fact.revision,text:s.fact.text,support:[expect.objectContaining({quote:s.fact.text})]});
});

test('long corrections and invalidation notices share the context budget without exposing full corrected text',async()=>{
 const s=await setup();await s.manager.send(s.chat.id,'Deployment');s.finish();
 const text='更正后的部署规程。'.repeat(500);
 s.runtime.memory.correct(root,{recordId:s.fact.recordId,expectedRevision:s.fact.revision,text});
 await s.manager.send(s.chat.id,'继续');
 expect(s.instructions).toContain('memory_changed');expect(s.instructions).toContain('corrected');expect(s.instructions).toContain('stale');
 expect(s.instructions).not.toContain(text);
 const context=s.instructions.match(/<memory_context>\n([\s\S]*?)\n<\/memory_context>/)?.[0];
 expect(Buffer.byteLength(context!,'utf8')).toBeLessThanOrEqual(6000);
 s.finish();s.config.system={cli:'codex',memory:{request:{read:false}}};
 await s.manager.send(s.chat.id,'继续');
 expect(s.instructions).toContain('memory_changed');expect(s.instructions).not.toContain('更正后的部署规程');
});
