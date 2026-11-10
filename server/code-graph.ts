import {isSystemAgent} from './conversation-context';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { CodeGraph as Engine, Node as EngineNode } from '@colbymchenry/codegraph';
import type { Config, Conversation } from '../shared/types';
import type { CodeGraphReadScope, CodeGraphResult, CodeGraphStatus } from '../shared/code-graph';
import { projectWorkspaces, selectedWorkspace } from '../shared/workspaces';
import { DomainError } from '../shared/workspace-contracts';
import type { Store } from './store';
import { codeGraphConfigurationAuthority } from './config';
import { canonical, codeFile, digest, inside, manifest, repositoryRoot, scanSources, sourceBytes, type SourceSnapshot } from './code-graph-sources';
const ENGINE_VERSION='1.2.0';
const boundary='Static TS/JS relationships only; dependencies beyond this binding and dynamic calls remain unresolved. No cross-workspace graph.';
type Binding=CodeGraphStatus & {key:string;projectId:string;workspaceId:string;authority:string};
type Index={id:string;source_root:string;generation:number;manifest:string;status:string;updated_at:string;ref_count:number;engine_version:string;failure_count:number};
const fail=(code:string,status:number,message:string):never=>{throw new DomainError(code,status,message);};
export function createCodeGraph({home,store,loadConfig}:{home:string;store:Store;loadConfig:()=>Promise<Config>}) {
 const db=store.database,managed=resolve(home,'code-graph'),engines=new Map<string,Engine>();
 db.exec(`CREATE TABLE IF NOT EXISTS code_indexes(id TEXT PRIMARY KEY,source_root TEXT NOT NULL UNIQUE,engine_version TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,manifest TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',updated_at TEXT NOT NULL DEFAULT '',ref_count INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS code_index_bindings(binding_key TEXT PRIMARY KEY,index_id TEXT NOT NULL,allowed_root TEXT NOT NULL);`);
 let tail:Promise<unknown>=Promise.resolve(),timer:ReturnType<typeof setInterval>|undefined,closed=false,running=false;
 const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=tail.then(()=>{if(closed)throw new Error('CodeGraph closed');return fn();});tail=next.catch(()=>{});return next;};
 const rows=()=>db.prepare('SELECT * FROM code_indexes').all() as unknown as Index[];
 const indexFor=(key:string)=>db.prepare('SELECT i.* FROM code_indexes i JOIN code_index_bindings b ON b.index_id=i.id WHERE b.binding_key=?').get(key) as unknown as Index|undefined;
 async function resolveBindings(config:Config,projectId?:string,workspaceId?:string|null,enabledOnly=false):Promise<Binding[]> {
  const result:Binding[]=[];
  for(const project of config.projects.filter(p=>projectId===undefined||p.id===projectId)){
   const workspaces=projectId!==undefined?[selectedWorkspace(project,workspaceId)].filter(w=>!!w):projectWorkspaces(project);
   for(const workspace of workspaces){
    for(const item of [{id:'cwd',label:workspace.name,kind:'local',location:workspace.cwd,codeGraph:workspace.codeGraph},...workspace.resources.map(resource=>({...resource,id:'resource:'+resource.id}))]){
     const settings=item.codeGraph??{enabled:false,scope:'directory' as const};
     if(enabledOnly&&!settings.enabled)continue;
     const remote=workspace.machineId!==undefined;
     const selectedRoot=!remote&&item.kind==='local'?await canonical(item.location):null;
     const repo=selectedRoot?await repositoryRoot(selectedRoot):null;
     result.push({key:JSON.stringify([project.id,workspace.id,item.id]),projectId:project.id,workspaceId:workspace.id,authority:readSignature(config),bindingId:item.id,label:item.label,enabled:settings.enabled,scope:settings.scope,selectedRoot,root:settings.scope==='repository'?repo:selectedRoot,repositoryRoot:repo,
      status:remote?'unsupported':item.kind!=='local'?'not-checked-out':!selectedRoot?'missing':!settings.enabled?'disabled':settings.scope==='repository'&&!repo?'unsupported':'pending',
      ...(remote?{error:'CodeGraph is unavailable for SSH workspaces'}:{})});
    }
   }
  }
  return result;
 }
 async function openEngine(index:Index) {
  const existing=engines.get(index.id);if(existing)return existing;
  // The platform package contains worker, WASM and schema resources: load its public facade lazily.
  const {CodeGraph}=createRequire(import.meta.url)('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph');
  const mirror=join(managed,index.id,'source');await mkdir(mirror,{recursive:true});
  const engine=await stat(join(mirror,'.codegraph')).then(()=>CodeGraph.open(mirror),()=>CodeGraph.init(mirror,{index:false}));engines.set(index.id,engine);return engine;
 }
 async function capture(conversation:Pick<Conversation,'projectId'|'agentId'|'workspaceId'|'cwd'|'executionLocation'>,config?:Config):Promise<CodeGraphReadScope> {
  if(conversation.executionLocation)return {projectId:conversation.projectId,agentId:conversation.agentId,workspaceId:conversation.workspaceId??null,cwd:conversation.cwd,bindings:[]};
  const current=config??await loadConfig(),project=current.projects.find(p=>p.id===conversation.projectId);
  if(!project||!current.agents.some(a=>a.id===conversation.agentId)||!project.agentIds.includes(conversation.agentId)&&!isSystemAgent(current,conversation.agentId))return {projectId:conversation.projectId,agentId:conversation.agentId,workspaceId:conversation.workspaceId??null,cwd:conversation.cwd,bindings:[]};
  const workspace=selectedWorkspace(project,conversation.workspaceId);
  const scope:CodeGraphReadScope={projectId:project.id,agentId:conversation.agentId,workspaceId:workspace?.id??null,cwd:conversation.cwd,bindings:[]};
  if(!workspace||workspace.machineId!==undefined||!workspace.codeGraph?.enabled&&!workspace.resources.some(resource=>resource.kind==='local'&&resource.codeGraph?.enabled))return scope;
  const actual=conversation.cwd?await canonical(conversation.cwd):await canonical(workspace.cwd);
  for(const binding of await resolveBindings(current,project.id,workspace.id,true)){
   if(binding.status!=='pending'||!binding.root||!binding.selectedRoot)continue;
   if(binding.bindingId==='cwd'&&actual!==binding.selectedRoot)continue;
   scope.bindings.push({bindingId:binding.bindingId,selectedRoot:binding.selectedRoot,allowedRoot:binding.root});
  }
  return scope;
 }
 async function authorize(scope:CodeGraphReadScope,bindingId:string,assertActive:()=>void):Promise<Binding> {
  assertActive();const config=await loadConfig(),project=config.projects.find(p=>p.id===scope.projectId);
  if(!project||!project.agentIds.includes(scope.agentId)&&!isSystemAgent(config,scope.agentId)||!config.agents.some(a=>a.id===scope.agentId))fail('forbidden',403,'CodeGraph identity revoked');
  let current:Binding[];try{current=await resolveBindings(config,scope.projectId,scope.workspaceId);}catch{fail('forbidden',403,'CodeGraph workspace removed');}
  const before=scope.bindings.find(b=>b.bindingId===bindingId),binding=current!.find(b=>b.bindingId===bindingId);
  if(!before||!binding?.enabled||binding.status!=='pending'||!binding.root||binding.selectedRoot!==before.selectedRoot)fail('forbidden',403,'CodeGraph binding unavailable');
  const root=inside(binding!.root!,before!.allowedRoot)?before!.allowedRoot:inside(before!.allowedRoot,binding!.root!)?binding!.root:null;
  if(!root)fail('forbidden',403,'CodeGraph read scope changed');assertActive();return {...binding!,root};
 }
 const activeSignature=(bindings:Binding[])=>JSON.stringify(bindings.filter(b=>b.status==='pending').map(b=>[b.key,b.root]).sort());
 const configurationSignature=(config:Config)=>JSON.stringify(config.projects.flatMap(project=>projectWorkspaces(project).flatMap(workspace=>[
  {id:'cwd',kind:'local',location:workspace.cwd,codeGraph:workspace.codeGraph},...workspace.resources.map(resource=>({...resource,id:'resource:'+resource.id})),
 ].filter(item=>item.codeGraph?.enabled).map(item=>[project.id,workspace.id,workspace.machineId??null,item.id,item.kind,item.location,item.codeGraph!.scope]))).sort());
 const readSignature=(config:Config)=>JSON.stringify([configurationSignature(config),config.agents.map(a=>[a.id,a.systemRole??null]).sort(),config.mandala?.agentId??null,config.projects.map(p=>[p.id,[...p.agentIds].sort()]).sort()]);
 // Called synchronously after the caller's final config load; never await between this gate and return.
 const assertOutput=(revision:number,config:Config,bindings:Binding[],assertActive:()=>void=()=>{})=>{
  assertActive();const saving=codeGraphConfigurationAuthority(home);
  if(closed||saving.pending||saving.revision!==revision||bindings.some(binding=>binding.authority!==readSignature(config)))fail('forbidden',403,'CodeGraph configuration changed during read');
 };
 const cacheFiles=(engine:Engine)=>engine.getFiles().map(file=>[file.path,file.contentHash,file.nodeCount]).sort();
 async function cacheValid(index:Index){
  const mirror=join(managed,index.id,'source');
  try{
   const committed=JSON.parse(await readFile(join(managed,index.id,'committed.json'),'utf8'));
   if(committed.generation!==index.generation||committed.manifest!==index.manifest)return false;
   const canonicalMirror=await canonical(mirror);if(!canonicalMirror)return false;
   for(const [path,hash] of Object.entries(JSON.parse(index.manifest)))if(digest(await sourceBytes(canonicalMirror,path))!==hash)return false;
   // Opening a missing SDK cache would silently initialize an empty graph. Check it before reuse.
   const database=new DatabaseSync(join(mirror,'.codegraph','codegraph.db'),{readOnly:true});
   try{if(database.prepare('PRAGMA quick_check').all().some(row=>row.quick_check!=='ok'))return false;}finally{database.close();}
   const engine=await openEngine(index);
   return JSON.stringify(cacheFiles(engine))===JSON.stringify(committed.files);
  }catch{return false;}
 }
 async function syncIndex(index:Index,bindings:Binding[],authority:string,revision:number) {
  const selected=bindings.filter(b=>indexFor(b.key)?.id===index.id&&b.status==='pending');if(!selected.length)return;
  const snapshot:SourceSnapshot=new Map();
  for(const binding of selected){const part=await scanSources(binding.root!,resolve(home));for(const [path,file] of part)snapshot.set(relative(index.source_root,join(binding.root!,path)),file);}
  const next=JSON.stringify(manifest(snapshot));let old=JSON.parse(index.manifest) as Record<string,string>;
  const mirror=join(managed,index.id,'source');
  const intact=index.generation>0&&await cacheValid(index);
  if(next===index.manifest&&intact&&index.status==='ready'&&index.engine_version===ENGINE_VERSION)return;
  db.prepare("UPDATE code_indexes SET status='indexing' WHERE id=?").run(index.id);
  // SDK sync does not re-resolve unchanged files after tsconfig/package-only edits.
  const metadataChanged=[...new Set([...Object.keys(old),...snapshot.keys()])].some(path=>!codeFile(path)&&old[path]!==snapshot.get(path)?.hash);
  if(!intact||!['ready','pending'].includes(index.status)||index.engine_version!==ENGINE_VERSION||metadataChanged){engines.get(index.id)?.close();engines.delete(index.id);await rm(mirror,{recursive:true,force:true});old={};}
  await mkdir(mirror,{recursive:true});
  for(const path of Object.keys(old))if(!snapshot.has(path))await rm(join(mirror,path),{force:true});
  for(const [path,file] of snapshot)if(old[path]!==file.hash){await mkdir(dirname(join(mirror,path)),{recursive:true});await writeFile(join(mirror,path),file.bytes);}
  const engine=await openEngine(index);await engine.sync();
  if(closed||activeSignature(await resolveBindings(await loadConfig(),undefined,undefined,true))!==activeSignature(bindings))fail('code_graph_stale',409,'Bindings changed during indexing');
  for(const binding of selected){const latest=manifest(await scanSources(binding.root!,resolve(home)));for(const [path,hash] of Object.entries(latest))if(snapshot.get(relative(index.source_root,join(binding.root!,path)))?.hash!==hash)fail('code_graph_stale',409,'Source changed during indexing');const expected=[...snapshot.keys()].filter(path=>inside(binding.root!,join(index.source_root,path)));if(expected.length!==Object.keys(latest).length)fail('code_graph_stale',409,'Source changed during indexing');}
  const current=await resolveBindings(await loadConfig(),undefined,undefined,true);
  await writeFile(join(managed,index.id,'committed.json'),JSON.stringify({generation:index.generation+1,manifest:next,files:cacheFiles(engine)}));
  const latest=await loadConfig();
  // No await after this configuration-only authority gate. Pending saves cover rename completion
  // before its promise continuation; the revision covers saves completed since reconciliation began.
  const saving=codeGraphConfigurationAuthority(home);
  if(closed||saving.pending||saving.revision!==revision||configurationSignature(latest)!==authority||activeSignature(current)!==activeSignature(bindings))fail('code_graph_stale',409,'Bindings changed before index publication');
  db.prepare("UPDATE code_indexes SET manifest=?,generation=generation+1,engine_version=?,status='ready',updated_at=? WHERE id=?").run(next,ENGINE_VERSION,new Date().toISOString(),index.id);
 }
 async function reconcileNow() {
  const revision=codeGraphConfigurationAuthority(home).revision,config=await loadConfig(),authority=configurationSignature(config),all=await resolveBindings(config,undefined,undefined,true),enabled=all.filter(b=>b.status==='pending'&&b.root).sort((a,b)=>a.root!.length-b.root!.length);
  // Path containment alone crosses ignored nested repositories and linked worktrees.
  const worktrees=new Map(await Promise.all(rows().filter(index=>enabled.some(binding=>inside(index.source_root,binding.root!))).map(async index=>[index.id,await repositoryRoot(index.source_root)] as const)));
  store.transaction(()=>{
   db.prepare('DELETE FROM code_index_bindings').run();db.prepare('UPDATE code_indexes SET ref_count=0 WHERE ref_count<>0').run();
   for(const binding of enabled){let index=rows().filter(i=>inside(i.source_root,binding.root!)&&worktrees.get(i.id)===binding.repositoryRoot).sort((a,b)=>a.source_root.length-b.source_root.length)[0];
    if(!index){const id=digest(binding.root!).slice(0,24);db.prepare('INSERT INTO code_indexes(id,source_root,engine_version) VALUES(?,?,?)').run(id,binding.root!,ENGINE_VERSION);index=rows().find(i=>i.id===id)!;worktrees.set(id,binding.repositoryRoot);}
    db.prepare('INSERT INTO code_index_bindings VALUES(?,?,?)').run(binding.key,index.id,binding.root!);db.prepare('UPDATE code_indexes SET ref_count=ref_count+1 WHERE id=?').run(index.id);
   }
  });
  for(const index of rows()){
   if(!index.ref_count){engines.get(index.id)?.close();engines.delete(index.id);continue;}
   if(index.failure_count>=3)continue;
   try{await syncIndex(index,all,authority,revision);db.prepare('UPDATE code_indexes SET failure_count=0 WHERE id=?').run(index.id);}catch(error){db.prepare('UPDATE code_indexes SET failure_count=failure_count+1,status=? WHERE id=?').run(error instanceof DomainError&&error.code==='code_graph_stale'?'stale':error instanceof DomainError&&error.code==='code_graph_unsupported'?'unsupported':'error',index.id);}
  }
 }
 async function view(binding:Binding):Promise<CodeGraphStatus> {
  const {key,projectId,workspaceId,authority,...status}=binding;if(binding.status!=='pending'||!binding.root)return status;
  const index=indexFor(key);if(!index)return status;
  if(index.status!=='ready')return {...status,status:index.status as CodeGraphStatus['status'],error:index.status==='error'?'Index failed; refresh to retry':undefined};
  const stored=JSON.parse(index.manifest) as Record<string,string>,scoped=Object.fromEntries(Object.entries(stored).filter(([path])=>inside(binding.root!,join(index.source_root,path))).map(([path,hash])=>[relative(binding.root!,join(index.source_root,path)),hash]));
  try{
   const current=manifest(await scanSources(binding.root,resolve(home)));const snapshot=digest(JSON.stringify(current));
   if(JSON.stringify(current)!==JSON.stringify(Object.fromEntries(Object.entries(scoped).sort(([a],[b])=>a.localeCompare(b)))))return {...status,status:'stale'};
   const engine=await openEngine(index);const files=engine.getFiles().filter(f=>inside(binding.root!,resolve(index.source_root,f.path))&&stored[f.path]);
   return {...status,status:files.length?'ready':'unsupported',files:files.length,nodes:files.reduce((n,f)=>n+f.nodeCount,0),generation:index.generation,snapshot,updatedAt:index.updated_at};
  }catch{return {...status,status:'stale'};}
 }
 const bindings=(projectId:string,workspaceId?:string|null)=>serial(async()=>{const revision=codeGraphConfigurationAuthority(home).revision,result:CodeGraphStatus[]=[],selected=await resolveBindings(await loadConfig(),projectId,workspaceId);for(const binding of selected)result.push(await view(binding));const current=await loadConfig();assertOutput(revision,current,selected);return result;});
 async function queryNow(scope:CodeGraphReadScope,action:string,args:Record<string,unknown>,assertActive:()=>void):Promise<CodeGraphResult> {
  const revision=codeGraphConfigurationAuthority(home).revision;
  const fields:Record<string,string[]>={search:['bindingId','query'],definition:['bindingId','nodeId'],callers:['bindingId','nodeId','depth'],callees:['bindingId','nodeId','depth']};
  if(!fields[action]||!args||Object.keys(args).some(k=>!fields[action].includes(k))||typeof args.bindingId!=='string'||action==='search'&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>200)||action!=='search'&&(typeof args.nodeId!=='string'||args.nodeId.length>300)||args.depth!==undefined&&(!Number.isInteger(args.depth)||Number(args.depth)<1||Number(args.depth)>4))fail('invalid_code_graph_input',422,'Invalid bounded CodeGraph query');
  const binding=await authorize(scope,args.bindingId as string,assertActive),status=await view(binding),index=indexFor(binding.key);
  if(status.status!=='ready'||!index)fail(status.status==='stale'?'code_graph_stale':'code_graph_unavailable',409,'CodeGraph '+status.status+'; refresh the binding before querying');
  const engine=await openEngine(index!),stored=JSON.parse(index!.manifest) as Record<string,string>;
  const allowed=(node:EngineNode|null):node is EngineNode=>!!node&&!!stored[node.filePath]&&inside(binding.root!,resolve(index!.source_root,node.filePath));
  let found:EngineNode[]=[],snippet:string|undefined,truncated=false;
  if(action==='search'){
   // Enumerate only authorized files: a parent graph's FTS ranking/limit cannot hide child results.
   const term=(args.query as string).toLocaleLowerCase();
   for(const file of engine.getFiles())if(stored[file.path]&&inside(binding.root!,resolve(index!.source_root,file.path)))for(const node of engine.getNodesInFile(file.path))if(allowed(node)&&(node.name.toLocaleLowerCase().includes(term)||node.qualifiedName.toLocaleLowerCase().includes(term))){if(found.length<100)found.push(node);else truncated=true;}
  }else{
   const seed=engine.getNode(args.nodeId as string);if(!allowed(seed))fail('forbidden',403,'Symbol unavailable in this binding');
   if(action==='definition'){found=[seed!];const bytes=await sourceBytes(binding.root!,relative(binding.root!,join(index!.source_root,seed!.filePath)));if(digest(bytes)!==stored[seed!.filePath])fail('code_graph_stale',409,'Source changed');const lines=bytes.toString('utf8').split('\n').slice(seed!.startLine-1,Math.min(seed!.endLine,seed!.startLine+199)).join('\n');snippet=lines.slice(0,24000);truncated=seed!.endLine-seed!.startLine>=200||lines.length>24000;}
   else{
    const seen=new Set([seed!.id]);let frontier=[seed!];
    for(let depth=0;depth<Number(args.depth??1)&&frontier.length;depth++){const next:EngineNode[]=[];for(const node of frontier){const edges=action==='callers'?engine.getIncomingEdges(node.id):engine.getOutgoingEdges(node.id);for(const edge of edges){if(edge.kind!=='calls')continue;const neighbor=engine.getNode(action==='callers'?edge.source:edge.target);if(!allowed(neighbor)||seen.has(neighbor.id))continue;seen.add(neighbor.id);if(found.length>=100){truncated=true;continue;}found.push(neighbor);next.push(neighbor);}}frontier=next;}
   }
  }
  // Do not publish data captured before a source edit, scope revocation or invocation expiry.
  const latest=await authorize(scope,args.bindingId as string,assertActive);if(latest.root!==binding.root)fail('forbidden',403,'CodeGraph scope changed');
  const after=await view(latest);if(after.status!=='ready'||after.snapshot!==status.snapshot)fail('code_graph_stale',409,'Source changed during query');const finalScope=await authorize(scope,args.bindingId as string,assertActive);if(finalScope.root!==binding.root)fail('forbidden',403,'CodeGraph scope changed');
  const current=await loadConfig();assertOutput(revision,current,[binding,finalScope],assertActive);
  return {root:binding.root!,generation:status.generation!,snapshot:status.snapshot!,freshness:'current',boundary,nodes:found.map(n=>({id:n.id,name:n.name,kind:n.kind,path:join(index!.source_root,n.filePath),startLine:n.startLine,endLine:n.endLine})),...(snippet!==undefined?{snippet}:{}),...(truncated?{truncated:true}:{})};
 }
 const service={capture,bindings,
  reconcile:()=>serial(reconcileNow),
  refresh:(projectId:string,workspaceId:string,bindingId:string)=>serial(async()=>{const revision=codeGraphConfigurationAuthority(home).revision,binding=(await resolveBindings(await loadConfig(),projectId,workspaceId)).find(b=>b.bindingId===bindingId);if(binding?.status==='unsupported'&&binding.error)fail('code_graph_unsupported',409,binding.error);if(!binding||binding.status!=='pending')fail('code_graph_unavailable',409,'Enable a local binding before refreshing');const previous=indexFor(binding!.key);if(previous)db.prepare('UPDATE code_indexes SET failure_count=0 WHERE id=?').run(previous.id);await reconcileNow();const status=await view(binding!),current=await loadConfig();assertOutput(revision,current,[binding!]);return status;}),
  query:(scope:CodeGraphReadScope,action:string,args:Record<string,unknown>,assertActive:()=>void=()=>{})=>serial(()=>queryNow(scope,action,args,assertActive)),
  boundStatus:(scope:CodeGraphReadScope,assertActive:()=>void)=>serial(async()=>{
   const revision=codeGraphConfigurationAuthority(home).revision,result:CodeGraphStatus[]=[],selected:Binding[]=[];
   for(const b of scope.bindings){try{const binding=await authorize(scope,b.bindingId,assertActive),status=await view(binding);if((await authorize(scope,b.bindingId,assertActive)).root!==binding.root)fail('forbidden',403,'CodeGraph scope changed');selected.push(binding);result.push(status);}catch(error){if(!(error instanceof DomainError)||error.status!==403)throw error;}}
   const current=await loadConfig();assertOutput(revision,current,selected,assertActive);return result;
  }),
  boundRefresh:(scope:CodeGraphReadScope,bindingId:string,assertActive:()=>void)=>serial(async()=>{
   const revision=codeGraphConfigurationAuthority(home).revision,binding=await authorize(scope,bindingId,assertActive),previous=indexFor(binding.key);if(previous)db.prepare('UPDATE code_indexes SET failure_count=0 WHERE id=?').run(previous.id);await reconcileNow();
   const current=await authorize(scope,bindingId,assertActive),status=await view(current);if((await authorize(scope,bindingId,assertActive)).root!==current.root)fail('forbidden',403,'CodeGraph scope changed');
   const config=await loadConfig();assertOutput(revision,config,[binding,current],assertActive);return status;
  }),
  hasActiveWork:()=>running,
  start(){if(timer||closed)return;const tick=()=>{if(running||closed)return;running=true;void service.reconcile().catch(()=>{}).finally(()=>{running=false;});};tick();timer=setInterval(tick,5000);timer.unref();},
  async close(){if(timer)clearInterval(timer);timer=undefined;closed=true;await tail;for(const engine of engines.values())engine.close();engines.clear();},
 };
 return service;
}
export type CodeGraphService=ReturnType<typeof createCodeGraph>;
