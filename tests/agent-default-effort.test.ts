import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {connectCodex} from '../server/codex';
import {readConfig,updateMandalaSettings,writeConfig} from '../server/config';
import {ensureMandalaConversation} from '../server/mandala';
import {createRpcClient,type RpcMessage} from '../server/rpc';
import {createSessionManager} from '../server/sessions';
import {openStore} from '../server/store';
import {createAutomations} from '../server/automations';
import type {AgentEffort} from '../shared/chat-input';
import {ensureConfiguredMandala} from './configured-mandala';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const high:AgentEffort={cli:'codex',model:'model-fixture',effort:'high'};
const system={name:'Mandala',soul:'',cli:'codex',models:{codex:high.model},maxParallel:3};
async function setup(defaultEffort?:AgentEffort){
 const home=await mkdtemp(join(tmpdir(),'agent-effort-')),store=openStore(home);
 cleanup.push(async()=>{store.close();await rm(home,{recursive:true,force:true});});
 const first=await ensureConfiguredMandala(home);
 const worker={id:'worker',name:'Worker',defaultCli:'codex' as const,models:{codex:high.model},defaultEffort,instructions:'',skills:[],mcp:[]};
 await writeConfig(home,{...first.config,agents:[...first.config.agents,worker]},first.revision);
 const native:RpcMessage[]=[];
 const loadConfig=async()=>(await readConfig(home)).config;
 const manager=createSessionManager(store,loadConfig,async options=>connectCodex(createRpcClient(
  spawn(process.execPath,['tests/fixtures/fake-cli.mjs','--chat','--record-effort','--state',join(home,'native.json')],{stdio:'pipe',signal:options.signal}),
  {onNotification:event=>{if(event.method==='fixture/turn-options')native.push(event);options.onEvent(event);},onRequest:options.onApproval,onExit:options.onExit},
 ),options.cwd),undefined,home);
 cleanup.push(()=>manager.close());
 const main=ensureMandalaConversation(store,await loadConfig());
 const saveSystem=async (patch:Record<string,unknown>)=>updateMandalaSettings(home,{...system,...patch},(await readConfig(home)).revision);
 const wire=(id:string)=>native.filter(event=>event.params?.threadId===store.getConversation(id)?.nativeId).map(event=>event.params?.effort);
 const send=async (id:string,text:string)=>{
  const count=native.length;
  await manager.send(id,text);
  await expect.poll(()=>native.length).toBe(count+1);
  await expect.poll(()=>store.getConversation(id)?.status).toBe('idle');
 };
 return {home,store,manager,main,saveSystem,wire,send,loadConfig};
}

it('persists Agent defaults, snapshots new chats, and sends a conversation override without rewriting Agent settings',async()=>{
 const {loadConfig,manager,send,wire}=await setup(high);
 expect((await loadConfig()).agents.find(a=>a.id==='worker')?.defaultEffort).toEqual(high);
 const chat=await manager.create('','worker');
 expect(chat).toMatchObject({agentEffort:high,effort:null});
 await send(chat.id,'Use inherited effort');expect(wire(chat.id)).toEqual(['high']);
 await manager.setModel(chat.id,high.model,'low');
 await send(chat.id,'Use conversation effort');expect(wire(chat.id)).toEqual(['high','low']);
 expect((await loadConfig()).agents.find(a=>a.id==='worker')?.defaultEffort).toEqual(high);
 const otherModel=await manager.create('','worker','model-second');
 await send(otherModel.id,'Use a different model');expect(wire(otherModel.id)).toEqual([undefined]);
 const newChat=await manager.create('','worker');
 await send(newChat.id,'Inherit again');expect(wire(newChat.id)).toEqual(['high']);
});

it('omits unadvertised defaults and records the fallback before sending',async()=>{
 const {manager,store,send,wire}=await setup({...high,effort:'xhigh'});
 const chat=await manager.create('','worker');
 await send(chat.id,'Use the native default');expect(wire(chat.id)).toEqual([undefined]);
 expect(store.listEvents(chat.id,0)).toContainEqual(expect.objectContaining({kind:'metadata',data:expect.objectContaining({agentEffortFallback:true})}));
});

it('uses a new dedicated task chat for Agent defaults but keeps a linked chat override',async()=>{
 const {manager,store,wire}=await setup(high);
 const root={userId:store.ownerUserId};
 const task=manager.taskService.createTask(root,{goal:'Run a dedicated check',assigneeAgentId:'worker'},'dedicated');
 const run=await manager.startDurableTask(task.id,task.revision,'start-dedicated');
 await expect.poll(()=>manager.taskService.listRuns(root,task.id)[0]?.state).toBe('succeeded');
 expect(wire(run.routing!.executionConversationId)).toEqual(['high']);
 const chat=await manager.create('','worker',high.model,'codex',{effort:'low'});
 const linked=manager.taskService.createTask(root,{goal:'Run a linked check',assigneeAgentId:'worker',originConversationId:chat.id},'linked');
 await manager.startDurableTask(linked.id,linked.revision,'start-linked',chat.id);
 await expect.poll(()=>manager.taskService.listRuns(root,linked.id)[0]?.state).toBe('succeeded');
 expect(wire(chat.id)).toEqual(['low']);
});

it('applies changes on the next primary Mandala turn and keeps existing background settings unchanged',async()=>{
 const {manager,main,store,send,wire,saveSystem,loadConfig}=await setup();
 const old=await manager.create('',main.agentId);
 await saveSystem({defaultEffort:high});
 expect((await loadConfig()).agents.find(a=>a.id===main.agentId)?.defaultEffort).toEqual(high);
 await send(old.id,'Existing background');expect(wire(old.id)).toEqual([undefined]);
 const fresh=await manager.create('',main.agentId);
 await send(fresh.id,'New background');expect(wire(fresh.id)).toEqual(['high']);
 await send(main.id,'Primary turn');expect(wire(main.id)).toEqual(['high']);
 const native=store.getConversation(main.id)?.nativeId;
 await saveSystem({defaultEffort:{...high,effort:'low'}});
 await send(main.id,'Next primary turn');expect(wire(main.id)).toEqual(['high','low']);
 expect(store.getConversation(main.id)?.nativeId).toBe(native);
 await saveSystem({defaultEffort:null});
 await send(main.id,'Return to native default');expect(wire(main.id)).toEqual([undefined]);
 expect(store.getConversation(main.id)?.nativeId).not.toBe(native);
});

it.each(['worker','system'])('sends the %s default from a new independent automation execution',async executor=>{
 const {manager,main,store,home,wire,saveSystem,loadConfig}=await setup(high);
 await saveSystem({defaultEffort:high});
 const service=createAutomations({home,store,manager,loadConfig});cleanup.push(async()=>service.close());
 const root={userId:store.ownerUserId};
 const rule=await service.create({name:'Effort fixture',instructions:'Run an independent check',projectId:'',agentId:executor==='system'?main.agentId:'worker',cli:'codex',enabled:false,executionMode:'independent',schedule:{kind:'interval',minutes:5,anchor:new Date().toISOString()}});
 const occurrence=await service.runNow(rule.id,'effort-automation');await service.tick();
 await expect.poll(()=>manager.taskService.listRuns(root,occurrence.taskId!)[0]?.state).toBe('succeeded');
 const run=manager.taskService.listRuns(root,occurrence.taskId!)[0];
 expect(wire(run.routing!.executionConversationId)).toEqual(['high']);
});
