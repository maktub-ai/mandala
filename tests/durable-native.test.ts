import {createHttpServer} from '../server/http';
import {businessCliContext} from './business-cli-context';
import {spawn} from 'node:child_process';
import { afterEach, test, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { KNOWLEDGE_CUTOVER } from '../server/knowledge';
import { createTasks } from '../server/tasks';
import { createSessionManager } from '../server/sessions';
import { createSystemTasks } from '../server/system-tasks';
import type { Config } from '../shared/types';
import type { CodexClient, CodexOptions } from '../server/codex';
const config:Config={version:2,projects:[{id:'p',name:'P',cwd:'/tmp',agentIds:['a','b'],resources:[],mcp:[],skills:[]}],agents:['a','b'].map(id=>({id,name:id,instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}))};
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0))await f();});
const tick=()=>new Promise(r=>setTimeout(r,15));
function setup(options: {beforeThread?:()=>Promise<void>;beforeTurn?:()=>Promise<void>;ignoreInterrupt?:boolean;loadConfig?:(store:ReturnType<typeof openStore>)=>Promise<Config>;onMessage?:(id:string)=>void} = {}){
 const home=mkdtempSync(join(tmpdir(),'mana-durable-native-')),store=openStore(home);
 const clients:{options:CodexOptions;session:string;texts:string[];turn:number;token?:string;instructions?:string}[]=[];
 const beforeThread=options.beforeThread,optionsBeforeTurn=options.beforeTurn,ignoreInterrupt=options.ignoreInterrupt;
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{
  const c={options,session:`s${clients.length}`,texts:[] as string[],turn:0,token:'',instructions:''};clients.push(c);
  return {getStatus:async()=>({status:'ready',version:'fake'}),listModels:async()=>[],startThread:async p=>{c.instructions=p.instructions;c.token=businessCliContext(p.instructions).token;expect(p.mcp?.some(m=>m.name==='openmana_tasks')).toBe(false);await beforeThread?.();return c.session;},resumeThread:async(_id,mcp,instructions)=>{c.session=_id;c.instructions=instructions??'';c.token=businessCliContext(instructions).token;expect(mcp?.some(m=>m.name==='openmana_tasks')).toBe(false);},startTurn:async(_,text)=>{c.texts.push(text);c.turn++;await optionsBeforeTurn?.();return `t${c.turn}`;},interrupt:async()=>{if(!ignoreInterrupt)terminal(c,'interrupted');},replyApproval(){},close(){}};
 };
 const manager=createSessionManager(store,()=>options.loadConfig?.(store)??Promise.resolve(structuredClone(config)),factory,undefined,home,undefined,options.onMessage);
 cleanup.push(async()=>{await manager.close();store.close();rmSync(home,{recursive:true,force:true});});
 return {home,store,manager,clients};
}
function terminal(c:{options:CodexOptions;session:string;turn:number},status='completed',text='Verified output'){
 c.options.onEvent({method:'item/completed',params:{threadId:c.session,turnId:`t${c.turn}`,item:{id:'reply',type:'agentMessage',phase:'final_answer',text}}});
 c.options.onEvent({method:'turn/completed',params:{threadId:c.session,turn:{id:`t${c.turn}`,status}}});
}
test('generates a delegated execution title while its native task is still running',async()=>{
 const titleConfig:Config={...structuredClone(config),system:{cli:'codex',automaticTitles:true}};
 const loadConfig=async()=>titleConfig;
 const f=setup({loadConfig,onMessage:id=>{void titles.onMessage(id);}});
 const titles=createSystemTasks({store:f.store,home:f.home,loadConfig,generate:async(_config,prompt)=>JSON.parse(prompt.split('SOURCE_JSON:\n')[1]).user.includes('12条')?'剩余计费模型映射复核':'计费模型映射梳理'});
 cleanup.unshift(()=>titles.close());
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'检查计费模型映射');
 const task=await f.manager.createTask(source.id,'b','用户转发同事反馈：模型映射已审核一轮，还剩12条，请只读复核。',undefined,{policy:'notify'});
 await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 await vi.waitFor(()=>expect(f.store.getConversation(task.targetConversationId)).toMatchObject({title:'剩余计费模型映射复核',titleSource:'automatic',status:'running'}));
 expect(f.manager.taskService.listRunControls({userId:'local'},task.id).at(-1)?.state).toBe('running');
});
test('delegate commits canonical Run immediately, dedicated chat, notify receipt and no legacy writes',async()=>{
 const {manager,store,clients}=setup();const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Original user goal');
 const task=await manager.createTask(source.id,'b','Child work',undefined,{policy:'notify'});
 expect(task.status).toBe('queued');
 expect(store.database.prepare('SELECT state FROM task_runs WHERE task_id=?').get(task.id)).toMatchObject({state:'queued'});
 expect(store.listTasks()).toEqual([]);
 await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));
 const run=store.database.prepare('SELECT * FROM task_runs WHERE task_id=?').get(task.id)!;
 expect(run).toMatchObject({state:'running',native_session_id:'s1',native_turn_id:'t1'});
 terminal(clients[1]);terminal(clients[1]);await tick();
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM task_receipts WHERE task_id=?').get(task.id)!.n).toBe(1);
 expect(manager.listTasks().find(t=>t.id===task.id)).toMatchObject({status:'completed',result:'Verified output'});
 terminal(clients[0]);await tick();expect(clients[0].texts).toEqual(['Original user goal']);
});
test('busy source accepts persisted cancellable inputs without steer; user input precedes explicit resume',async()=>{
 const {manager,store,clients}=setup();const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Actual user goal');
 await manager.createTask(source.id,'b','Child work',undefined,{policy:'resume',commandKey:'child-1'});
 const queued=manager.enqueueUserInput(source.id,'Unrelated new request','input-1');
 const cancelled=manager.enqueueUserInput(source.id,'Cancel me','input-2');manager.cancelUserInput(cancelled.id);
 expect(manager.listUserInputs(source.id)).toMatchObject([{id:queued.id,state:'queued'},{id:cancelled.id,state:'cancelled'}]);
 await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));terminal(clients[1]);terminal(clients[0]);await vi.waitFor(()=>expect(clients[0].texts).toHaveLength(2));
 expect(clients[0].texts[1]).toBe('Unrelated new request');
 expect(store.database.prepare('SELECT delivery_state FROM task_receipts LIMIT 1').get()!.delivery_state).not.toBe('consumed');
 terminal(clients[0]);await vi.waitFor(()=>expect(clients[0].texts).toHaveLength(3));expect(clients[0].texts[2]).toContain('Actual user goal');expect(clients[0].texts[2]).toContain('Verified output');
 terminal(clients[0]);await tick();expect(store.database.prepare("SELECT COUNT(*) AS n FROM task_receipts WHERE policy='resume' AND delivery_state='consumed'").get()!.n).toBe(1);
});
test('stopping the origin chat revokes automatic continuation while its execution can still finish truthfully',async()=>{
 const f=setup(),p={userId:'local'},source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'Original request');
 const delegated=await f.manager.createTask(source.id,'b','Independent delivery',undefined,{policy:'resume',commandKey:'stop-origin'});await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 const run=f.manager.taskService.listRunControls(p,delegated.id).find(item=>item.routing?.executionConversationId===delegated.targetConversationId)!;
 await f.manager.stop(source.id);expect(f.manager.taskService.getRunControl(p,run.id).state).toBe('running');expect(f.manager.taskService.getTask(p,delegated.id)).toMatchObject({futureAutoResume:false,continuationEpoch:1});
 terminal(f.clients[1]);await tick();expect(f.manager.taskService.getRun(p,run.id)).toMatchObject({state:'succeeded',summary:'Verified output'});expect(f.manager.taskService.listReceipts(p,delegated.id)).toMatchObject([{executionId:run.executionId,destinationConversationId:source.id,deliveryState:'parked'}]);expect(f.clients[0].texts).toEqual(['Original request']);expect(f.manager.listUserInputs(source.id).some(item=>item.state==='queued'||item.state==='running')).toBe(false);
});
test('old queued JSON is migrated as history and is never dispatched',async()=>{
 const {manager,store,clients}=setup();const source=await manager.create('p','a',undefined,undefined,{workspaceId:null}),target=await manager.create('p','b');
 store.createTask({projectId:'p',sourceConversationId:source.id,targetConversationId:target.id,kind:'dispatch',request:'historic'});
 manager.close();const restarted=createSessionManager(store,async()=>config,async()=>{throw Error('must not dispatch');},undefined,'');
 await tick();expect(clients).toHaveLength(0);expect(store.listTasks()[0].status).toBe('queued');restarted.close();
});

async function document(f:ReturnType<typeof setup>,access:{mode:'owner'|'all'|'selected';agentIds?:string[];projectIds?:string[]}={mode:'all'},ownerAgentId='a'){
 const files=createAssetFiles(f.home),assets=createAssets(f.store,files);const root={userId:'local'};
 f.store.database.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(KNOWLEDGE_CUTOVER,new Date().toISOString());
 writeFileSync(join(f.home,'reference.txt'),'reference version one');
 const a=assets.createAsset(root,{kind:'document',title:'reference',owner:{userId:'local',agentId:ownerAgentId}});
 const staged=await files.stageFiles(root,null,[{allowedRoot:f.home,relativePath:'reference.txt',manifestPath:'reference.txt'}]);
 const v=assets.publishAssetVersion(root,{assetId:a.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{sourceVersions:[]}},'doc');
 assets.setAccess(root,a.id,access,2);assets.bind(root,{ownerType:'project',ownerId:'p',assetId:a.id,versionPolicy:'pinned',versionId:v.id});
 return{assets,files,a,v,root};
}
test('fixed context stays on accepted version and ACL is checked again after native preparation',async()=>{
 let blocked=false,release!:()=>void,entered=false;
 const f=setup({beforeThread:async()=>{if(blocked){entered=true;await new Promise<void>(r=>{release=r;});}}});const d=await document(f);
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'reference');
 blocked=true;const task=await f.manager.createTask(source.id,'b','reference child',undefined,{policy:'notify'});await vi.waitFor(()=>expect(entered).toBe(true));
 const run=f.store.database.prepare('SELECT * FROM task_runs WHERE task_id=?').get(task.id)!;
 const snapshot=f.store.database.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id as string)!;
 expect(snapshot.input).toContain('reference version one');expect(JSON.parse(snapshot.source_versions as string)).toMatchObject([{versionId:d.v.id}]);
 const a=d.assets.getAuthorizedAsset(d.root,d.a.id);d.assets.setAccess(d.root,a.id,{mode:'owner'},a.revision);
 release();await vi.waitFor(()=>expect(f.store.database.prepare('SELECT state FROM task_runs WHERE task_id=?').get(task.id)!.state).toBe('unknown'));expect(f.clients[1].texts).toEqual([]);
 const failed=f.store.database.prepare('SELECT * FROM task_runs WHERE task_id=?').get(task.id)!;expect(failed.native_session_id).toBeNull();expect(failed.native_turn_id).toBeNull();expect(failed.state).toBe('unknown');
});
test('known private source remains bound after deselection; model cannot omit it to delegate',async()=>{
 const f=setup(),d=await document(f,{mode:'owner'});const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'reference');terminal(f.clients[0]);
 f.store.database.prepare('DELETE FROM asset_bindings WHERE asset_id=?').run(d.a.id);
 await f.manager.send(source.id,'unrelated');
 await expect(f.manager.createTask(source.id,'b','Use remembered content',undefined,{policy:'notify'})).rejects.toMatchObject({status:403});
 expect(f.clients).toHaveLength(1);
});
test('bound tool ignores no identity overrides, expires with turn and stable delegation command deduplicates',async()=>{
 const f=setup();const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'goal');const token=f.clients[0].token!;
 const args={targetAgentId:'b',request:'child'};
 const one=await f.manager.callBoundTool(token,'delegate',args,'fixed-id') as {id:string};
 const two=await f.manager.callBoundTool(token,'delegate',args,'fixed-id') as {id:string};expect(two.id).toBe(one.id);
 await expect(f.manager.callBoundTool(token,'delegate',{...args,executionId:'fake'},'spoof')).rejects.toThrow();
 terminal(f.clients[0]);await expect(f.manager.callBoundTool(token,'delegate',args,'late')).rejects.toMatchObject({status:403});
});
test('queued child holds a twenty-second terminal while caller can submit new input immediately',async()=>{
 const f=setup();const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'goal');
 const start=performance.now();const task=await f.manager.createTask(source.id,'b','twenty-second child',undefined,{policy:'notify'});const acceptanceMs=performance.now()-start;
 expect(task.status).toBe('queued');expect(acceptanceMs).toBeLessThan(1000);
 const queued=f.manager.enqueueUserInput(source.id,'next user input','new-input');expect(queued.state).toBe('queued');
 await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 try {
  setTimeout(()=>terminal(f.clients[1]),20000);
  await vi.advanceTimersByTimeAsync(19999);expect(f.manager.listTasks().find(t=>t.id===task.id)!.status).toBe('running');
  await vi.advanceTimersByTimeAsync(1);expect(f.manager.listTasks().find(t=>t.id===task.id)!.status).toBe('completed');
  console.log(JSON.stringify({durableAcceptanceMs:acceptanceMs,heldTerminalMs:20000,cliStartupIncluded:false}));
 } finally {vi.useRealTimers();}
});
test('simultaneous replay of one bound delegate command produces one Task, Run and dedicated conversation',async()=>{
 const f=setup();const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'goal');const token=f.clients[0].token!;
 const args={targetAgentId:'b',request:'child'};
 const results=await Promise.all([f.manager.callBoundTool(token,'delegate',args,'same'),f.manager.callBoundTool(token,'delegate',args,'same')]) as {id:string}[];
 expect(results[0].id).toBe(results[1].id);expect(f.store.listConversations()).toHaveLength(2);
 expect(f.store.database.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n).toBe(1);
});
test('queued existing destination injects its accepted fixed version after latest head changes',async()=>{
 const f=setup(),d=await document(f);const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null}),target=await f.manager.create('p','b');
 await f.manager.send(target.id,'hold');
 const task=await f.manager.createTask(source.id,'b','reference child',target.id,{policy:'notify'});
 expect(task.status).toBe('queued');expect(f.clients[0].texts).toEqual(['hold']);
 writeFileSync(join(f.home,'reference.txt'),'reference version TWO');const stage=await d.files.stageFiles(d.root,null,[{allowedRoot:f.home,relativePath:'reference.txt',manifestPath:'reference.txt'}]);
 d.assets.publishAssetVersion(d.root,{assetId:d.a.id,expectedHeadVersionId:d.v.id,submissionId:stage.submissionId,files:stage.files,provenance:{sourceVersions:[]}},'changed');
 terminal(f.clients[0]);await vi.waitFor(()=>expect(f.clients[0].texts).toHaveLength(2));
 expect(f.clients[0].texts[1]).toContain('reference version one');expect(f.clients[0].texts[1]).not.toContain('version TWO');
 const actual=f.store.listEvents(target.id,0).filter(e=>(e.data as any).actualUse==='acknowledged').at(-1)!.data as any;
 expect(actual.sourceVersions).toContainEqual(expect.objectContaining({versionId:d.v.id}));expect(actual.nativeVisibility).toBe('partial');
});

test('invocation CLI delegate uses bound HTTP identity and stable command keys',async()=>{
 const f=setup(),source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'goal');
 const server=createHttpServer({requireIdentity:false,home:f.home,store:f.store,manager:f.manager});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const context=businessCliContext(f.clients[0].instructions);
 writeFileSync(context.contextFile,JSON.stringify({baseUrl:base,token:context.token}));
 const invoke=async()=>{
  const child=spawn(context.launcher,['tasks','delegate','--data',JSON.stringify({targetAgentId:'b',request:'child'}),'--key','delegate-17'],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  expect(stderr).toBe('');expect(code).toBe(0);const result=JSON.parse(stdout);expect(result).toMatchObject({ok:true,command:'tasks delegate',commandKey:'delegate-17'});return result.data;
 };
 try {
  const results=[await invoke(),await invoke()];expect(results[0].id).toBe(results[1].id);expect(results[0]).toMatchObject({status:'queued',targetConversationId:expect.any(String)});
  expect(f.store.listConversations()).toHaveLength(2);
  const ordinary=await (await fetch(base+'/api/conversations')).json();expect(ordinary.map((c:any)=>c.id)).toEqual([source.id]);
  expect((await fetch(base+'/api/conversations/'+results[0].targetConversationId)).status).toBe(200);
  const task=f.manager.taskService.getTask({userId:'local'},results[0].id);expect(task).toMatchObject({creatorAgentId:null,creationSource:'system',originConversationId:source.id});expect(task.executions).toMatchObject([{agentId:'b',createdByAgentId:'a',conversationId:results[0].targetConversationId}]);
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('bound native Run publishes explicit outputs and terminal records only published delivery versions',async()=>{
 const f=setup(),source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});const task=await f.manager.createTask(source.id,'b','Create a file',undefined,{policy:'notify'});
 await vi.waitFor(()=>expect(f.clients[0]?.texts).toHaveLength(1));
 const run=f.store.database.prepare('SELECT id FROM task_runs WHERE task_id=?').get(task.id)!;
 // Host fixture supplies the file; this does not verify a real CLI sandbox can write this root.
 writeFileSync(join(f.home,'outputs',run.id as string,'result.txt'),'Bound output');
 const published=await f.manager.callBoundTool(f.clients[0].token!,'artifact_publish',{title:'Result',files:[{path:'result.txt'}]},'publish') as any;
 expect(published.version.provenance).toEqual({runId:run.id,sourceVersions:[]});
 expect(await f.manager.callBoundTool(f.clients[0].token!,'artifact_read',{assetId:published.asset.id,versionId:published.version.id,fileId:'0'},'read')).toMatchObject({text:'Bound output'});
 terminal(f.clients[0]);
 const receipt=f.store.database.prepare('SELECT artifact_versions FROM task_receipts WHERE task_id=?').get(task.id)!;
 expect(JSON.parse(receipt.artifact_versions as string)).toEqual([{assetId:published.asset.id,versionId:published.version.id}]);
});

test('F1 bound HTTP delegation acknowledgement and private terminal replay expose control fields only',async()=>{
 const f=setup(),source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'Delegate a task');
 const d=await document(f,{mode:'owner'},'b');
 const server=createHttpServer({requireIdentity:false,home:f.home,store:f.store,manager:f.manager});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const request={token:f.clients[0].token,name:'delegate',args:{targetAgentId:'b',request:'reference child'},commandKey:'private-replay'};
 const call=async()=>{const response=await fetch(base+'/api/task-tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});expect(response.status).toBe(200);return response.json();};
 try {
  const first=await call();await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
  const run=f.store.database.prepare('SELECT id FROM task_runs WHERE task_id=?').get(first.id)!;
  writeFileSync(join(f.home,'outputs',run.id as string,'private.txt'),'CHILD_ONLY_OUTPUT_SECRET');
  const published=await f.manager.callBoundTool(f.clients[1].token!,'artifact_publish',{title:'Private output',files:[{path:'private.txt'}]},'private-output') as any;
  terminal(f.clients[1],'completed','CHILD_ONLY_SYNTHETIC_SECRET');
  expect(()=>createTasks(f.store,{assets:d.assets}).getRun({userId:'local',agentId:'a'},run.id as string)).toThrow(expect.objectContaining({status:403}));
  expect(()=>d.assets.getAuthorizedVersion({userId:'local',agentId:'a'},{assetId:published.asset.id,versionId:published.version.id})).toThrow(expect.objectContaining({status:403}));
  const replay=await call();
  expect(replay).toEqual({id:first.id,targetConversationId:first.targetConversationId,status:'completed'});
  expect(first).toEqual({id:first.id,targetConversationId:first.targetConversationId,status:'queued'});
  expect(JSON.stringify(replay)).not.toContain('CHILD_ONLY');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('F2 forced stop retains physical directory occupancy while explicit continuation stays queued',async()=>{
 const f=setup({ignoreInterrupt:true}),source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});
 const first=f.manager.enqueueUserInput(source.id,'first','first');await vi.waitFor(()=>expect(f.clients[0]?.texts).toHaveLength(1));
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 try{const stopping=f.manager.stop(source.id);await vi.advanceTimersByTimeAsync(3000);await stopping;}finally{vi.useRealTimers();}
 await f.manager.continue(source.id,'explicit continuation');
 terminal(f.clients[0]); // Retired callback is not proof about a current physical invocation.
 expect(f.store.getConversation(source.id)?.status).toBe('interrupted');
 expect(f.clients).toHaveLength(1);
 expect(f.manager.listUserInputs(source.id)).toMatchObject([{id:first.id,state:'completed'},{text:'explicit continuation',state:'queued'}]);
 expect(f.store.database.prepare('SELECT submitted FROM task_directory_claims').all()).toEqual([{submitted:1}]);
});
test('F3 additional private native history parks accepted child before injection without changing its snapshot',async()=>{
 let projectCwd='';
 const f=setup({loadConfig:async()=>{const next=structuredClone(config);next.projects[0].cwd=projectCwd;return next;}});
 projectCwd=join(f.home,'project');mkdirSync(projectCwd);
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null}),target=await f.manager.create('p','b');
 await f.manager.send(source.id,'Actual original goal');await f.manager.send(target.id,'hold');
 const child=await f.manager.createTask(source.id,'b','child work',target.id,{policy:'resume'});
 const run=f.store.database.prepare('SELECT id FROM task_runs WHERE task_id=?').get(child.id)!;
 const snapshot=f.store.database.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id as string)!;
 expect(JSON.parse(snapshot.source_versions as string)).toEqual([]);
 const d=await document(f,{mode:'owner'},'b');
 expect(()=>d.assets.getAuthorizedVersion({userId:'local',agentId:'a'},{assetId:d.a.id,versionId:d.v.id})).toThrow(expect.objectContaining({status:403}));
 f.manager.enqueueUserInput(target.id,'reference user input','priority');terminal(f.clients[1]);
 await vi.waitFor(()=>expect(f.clients[1].texts).toEqual(['hold','reference user input']));
 terminal(f.clients[1],'completed','Private user input completed');
 await vi.waitFor(()=>expect(f.store.database.prepare('SELECT state FROM task_runs WHERE id=?').get(run.id as string)!.state).toBe('interrupted'));
 expect(f.clients[1].texts).toEqual(['hold','reference user input']);
 expect(f.store.database.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id as string)).toEqual(snapshot);
 const receipt=f.store.database.prepare('SELECT * FROM task_receipts WHERE source_run_id=?').get(run.id as string)!;
 expect(receipt).toMatchObject({delivery_state:'parked',claim_error:'native_history_changed',claimed_by_run_id:null});
 expect(f.store.database.prepare('SELECT native_session_id,native_turn_id FROM task_runs WHERE id=?').get(run.id as string)).toMatchObject({native_session_id:null,native_turn_id:null});
 terminal(f.clients[1],'completed','LATER_CHILD_ONLY_SECRET');terminal(f.clients[0]);await tick();
 expect(f.clients[0].texts).toEqual(['Actual original goal']);expect(f.clients[1].texts).not.toContain('child work');
 expect(f.store.database.prepare('SELECT COUNT(*) AS n FROM task_receipts WHERE source_run_id=?').get(run.id as string)!.n).toBe(1);
});
test('F3 history drift during asynchronous native preparation leaves an unsubmitted interrupted Run',async()=>{
 let blocked=false,entered=false,release!:()=>void;
 const f=setup({beforeThread:async()=>{if(blocked){entered=true;await new Promise<void>(r=>{release=r;});}}});
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'Actual goal');blocked=true;
 const child=await f.manager.createTask(source.id,'b','child',undefined,{policy:'resume'});
 await vi.waitFor(()=>expect(entered).toBe(true));
 const run=f.store.database.prepare('SELECT * FROM task_runs WHERE task_id=?').get(child.id)!;
 const snapshot=f.store.database.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id as string)!;
 const d=await document(f,{mode:'owner'},'b');
 // Controlled preparation race: another confirmed platform source becomes known before startTurn.
 f.store.appendEvent(child.targetConversationId,'metadata',{memoryRecall:'confirmed-race',status:'completed',entries:[{assetId:d.a.id,versionId:d.v.id}]});
 release();await vi.waitFor(()=>expect(f.store.database.prepare('SELECT state FROM task_runs WHERE id=?').get(run.id as string)!.state).toBe('interrupted'));
 expect(f.clients[1].texts).toEqual([]);expect(f.store.getConversation(child.targetConversationId)?.status).toBe('idle');
 expect(f.store.database.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id as string)).toEqual(snapshot);
 expect(f.store.database.prepare('SELECT native_session_id,native_turn_id,summary FROM task_runs WHERE id=?').get(run.id as string)).toMatchObject({native_session_id:null,native_turn_id:null,summary:'Native session context changed; explicit re-preparation is required'});
 expect(f.store.database.prepare('SELECT state,waiting_reason FROM work_tasks WHERE id=?').get(child.id)).toMatchObject({state:'waiting',waiting_reason:'interrupted'});
 expect(f.store.listEvents(child.targetConversationId,0).some(event=>event.kind==='metadata' && (event.data as any).reason==='native_history_changed' && (event.data as any).nativeTurnSubmitted===false && (event.data as any).requiresPreparation===true)).toBe(true);
 terminal(f.clients[0]);await tick();expect(f.clients[0].texts).toEqual(['Actual goal']);
});

test.each(['old','missing'] as const)('same-session %s item turn identity cannot certify the next Run delivery',async identity=>{
 const f=setup(),source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null}),target=await f.manager.create('p','b');
 const first=await f.manager.createTask(source.id,'b','first',target.id,{policy:'notify'});await vi.waitFor(()=>expect(f.clients[0]?.texts).toHaveLength(1));terminal(f.clients[0]);await tick();
 const next=await f.manager.createTask(source.id,'b','next',target.id,{policy:'notify'});await vi.waitFor(()=>expect(f.clients[0].texts).toHaveLength(2));
 const client=f.clients[0];client.options.onEvent({method:'item/completed',params:{threadId:client.session,...(identity==='old'?{turnId:'t1'}:{}),item:{id:'old-proof',type:'agentMessage',phase:'final_answer',text:'Old output must not complete next task'}}});
 client.options.onEvent({method:'turn/completed',params:{threadId:client.session,turn:{id:'t2',status:'completed'}}});
 expect(f.manager.taskService.getTask({userId:'local'},next.id)).toMatchObject({state:'waiting',waitingReason:'delivery_missing'});
 expect(next.id).toBe(first.id);expect(f.manager.taskService.listRuns({userId:'local'},first.id)).toMatchObject([{state:'succeeded',summary:'Verified output'},{state:'succeeded',summary:''}]);
});

test('an unrelated successful command cannot certify immutable artifact checks',async()=>{
 const f=setup(),root={userId:'local'};
 const task=f.manager.taskService.createTask(root,{goal:'produce checked output',criteria:[{id:'verify',text:'Run exact verification',checkRef:'command:printf verified'}],acceptance:'checks',projectId:'p',assigneeAgentId:'b'},'checked');
 const run=await f.manager.startDurableTask(task.id,task.revision,'checked-start');await vi.waitFor(()=>expect(f.clients[0]?.texts).toHaveLength(1));
 writeFileSync(join(f.home,'outputs',run.id,'result.txt'),'immutable actual output');
 const publication=await f.manager.callBoundTool(f.clients[0].token!,'artifact_publish',{title:'Checked output',files:[{path:'result.txt'}]},'checked-output') as {asset:{id:string};version:{id:string}};
 f.clients[0].options.onEvent({method:'item/completed',params:{threadId:f.clients[0].session,turnId:'t1',item:{id:'check-item',type:'commandExecution',command:'printf verified',status:'completed',exitCode:0}}});
 terminal(f.clients[0]);
 expect(f.manager.taskService.getTask(root,task.id)).toMatchObject({state:'review',completion:null});
 expect(f.manager.taskService.getRun(root,run.id)).toMatchObject({completion:null,artifactVersions:[{assetId:publication.asset.id,versionId:publication.version.id}]});
});

test('new user conversations sharing an Agent and directory start independently and retain their own queues',async()=>{
 const f=setup(),first=await f.manager.create('p','a'),second=await f.manager.create('p','a');
 await f.manager.send(first.id,'First conversation');
 await f.manager.send(second.id,'New conversation');
 expect(f.clients.map(c=>c.texts)).toEqual([['First conversation'],['New conversation']]);
 expect(f.store.getConversation(first.id)?.status).toBe('running');
 expect(f.store.getConversation(second.id)?.status).toBe('running');
 expect(f.manager.listUserInputs(second.id)).toEqual([]);
 const next=f.manager.enqueueUserInput(second.id,'Next message','next-message');
 await tick();expect(f.manager.listUserInputs(second.id)).toMatchObject([{id:next.id,state:'queued'}]);
 terminal(f.clients[1]);await vi.waitFor(()=>expect(f.clients[1].texts).toEqual(['New conversation','Next message']));
 expect(f.clients[0].texts).toEqual(['First conversation']);
 expect(f.store.getConversation(first.id)?.status).toBe('running');
});

test('ordinary source chat holds its real directory until native terminal while dedicated Task stays queued',async()=>{
 const f=setup(),source=await f.manager.create('p','a');await f.manager.send(source.id,'source edits selected directory');
 const task=await f.manager.createTask(source.id,'b','same directory child',undefined,{policy:'notify'});
 await vi.waitFor(()=>expect(f.manager.taskService.listRunControls({userId:'local'},task.id)[0]).toMatchObject({waitingForDirectory:true}));
 expect(f.store.database.prepare('SELECT state FROM task_runs WHERE task_id=?').get(task.id)).toMatchObject({state:'queued'});
 expect(f.clients).toHaveLength(1);
 expect(f.manager.taskService.listRunControls({userId:'local'},task.id)[0]).toMatchObject({waitingForDirectory:true});
 terminal(f.clients[0]);await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 expect(f.manager.taskService.listRunControls({userId:'local'},task.id)[0].state).toBe('running');
});

test('explicit Project pinned file binding becomes immutable second Task input for bound artifact_read',async()=>{
 const f=setup(),user={userId:'local'},files=createAssetFiles(f.home),assets=createAssets(f.store,files);
 writeFileSync(join(f.home,'result.txt'),'fixed produced bytes');
 const staged=await files.stageFiles(user,null,[{allowedRoot:f.home,relativePath:'result.txt',manifestPath:'result.txt'}]);
 const published=assets.importAsset(user,{kind:'file',title:'Result',submissionId:staged.submissionId},'result');
 assets.setAccess(user,published.asset.id,{mode:'selected',agentIds:['a','b']},published.asset.revision);
 assets.bind(user,{ownerType:'project',ownerId:'p',assetId:published.asset.id,versionPolicy:'pinned',versionId:published.version.id});
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'original');terminal(f.clients[0]);
 const second=await f.manager.createTask(source.id,'b','Read the selected fixed output',undefined,{policy:'notify'});
 await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 const run=f.manager.taskService.listRuns(user,second.id)[0];
 expect(f.manager.taskService.getContextSnapshot(user,run.id)?.sourceVersions).toContainEqual(expect.objectContaining({assetId:published.asset.id,versionId:published.version.id}));
 expect(await f.manager.callBoundTool(f.clients[1].token!,'artifact_read',{assetId:published.asset.id,versionId:published.version.id,fileId:'0'},'read')).toMatchObject({text:'fixed produced bytes'});
});

test('Project follow-latest overrides Agent pin and accepted file snapshot never follows a later head',async()=>{
 const f=setup(),user={userId:'local'},files=createAssetFiles(f.home),assets=createAssets(f.store,files);
 const stage=async(text:string)=>{writeFileSync(join(f.home,'selected.txt'),text);return files.stageFiles(user,null,[{allowedRoot:f.home,relativePath:'selected.txt',manifestPath:'selected.txt'}]);};
 const first=assets.importAsset(user,{kind:'file',title:'Selected',submissionId:(await stage('v1')).submissionId},'first');
 assets.setAccess(user,first.asset.id,{mode:'selected',agentIds:['a','b']},first.asset.revision);
 const next=await stage('v2'),second=assets.publishAssetVersion(user,{assetId:first.asset.id,expectedHeadVersionId:first.version.id,submissionId:next.submissionId,files:next.files,provenance:{sourceVersions:[]}},'second');
 assets.bind(user,{ownerType:'agent',ownerId:'b',assetId:first.asset.id,versionPolicy:'pinned',versionId:first.version.id});
 assets.bind(user,{ownerType:'project',ownerId:'p',assetId:first.asset.id,versionPolicy:'latest'});
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'original');terminal(f.clients[0]);
 const task=await f.manager.createTask(source.id,'b','Read selected file',undefined,{policy:'notify'});await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 const run=f.manager.taskService.listRuns(user,task.id)[0],snapshot=f.manager.taskService.getContextSnapshot(user,run.id)!;
 expect(snapshot.sourceVersions.map(({assetId,versionId})=>({assetId,versionId}))).toEqual([{assetId:first.asset.id,versionId:second.id}]);
 const last=await stage('v3');assets.publishAssetVersion(user,{assetId:first.asset.id,expectedHeadVersionId:second.id,submissionId:last.submissionId,files:last.files,provenance:{sourceVersions:[]}},'third');
 expect(await f.manager.callBoundTool(f.clients[1].token!,'artifact_read',{assetId:first.asset.id,versionId:second.id,fileId:'0'},'read')).toMatchObject({text:'v2'});
 expect(f.manager.taskService.getContextSnapshot(user,run.id)!.sourceVersions).toEqual(snapshot.sourceVersions);
});
test.each(['unbound','denied','retracted'] as const)('%s file is not admitted through Task bindings or readable by bound tool',async state=>{
 const f=setup(),user={userId:'local'},files=createAssetFiles(f.home),assets=createAssets(f.store,files);
 writeFileSync(join(f.home,'secret.txt'),'unselected bytes');const staged=await files.stageFiles(user,null,[{allowedRoot:f.home,relativePath:'secret.txt',manifestPath:'secret.txt'}]);
 const result=assets.importAsset(user,{kind:'file',title:'Selected',submissionId:staged.submissionId},'file');
 let asset=assets.setAccess(user,result.asset.id,{mode:'selected',agentIds:state==='denied'?['a']:['a','b']},result.asset.revision);
 if(state!=='unbound')assets.bind(user,{ownerType:'project',ownerId:'p',assetId:asset.id,versionPolicy:'pinned',versionId:result.version.id});
 if(state==='retracted')assets.setLifecycle(user,asset.id,'retracted',asset.revision);
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'original');terminal(f.clients[0]);
 if(state==='denied'){
  // This file is already admitted to the source Agent's native context; delegation cannot omit that lineage.
  await expect(f.manager.createTask(source.id,'b','Read file')).rejects.toMatchObject({status:403});
  expect(f.clients).toHaveLength(1);expect(f.store.database.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n).toBe(0);return;
 }
 const task=await f.manager.createTask(source.id,'b','Read file');await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 const run=f.manager.taskService.listRuns(user,task.id)[0];expect(f.manager.taskService.getContextSnapshot(user,run.id)!.sourceVersions).toEqual([]);
 await expect(f.manager.callBoundTool(f.clients[1].token!,'artifact_read',{assetId:asset.id,versionId:result.version.id,fileId:'0'},'read')).rejects.toMatchObject({status:403});
});

test('stop before any native submission releases only the unsubmitted directory claim',async()=>{
 let first=true,entered=false,release!:()=>void;
 const f=setup({beforeThread:async()=>{if(first){first=false;entered=true;await new Promise<void>(resolve=>{release=resolve;});}}});
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});
 const task=await f.manager.createTask(source.id,'b','Never submitted',undefined,{policy:'notify'});await vi.waitFor(()=>expect(entered).toBe(true));
 const run=f.manager.taskService.listRuns({userId:'local'},task.id)[0];
 expect(f.store.database.prepare('SELECT submitted FROM task_directory_claims WHERE owner_id=?').get(run.id)).toMatchObject({submitted:0});
 await f.manager.stop(task.targetConversationId);release();
 expect(f.store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE owner_id=?').get(run.id)).toBeUndefined();
 const next=await f.manager.createTask(source.id,'b','Independent next task',undefined,{policy:'notify'});await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 expect(f.manager.taskService.listRuns({userId:'local'},next.id)[0].state).toBe('running');
},8000);


test.each([false,true])('F1 stop/cancel during earliest configuration await prevents old native startup (cancel=%s)',async cancel=>{
 let entered=false,release!:()=>void,finished=false;
 const f=setup({loadConfig:async store=>{
  if(!entered&&store.database.prepare("SELECT id FROM task_runs WHERE state='starting'").get()){
   entered=true;await new Promise<void>(resolve=>{release=resolve;});finished=true;
  }
  return structuredClone(config);
 }}),root={userId:'local'};
 const task=f.manager.taskService.createTask(root,{goal:'Stopped before native startup',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'b'},'pre-runtime');
 const run=await f.manager.startDurableTask(task.id,task.revision,'start');await vi.waitFor(()=>expect(entered).toBe(true));
 const id=run.routing!.executionConversationId;
 expect(f.manager.taskService.getRunControl(root,run.id).state).toBe('starting');expect(f.clients).toHaveLength(0);
 expect(f.store.getConversation(id)?.status).toBe('idle');
 const result=await f.manager.stopDurableTask(task.id,f.manager.taskService.getTask(root,task.id).revision,cancel);
 expect(result.status).toBe(cancel?'cancelled':'stopped');
 release();await vi.waitFor(()=>expect(finished).toBe(true));await tick();await tick();
 expect(f.clients).toHaveLength(0);
 expect(f.store.getConversation(id)?.status).not.toBe('running');
 expect(f.manager.taskService.getRunControl(root,run.id).state).toBe('interrupted');
 expect(f.manager.taskService.getTask(root,task.id).state).toBe(cancel?'cancelled':'waiting');
 expect(f.store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE owner_id=?').get(run.id)).toBeUndefined();
});

test.each(['config','thread'] as const)('F1 late %s preparation cannot overwrite a newer same-conversation invocation',async stage=>{
 let entered=false,release!:()=>void;
 const pause=async()=>{entered=true;await new Promise<void>(resolve=>{release=resolve;});};
 const f=setup({loadConfig:async store=>{if(stage==='config'&&!entered&&store.database.prepare("SELECT id FROM task_runs WHERE state='starting'").get())await pause();return structuredClone(config);},beforeThread:async()=>{if(stage==='thread'&&!entered)await pause();}}),root={userId:'local'};
 const task=f.manager.taskService.createTask(root,{goal:'Old attempt',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'b'},'old');
 const run=await f.manager.startDurableTask(task.id,task.revision,'start');await vi.waitFor(()=>expect(entered).toBe(true));const id=run.routing!.executionConversationId;
 const queued=f.manager.enqueueUserInput(id,'Queued user input','queued-during-preparation');await tick();expect(f.manager.listUserInputs(id)).toMatchObject([{id:queued.id,state:'queued'}]);
 await f.manager.stopDurableTask(task.id,f.manager.taskService.getTask(root,task.id).revision);
 await f.manager.continue(id,'New independent topic');
 const newer=f.clients.at(-1)!,nativeId=f.store.getConversation(id)!.nativeId;
 expect(newer.texts).toEqual(['New independent topic']);
 const count=f.clients.length;release();await tick();await tick();
 expect(f.clients).toHaveLength(count);expect(f.clients.flatMap(c=>c.texts)).toEqual(['New independent topic']);
 expect(f.store.getConversation(id)).toMatchObject({status:'running',nativeId,turnId:'t1'});
 expect(f.manager.listUserInputs(id)).toMatchObject([{id:queued.id,state:'queued'}]);
 expect(f.manager.taskService.getRunControl(root,run.id).state).toBe('interrupted');
 expect(f.store.database.prepare('SELECT submitted FROM task_directory_claims WHERE conversation_id=?').all(id)).toEqual([{submitted:1}]);
 terminal(newer);await vi.waitFor(()=>expect(newer.texts).toEqual(['New independent topic','Queued user input']));
});

test('F1 preparation load rejection finishes its owner once and permits explicit retry',async()=>{
 let rejected=false;
 const f=setup({loadConfig:async store=>{if(!rejected&&store.database.prepare("SELECT id FROM task_runs WHERE state='starting'").get()){rejected=true;throw new Error('synthetic configuration read failed');}return structuredClone(config);}}),root={userId:'local'};
 const task=f.manager.taskService.createTask(root,{goal:'Retry after preparation error',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'b'},'load-error');
 const run=await f.manager.startDurableTask(task.id,task.revision,'start');const id=run.routing!.executionConversationId;
 await vi.waitFor(()=>expect(f.manager.taskService.getRunControl(root,run.id).state).toBe('unknown'));
 expect(f.clients).toHaveLength(0);expect(f.store.getConversation(id)?.status).toBe('error');
 expect(f.store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE owner_id=?').get(run.id)).toBeUndefined();
 expect(f.store.listEvents(id,0).filter(e=>e.kind==='error')).toHaveLength(1);
 const retry=await f.manager.retryTask(task.id,f.manager.taskService.getTask(root,task.id).revision,'retry');await vi.waitFor(()=>expect(f.clients[0]?.texts).toHaveLength(1));
 expect(retry.id).not.toBe(run.id);expect(f.manager.taskService.getRunControl(root,run.id).state).toBe('interrupted');
});

test('closing during queued pump configuration rejection leaves no late native work or unhandled rejection',async()=>{
 let entered=false,reject!:()=>void,settled=false;
 const f=setup({loadConfig:async store=>{
  if(!entered&&store.database.prepare("SELECT id FROM task_user_inputs WHERE state='queued'").get()){
   entered=true;try{await new Promise<void>((_resolve,fail)=>{reject=()=>fail(Object.assign(new Error('synthetic removed config.json'),{code:'ENOENT'}));});}finally{settled=true;}
  }
  return structuredClone(config);
 }});
 const c=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});const input=f.manager.enqueueUserInput(c.id,'Queued while closing','close-pump');
 await vi.waitFor(()=>expect(entered).toBe(true));f.manager.close();reject();
 await vi.waitFor(()=>expect(settled).toBe(true));await new Promise(resolve=>setImmediate(resolve));
 expect(f.clients).toEqual([]);expect(f.manager.listUserInputs(c.id)).toMatchObject([{id:input.id,state:'queued'}]);
});

test('obsolete queued recipient is rejected without crashing or starving legal work or releasing submitted claims',async()=>{
 const current=structuredClone(config),f=setup({loadConfig:async()=>current});current.projects[0].cwd=join(f.home,'shared');mkdirSync(current.projects[0].cwd);
 const source=await f.manager.create('p','a');await f.manager.createTask(source.id,'a','Hold shared directory',source.id,{policy:'notify'});
 await vi.waitFor(()=>expect(f.clients[0]?.texts).toHaveLength(1));
 const obsolete=await f.manager.createTask(source.id,'b','Obsolete recipient',undefined,{policy:'notify'});
 const obsoleteChat=await f.manager.create('p','b');await f.manager.send(obsoleteChat.id,'Obsolete queued input');
 const legal=await f.manager.create('p','a');await f.manager.send(legal.id,'Legal queued request');
 const other=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(other.id,'Preserve submitted occupancy');
 const held=f.store.database.prepare('SELECT * FROM task_directory_claims WHERE conversation_id=?').all(other.id);expect(held).toHaveLength(1);expect(held[0].submitted).toBe(1);
 current.agents=current.agents.filter(a=>a.id!=='b');current.projects[0].agentIds=['a'];
 terminal(f.clients[0]);
 await vi.waitFor(()=>expect(f.clients.some(c=>c.texts.includes('Legal queued request'))).toBe(true));
 expect(f.manager.listUserInputs(obsoleteChat.id)[0].state).toBe('cancelled');
 const run=f.manager.taskService.listRunControls({userId:'local'},obsolete.id).find(run=>run.routing?.executionConversationId===obsolete.targetConversationId)!;expect(run.state).toBe('interrupted');expect(f.store.listEvents(obsolete.targetConversationId,0).some(e=>e.kind==='error')).toBe(true);
 expect(f.store.database.prepare('SELECT * FROM task_directory_claims WHERE conversation_id=?').all(other.id)).toEqual(held);
});

test('native approval before start reply projects exact Run state and ignores stale or terminal identities',async()=>{
 let block=false,release!:()=>void;let gate=new Promise<void>(r=>release=r);const f=setup({beforeTurn:async()=>{if(block)await gate;}});
 const source=await f.manager.create('p','a',undefined,undefined,{workspaceId:null});await f.manager.send(source.id,'Source');block=true;
 const child=await f.manager.createTask(source.id,'b','Needs approval',undefined,{policy:'notify'});await vi.waitFor(()=>expect(f.clients[1]?.texts).toHaveLength(1));
 const c=f.clients[1],run=f.manager.taskService.listRunControls({userId:'local'},child.id)[0];
 c.options.onApproval({id:42,method:'item/commandExecution/requestApproval',params:{threadId:c.session,turnId:'t1',command:'echo ok'}});
 c.options.onApproval({id:45,method:'item/commandExecution/requestApproval',params:{threadId:c.session,turnId:'old-early',command:'stale before reply'}});
 expect(f.store.getConversation(child.targetConversationId)!.status).toBe('approval');
 c.options.onEvent({method:'turn/started',params:{threadId:c.session,turn:{id:'t1',status:'inProgress'}}});
 expect(f.manager.taskService.getRunControl({userId:'local'},run.id).state).toBe('approval');release();await tick();expect(f.manager.taskService.getRunControl({userId:'local'},run.id).state).toBe('approval');
 expect(f.manager.getApprovals(child.targetConversationId)).toHaveLength(1);const approval=f.manager.getApprovals(child.targetConversationId)[0];await f.manager.approve(child.targetConversationId,approval.id,'reject');expect(f.manager.taskService.getRunControl({userId:'local'},run.id).state).toBe('running');
 f.manager.taskService.setRunApproval({runId:run.id,hostId:'local',nativeSessionId:c.session,nativeTurnId:'old'},true);expect(f.manager.taskService.getRunControl({userId:'local'},run.id).state).toBe('running');
 c.options.onApproval({id:43,method:'item/commandExecution/requestApproval',params:{threadId:c.session,turnId:'wrong-turn',command:'old'}});expect(f.manager.getApprovals(child.targetConversationId)).toHaveLength(0);
 terminal(c);await tick();c.options.onApproval({id:44,method:'item/commandExecution/requestApproval',params:{threadId:c.session,turnId:'t1',command:'late'}});expect(f.store.getConversation(child.targetConversationId)!.status).toBe('idle');
 const identity={runId:run.id,hostId:'local',nativeSessionId:c.session,nativeTurnId:'t1'};
 f.manager.taskService.setRunApproval({...identity,nativeTurnId:'old'},true);f.manager.taskService.setRunApproval(identity,true);expect(f.manager.taskService.getRunControl({userId:'local'},run.id).state).toBe('succeeded');
 gate=new Promise<void>(r=>release=r);const next=await f.manager.createTask(source.id,'b','Next round',child.targetConversationId,{commandKey:'next-approval-round'});await vi.waitFor(()=>expect(c.texts).toHaveLength(2));
 c.options.onApproval({id:46,method:'item/commandExecution/requestApproval',params:{threadId:c.session,turnId:'t1',command:'old completed turn'}});expect(f.manager.getApprovals(child.targetConversationId)).toHaveLength(0);
 c.options.onApproval({id:47,method:'item/commandExecution/requestApproval',params:{threadId:c.session,turnId:'t2',command:'new early approval'}});c.options.onEvent({method:'turn/started',params:{threadId:c.session,turn:{id:'t2',status:'inProgress'}}});release();await tick();const nextRun=f.manager.taskService.listRunControls({userId:'local'},next.id).at(-1)!;expect(nextRun.state).toBe('approval');
 await f.manager.stopDurableTask(next.id,f.manager.taskService.getTask({userId:'local'},next.id).revision,true);c.options.onApproval({id:48,method:'item/commandExecution/requestApproval',params:{threadId:c.session,turnId:'t2',command:'cancelled late'}});expect(f.manager.taskService.getTask({userId:'local'},next.id).state).toBe('cancelled');expect(f.manager.taskService.getRunControl({userId:'local'},nextRun.id).state).toBe('interrupted');expect(f.manager.getApprovals(child.targetConversationId)).toHaveLength(0);

});
