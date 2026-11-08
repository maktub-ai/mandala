import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {memoryServices} from '../server/memory-runtime';
import {createMemoryScheduler} from '../server/memory-scheduling-runtime';
import {retireMemoryJobs} from '../scripts/retire-memory-jobs';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).forEach(close=>close()));
const p={userId:'local'},before='2026-10-16T00:00:00Z';
function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-retirement-'));let store=openStore(home),services=memoryServices(home,store);
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const c=services.memory.ensureCollection(p,{projectId:null,agentId:null}),chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 const text='A preserved confirmed project fact.',event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
 const captured=services.memory.captureConversation(p,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),source=captured.sources[0],job=captured.jobs[0];
 const fact=services.memory.applyProposal(p,{collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],dependencies:[],validUntil:null,certainty:'user_asserted'},c.generation,'evidence_extract')!;
 store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,createdAt:'2026-10-14T00:00:00Z',state:'failed',error:'invalid_memory_generation',outputInputs:{stage:'scene',records:[{recordId:fact.recordId,revision:1}]}}),job.id);
 for(const table of ['memory_extraction_drafts','memory_output_drafts','memory_output_verifications','memory_scene_recoveries']){store.database.exec(`CREATE TABLE IF NOT EXISTS ${table}(job_id TEXT PRIMARY KEY,data TEXT NOT NULL)`);store.database.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(job.id,JSON.stringify({text:'synthetic unfinished draft'}));}
 store.database.exec('CREATE TABLE IF NOT EXISTS memory_scheduled_jobs(job_id TEXT PRIMARY KEY,due_at TEXT NOT NULL)');store.database.prepare('INSERT INTO memory_scheduled_jobs VALUES(?,?)').run(job.id,job.availableAt);
 const restart=()=>{store.close();store=openStore(home);services=memoryServices(home,store);};
 return {home,get store(){return store;},get services(){return services;},job,source,fact,chat,c,restart};
}
test('retirement backs up exact rows, deletes only intermediate data and persists a no-replay acknowledgment',()=>{
 const s=setup(),original=s.store.database.prepare('SELECT * FROM memory_jobs WHERE id=?').get(s.job.id),events=s.store.listEvents(s.chat.id,0),sources=s.store.database.prepare('SELECT * FROM memory_sources').all();
 const result=retireMemoryJobs({home:s.home,before,apply:true});
 expect(result.retired).toBe(1);expect(Object.values(result.intermediateRows).reduce((a,b)=>a+b,0)).toBe(5);expect(result.protectedTablesUnchanged).toBe(true);
 const backup=JSON.parse(readFileSync(result.backupPath!,'utf8'));expect(backup.rows.memory_jobs).toEqual([original]);
 expect(s.store.database.prepare('SELECT count(*) AS n FROM memory_jobs').get()?.n).toBe(1);
 const marker=JSON.parse(s.store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(s.job.id)!.data as string);
 expect(marker).toMatchObject({state:'obsolete',error:'user_discarded',leaseUntil:null,workerId:null});expect(marker.outputInputs).toBeUndefined();
 for(const table of Object.keys(result.intermediateRows))expect(s.store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
 expect(s.store.listEvents(s.chat.id,0)).toEqual(events);expect(s.store.database.prepare('SELECT * FROM memory_sources').all()).toEqual(sources);expect(s.services.memory.read(p,s.fact.recordId)).toMatchObject({status:'active'});
 s.restart();expect(s.services.jobs.claim('restarted','2099-01-01T00:00:00Z')).toBeNull();
 expect(s.services.memory.captureConversation(p,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).jobs).toEqual([]);
 expect(retireMemoryJobs({home:s.home,before,apply:true}).retired).toBe(0);
 s.store.appendEvent(s.chat.id,'user',{text:'A new source revision can proceed.'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const fresh=s.services.memory.captureConversation(p,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).jobs[0];
 expect(s.services.jobs.claim('fresh','2099-01-01T00:00:00Z')).toMatchObject({id:fresh.id,attempt:1});
});
test('retirement refuses active queues and failed backup writes without mutating jobs',()=>{
 const s=setup(),original=s.store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(s.job.id)!.data;
 writeFileSync(join(s.home,'maintenance-backups'),'not a directory');
 expect(()=>retireMemoryJobs({home:s.home,before,apply:true})).toThrow();expect(s.store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(s.job.id)?.data).toBe(original);
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.state','running') WHERE id=?").run(s.job.id);
 expect(()=>retireMemoryJobs({home:s.home,before,apply:true})).toThrow('memory_workers_not_idle');
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(s.job.id)!.data as string).state).toBe('running');
});
test('retirement dry run does not write and leaves completed work and session summaries untouched',()=>{
 const s=setup();s.store.database.exec('CREATE TABLE IF NOT EXISTS memory_session_summaries(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,conversation_id TEXT NOT NULL,data TEXT NOT NULL)');
 const completed=JSON.stringify({...s.job,id:'completed-job',state:'completed'});s.store.database.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run('completed-job','completed-key',completed);
 s.store.database.prepare('INSERT INTO memory_session_summaries VALUES(?,?,?,?)').run(s.job.id,s.c.id,s.chat.id,'{"text":"Preserved committed summary"}');
 const plan=retireMemoryJobs({home:s.home,before,apply:false});expect(plan.retired).toBe(0);expect(plan.selected).toBe(1);expect(plan.backupPath).toBeNull();
 const applied=retireMemoryJobs({home:s.home,before,apply:true});expect(applied.retired).toBe(1);expect(s.store.database.prepare('SELECT data FROM memory_session_summaries').get()?.data).toBe('{"text":"Preserved committed summary"}');expect(s.store.database.prepare("SELECT data FROM memory_jobs WHERE id='completed-job'").get()?.data).toBe(completed);
});
test('a retired automatic scope timer is not recreated on repeated scans or restart',()=>{
 const s=setup(),scheduler=createMemoryScheduler(s.services.memory,s.services.jobs),now=Date.parse('2026-10-14T00:00:00Z');
 scheduler.afterL1(s.job,now);scheduler.scan(now+10_000);
 const timer=s.services.jobs.list(p).find(job=>job.sourceRefs.length===0)!;expect(timer).toBeDefined();
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.state','failed','$.error','source_changed') WHERE id=?").run(timer.id);
 retireMemoryJobs({home:s.home,before,apply:true});s.restart();
 const restarted=createMemoryScheduler(s.services.memory,s.services.jobs),count=s.services.jobs.list(p).length;
 for(let i=0;i<3;i++)restarted.scan(now+20_000+i*1000);
 expect(s.services.jobs.list(p)).toHaveLength(count);expect(s.services.jobs.list(p,{states:['queued','pending','running']})).toEqual([]);
});
