import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { readConfig, writeConfig } from '../server/config';
import { createSkillLearning } from '../server/skill-learning';
import { createSkillService } from '../server/skill-service';
let home:string,store:ReturnType<typeof openStore>,runtime:ReturnType<typeof createSkillLearning>;
const content='---\nname: inspect\ndescription: Inspect saved state\n---\nRead back the saved result; verification is still required.';
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'skill-learning-'));store=openStore(home);const s=await readConfig(home);await writeConfig(home,{...s.config,agents:[{id:'a',name:'a',instructions:'',defaultCli:'codex',models:{},skills:[],mcp:[]}]},s.revision);});
afterEach(async()=>{await runtime?.close();store.close();await rm(home,{recursive:true,force:true});});
const round=(id:string,tools=0)=>{store.appendEvent(id,'user',{text:'Inspect, fix, and verify the saved result'});for(let i=0;i<tools;i++)store.appendEvent(id,'tool',{method:'item/completed',params:{item:{type:'commandExecution',command:'inspect',aggregatedOutput:'checked'}}});store.appendEvent(id,'tool',{method:'item/completed',params:{item:{id:'reply',type:'agentMessage',phase:'final_answer',text:'Readback succeeded; reuse these steps.'}}});store.appendEvent(id,'tool',{method:'item/completed',params:{item:{type:'reasoning',text:'PRIVATE_THOUGHT'}}});store.appendEvent(id,'status',{status:'idle'});};
const chat=()=>store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
test('ordinary final/tool events batch at ten calls, include related skills, exclude reasoning and never reprocess old progress',async()=>{
 const service=createSkillService(home,store);await service('a','skill_register',{name:'inspect',content},'seed',()=>{});
 const c=chat();let calls=0,prompt='';runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async(_config,input)=>{calls++;prompt=input;return JSON.stringify({action:'skip'});}});
 round(c.id,9);await runtime.capture(c.id);await runtime.drain();expect(calls).toBe(0);
 round(c.id,1);await runtime.capture(c.id);await runtime.drain();expect(calls).toBe(1);expect(prompt).toContain('Readback succeeded');expect(prompt).toContain(content.replaceAll('\n','\\n'));expect(prompt).not.toContain('PRIVATE_THOUGHT');
 await runtime.capture(c.id,true);await runtime.drain();expect(calls).toBe(1);
 round(c.id);await runtime.capture(c.id,true);await runtime.drain();expect(calls).toBe(2);
});
test('saved output survives publication failure and restart without another generation',async()=>{
 const c=chat();let calls=0;let fail=true;
 const generate=async()=>{calls++;return JSON.stringify({action:'new',name:'inspect',content});};
 runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate,beforePublish:()=>{if(fail)throw new Error('interruption');}});
 round(c.id);await runtime.capture(c.id,true);await runtime.drain();expect(calls).toBe(1);expect((await readConfig(home)).config.skillLibrary??[]).toHaveLength(0);
 await runtime.close();fail=false;runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate});await runtime.reconcile();await runtime.drain();
 expect(calls).toBe(1);const skill=(await readConfig(home)).config.skillLibrary![0];expect(skill.source).toMatchObject({method:'dialogue',verification:'draft',conversationId:c.id});expect(skill.creatorAgentId).toBe('a');
});
test.each(['disabled','source-replaced','agent-revoked'])('rejects an in-flight result after %s',async kind=>{
 const c=chat();let finish!:(value:string)=>void;runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>new Promise(resolve=>{finish=resolve;})});
 round(c.id);await runtime.capture(c.id,true);const work=runtime.drain();await expect.poll(()=>typeof finish).toBe('function');
 if(kind==='source-replaced')store.replaceHistory(c.id,store.listEvents(c.id,0)[0].id,'branched');else{const snapshot=await readConfig(home);if(kind==='disabled')snapshot.config.system={cli:'codex',skillLearning:false};else snapshot.config.agents=[];await writeConfig(home,snapshot.config,snapshot.revision);}
 finish(JSON.stringify({action:'new',name:'inspect',content}));await work;expect((await readConfig(home)).config.skillLibrary??[]).toHaveLength(0);
});
test('a disable then reenable while generating permanently invalidates that batch',async()=>{
 const c=chat();let finish!:(value:string)=>void;runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>new Promise(resolve=>{finish=resolve;})});
 round(c.id);await runtime.capture(c.id,true);const work=runtime.drain();await expect.poll(()=>typeof finish).toBe('function');
 let snapshot=await readConfig(home);snapshot.config.system={cli:'codex',skillLearning:false};await writeConfig(home,snapshot.config,snapshot.revision);
 snapshot=await readConfig(home);snapshot.config.system!.skillLearning=true;await writeConfig(home,snapshot.config,snapshot.revision);
 finish(JSON.stringify({action:'new',name:'inspect',content}));await work;expect((await readConfig(home)).config.skillLibrary??[]).toHaveLength(0);
});
test('removing an original dialogue source prevents later reads and native resolution',async()=>{
 const c=chat();runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>JSON.stringify({action:'new',name:'inspect',content})});
 round(c.id);await runtime.capture(c.id,true);await runtime.drain();const skill=(await readConfig(home)).config.skillLibrary![0];
 store.replaceHistory(c.id,store.listEvents(c.id,0)[0].id,'replaced');
 await expect(createSkillService(home,store)('a','skill_read',{skillId:skill.id},'',()=>{})).rejects.toMatchObject({status:403});
});
test('relevance selects the complete authorized Skill body beyond ten thousand characters',async()=>{
 const service=createSkillService(home,store),longContent=content+'\n'+('Readback verification conditions. '.repeat(400))+'\nFINAL_REQUIRED_CHECK';
 for(let i=0;i<9;i++)await service('a','skill_register',{name:'unrelated'+i,content:'---\nname: unrelated'+i+'\ndescription: Gardening plants\n---\nWater flowers.'},'unrelated'+i,()=>{});
 await service('a','skill_register',{name:'inspect',content:longContent},'related',()=>{});
 let prompt='';runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async(_config,input)=>{prompt=input;return JSON.stringify({action:'skip'});}});
 const c=chat();round(c.id);await runtime.capture(c.id,true);await runtime.drain();const source=JSON.parse(prompt.split('SOURCE_JSON:\n')[1]);
 expect(source.relatedSkills.some((skill:any)=>skill.name==='inspect'&&skill.content===longContent)).toBe(true);
});
test('bounded excerpts mark truncation and redact credential fields before durable capture',async()=>{
 const c=chat();store.appendEvent(c.id,'user',{text:'Inspect saved state'});store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{type:'functionCall',name:'inspect',arguments:{api_key:'SECRET_VALUE'},result:'x'.repeat(12000)}}});store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{id:'reply',type:'agentMessage',text:'Inspection remains unverified'}}});store.appendEvent(c.id,'status',{status:'idle'});
 let prompt='';runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async(_config,input)=>{prompt=input;return JSON.stringify({action:'skip'});}});await runtime.capture(c.id,true);await runtime.drain();
 expect(prompt).toContain('truncated');expect(prompt).not.toContain('SECRET_VALUE');expect(JSON.stringify(store.database.prepare('SELECT data FROM skill_learning_jobs').all())).not.toContain('SECRET_VALUE');
});
test('dialogue evidence is retained in each immutable AssetVersion',async()=>{
 const c=chat();runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>JSON.stringify({action:'new',name:'inspect',content})});round(c.id);await runtime.capture(c.id,true);await runtime.drain();
 const skill=(await readConfig(home)).config.skillLibrary![0];const version=JSON.parse(store.database.prepare('SELECT data FROM asset_versions WHERE id=?').get(skill.versionRef!.versionId)!.data as string);
 expect(version.provenance.skill.source).toMatchObject({conversationId:c.id,verification:'draft',method:'dialogue'});
});
test('forty KiB of new content queues without ten tools and idle reconciliation queues smaller progress',async()=>{
 let calls=0;runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>{calls++;return JSON.stringify({action:'skip'});}});const c=chat();
 for(let i=0;i<5;i++){store.appendEvent(c.id,'user',{text:'Inspect '+('a'.repeat(11000))});store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{id:'reply'+i,type:'agentMessage',text:'Recorded'}}});store.appendEvent(c.id,'status',{status:'idle'});await runtime.capture(c.id);}
 await runtime.drain();expect(calls).toBe(1);
 round(c.id);await runtime.capture(c.id);store.database.prepare("UPDATE skill_learning_batches SET data=json_set(data,'$.updatedAt',0)").run();await runtime.reconcile();await runtime.drain();expect(calls).toBe(2);
});
test('a durable completion capture survives a configuration failure before its cursor advances',async()=>{
 const c=chat();round(c.id);runtime=createSkillLearning({home,store,loadConfig:async()=>{throw new Error('temporary config outage');},generate:async()=>JSON.stringify({action:'skip'})});
 await expect(runtime.capture(c.id,true)).rejects.toThrow('temporary config outage');
 expect(store.listOutbox(0).some(event=>event.type==='skill.capture_requested')).toBe(true);
 await runtime.close();let calls=0;runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>{calls++;return JSON.stringify({action:'skip'});}});await runtime.reconcile();await runtime.drain();expect(calls).toBe(1);
});
test('capture delivery cannot regress its cursor when configuration promises finish in reverse order',async()=>{
 const c=chat(),config=(await readConfig(home)).config,releases:(()=>void)[]=[];
 runtime=createSkillLearning({home,store,loadConfig:async()=>new Promise(resolve=>releases.push(()=>resolve(config))),generate:async()=>JSON.stringify({action:'skip'})});
 round(c.id);const first=runtime.capture(c.id);await expect.poll(()=>releases.length).toBe(1);
 round(c.id);const terminal=store.listEvents(c.id,0).at(-1)!.id,second=runtime.capture(c.id,true);
 await new Promise(resolve=>setTimeout(resolve,10));if(releases[1])releases[1]();releases[0]();
 for(let i=0;i<6;i++){await new Promise(resolve=>setTimeout(resolve,5));for(const release of releases)release();}
 await Promise.all([first,second]);
 expect(store.database.prepare('SELECT event_id FROM skill_learning_cursors WHERE conversation_id=?').get(c.id)!.event_id).toBe(terminal);
 const fragments=store.database.prepare('SELECT data FROM skill_learning_jobs UNION ALL SELECT data FROM skill_learning_batches').all().flatMap(row=>JSON.parse(row.data as string).fragments);
 expect(new Set(fragments.map(f=>f.eventId)).size).toBe(fragments.length);
});
test('every split chunk retains source authorization and cannot publish after an early-chunk source is revoked',async()=>{
 const {createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files'),{workspacePrincipal}=await import('../server/workspace-identity'),{mkdir,writeFile}=await import('node:fs/promises');
 const files=createAssetFiles(home),assets=createAssets(store,files),root=workspacePrincipal(store),directory=join(home,'input');await mkdir(directory);await writeFile(join(directory,'source.txt'),'input evidence');const staged=await files.stageFiles(root,null,[{allowedRoot:directory,relativePath:'source.txt',manifestPath:'source.txt'}]);const imported=assets.importAsset(root,{kind:'file',title:'source',agentId:'a',submissionId:staged.submissionId},'source');const ref={assetId:imported.asset.id,versionId:imported.version.id};
 const c=chat();store.appendEvent(c.id,'user',{text:'Inspect source'});store.appendEvent(c.id,'metadata',{sourceVersions:[ref]});for(let i=0;i<15;i++)store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{type:'commandExecution',command:'inspect',aggregatedOutput:'x'.repeat(8000)}}});store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{type:'agentMessage',text:'Result'}}});store.appendEvent(c.id,'status',{status:'idle'});
 let calls=0;runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>{calls++;return JSON.stringify({action:'new',name:'inspect',content});}});await runtime.capture(c.id,true);
 const jobs=store.database.prepare('SELECT data FROM skill_learning_jobs').all().map(row=>JSON.parse(row.data as string));expect(jobs.length).toBeGreaterThan(1);for(const job of jobs)expect(job.sourceVersions).toEqual([ref]);
 assets.setLifecycle(root,ref.assetId,'retracted',assets.getAuthorizedAsset(root,ref.assetId).revision);await runtime.drain();expect(calls).toBe(0);expect((await readConfig(home)).config.skillLibrary??[]).toHaveLength(0);
});
test('saved generated output retries a proven precommit journal failure after restart',async()=>{
 const c=chat();let calls=0;const generate=async()=>{calls++;return JSON.stringify({action:'new',name:'inspect',content});};runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate});store.database.exec("CREATE TRIGGER reject_stage BEFORE INSERT ON skill_publication_journal BEGIN SELECT RAISE(ABORT,'fault'); END");round(c.id);await runtime.capture(c.id,true);await runtime.drain();expect(calls).toBe(1);store.database.prepare('UPDATE skill_registration_receipts SET complete=0').run();await runtime.close();store.database.exec('DROP TRIGGER reject_stage');runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate});await runtime.reconcile();await runtime.drain();expect(calls).toBe(1);expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
});
test('completed dialogue is durably queued in the existing outbox and consumed after restart without a capture call',async()=>{
 const c=chat();round(c.id);expect(store.listOutbox(0).some(event=>event.type==='skill.dialogue_completed'&&event.aggregateId===c.id)).toBe(true);
 runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>JSON.stringify({action:'skip'})});await runtime.reconcile();expect(store.database.prepare('SELECT event_id FROM skill_learning_cursors WHERE conversation_id=?').get(c.id)!.event_id).toBe(store.listEvents(c.id,0).at(-1)!.id);
 const offset=store.database.prepare('SELECT sequence FROM skill_learning_consumer WHERE id=1').get()!.sequence;await runtime.close();runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>JSON.stringify({action:'skip'})});await runtime.reconcile();expect(store.database.prepare('SELECT sequence FROM skill_learning_consumer WHERE id=1').get()!.sequence).toBe(offset);
});
test('completion and outbox record roll back together and disabled completion is excluded after reopening',async()=>{
 const c=chat();store.appendEvent(c.id,'user',{text:'Disabled material'});
 store.database.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON outbox WHEN NEW.type='skill.dialogue_completed' BEGIN SELECT RAISE(ABORT,'completion fault'); END");
 expect(()=>store.appendEvent(c.id,'status',{status:'idle'})).toThrow();expect(store.listEvents(c.id,0).filter(event=>event.kind==='status')).toHaveLength(0);store.database.exec('DROP TRIGGER reject_completion');
 let snapshot=await readConfig(home);snapshot.config.system={cli:'codex',skillLearning:false};await writeConfig(home,snapshot.config,snapshot.revision);store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{type:'agentMessage',text:'Disabled response'}}});store.appendEvent(c.id,'status',{status:'idle'});
 snapshot=await readConfig(home);snapshot.config.system!.skillLearning=true;await writeConfig(home,snapshot.config,snapshot.revision);runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>JSON.stringify({action:'skip'})});await runtime.reconcile();expect(store.database.prepare('SELECT COUNT(*) AS n FROM skill_learning_batches').get()!.n).toBe(0);
 round(c.id);await runtime.capture(c.id,true);const jobs=store.database.prepare('SELECT data FROM skill_learning_jobs').all().map(row=>JSON.parse(row.data as string));expect(jobs).toHaveLength(1);expect(JSON.stringify(jobs)).not.toContain('Disabled material');
});
test('capture delivered while an empty outbox read settles is not lost',async()=>{
 const c=chat();runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>JSON.stringify({action:'skip'})});
 const empty=runtime.reconcile();round(c.id);await runtime.capture(c.id,true);await empty;
 expect(store.database.prepare('SELECT event_id FROM skill_learning_cursors WHERE conversation_id=?').get(c.id)?.event_id).toBe(store.listEvents(c.id,0).at(-1)!.id);
});
test('idle reconciliation and a newer forced capture serialize without deleting or duplicating progress',async()=>{
 const c=chat(),config=(await readConfig(home)).config;let paused=false;const releases:(()=>void)[]=[];
 runtime=createSkillLearning({home,store,loadConfig:async()=>paused?new Promise(resolve=>releases.push(()=>resolve(config))):config,generate:async()=>JSON.stringify({action:'skip'})});round(c.id);await runtime.capture(c.id);store.database.prepare("UPDATE skill_learning_batches SET data=json_set(data,'$.updatedAt',0)").run();paused=true;
 const idle=runtime.reconcile();await expect.poll(()=>releases.length).toBe(1);round(c.id);const capture=runtime.capture(c.id,true);await new Promise(resolve=>setTimeout(resolve,10));expect(releases).toHaveLength(1);for(let i=0;i<6;i++){for(const release of releases)release();await new Promise(resolve=>setTimeout(resolve,5));}await Promise.all([idle,capture]);
 const fragments=store.database.prepare('SELECT data FROM skill_learning_jobs UNION ALL SELECT data FROM skill_learning_batches').all().flatMap(row=>JSON.parse(row.data as string).fragments);expect(fragments).toHaveLength(4);expect(new Set(fragments.map(f=>f.eventId)).size).toBe(4);
});

test('permanently revoked jobs stop consuming retries and writing after a bounded outcome',async()=>{
 const c=chat();runtime=createSkillLearning({home,store,loadConfig:async()=>(await readConfig(home)).config,generate:async()=>{throw new Error('must not generate');}});round(c.id);await runtime.capture(c.id,true);store.replaceHistory(c.id,store.listEvents(c.id,0)[0].id,'replaced');
 for(let i=0;i<4;i++)await runtime.drain();const before=store.database.prepare('SELECT total_changes() AS n').get()!.n;await runtime.drain();expect(store.database.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
});
