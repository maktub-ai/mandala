import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,renameSync,rmSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {readConfig,writeConfig} from '../server/config';
import {openStore} from '../server/store';
import {createMemoryRuntime} from '../server/memory-runtime';
import {createSessionManager} from '../server/sessions';
import {createHttpServer} from '../server/http';
import type {Config} from '../shared/types';

vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs')>();return {...actual,renameSync:vi.fn(actual.renameSync)};});
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return {...actual,rm:vi.fn(actual.rm)};});
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{
 for(const cleanup of cleanups.splice(0))await cleanup();
 vi.mocked(renameSync).mockReset();
 vi.mocked(rm).mockReset();
});
const setting=(config:Config,generate:boolean):Config=>({...config,system:{cli:'codex',memory:{request:{generate,read:true},session:{generate:false,read:true},idleHours:6}}});
async function fixture(){const home=mkdtempSync(join(tmpdir(),'memory-boundaries-')),store=openStore(home),config=setting((await readConfig(home)).config,true);cleanups.push(async()=>{store.close();rmSync(home,{recursive:true,force:true});});return {home,store,config};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function turn(store:ReturnType<typeof openStore>,text='Disabled private text'){const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'text',{text:'Private response'});store.appendEvent(chat.id,'status',{status:'idle'});return chat;}

test.each((['request'] as const).flatMap(kind=>[false,true].flatMap(otherEvents=>[false,true].map(restart=>({kind,otherEvents,restart})))))('quiet $kind turn crossing off/on is excluded (other events: $otherEvents, restart: $restart)',async({kind,otherEvents,restart})=>{
 const s=await fixture(),root={userId:s.store.ownerUserId};
 const config:Config={...s.config,system:{cli:'codex',memory:{request:{generate:true,read:true},session:{generate:true,read:true},idleHours:0}}};
 const create=()=>createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>structuredClone(config),generate:async()=>{throw new Error('No model calls expected');}});
 let runtime=create();cleanups.unshift(()=>runtime.close());await runtime.getSettings();
 const queued=turn(s.store,'Queued before disable');await runtime.scan();
 const queuedJobs=runtime.jobs.list(root).filter(job=>job.kind===kind).map(job=>job.id);
 const completed=turn(s.store,'Completed before disable, not yet captured');
 const chat=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});s.store.appendEvent(chat.id,'user',{text:'Quiet crossing request'});
 config.system!.memory![kind]!.generate=false;runtime.settingsChanged(structuredClone(config));
 if(otherEvents)turn(s.store,'Only another conversation emits while disabled');
 if(restart){await runtime.close();runtime=create();await runtime.getSettings();}
 config.system!.memory![kind]!.generate=true;runtime.settingsChanged(structuredClone(config));
 // Closed boundaries must also survive a restart before the quiet turn finishes.
 if(restart){await runtime.close();runtime=create();await runtime.getSettings();}
 s.store.appendEvent(chat.id,'text',{text:'Answer after reenable'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 await runtime.scan();
 const jobs=runtime.jobs.list(root);
 expect(jobs.filter(job=>job.kind===kind&&job.conversationId===chat.id)).toEqual([]);
 expect(jobs.some(job=>job.kind==='session')).toBe(false);
 expect(jobs.filter(job=>job.kind===kind&&job.conversationId===queued.id).map(job=>job.id)).toEqual(queuedJobs);
 expect(jobs.some(job=>job.kind===kind&&job.conversationId===completed.id)).toBe(true);
 s.store.appendEvent(chat.id,'user',{text:'Eligible later turn'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const future=await runtime.captureConversation(chat.id,'completed',kind);
 expect(future.sources).toHaveLength(1);expect(future.sources[0].text).toContain('Eligible later turn');expect(future.sources[0].text).not.toContain('Quiet crossing request');
 const manual=await runtime.captureConversation(chat.id,'explicit',kind,true);
 expect(manual.sources).toHaveLength(2);expect(manual.sources[0].text).toContain('Quiet crossing request');
});

test('an older deferred config read cannot undo a newer saved disable',async()=>{
 const s=await fixture();let config=s.config,gate:ReturnType<typeof deferred<Config>>|undefined;
 const runtime=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>gate?gate.promise:structuredClone(config)});cleanups.unshift(()=>runtime.close());await runtime.getSettings();
 gate=deferred<Config>();const old=structuredClone(config),pending=runtime.getSettings();config=setting(config,false);runtime.settingsChanged(config);gate.resolve(old);await pending;gate=undefined;
 const disabled=turn(s.store);await runtime.getSettings();config=setting(config,true);runtime.settingsChanged(config);await runtime.scan();
 expect(runtime.jobs.list({userId:'local'}).some(job=>job.conversationId===disabled.id)).toBe(false);
});

test('a late config load after shutdown cannot mutate durable generation boundaries',async()=>{
 const s=await fixture(),gate=deferred<Config>();let defer=false;
 const runtime=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>defer?gate.promise:s.config});await runtime.getSettings();defer=true;
 const pending=runtime.getSettings();await runtime.close();gate.resolve(setting(s.config,false));await pending;
 expect(runtime.beginSettingsSave(setting(s.config,false))).toBeUndefined();
 expect(s.store.database.prepare("SELECT enabled FROM memory_generation_state WHERE kind='request'").get()?.enabled).toBe(1);
 expect(s.store.database.prepare('SELECT * FROM memory_generation_exclusions').all().filter(row=>row.kind==='request')).toHaveLength(0);
});

async function httpFixture(configure?:(config:Config,home:string)=>Config){
 const s=await fixture();if(configure)s.config=configure(s.config,s.home);const value=await readConfig(s.home);await writeConfig(s.home,s.config,value.revision);
 const pause=()=>({entered:deferred<void>(),gate:deferred<void>()});
 let nextSettingsRead:ReturnType<typeof pause>|undefined;
 const pauseSettingsRead=()=>{
  const pending=pause();nextSettingsRead=pending;
  return {entered:pending.entered.promise,release:()=>pending.gate.resolve()};
 };
 const runtime=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>{
  const pending=nextSettingsRead;nextSettingsRead=undefined;
  const {config}=await readConfig(s.home);
  if(pending){pending.entered.resolve();await pending.gate.promise;}
  return config;
 }});
 const manager=createSessionManager(s.store,async()=>(await readConfig(s.home)).config,undefined,undefined,s.home,undefined,undefined,runtime),server=createHttpServer({requireIdentity:false,home:s.home,store:s.store,manager,memoryRuntime:runtime});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 cleanups.unshift(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await manager.close();await runtime.close();});
 const save=async(generate:boolean|Config)=>{const current=await readConfig(s.home);return fetch(base+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:current.revision,config:typeof generate==='boolean'?setting(current.config,generate):generate})});};
 return {...s,runtime,save,pauseSettingsRead};
}
async function pauseReconciliation(home:string,fail=false){
 const entered=deferred<void>(),gate=deferred<void>();
 const {rm:actualRm}=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
 if(fail){
  const {renameSync:actualRename}=await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation((source,destination)=>{
   if(String(destination)===join(home,'config.json'))throw new Error('synthetic config rename failure');
   return actualRename(source,destination);
  });
 }
 let pause=true;
 // Guard and rename are synchronous. Temp cleanup still precedes settings reconciliation.
 vi.mocked(rm).mockImplementation(async(path,options)=>{
  if(pause&&dirname(String(path))===home&&/^config-[a-f0-9-]+\.tmp$/.test(basename(String(path)))){
   pause=false;entered.resolve();await gate.promise;
  }
  return actualRm(path,options);
 });
 return {entered:entered.promise,release:()=>gate.resolve()};
}

test('an in-flight old settings read cannot undo a published disable pending reconciliation',async()=>{
 const s=await httpFixture(),pausedRead=s.pauseSettingsRead(),reading=s.runtime.getSettings();await pausedRead.entered;
 const paused=await pauseReconciliation(s.home),saving=s.save(false);await paused.entered;
 try{
  expect((await readConfig(s.home)).config.system?.memory?.request?.generate).toBe(false);
  pausedRead.release();
  expect((await reading).request.generate).toBe(false);
  expect((await s.runtime.getSettings()).request.generate).toBe(false);
  turn(s.store);
 }finally{pausedRead.release();paused.release();}
 expect((await saving).status).toBe(200);expect((await s.save(true)).status).toBe(200);await s.runtime.scan();expect(s.runtime.jobs.list({userId:'local'})).toEqual([]);
 const future=turn(s.store,'Post-enable future content');await s.runtime.scan();expect(s.runtime.jobs.list({userId:'local'}).map(job=>job.conversationId)).toEqual([future.id]);
});

test('failed config save clears its pending guard and a restart retains eligible future work',async()=>{
 const s=await httpFixture(),paused=await pauseReconciliation(s.home,true),saving=s.save(false);await paused.entered;
 try{await s.runtime.getSettings();turn(s.store,'Attempted-disable interval content');}finally{paused.release();}
 expect((await saving).ok).toBe(false);expect((await s.runtime.getSettings()).request.generate).toBe(true);
 const future=turn(s.store,'After failed save');await s.runtime.scan();expect(s.runtime.jobs.list({userId:'local'}).map(job=>job.conversationId)).toEqual([future.id]);
 await s.runtime.close();const restarted=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>(await readConfig(s.home)).config});cleanups.unshift(()=>restarted.close());await restarted.scan();
 expect(restarted.jobs.list({userId:'local'}).map(job=>job.conversationId)).toEqual([future.id]);
});

test('restart closes a persisted disabled interval only after observing committed enable',async()=>{
 const s=await httpFixture();expect((await s.save(false)).status).toBe(200);turn(s.store);await s.runtime.close();
 const current=await readConfig(s.home);await writeConfig(s.home,setting(current.config,true),current.revision);
 const restarted=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>(await readConfig(s.home)).config});cleanups.unshift(()=>restarted.close());await restarted.scan();expect(restarted.jobs.list({userId:'local'})).toEqual([]);
 const future=turn(s.store,'After restart');await restarted.scan();expect(restarted.jobs.list({userId:'local'}).map(job=>job.conversationId)).toEqual([future.id]);
});


test.each([true,false])('pending project grant is forbidden until committed reconciliation (rename fails: %s)',async fails=>{
 const s=await httpFixture((config,home)=>({...config,runtimes:['codex'],agents:[{id:'excluded-agent',name:'Excluded',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}],projects:[{id:'private-project',name:'Private',cwd:home,resources:[],agentIds:[],mcp:[],skills:[]}],system:{...config.system,cli:'codex',model:'committed-model'}}));
 await s.runtime.getSettings();const root={userId:s.store.ownerUserId},agent={...root,agentId:'excluded-agent'},collection=s.runtime.memory.ensureCollection(root,{projectId:'private-project',agentId:null});
 const chat=s.store.createConversation({projectId:'private-project',agentId:'',cli:'codex',model:null}),secret='Synthetic restricted project fact';s.store.appendEvent(chat.id,'user',{text:secret});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.runtime.memory.captureConversation(root,{collectionId:collection.id,conversationId:chat.id,trigger:'completed',kind:'request'}).sources[0];
 const record=s.runtime.memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text:secret,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:source.events[0].id,quote:secret}],validUntil:null,certainty:'user_asserted',pipeline:'request'},collection.generation,'evidence_extract')!;
 const forbidden=()=>{expect(()=>s.runtime.memory.source(agent,source.id,'private-project')).toThrow('Project membership required');expect(s.runtime.memory.list(agent,{projectId:'private-project',status:'active'})).toEqual([]);expect(()=>s.runtime.memory.read(agent,record.recordId,'private-project')).toThrow('Project membership required');};
 forbidden();const requested:Config={...s.config,runtimes:['omp'],projects:[{...s.config.projects[0],agentIds:[agent.agentId]}],system:{cli:'omp',model:'uncommitted-model',memory:{request:{generate:false,read:false},session:{generate:true,read:false},idleHours:24}}};
 const paused=await pauseReconciliation(s.home,fails),saving=s.save(requested);await paused.entered;let response!:Response;
 try{forbidden();const settings=await s.runtime.getSettings();expect(settings.request).toEqual({generate:false,read:true});expect(settings.session).toEqual({generate:false,read:false});expect(settings.idleHours).toBe(6);expect(await s.runtime.reading(agent)).toEqual(['request']);forbidden();}finally{paused.release();response=await saving;}
 expect(response.ok).toBe(!fails);
 if(fails){forbidden();expect((await s.runtime.getSettings()).request.generate).toBe(true);expect(await s.runtime.reading(agent)).toEqual(['request']);}
 else{expect(s.runtime.memory.source(agent,source.id,'private-project').text).toContain(secret);expect(s.runtime.memory.list(agent,{projectId:'private-project',status:'active'}).map(item=>item.text)).toEqual([secret]);expect(s.runtime.memory.read(agent,record.recordId,'private-project').text).toBe(secret);expect(await s.runtime.reading(agent)).toEqual([]);}
});

test('uninitialized synchronous save cannot adopt requested project authority',async()=>{
 const s=await fixture(),runtime=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>s.config});cleanups.unshift(()=>runtime.close());
 const requested={...s.config,projects:[{id:'private-project',name:'Private',cwd:s.home,resources:[],agentIds:['excluded-agent'],mcp:[],skills:[]}]};
 expect(()=>runtime.beginSettingsSave(requested)).toThrow('memory_settings_uninitialized');
 expect(s.store.database.prepare('SELECT * FROM memory_generation_state').all()).toEqual([]);
 await runtime.getSettings();expect(runtime.beginSettingsSave(requested)).toBeTypeOf('number');
});
