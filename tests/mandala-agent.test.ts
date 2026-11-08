import {ensureConfiguredMandala} from './configured-mandala';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig } from '../server/config';
import { openStore, type Store } from '../server/store';
import { ensureMandalaConversation } from '../server/mandala';
let home: string, store: Store;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'mandala-identity-')); store = openStore(home); });
afterEach(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
it('creates a stable marked identity without taking over an ordinary same-name Agent', async () => {
  const initial = await readConfig(home);
  await writeConfig(home, { ...initial.config, agents: [{ id:'user', name:'Mandala', instructions:'Keep me', defaultCli:'codex', models:{}, mcp:[], skills:[] }] }, initial.revision);
  const first = await ensureConfiguredMandala(home);
  const second = await ensureConfiguredMandala(home);
  expect(second).toEqual(first);
  expect(first.config.agents.find(a=>a.id==='user')).toMatchObject({instructions:'Keep me'});
  expect(first.config.mandala).toMatchObject({maxParallel:3,soul:''});
  expect(first.config.agents.find(a=>a.id===first.config.mandala!.agentId)).toMatchObject({name:'Mandala',systemRole:'mandala'});
  const chat = ensureMandalaConversation(store, first.config);
  store.close(); store = openStore(home);
  expect(ensureMandalaConversation(store, (await readConfig(home)).config).id).toBe(chat.id);
  expect(chat.purpose).toBe('mandala-main');
});

it('rejects forged identity, deletion and managed-field edits through generic configuration writes', async () => {
  const first = await ensureConfiguredMandala(home);
  const id = first.config.mandala!.agentId;
  for (const patch of [
    { agents:first.config.agents.filter(a=>a.id!==id) },
    { agents:first.config.agents.map(a=>({...a, instructions:'override rules'})) },
    { agents:first.config.agents.map(a=>({...a, managedWorkspace:'/tmp'})) },
    { agents:first.config.agents.map(a=>({...a, mcp:[{name:'evil',transport:'stdio' as const,command:'sh'}]})) },
    { mandala:{...first.config.mandala!,maxParallel:20} },
  ]) await expect(writeConfig(home, {...first.config,...patch}, first.revision)).rejects.toThrow();
  expect(await readConfig(home)).toEqual(first);
});

it('captures active runtime and starts a fresh native session with visible continuity on the next main turn', async () => {
  const { createSessionManager } = await import('../server/sessions');
  const { updateMandalaSettings } = await import('../server/config');
  type Options = import('../server/codex').CodexOptions;
  const captured: {cli:string; options:Options; instructions:string; texts:string[]; resume?:string}[] = [];
  const factory = (cli:string) => async (options:Options & {resume?:string}) => {
    const entry = {cli,options,instructions:'',texts:[] as string[],resume:options.resume}; captured.push(entry);
    return {getStatus:async()=>({status:'ready' as const}),listModels:async()=>[],
      startThread:async(input:{instructions?:string})=>{entry.instructions=input.instructions??'';return `${cli}-native`;},
      resumeThread:async()=>{throw new Error('must not reuse a foreign native session');},
      startTurn:async(_id:string,text:string)=>{entry.texts.push(text);return 'turn';},interrupt:async()=>{},replyApproval:()=>{},close:()=>{}};
  };
  const first=await ensureConfiguredMandala(home), chat=ensureMandalaConversation(store,first.config);
  const manager=createSessionManager(store,async()=>(await readConfig(home)).config,factory('codex') as any,factory('omp') as any,home);
  try {
    const owner={userId:store.ownerUserId};
    const privateGoal=manager.taskService.createTask(owner,{goal:'PRIVATE NONPARTICIPANT GOAL',originConversationId:chat.id},'private-linked-goal');
    const sharedGoal=manager.taskService.createTask(owner,{goal:'Authorized shared goal',originConversationId:chat.id,participantAgentIds:[first.config.mandala!.agentId]},'authorized-linked-goal');
    // Origin references do not grant participation; ownership is the durable handoff source.
    store.database.prepare('INSERT INTO mandala_ownership VALUES (?,?)').run(sharedGoal.id,JSON.stringify({taskId:sharedGoal.id,agentId:chat.agentId,relation:'taken-over',conversationId:chat.id,sourceEventId:null,invocationId:'historical',createdAt:new Date().toISOString(),blockedReason:null}));
    const background=await manager.create('',first.config.mandala!.agentId);
    await manager.send(chat.id,'Please remember the purple project');
    const updated=await updateMandalaSettings(home,{name:'Manbo',soul:'Speak clearly',cli:'omp',maxParallel:3},first.revision);
    expect(store.getConversation(chat.id)?.cli).toBe('codex');
    expect(store.getConversation(background.id)).toMatchObject({cli:'codex',purpose:'mandala-background'});
    await expect(manager.send(chat.id,'Do not redirect active work')).rejects.toThrow('busy');
    store.appendEvent(chat.id,'text',{phase:'analysis',text:'SECRET HIDDEN REASONING'});
    captured[0].options.onEvent({method:'turn/completed',params:{threadId:'codex-native',turn:{id:'turn',status:'completed'}}});
    await manager.send(chat.id,'Continue our project');
    expect(store.getConversation(chat.id)).toMatchObject({cli:'omp',nativeId:'omp-native'});
    expect(captured.at(-1)?.resume).toBeUndefined();
    expect(captured.at(-1)?.texts.join('\n')).toContain('purple project');
    expect(captured.at(-1)?.texts.join('\n')).not.toContain('SECRET HIDDEN REASONING');
    expect(captured.at(-1)?.texts.join('\n')).not.toContain('PRIVATE NONPARTICIPANT GOAL');
    expect(captured.at(-1)?.texts.join('\n')).toContain('Authorized shared goal');
    expect(captured.at(-1)?.instructions).toContain('Speak clearly');
    expect(captured.at(-1)?.instructions).toContain('never overrides host rules');
    expect(store.listEvents(chat.id,0).filter(e=>e.kind==='user')).toHaveLength(2);
    expect((await manager.create('',updated.config.mandala!.agentId)).purpose).toBe('mandala-background');
    expect(await manager.create('',updated.config.mandala!.agentId,undefined,undefined,{cwd:'/tmp'})).toMatchObject({purpose:'mandala-background',cwd:'/tmp'});
  } finally {await manager.close();}
});

it('concurrent bootstrap and recovery after config-only persistence never duplicate the primary identity', async () => {
  const initial=await readConfig(home);
  await writeConfig(home,{...initial.config,runtimes:['codex','omp']},initial.revision);
  const results=await Promise.all(Array.from({length:6},()=>ensureConfiguredMandala(home)));
  expect(new Set(results.map(item=>item.config.mandala!.agentId)).size).toBe(1);
  // A restart after config persistence but before first conversation creation.
  store.close();store=openStore(home);
  const config=(await readConfig(home)).config;
  const ids=Array.from({length:6},()=>ensureMandalaConversation(store,config).id);
  expect(new Set(ids).size).toBe(1);
  expect(store.listConversations()).toHaveLength(1);
  expect(()=>store.archiveConversation(ids[0],true)).toThrow('primary');
});

it('saves per-runtime models without changing managed authority and rejects invalid model maps', async () => {
  const {updateMandalaSettings}=await import('../server/config');
  const first=await ensureConfiguredMandala(home), id=first.config.mandala!.agentId;
  const settings={name:'Mandala',soul:'',cli:'codex',maxParallel:3};
  const saved=await updateMandalaSettings(home,{...settings,models:{codex:'custom-codex',omp:'provider/model'}},first.revision);
  expect(saved.config.agents.find(a=>a.id===id)).toEqual({...first.config.agents.find(a=>a.id===id),models:{codex:'custom-codex',omp:'provider/model'}});
  const switched=await updateMandalaSettings(home,{...settings,cli:'omp',models:{omp:''}},saved.revision);
  expect(switched.config.agents.find(a=>a.id===id)?.models).toEqual({codex:'custom-codex',omp:''});
  const renamed=await updateMandalaSettings(home,{...settings,name:'Manbo'},switched.revision);
  expect(renamed.config.agents.find(a=>a.id===id)?.models).toEqual({codex:'custom-codex',omp:''});
  for(const models of [null,[],{unknown:'x'},{codex:42},{codex:'x'.repeat(201)}])
    await expect(updateMandalaSettings(home,{...settings,models},renamed.revision)).rejects.toThrow();
  expect(await readConfig(home)).toEqual(renamed);
});
it('resolves changed main models on the next same-runtime turn, preserving active and background execution', async () => {
  const {createSessionManager}=await import('../server/sessions'),{updateMandalaSettings}=await import('../server/config');
  const captured:{options:any;model?:string;turnModel?:string;native:string}[]=[];
  const factory=async(options:any)=>{const entry={options,native:'native-'+captured.length,model:undefined as string|undefined,turnModel:undefined as string|undefined};captured.push(entry);return {
    getStatus:async()=>({status:'ready' as const}),listModels:async()=>[],startThread:async(input:any)=>{entry.model=input.model;return entry.native;},resumeThread:async()=>{},
    startTurn:async(_id:string,_text:string,_approval:any,_roots:any,opts:any)=>{entry.turnModel=opts?.model;return 'turn';},interrupt:async()=>{},replyApproval:()=>{},close:()=>{}};};
  const initial=await readConfig(home);
  await writeConfig(home,{...initial.config,chatDefaults:{codex:{model:'global-model'}}},initial.revision);
  const first=await ensureConfiguredMandala(home),chat=ensureMandalaConversation(store,first.config);
  const manager=createSessionManager(store,async()=>(await readConfig(home)).config,factory as any,undefined,home);
  try{
    const cfg=await updateMandalaSettings(home,{name:'Mandala',soul:'',cli:'codex',maxParallel:3,models:{codex:'first-model'}},first.revision);
    const background=await manager.create('',chat.agentId);await manager.send(background.id,'Background');await manager.send(chat.id,'First');
    const changed=await updateMandalaSettings(home,{name:'Mandala',soul:'',cli:'codex',maxParallel:3,models:{codex:'second-model'}},cfg.revision);
    expect(store.getConversation(chat.id)).toMatchObject({model:'first-model',status:'running'});
    expect(store.getConversation(background.id)).toMatchObject({model:'first-model',status:'running'});
    captured[1].options.onEvent({method:'turn/completed',params:{threadId:captured[1].native,turn:{id:'turn',status:'completed'}}});
    await manager.send(chat.id,'Second');
    expect(store.getConversation(chat.id)).toMatchObject({model:'second-model',status:'running'});
    expect(captured.at(-1)).toMatchObject({model:'second-model',turnModel:'second-model'});
    expect(store.getConversation(background.id)).toMatchObject({model:'first-model',status:'running'});
    captured.at(-1)!.options.onEvent({method:'turn/completed',params:{threadId:captured.at(-1)!.native,turn:{id:'turn',status:'completed'}}});
    await updateMandalaSettings(home,{name:'Mandala',soul:'',cli:'codex',maxParallel:3,models:{codex:''}},changed.revision);
    await manager.send(chat.id,'Use native default');
    expect(store.getConversation(chat.id)).toMatchObject({model:null,status:'running'});
    expect(captured.at(-1)).toMatchObject({model:undefined,turnModel:undefined});
    const nextBackground=await manager.create('',chat.agentId);
    expect(nextBackground).toMatchObject({purpose:'mandala-background',model:null});
    await manager.send(nextBackground.id,'Background using native default');
    expect(captured.at(-1)).toMatchObject({model:undefined,turnModel:undefined});
    expect(store.getConversation(background.id)).toMatchObject({model:'first-model',status:'running'});
    expect(captured[0]).toMatchObject({model:'first-model',turnModel:'first-model'});
    expect(await manager.create('','',undefined,'codex')).toMatchObject({model:'global-model'});
    expect(await manager.create('','','explicit-model','codex')).toMatchObject({model:'explicit-model'});
  }finally{await manager.close();}
});
