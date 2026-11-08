import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Config, Conversation, Workspace } from '../shared/types';
import { openStore } from '../server/store';
import { createCodeGraph } from '../server/code-graph';
import * as sources from '../server/code-graph-sources';
let dir:string, home:string, source:string, config:Config, store:ReturnType<typeof openStore>, service:ReturnType<typeof createCodeGraph>;
const ws=(id:string,cwd:string):Workspace=>({id,name:id,cwd,resources:[],codeGraph:{enabled:true,scope:'directory'}});
const chat=(workspaceId='parent',cwd?:string)=>({projectId:'p',agentId:'a',workspaceId,cwd} as Conversation);
const bindings=()=>service.bindings('p','parent');
const query=async(query:string,workspaceId='parent')=>service.query(await service.capture(chat(workspaceId)),'search',{bindingId:'cwd',query});
beforeEach(async()=>{
 dir=await realpath(await mkdtemp(join(tmpdir(),'mandala-codegraph-'))); home=join(dir,'home');source=join(dir,'source');await mkdir(source);await mkdir(join(source,'child'));
 await writeFile(join(source,'child','leaf.ts'),'export function leaf() { return 1; }\n');
 await writeFile(join(source,'bridge.ts'),"import { leaf } from './child/leaf';\nexport function bridge() { return leaf(); }\n");
 await writeFile(join(source,'child','entry.ts'),"import { bridge } from '../bridge';\nexport function entry() { return bridge(); }\n");
 config={version:2,projects:[{id:'p',name:'p',cwd:source,resources:[],agentIds:['a'],skills:[],mcp:[],workspaces:[ws('parent',source),ws('child',join(source,'child'))]}],agents:[{id:'a',name:'a',instructions:'',defaultCli:'codex',models:{},skills:[],mcp:[]}]};
 store=openStore(home);service=createCodeGraph({home,store,loadConfig:async()=>config});
});
afterEach(async()=>{vi.restoreAllMocks();await service?.close();store?.close();await rm(dir,{recursive:true,force:true});});
test('physical aliases reuse; child counts, search, snippets and calls stay clipped at every traversal hop',async()=>{
 await symlink(source,join(dir,'alias'));config.projects[0].workspaces!.push(ws('alias',join(dir,'alias')));await service.reconcile();
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM code_indexes').get()!.n).toBe(1);
 const child=(await service.bindings('p','child'))[0];expect(child.files).toBe(2);expect(child.root).toBe(join(source,'child'));
 expect((await query('bridge','child')).nodes.every((n:any)=>n.path.startsWith(join(source,'child')+'/'))).toBe(true);
 const entry=(await query('entry','child')).nodes.find((n:any)=>n.name==='entry'&&n.kind==='function');expect(entry).toBeTruthy();
 const scope=await service.capture(chat('child'));const result=await service.query(scope,'callees',{bindingId:'cwd',nodeId:entry!.id,depth:4});expect(result.nodes).toHaveLength(0);expect(result.boundary).toContain('unresolved');
 const parentBridge=(await query('bridge')).nodes.find((n:any)=>n.kind==='function');await expect(service.query(scope,'definition',{bindingId:'cwd',nodeId:parentBridge!.id})).rejects.toMatchObject({status:403});
 const def=await service.query(scope,'definition',{bindingId:'cwd',nodeId:entry!.id});expect(def.snippet).toContain('function entry');expect(def.nodes[0].path).toBe(join(source,'child','entry.ts'));
 expect(await stat(join(source,'.codegraph')).catch(()=>null)).toBeNull();expect(await readFile(join(source,'bridge.ts'),'utf8')).toContain('return leaf');
});
test('only child enabled never scans parent; whole-repository opt-in is independent and cannot broaden in-flight scopes',async()=>{
 execFileSync('git',['init','-q',source]);config.projects[0].workspaces![0].codeGraph!.enabled=false;
 const before=await service.capture(chat('child'));await service.reconcile();expect(store.database.prepare('SELECT source_root FROM code_indexes').get()!.source_root).toBe(join(source,'child'));
 config.projects[0].workspaces![1].codeGraph!.scope='repository';await service.reconcile();const now=await service.capture(chat('child'));expect(now.bindings[0].allowedRoot).toBe(source);
 const bridge=(await service.query(now,'search',{bindingId:'cwd',query:'bridge'})).nodes.find((n:any)=>n.kind==='function');expect(bridge).toBeTruthy();await expect(service.query(before,'definition',{bindingId:'cwd',nodeId:bridge!.id})).rejects.toMatchObject({status:403});
 config.projects[0].workspaces![1].codeGraph!.scope='directory';await expect(service.query(now,'definition',{bindingId:'cwd',nodeId:bridge!.id})).rejects.toMatchObject({status:403});
});
test('dirty edits, deletion and rename reject stale rows until sync, preserve copies and recover on restart',async()=>{
 await service.reconcile();const first=(await bindings())[0];const scope=await service.capture(chat());await writeFile(join(source,'child','leaf.ts'),'export function changed() { return 2; }\n');
 await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).rejects.toMatchObject({code:'code_graph_stale'});expect((await bindings())[0].status).toBe('stale');await service.reconcile();expect((await query('changed')).nodes.some((n:any)=>n.name==='changed')).toBe(true);
 await rename(join(source,'child','leaf.ts'),join(source,'renamed.js'));await rm(join(source,'bridge.ts'));await service.reconcile();expect((await query('bridge')).nodes.filter((n:any)=>n.kind==='function')).toEqual([]);expect((await query('changed')).nodes[0].path).toBe(join(source,'renamed.js'));
 const generation=(await bindings())[0].generation;expect(generation).toBeGreaterThan(first.generation!);await service.close();service=createCodeGraph({home,store,loadConfig:async()=>config});await service.reconcile();expect((await bindings())[0].generation).toBe(generation);
});
test('disable independently, retain cache, remove revoked scopes and stop all-off maintenance',async()=>{
 await service.reconcile();const scope=await service.capture(chat());config.projects[0].workspaces![0].codeGraph!.enabled=false;await service.reconcile();await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).rejects.toMatchObject({status:403});expect((await query('leaf','child')).nodes.length).toBeGreaterThan(0);
 expect(store.database.prepare('SELECT ref_count FROM code_indexes WHERE ref_count>0').get()!.ref_count).toBe(1);
 config.projects[0].workspaces![1].codeGraph!.enabled=false;await service.reconcile();const rows=store.database.prepare('SELECT * FROM code_indexes').all();await writeFile(join(source,'child','leaf.ts'),'export function stopped(){}');await service.reconcile();expect(store.database.prepare('SELECT * FROM code_indexes').all()).toEqual(rows);
});
test('invocation identity, saved cwd and resource roots cannot be replaced or expanded',async()=>{
 await service.reconcile();const scope=await service.capture(chat('parent',source));config.projects[0].workspaces![0].resources.push({id:'extra',label:'extra',kind:'local',location:dir,codeGraph:{enabled:true,scope:'directory'}});
 await expect(service.query(scope,'search',{bindingId:'resource:extra',query:'leaf'})).rejects.toMatchObject({status:403});
 config.projects[0].workspaces![0].cwd=join(source,'child');await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).rejects.toMatchObject({status:403});expect((await service.capture(chat('parent',source))).bindings.some(b=>b.bindingId==='cwd')).toBe(false);
 config.projects[0].agentIds=[];await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).rejects.toMatchObject({status:403});
});
test('revalidates invocation after asynchronous source checks and denies caller supplied filesystem roots',async()=>{
 await service.reconcile();const scope=await service.capture(chat());let checks=0;await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf'},()=>{if(++checks>1)throw Object.assign(new Error('revoked'),{status:403});})).rejects.toMatchObject({status:403});
 await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf',root:source})).rejects.toMatchObject({status:422});
});
test('distinct worktrees stay separate; symlinks, ignored/generated files and nested managed home are excluded',async()=>{
 const other=join(dir,'copy');await mkdir(other);await writeFile(join(other,'other.ts'),'export function other(){}');config.projects[0].workspaces!.push(ws('copy',other));
 await symlink(join(other,'other.ts'),join(source,'escape.ts'));await symlink(other,join(source,'escape'));await mkdir(join(source,'node_modules'));await writeFile(join(source,'node_modules','hidden.ts'),'export function hidden(){}');
 execFileSync('git',['init','-q',source]);await writeFile(join(source,'.gitignore'),'ignored.ts\n');await writeFile(join(source,'ignored.ts'),'export function ignored(){}');
 await service.reconcile();expect(store.database.prepare('SELECT COUNT(*) AS n FROM code_indexes').get()!.n).toBe(2);expect((await query('other')).nodes).toEqual([]);expect((await query('hidden')).nodes).toEqual([]);expect((await query('ignored')).nodes).toEqual([]);
});
test('missing, unsupported and remote bindings are explicit, defaults and null workspace do not invent authority',async()=>{
 config.projects[0].workspaces!.push(ws('missing',join(dir,'missing')));const empty=join(dir,'empty');await mkdir(empty);config.projects[0].workspaces!.push(ws('empty',empty));config.projects[0].workspaces![0].resources.push({id:'remote',label:'remote',kind:'remote-git',location:'https://example.com/repo.git'});
 await service.reconcile();expect((await service.bindings('p','missing'))[0].status).toBe('missing');expect((await service.bindings('p','empty'))[0].status).toBe('unsupported');expect((await bindings()).find((b:any)=>b.bindingId==='resource:remote')!.status).toBe('not-checked-out');expect((await service.capture({...chat(),workspaceId:null})).bindings).toEqual([]);
});
test('manifest publication is revoked mid-index and recovery rebuilds a potentially mutated mirror',async()=>{
 await service.reconcile();const scope=await service.capture(chat());await writeFile(join(source,'child','leaf.ts'),'export function uncommitted(){}');
 const prior=JSON.stringify(config);let calls=0;
 await service.close();service=createCodeGraph({home,store,loadConfig:async()=>{if(++calls===2)config.projects[0].workspaces![0].codeGraph!.enabled=false;return config;}});
 await service.reconcile();expect(store.database.prepare('SELECT status FROM code_indexes').get()!.status).toBe('stale');
 config=JSON.parse(prior);await writeFile(join(source,'child','leaf.ts'),'export function leaf() { return 1; }\n');await service.reconcile();expect((await query('uncommitted')).nodes).toEqual([]);expect((await service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).nodes.length).toBeGreaterThan(0);
});
test('non-Git ignore rules and nested managed home exclude source copies and all-off loads no engine',async()=>{
 await writeFile(join(source,'.gitignore'),'secret/\n');await mkdir(join(source,'secret'));await writeFile(join(source,'secret','private.ts'),'export function privateSymbol(){}');
 await service.close();home=join(source,'managed');service=createCodeGraph({home,store,loadConfig:async()=>config});await mkdir(join(home,'code-graph'),{recursive:true});await writeFile(join(home,'code-graph','recursive.ts'),'export function recursiveSymbol(){}');await service.reconcile();expect((await query('privateSymbol')).nodes).toEqual([]);expect((await query('recursiveSymbol')).nodes).toEqual([]);
 config.projects[0].workspaces!.forEach(w=>w.codeGraph!.enabled=false);await service.reconcile();expect(store.database.prepare('SELECT SUM(ref_count) AS n FROM code_indexes').get()!.n).toBe(0);
});
test('different Git worktrees never share an index despite identical commits; directory prefix siblings stay excluded',async()=>{
 execFileSync('git',['init','-q',source]);execFileSync('git',['-C',source,'add','.']);execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const worktree=join(dir,'worktree');execFileSync('git',['-C',source,'worktree','add','--quiet','--detach',worktree]);config.projects[0].workspaces!.push(ws('worktree',worktree));
 await mkdir(join(source,'child-other'));await writeFile(join(source,'child-other','secret.ts'),'export function siblingSecret(){}');await service.reconcile();
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM code_indexes').get()!.n).toBe(2);expect((await query('siblingSecret','child')).nodes).toEqual([]);
 const parent=(await query('leaf')).nodes.find(n=>n.kind==='function'),copy=(await query('leaf','worktree')).nodes.find(n=>n.kind==='function');expect(parent!.path).not.toBe(copy!.path);expect(copy!.path).toBe(join(worktree,'child','leaf.ts'));
});
test('bounded failures stop automatic retries until explicit refresh; changed source then recovers',async()=>{
 await writeFile(join(source,'huge.ts'),'x'.repeat(2*1024*1024+1));await service.reconcile();await service.reconcile();await service.reconcile();const failed=store.database.prepare('SELECT failure_count FROM code_indexes').get();expect(failed!.failure_count).toBe(3);await service.reconcile();expect(store.database.prepare('SELECT failure_count FROM code_indexes').get()).toEqual(failed);
 await rm(join(source,'huge.ts'));await service.refresh('p','parent','cwd');expect((await bindings())[0].status).toBe('ready');
});
test('final post-read authorization cannot publish a wider status or query after a late scope shrink',async()=>{
 execFileSync('git',['init','-q',source]);config.projects[0].workspaces![1].codeGraph!.scope='repository';await service.reconcile();const scope=await service.capture(chat('child'));await service.close();
 let reads=0;service=createCodeGraph({home,store,loadConfig:async()=>{if(++reads===3)config.projects[0].workspaces![1].codeGraph!.scope='directory';return config;}});
 await expect(service.query(scope,'search',{bindingId:'cwd',query:'bridge'})).rejects.toMatchObject({status:403});
 config.projects[0].workspaces![1].codeGraph!.scope='repository';await service.close();reads=0;service=createCodeGraph({home,store,loadConfig:async()=>{if(++reads===2)config.projects[0].workspaces![1].codeGraph!.scope='directory';return config;}});
 expect(await service.boundStatus(scope,()=>{})).toEqual([]);
});
test('canonicalizes a symlink-alias HOME before excluding its nested mirror from source traversal',async()=>{
 await service.close();const nested=join(source,'managed-home'),alias=join(dir,'home-alias');await mkdir(join(nested,'runtime'),{recursive:true});await symlink(nested,alias);await writeFile(join(nested,'runtime','private.ts'),'export function managedPrivate(){}');service=createCodeGraph({home:alias,store,loadConfig:async()=>config});await service.reconcile();expect((await query('managedPrivate')).nodes).toEqual([]);
});
test('resolver metadata-only edits rebuild calls for unchanged source files',async()=>{
 await writeFile(join(source,'tsconfig.json'),JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@leaf':['one.ts']}}}));
 await writeFile(join(source,'one.ts'),'export function targetLeaf() { return 1; }');await writeFile(join(source,'two.ts'),'export function targetLeaf() { return 2; }');await writeFile(join(source,'alias-entry.ts'),"import { targetLeaf } from '@leaf';\nexport function aliasEntry() { return targetLeaf(); }\n");
 await service.reconcile();const scope=await service.capture(chat()),entry=(await query('aliasEntry')).nodes.find(n=>n.kind==='function')!;
 expect((await service.query(scope,'callees',{bindingId:'cwd',nodeId:entry.id})).nodes.map(n=>n.path)).toEqual([join(source,'one.ts')]);
 await writeFile(join(source,'tsconfig.json'),JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@leaf':['two.ts']}}}));await service.reconcile();
 expect((await service.query(scope,'callees',{bindingId:'cwd',nodeId:entry.id})).nodes.map(n=>n.path)).toEqual([join(source,'two.ts')]);
});

test('all-off invocation capture and maintenance perform no directory or Git I/O',async()=>{
 config.projects[0].workspaces!.forEach(workspace=>workspace.codeGraph!.enabled=false);const paths=vi.spyOn(sources,'canonical'),git=vi.spyOn(sources,'repositoryRoot');
 expect((await service.capture(chat())).bindings).toEqual([]);await service.reconcile();expect(paths).not.toHaveBeenCalled();expect(git).not.toHaveBeenCalled();
});

test('SSH workspace graph APIs never inspect or index a same-named local directory',async()=>{
 config.executionMachines=[{id:'linux',name:'Linux',host:'build-host'}];
 config.projects[0].workspaces!.forEach(workspace=>{workspace.machineId='linux';workspace.resources.push({id:'source',label:'Source',kind:'local',location:source,codeGraph:{enabled:true,scope:'directory'}});});
 const paths=vi.spyOn(sources,'canonical'),git=vi.spyOn(sources,'repositoryRoot'),scan=vi.spyOn(sources,'scanSources');
 expect((await service.capture(chat())).bindings).toEqual([]);
 expect((await bindings()).every(binding=>binding.status==='unsupported'&&binding.root===null&&binding.error?.includes('SSH'))).toBe(true);
 await expect(service.refresh('p','parent','cwd')).rejects.toMatchObject({code:'code_graph_unsupported',status:409});
 await service.reconcile();
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM code_indexes').get()!.n).toBe(0);
 expect(paths).not.toHaveBeenCalled();expect(git).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();
});

test('a pinned SSH conversation cannot capture a workspace that was later changed to local',async()=>{
 const paths=vi.spyOn(sources,'canonical');
 const scope=await service.capture({...chat(),executionLocation:{machineId:'linux',machineName:'Linux',host:'build-host',cwd:source}});
 expect(scope.bindings).toEqual([]);expect(paths).not.toHaveBeenCalled();
});

test('existing local graph scopes are revoked when their workspace changes to SSH',async()=>{
 await service.reconcile();const scope=await service.capture(chat());
 config.executionMachines=[{id:'linux',name:'Linux',host:'build-host'}];config.projects[0].workspaces![0].machineId='linux';
 await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).rejects.toMatchObject({status:403});
});

test.each(['disable','remove','shrink','close'] as const)('final source scan cannot publish after late %s and retains recoverable committed state',async change=>{
 execFileSync('git',['init','-q',source]);config.projects[0].workspaces=[ws('parent',join(source,'child'))];config.projects[0].workspaces[0].codeGraph!.scope='repository';
 await service.reconcile();const prior=store.database.prepare('SELECT generation,manifest FROM code_indexes').get(),saved=JSON.stringify(config);await writeFile(join(source,'child','leaf.ts'),'export function lateChange(){}');
 const scan=sources.scanSources;let count=0,release!:()=>void,entered!:()=>void;const paused=new Promise<void>(resolve=>entered=resolve),resume=new Promise<void>(resolve=>release=resolve);
 vi.spyOn(sources,'scanSources').mockImplementation(async(...args)=>{const result=await scan(...args);if(++count===2){entered();await resume;}return result;});
 const pending=service.reconcile();await paused;let closing:Promise<void>|undefined;
 if(change==='disable')config.projects[0].workspaces[0].codeGraph!.enabled=false;
 if(change==='remove')config.projects[0].workspaces=[];
 if(change==='shrink')config.projects[0].workspaces[0].codeGraph!.scope='directory';
 if(change==='close')closing=service.close();release();await pending;await closing;
 expect(store.database.prepare('SELECT generation,manifest FROM code_indexes').get()).toEqual(prior);expect(store.database.prepare('SELECT status FROM code_indexes').get()!.status).toBe('stale');
 vi.restoreAllMocks();config=JSON.parse(saved);if(change==='close')service=createCodeGraph({home,store,loadConfig:async()=>config});await service.reconcile();expect((await bindings())[0].status).toBe('ready');expect((await query('lateChange')).nodes.some(n=>n.name==='lateChange')).toBe(true);
});

test('ignored nested linked Git worktree has an independent reusable index and disable lifecycle',async()=>{
 execFileSync('git',['init','-q',source]);await writeFile(join(source,'.gitignore'),'.worktrees/\n');execFileSync('git',['-C',source,'add','.']);execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const nested=join(source,'.worktrees','feature');execFileSync('git',['-C',source,'worktree','add','--quiet','--detach',nested]);await writeFile(join(nested,'nested-only.ts'),'export function nestedOnly(){}');config.projects[0].workspaces!.push(ws('nested',nested));
 await service.reconcile();expect((await bindings())[0].status).toBe('ready');expect((await service.bindings('p','nested'))[0].status).toBe('ready');expect(store.database.prepare('SELECT COUNT(*) AS n FROM code_indexes').get()!.n).toBe(2);
 expect((await query('nestedOnly')).nodes).toEqual([]);expect((await query('nestedOnly','nested')).nodes.find(n=>n.kind==='function')!.path).toBe(join(nested,'nested-only.ts'));expect((await service.bindings('p','child'))[0].files).toBe(2);
 config.projects[0].workspaces![2].codeGraph!.enabled=false;await service.reconcile();await service.refresh('p','parent','cwd');expect((await bindings())[0].status).toBe('ready');expect(store.database.prepare('SELECT ref_count FROM code_indexes WHERE source_root=?').get(nested)!.ref_count).toBe(0);
 config.projects[0].workspaces![2].codeGraph!.enabled=true;config.projects[0].workspaces![0].codeGraph!.enabled=false;await service.refresh('p','nested','cwd');expect((await service.bindings('p','nested'))[0].status).toBe('ready');expect((await service.bindings('p','child'))[0].status).toBe('ready');
});

test.each(['disable','remove','shrink','close'] as const)('independent config snapshots reject %s committed during final root resolution',async change=>{
 execFileSync('git',['init','-q',source]);config.projects[0].workspaces=[ws('parent',join(source,'child'))];config.projects[0].workspaces[0].codeGraph!.scope='repository';await service.reconcile();
 const prior=store.database.prepare('SELECT generation,manifest FROM code_indexes').get(),saved=structuredClone(config);await writeFile(join(source,'child','leaf.ts'),'export function resolutionChange(){}');await service.close();let reads=0,closing:Promise<void>|undefined;
 service=createCodeGraph({home,store,loadConfig:async()=>{const snapshot=structuredClone(config);if(++reads===3)queueMicrotask(()=>{config=structuredClone(config);if(change==='disable')config.projects[0].workspaces![0].codeGraph!.enabled=false;if(change==='remove')config.projects[0].workspaces=[];if(change==='shrink')config.projects[0].workspaces![0].codeGraph!.scope='directory';if(change==='close')closing=service.close();});return snapshot;}});
 await service.reconcile();await closing;expect(reads).toBeGreaterThanOrEqual(3);expect(store.database.prepare('SELECT generation,manifest FROM code_indexes').get()).toEqual(prior);expect(store.database.prepare('SELECT status FROM code_indexes').get()!.status).toBe('stale');
 config=saved;if(change==='close')service=createCodeGraph({home,store,loadConfig:async()=>structuredClone(config)});await service.reconcile();expect((await bindings())[0].status).toBe('ready');expect((await query('resolutionChange')).nodes.some(n=>n.name==='resolutionChange')).toBe(true);
});

test.each(['query','status','refresh','multi-status','bindings','refresh-user'] as const)('normal config write during final %s authorization rejects the entire stale output',async action=>{
 const {readConfig,writeConfig}=await import('../server/config');
 config.projects[0].workspaces![0].resources.push({id:'child',label:'child',kind:'local',location:join(source,'child'),codeGraph:{enabled:true,scope:'directory'}});
 const initial=await readConfig(home);await writeConfig(home,config,initial.revision);await service.reconcile();const scope=await service.capture(chat());await service.close();let reads=0;
 // Capture the stale snapshot before committing a normal writer revoke at the last old authorization.
 const trigger=action==='query'?3:action==='status'?2:action==='multi-status'?4:action==='bindings'?1:action==='refresh-user'?2:4;
 service=createCodeGraph({home,store,loadConfig:async()=>{const snapshot=await readConfig(home);if(++reads===trigger){const next=structuredClone(snapshot.config);next.projects[0].workspaces![0].codeGraph!.enabled=false;await writeConfig(home,next,snapshot.revision);}return snapshot.config;}});
 const operation=action==='query'?service.query(scope,'search',{bindingId:'cwd',query:'leaf'}):action==='refresh'?service.boundRefresh(scope,'cwd',()=>{}):action==='bindings'?service.bindings('p','parent'):action==='refresh-user'?service.refresh('p','parent','cwd'):service.boundStatus({...scope,bindings:action==='status'?scope.bindings.slice(0,1):scope.bindings},()=>{});
 const result=await operation.then(value=>({value}),error=>({error}));
 expect((await readConfig(home)).config.projects[0].workspaces![0].codeGraph!.enabled).toBe(false);
 expect('error' in result?result.error.status===403:JSON.stringify(result.value)==='[]').toBe(true);
});
test.each(['missing','damaged','database'] as const)('restart and refresh reconstruct an unchanged %s managed SDK cache',async damage=>{
 await service.reconcile();const prior=(await bindings())[0],index=store.database.prepare('SELECT id FROM code_indexes').get()!.id as string;await service.close();
 const mirror=join(home,'code-graph',index,'source');if(damage==='missing')await rm(join(home,'code-graph',index),{recursive:true,force:true});else if(damage==='database')await writeFile(join(mirror,'.codegraph','codegraph.db'),'not a SQLite database');else await writeFile(join(mirror,'child','leaf.ts'),'export function corruptedCache(){}');
 service=createCodeGraph({home,store,loadConfig:async()=>config});await service.reconcile();const repaired=(await bindings())[0];expect(repaired.status).toBe('ready');expect(repaired.files).toBe(prior.files);expect((await query('leaf')).nodes.some(n=>n.name==='leaf')).toBe(true);expect(repaired.generation).toBeGreaterThan(prior.generation!);
 await rm(join(home,'code-graph',index),{recursive:true,force:true});expect((await service.refresh('p','parent','cwd')).status).toBe('ready');expect((await query('leaf')).nodes.some(n=>n.name==='leaf')).toBe(true);
});
test('definition reports truncation when the character cap cuts a short function',async()=>{
 await writeFile(join(source,'long.ts'),'export function longDefinition(){ return "'+'x'.repeat(25000)+'"; }');await service.reconcile();const scope=await service.capture(chat()),node=(await query('longDefinition')).nodes.find(n=>n.kind==='function')!;
 const result=await service.query(scope,'definition',{bindingId:'cwd',nodeId:node.id});expect(result.snippet).toHaveLength(24000);expect(result.truncated).toBe(true);
});

test('configured system identity reads only its explicit Project graph without membership',async()=>{
 config.agents.push({...config.agents[0],id:'system',systemRole:'mandala'});config.mandala={agentId:'system',soul:'',maxParallel:3};
 config.agents.push({...config.agents[0],id:'unrelated'});
 await service.reconcile();
 const scope=await service.capture({...chat(),agentId:'system'});
 expect(scope.bindings).toHaveLength(1);expect((await service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).nodes.length).toBeGreaterThan(0);
 expect((await service.capture({...chat(),agentId:'unrelated'})).bindings).toEqual([]);
 expect((await service.capture({...chat(),agentId:'system',projectId:''})).bindings).toEqual([]);
 expect(config.projects[0].agentIds).toEqual(['a']);
 config.mandala.agentId='a';await expect(service.query(scope,'search',{bindingId:'cwd',query:'leaf'})).rejects.toMatchObject({status:403});
});
