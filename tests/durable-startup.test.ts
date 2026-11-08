import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, acquireWorkspaceMaintenance } from '../server/store';
import { createTaskResources } from '../server/task-resources';

test('occupied old-service port prevents every home bootstrap write', async () => {
 const home = mkdtempSync(join(tmpdir(), 'mana-occupied-'));
 const server = createServer((_q, r) => r.end('old service'));
 await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
 const port = (server.address() as { port:number }).port;
 writeFileSync(join(home, 'knowledge.json'), '[]');
 try {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], { cwd: process.cwd(), env:{...process.env, OPEN_MANA_HOME:home, OPEN_MANA_PORT:String(port)}, stdio:['ignore','pipe','pipe'] });
  let output = ''; child.stderr.on('data', x => { output += x; });
  const code = await new Promise<number|null>(r => child.on('exit', r));
  expect(code).not.toBe(0); expect(output).toContain('EADDRINUSE');
  expect(readdirSync(home)).toEqual(['knowledge.json']);
  expect(readFileSync(join(home,'knowledge.json'),'utf8')).toBe('[]');
  expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('old service');
 } finally { await new Promise<void>(r => server.close(() => r())); rmSync(home,{recursive:true,force:true}); }
}, 15000);

test('a killed server can restart its synthetic home without dropping persisted native uncertainty', async () => {
 const home=mkdtempSync(join(tmpdir(),'mana-crash-restart-'));
 const children: ReturnType<typeof spawn>[]=[];
 const start=()=>{
  const child=spawn(process.execPath,['--import','tsx','server/main.ts'],{cwd:process.cwd(),env:{...process.env,OPEN_MANA_HOME:home,OPEN_MANA_PORT:'0'},stdio:['ignore','pipe','pipe']});children.push(child);
  let output='';
  const ready=new Promise<boolean>(resolve=>{child.stdout.on('data',data=>{output+=data;if(output.includes('Mandala:'))resolve(true);});child.stderr.on('data',data=>{output+=data;});child.on('exit',()=>resolve(false));});
  return {child,ready,output:()=>output};
 };
 try{
  const first=start();expect(await first.ready,first.output()).toBe(true);
  const exited=new Promise<void>(resolve=>first.child.once('exit',()=>resolve()));first.child.kill('SIGKILL');await exited;
  expect(readdirSync(join(home,'.store-leases'))).toHaveLength(1);
  const retained=openStore(home),conversation=retained.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
  retained.database.prepare('INSERT INTO task_native_uncertainty VALUES (?,?,?)').run('run','unresolved-physical-run',conversation.id);
  const resources=createTaskResources(retained);resources.claim({kind:'run',id:'unresolved-physical-run',conversationId:conversation.id},[home],'write');resources.submitted('run','unresolved-physical-run','unresolved-physical-run','native-session');resources.bindTurn('run','unresolved-physical-run','unresolved-physical-run','native-session','native-turn');retained.close();
  const second=start();expect(await second.ready,second.output()).toBe(true);
  const readback=openStore(home);
  try{expect(readback.database.prepare('SELECT owner_id,submitted,native_turn_id FROM task_directory_claims').all()).toEqual([{owner_id:'unresolved-physical-run',submitted:1,native_turn_id:'native-turn'}]);expect(readback.database.prepare('SELECT * FROM task_native_uncertainty').all()).toEqual([{kind:'run',claim_id:'unresolved-physical-run',conversation_id:conversation.id}]);}finally{readback.close();}
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;}
  rmSync(home,{recursive:true,force:true});
 }
},15000);

test('live and malformed Store leases continue to block maintenance',()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-lease-gate-')),store=openStore(home);let closed=false;
 try{
  expect(()=>acquireWorkspaceMaintenance(home)).toThrow('workspace_in_use');store.close();closed=true;
  writeFileSync(join(home,'.store-leases','ambiguous-owner'),'open');
  expect(()=>acquireWorkspaceMaintenance(home)).toThrow('workspace_in_use');
  expect(readFileSync(join(home,'.store-leases','ambiguous-owner'),'utf8')).toBe('open');
 }finally{if(!closed)store.close();rmSync(home,{recursive:true,force:true});}
});

test('startup can authorize persisted memory evidence before the memory repair migration reads it',async()=>{
 const {readConfig}=await import('../server/config'),{migrateWorkspace}=await import('../server/workspace-migrations'),{createMemoryRuntime}=await import('../server/memory-runtime');
 const home=mkdtempSync(join(tmpdir(),'mana-memory-restart-')),config=(await readConfig(home)).config;
 config.system={...config.system,cli:config.system?.cli??'codex',memoryCapture:false,memory:{request:{generate:false,read:true},session:{generate:false,read:true}}};
 writeFileSync(join(home,'config.json'),JSON.stringify(config));await migrateWorkspace(home,'apply');
 const store=openStore(home),runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,generate:async()=> '[]'});
 await runtime.initialize();
 const root={userId:store.ownerUserId},c=runtime.memory.ensureCollection(root,{projectId:null,agentId:null}),chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null}),text='Use verified evidence for delivery.';
 const event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
 const source=runtime.memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit'}).sources[0];
 const fact=runtime.memory.applyProposal(root,{collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted'},c.generation,'evidence_extract')!;
 await runtime.close();store.close();
 const child=spawn(process.execPath,['--import','tsx','server/main.ts'],{cwd:process.cwd(),env:{...process.env,OPEN_MANA_HOME:home,MANDALA_HOME:home,OPEN_MANA_PORT:'0',MANDALA_PORT:'0'},stdio:['ignore','pipe','pipe']});let output='';
 try{
  const ready=await new Promise<boolean>(resolve=>{child.stdout.on('data',data=>{output+=data;if(output.includes('Mandala:'))resolve(true);});child.stderr.on('data',data=>output+=data);child.once('exit',()=>resolve(false));});
  expect(ready,output).toBe(true);
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(home,'state.sqlite'),{readOnly:true});
  try{expect(JSON.parse(db.prepare('SELECT data FROM memory_records WHERE id=?').get(fact.recordId)!.data as string).text).toBe(text);}finally{db.close();}
 }finally{
  if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await exited;}
  rmSync(home,{recursive:true,force:true});
 }
},15000);
