import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store';
import { createAssetFiles } from '../server/asset-files';
import { createAssets } from '../server/assets';
import { createRunArtifacts } from '../server/run-artifacts';
import { createTasks } from '../server/tasks';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(f=>f()));
function setup(){const home=mkdtempSync(join(tmpdir(),'mana-run-artifacts-'));const store=openStore(home),files=createAssetFiles(home),assets=createAssets(store,files);clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});const root=join(home,'outputs','run');mkdirSync(root,{recursive:true});writeFileSync(join(root,'a.txt'),'alpha');writeFileSync(join(root,'b.txt'),'beta');return{home,store,files,assets,root};}
test('bound publisher stages multiple relative files, fixes provenance and deduplicates stable command',async()=>{
 const {home,store,files,assets,root}=setup();
 const tools=createRunArtifacts({store,files,assets,principal:{userId:'local',agentId:'a',runId:'run'},outputRoot:root,sourceVersions:[],assertActive(){}});
 const args={title:'Result',files:[{path:'a.txt'},{path:'b.txt'}]};const result=await tools.publish(args,'publish-1');
 expect(result.version.provenance).toEqual({runId:'run',sourceVersions:[]});expect(result.version.files).toHaveLength(2);
 expect((await tools.publish(args,'publish-1')).version.id).toBe(result.version.id);
 expect(await tools.read({assetId:result.asset.id,versionId:result.version.id,fileId:'0'})).toMatchObject({text:'alpha'});
 await expect(tools.publish({...args,runId:'other'},'bad')).rejects.toThrow();
 await expect(tools.publish({title:'Escape',files:[{path:join(home,'secrets')}]},'escape')).rejects.toThrow();
});
test('derived publication retains sources and recursive revoke rejects output reading',async()=>{
 const {store,files,assets,root}=setup();const p={userId:'local',agentId:'a',runId:'run'};
 const source=assets.createAsset(p,{kind:'file',title:'Input',owner:{userId:'local',agentId:'a'}});
 const staged=await files.stageFiles(p,'run',[{allowedRoot:root,relativePath:'a.txt',manifestPath:'a.txt'}]);
 const v=assets.publishAssetVersion(p,{assetId:source.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:'run',sourceVersions:[]}},'source');
 const refs=[{assetId:source.id,versionId:v.id}];const tools=createRunArtifacts({store,files,assets,principal:p,outputRoot:root,sourceVersions:refs,assertActive(){}});
 const result=await tools.publish({title:'Derived',files:[{path:'b.txt'}]},'out');expect(result.version.provenance.sourceVersions).toEqual(refs);
 const current=assets.getAuthorizedAsset({userId:'local'},source.id);assets.setAccess({userId:'local'},source.id,{mode:'private'},current.revision);
 await expect(tools.read({assetId:result.asset.id,versionId:result.version.id,fileId:'0'})).rejects.toThrow();
});
test('concurrent publish replay produces exactly one version',async()=>{
 const {store,files,assets,root}=setup();const tools=createRunArtifacts({store,files,assets,principal:{userId:'local',agentId:'a',runId:'run'},outputRoot:root,sourceVersions:[],assertActive(){}});
 const args={title:'One output',files:[{path:'a.txt'}]};
 const [one,two]=await Promise.all([tools.publish(args,'same'),tools.publish(args,'same')]);
 expect(one.version.id).toBe(two.version.id);expect(assets.listAssets({userId:'local'})).toHaveLength(1);
});
test('crash after Asset import but before command projection recovers original version and stable body',async()=>{
 const {store,files,assets,root}=setup(),principal={userId:'local',agentId:'a',runId:'run'};
 const options={store,files,assets,principal,outputRoot:root,sourceVersions:[],assertActive(){}};
 const args={title:'Durable output',files:[{path:'a.txt'}]};
 const tool=createRunArtifacts(options);
 store.database.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON run_artifact_commands BEGIN SELECT RAISE(ABORT,'simulated projection crash'); END");
 await expect(tool.publish(args,'crash-command')).rejects.toThrow('simulated projection crash');
 const original=store.database.prepare("SELECT id FROM asset_versions WHERE json_extract(data,'$.provenance.runId')='run'").get()!.id;
 expect(store.database.prepare('SELECT COUNT(*) n FROM run_artifact_commands').get()!.n).toBe(0);
 store.database.exec('DROP TRIGGER fail_projection');
 const recovered=createRunArtifacts(options);
 const result=await recovered.publish(args,'crash-command');expect(result.version.id).toBe(original);
 expect(store.database.prepare('SELECT COUNT(*) n FROM asset_versions').get()!.n).toBe(1);
 await expect(recovered.publish({...args,title:'Different body'},'crash-command')).rejects.toMatchObject({code:'idempotency_conflict'});
});

test('actual assignee Run may publish owner output from its project-only fixed source without granting wider readers',async()=>{
 const {store,files,root}=setup(),user={userId:'local'};
 const assets=createAssets(store,files,p=>{
  const row=store.database.prepare('SELECT t.project_id FROM task_runs r JOIN work_tasks t ON t.id=r.task_id WHERE r.id=? AND t.assignee_agent_id=? AND t.owner_user_id=?').get(p.runId??'',p.agentId??'',p.userId);return row?.project_id as string|undefined;
 });
 const staged=await files.stageFiles(user,null,[{allowedRoot:root,relativePath:'a.txt',manifestPath:'a.txt'}]);
 const source=assets.importAsset(user,{kind:'file',title:'Project source',submissionId:staged.submissionId},'input');
 assets.setAccess(user,source.asset.id,{mode:'selected',projectIds:['p']},source.asset.revision);
 const sources=[{assetId:source.asset.id,versionId:source.version.id}];
 const tasks=createTasks(store,{assets,resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:sources,requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const task=tasks.createTask(user,{goal:'derive',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'create');
 const run=tasks.startTask(user,task.id,task.revision,'start'),principal={...user,agentId:'a',runId:run.id};
 const tool=createRunArtifacts({store,files,assets,principal,outputRoot:root,sourceVersions:sources,assertActive(){}});
 const result=await tool.publish({title:'Derived',files:[{path:'b.txt'}]},'derived');
 for(const bad of [{...user,agentId:'a'}, {...user,agentId:'a',runId:'missing'}, {...user,agentId:'b',runId:run.id}]){
  expect(()=>assets.getAuthorizedVersion(bad,sources[0])).toThrow();
  if("runId" in bad)await expect(createRunArtifacts({store,files,assets,principal:bad,outputRoot:root,sourceVersions:sources,assertActive(){}}).publish({title:'Wrong publisher',files:[{path:'b.txt'}]},'wrong-'+bad.agentId+'-'+bad.runId)).rejects.toThrow();
 }
 const other=tasks.createTask(user,{goal:'cross project',criteria:[],acceptance:'delivery',projectId:'q',assigneeAgentId:'a'},'other-project');
 expect(()=>tasks.startTask(user,other.id,other.revision,'cross-start')).toThrow();
 expect(result.asset.accessPolicy).toEqual({mode:'owner'});
 expect(assets.getAuthorizedVersion(principal,{assetId:result.asset.id,versionId:result.version.id}).provenance.sourceVersions).toEqual(sources);
 expect(()=>assets.getAuthorizedVersion({...user,agentId:'a'},{assetId:result.asset.id,versionId:result.version.id})).toThrow();
 expect(()=>assets.getAuthorizedVersion({...user,agentId:'b',runId:run.id},{assetId:result.asset.id,versionId:result.version.id})).toThrow();
});
