import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import { createCodeGraph } from '../server/code-graph';
import type { Config } from '../shared/types';
import type { CodexClient, CodexOptions } from '../server/codex';
import { readConfig, writeConfig } from '../server/config';
let dir:string,home:string,source:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,config:Config,options:CodexOptions,roots:unknown;
beforeEach(()=>{dir=realpathSync(mkdtempSync(join(tmpdir(),'codegraph-session-')));home=join(dir,'home');source=join(dir,'source');mkdirSync(join(source,'child'),{recursive:true});execFileSync('git',['init','-q',source]);writeFileSync(join(source,'parent.ts'),'export function parentSymbol(){}');writeFileSync(join(source,'child','child.ts'),'export function childSymbol(){}');store=openStore(home);
 config={version:2,projects:[{id:'p',name:'p',cwd:join(source,'child'),resources:[],agentIds:['a'],mcp:[],skills:[],workspaces:[{id:'w',name:'w',cwd:join(source,'child'),resources:[],codeGraph:{enabled:true,scope:'repository'}}]}],agents:[{id:'a',name:'a',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}]};
 manager=createSessionManager(store,async()=>config,async o=>{options=o;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'native',resumeThread:async()=>{},startTurn:async(_id,_text,_mode,dirs)=>{roots=dirs;return 'turn';},interrupt:async()=>{o.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'interrupted'}}});},replyApproval(){},close(){}} as CodexClient;},undefined,home);
});
afterEach(async()=>{await manager.close();store.close();rmSync(dir,{recursive:true,force:true});});
test('whole-repository read snapshot is separate from native writable roots and follows live token revocation',async()=>{
 await manager.codeGraph.reconcile();const c=await manager.create('p','a');await manager.send(c.id,'hold');const invocation=store.database.prepare('SELECT invocation_id FROM file_execution_scopes WHERE conversation_id=?').get(c.id)!.invocation_id as string;
 const {token}=JSON.parse(readFileSync(join(home,'runtime','cli',invocation,'context.json'),'utf8'));
 expect(roots).toContain(join(source,'child'));expect(roots).not.toContain(source);expect(options.cwd).toBe(join(source,'child'));
 expect(await manager.callBoundTool(token,'code_graph_search',{bindingId:'cwd',query:'parentSymbol'},'search')).toMatchObject({nodes:[{name:'parentSymbol',path:join(source,'parent.ts')}]});
 config.projects[0].workspaces![0].codeGraph!.scope='directory';await expect(manager.callBoundTool(token,'code_graph_search',{bindingId:'cwd',query:'parentSymbol'},'narrow')).resolves.toMatchObject({nodes:[]});
 config.projects[0].workspaces![0].codeGraph!.enabled=false;await expect(manager.callBoundTool(token,'code_graph_search',{bindingId:'cwd',query:'childSymbol'},'disabled')).rejects.toMatchObject({status:403});
 await manager.stop(c.id);await expect(manager.callBoundTool(token,'code_graph_status',{},'late')).rejects.toMatchObject({status:403});
});
test('config persists independent settings and rejects remote enable or arbitrary scope fields',async()=>{
 const original=await readConfig(home);await writeConfig(home,config,original.revision);expect((await readConfig(home)).config.projects[0].workspaces![0].codeGraph).toEqual({enabled:true,scope:'repository'});
 for(const value of [{enabled:true,scope:'all'},{enabled:'yes',scope:'directory'},{enabled:true,scope:'directory',root:source}]){const current=await readConfig(home);(current.config.projects[0].workspaces![0] as any).codeGraph=value;await expect(writeConfig(home,current.config,current.revision)).rejects.toThrow();}
 const current=await readConfig(home);current.config.projects[0].workspaces![0].resources.push({id:'remote',label:'remote',kind:'remote-git',location:'https://example.com/repo',codeGraph:{enabled:true,scope:'directory'}});await expect(writeConfig(home,current.config,current.revision)).rejects.toThrow();
});
test('writeConfig materializes an empty cwd under HOME/workspaces and indexes it while excluding actual managed trees',async()=>{
 config.projects[0].workspaces![0].cwd='';config.projects[0].workspaces![0].codeGraph={enabled:true,scope:'directory'};
 const current=await readConfig(home);await writeConfig(home,config,current.revision);config=(await readConfig(home)).config;
 const workspace=config.projects[0].workspaces![0];expect(workspace.cwd).toBe(join(home,'workspaces','p','w'));writeFileSync(join(workspace.cwd,'materialized.ts'),'export function materializedWorkspace(){}');
 for(const path of [join(home,'runtime','cli','turn'),join(home,'outputs','conversations','chat','turn'),join(home,'code-graph','fixture','source')]){mkdirSync(path,{recursive:true});writeFileSync(join(path,'excluded.ts'),'export function excludedManagedSymbol(){}');}
 workspace.resources.push({id:'home',label:'Explicit home view',kind:'local',location:home,codeGraph:{enabled:true,scope:'directory'}});
 await manager.codeGraph.reconcile();const scope=await manager.codeGraph.capture({projectId:'p',agentId:'a',workspaceId:'w',cwd:workspace.cwd});
 expect((await manager.codeGraph.query(scope,'search',{bindingId:'cwd',query:'materializedWorkspace'})).nodes).toMatchObject([{path:join(workspace.cwd,'materialized.ts')}]);
 expect((await manager.codeGraph.query(scope,'search',{bindingId:'resource:home',query:'excludedManagedSymbol'})).nodes).toEqual([]);
});

test('completed writeConfig revocation invalidates even an older final configuration-only read',async()=>{
 await manager.close();await writeConfig(home,config,(await readConfig(home)).revision);let armed=false,reads=0;
 const graph=createCodeGraph({home,store,loadConfig:async()=>{const current=await readConfig(home),snapshot=structuredClone(current.config);if(armed&&++reads===4){current.config.projects[0].workspaces![0].codeGraph!.enabled=false;await writeConfig(home,current.config,current.revision);}return snapshot;}});
 try{
  await graph.reconcile();const prior=store.database.prepare('SELECT generation,manifest FROM code_indexes').get();writeFileSync(join(source,'child','child.ts'),'export function revokedPublication(){}');armed=true;await graph.reconcile();
  expect((await readConfig(home)).config.projects[0].workspaces![0].codeGraph!.enabled).toBe(false);expect(store.database.prepare('SELECT generation,manifest FROM code_indexes').get()).toEqual(prior);expect(store.database.prepare('SELECT status FROM code_indexes').get()!.status).toBe('stale');
  const current=await readConfig(home);current.config.projects[0].workspaces![0].codeGraph!.enabled=true;await writeConfig(home,current.config,current.revision);await graph.reconcile();expect((await graph.bindings('p','w'))[0].status).toBe('ready');
 }finally{await graph.close();}
});

test('save already pending before reconciliation invalidates old snapshots after its completion',async()=>{
 await manager.close();await writeConfig(home,config,(await readConfig(home)).revision);let pendingSave:Promise<string>|undefined;const old=structuredClone((await readConfig(home)).config);
 const graph=createCodeGraph({home,store,loadConfig:async()=>{if(pendingSave){await pendingSave;return structuredClone(old);}return (await readConfig(home)).config;}});
 try{
  await graph.reconcile();const prior=store.database.prepare('SELECT generation,manifest FROM code_indexes').get();writeFileSync(join(source,'child','child.ts'),'export function pendingSaveChange(){}');
  const current=await readConfig(home);current.config.projects[0].workspaces![0].codeGraph!.enabled=false;pendingSave=writeConfig(home,current.config,current.revision);await graph.reconcile();await pendingSave;
  expect((await readConfig(home)).config.projects[0].workspaces![0].codeGraph!.enabled).toBe(false);expect(store.database.prepare('SELECT generation,manifest FROM code_indexes').get()).toEqual(prior);expect(store.database.prepare('SELECT status FROM code_indexes').get()!.status).toBe('stale');
 }finally{await graph.close();}
});
