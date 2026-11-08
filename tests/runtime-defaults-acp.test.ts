import {ensureConfiguredMandala} from './configured-mandala';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import type { Config } from '../shared/types';
const native = vi.hoisted(()=>({launches:[] as any[],turns:[] as any[]}));
vi.mock('../server/acp',()=>({startAcp:async(cli:string,o:any)=>{native.launches.push({cli,...o});return {
 getStatus:async()=>({status:'ready',version:'synthetic'}),listModels:async()=>[{id:'synthetic',label:'Synthetic'}],startThread:async()=> 'acp-session',resumeThread:async()=>{},
 startTurn:async(...args:any[])=>{native.turns.push(args);return 'acp-turn';},close(){},replyApproval(){},interrupt:async()=>{},
};}}));
afterEach(()=>{vi.unstubAllEnvs();native.launches=[];native.turns=[];});
it.each(['claude','gemini','opencode','codebuddy','kimi','dsh','grok'] as const)('applies %s default environment/approval to actual ACP sends and probes, and Agent override on resume',async(cli)=>{
 const home=await mkdtemp(join(tmpdir(),'mana-runtime-acp-'));const store=openStore(home);
 const config:Config={version:2,runtimes:[cli],projects:[],agents:[{id:'a',name:'A',instructions:'Synthetic',defaultCli:cli,models:{},mcp:[],skills:[]}],runtimeDefaults:{[cli]:{env:{SERVICE:'${ACP_SOURCE}'},approvalMode:'auto'}}};
 vi.stubEnv('ACP_SOURCE','synthetic-reference-value');
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 try {
  const chat=await manager.create('','a',undefined,cli,{workspaceId:null});await manager.send(chat.id,'Synthetic send');
  expect(native.launches.at(-1)).toMatchObject({cli,env:{SERVICE:'synthetic-reference-value'}});expect(native.turns.at(-1)[2]).toBe('auto');
  native.launches.at(-1).onEvent({method:'turn/completed',params:{threadId:'acp-session',turn:{id:'acp-turn',status:'completed'}}});
  config.agents[0].runtime={[cli]:{approvalMode:'default'}};
  await manager.send(chat.id,'Synthetic resumed send');expect(native.turns.at(-1)[2]).toBe('default');
  await manager.getCliStatus(undefined,cli,{agentId:'a'});expect(native.launches.at(-1).env).toEqual({SERVICE:'synthetic-reference-value'});
  await manager.listModels(undefined,cli,{agentId:'a'});expect(native.launches.at(-1).env).toEqual({SERVICE:'synthetic-reference-value'});
 } finally {await manager.close();store.close();await rm(home,{recursive:true,force:true});}
});

it('blocks a retired default route until the Agent explicitly selects native settings',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mana-runtime-gateway-')),store=openStore(home);
 const config:Config={version:2,runtimes:['gemini'],projects:[],agents:[{id:'a',name:'A',instructions:'',defaultCli:'gemini',models:{},mcp:[],skills:[]}],runtimeDefaults:{gemini:{gateway:'unavailable'}}};
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 try{
  expect(await manager.getCliStatus(undefined,'gemini',{agentId:'a'})).toMatchObject({status:'unavailable'});expect(native.launches).toHaveLength(0);
  config.agents[0].runtime={gemini:{gateway:'native'}};
  await manager.listModels(undefined,'gemini',{agentId:'a'});expect(native.launches.at(-1).gateway).toBe('native');
 }finally{await manager.close();store.close();await rm(home,{recursive:true,force:true});}
});

it.each(['claude','gemini','opencode','codebuddy'] as const)('system %s probes inherit global connection but exclude Agent environment and execution permissions',async cli=>{
 const home=await mkdtemp(join(tmpdir(),'mana-system-catalog-')),store=openStore(home);
 const config:Config={version:2,runtimes:[cli],projects:[],agents:[{id:'a',name:'A',instructions:'PRIVATE',defaultCli:cli,models:{},mcp:[],skills:[],runtime:{[cli]:{env:{PRIVATE:'${MISSING_AGENT_SECRET}'}}}}],runtimeDefaults:{[cli]:{gateway:'native',env:{AUTH_ROUTE:'${SYSTEM_ROUTE}'},approvalMode:'auto',args:['--unsafe']}}};
 vi.stubEnv('SYSTEM_ROUTE','synthetic');const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 try{
  for(const method of ['getCliStatus','listModels'] as const){
   await manager[method](undefined,cli,{agentId:'a'},'system');
   expect(native.launches.at(-1)).toMatchObject({cli,safeSystem:true,gateway:'native',env:{AUTH_ROUTE:'synthetic'}});
   expect(native.launches.at(-1).extraArgs).toBeUndefined();
  }
 }finally{await manager.close();store.close();await rm(home,{recursive:true,force:true});}
});

it.each(['claude','gemini','opencode','codebuddy','kimi','dsh','grok'] as const)('managed %s main and background inherit only the configured connection route',async cli=>{
 const {ensureMandalaConfig}=await import('../server/config'),{ensureMandalaConversation}=await import('../server/mandala');
 const home=await mkdtemp(join(tmpdir(),'mandala-managed-route-')),store=openStore(home),initial=await ensureConfiguredMandala(home);
 const config:Config={...initial.config,runtimes:[cli],agents:initial.config.agents.map(a=>({...a,defaultCli:cli})),runtimeDefaults:{[cli]:{...cli!=='opencode'?{gateway:'native'}:{},env:{AUTH_ROUTE:'${MANAGED_ROUTE}'},args:['--unsafe'],approvalMode:'auto'}}};
 vi.stubEnv('MANAGED_ROUTE','connection-fixture');const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 try{
  const main=ensureMandalaConversation(store,config);await manager.send(main.id,'Coordinate');
  expect(native.launches.at(-1)).toMatchObject({cli,...cli!=='opencode'?{gateway:'native'}:{},env:{AUTH_ROUTE:'connection-fixture'},extraArgs:[]});
  expect(native.launches.at(-1).safeSystem).not.toBe(true);expect(native.turns.at(-1)[2]).toBe('default');
  const root={userId:store.ownerUserId},child=manager.taskService.createTask(root,{goal:'Background',assigneeAgentId:main.agentId},'background');
  await manager.startDurableTask(child.id,child.revision,'start');await expect.poll(()=>native.launches.length).toBe(2);
  expect(native.launches[1]).toMatchObject({cli,...cli!=='opencode'?{gateway:'native'}:{},env:{AUTH_ROUTE:'connection-fixture'},extraArgs:[]});expect(native.launches[1].safeSystem).not.toBe(true);
 }finally{await manager.close();store.close();await rm(home,{recursive:true,force:true});}
});
