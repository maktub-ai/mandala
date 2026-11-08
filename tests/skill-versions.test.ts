import {ensureConfiguredMandala} from './configured-mandala';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig } from '../server/config';
import { openStore } from '../server/store';
import { createSkillService } from '../server/skill-service';

let home:string, store:ReturnType<typeof openStore>;
const content='---\nname: review\ndescription: Review changes\n---\nCheck the final result.';
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'skill-versions-'));const snapshot=await readConfig(home);await writeConfig(home,{...snapshot.config,agents:['a','b'].map(id=>({id,name:id,instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}))},snapshot.revision);store=openStore(home);});
afterEach(async()=>{store.close();await rm(home,{recursive:true,force:true});});
test('creator binding uses a single immutable asset body and keeps stable IDs on manual revision',async()=>{
 const service=createSkillService(home,store),result:any=await service('a','skill_register',{name:'review',content},'first',()=>{});
 expect(result.assigned).toBe(true);
 const snapshot=await readConfig(home),skill=snapshot.config.skillLibrary![0];
 expect(snapshot.config.agents[0].skillIds).toEqual([result.skill.id]);expect(snapshot.config.agents[1].skillIds).toBeUndefined();
 expect(skill.versionRef).toMatchObject({assetId:expect.any(String),versionId:expect.any(String)});
 const disk=JSON.parse(await readFile(join(home,'config.json'),'utf8'));expect(disk.skillLibrary[0].content).toBeUndefined();
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM asset_versions').get()!.n).toBe(1);
 skill.content=content+'\nHuman addition';await writeConfig(home,snapshot.config,snapshot.revision);
 const revised=(await readConfig(home)).config.skillLibrary![0];expect(revised.id).toBe(skill.id);expect(revised.versionRef?.versionId).not.toBe(skill.versionRef?.versionId);
 expect((await service('a','skill_versions',{skillId:skill.id},'',()=>{}) as any).items).toHaveLength(2);
});
test('a shared Skill update becomes an idempotent suggestion until its maintainer accepts the exact baseline',async()=>{
 const service=createSkillService(home,store),first:any=await service('a','skill_register',{name:'review',content},'first',()=>{});
 const snapshot=await readConfig(home);snapshot.config.agents[1].skillIds=[first.skill.id];await writeConfig(home,snapshot.config,snapshot.revision);
 const args={skillId:first.skill.id,content:content+'\nSuggested step',expectedVersionId:first.skill.versionRef.versionId};
 const result:any=await service('a','skill_update',args,'suggest',()=>{});expect(result.suggestion.status).toBe('pending');
 expect(await service('a','skill_update',args,'suggest',()=>{})).toEqual(result);
 expect((await service('a','skill_read',{skillId:first.skill.id},'',()=>{}) as any).content).toBe(content);
 const accepted:any=await service('a','skill_accept',{skillId:first.skill.id,suggestionId:result.suggestion.id},'accept',()=>{});expect(accepted.skill.content).toContain('Suggested step');
});
test('an owned update can replay across a restart without publishing another version',async()=>{
 const service=createSkillService(home,store),first:any=await service('a','skill_register',{name:'review',content},'first',()=>{});
 const args={skillId:first.skill.id,content:content+'\nNew step',expectedVersionId:first.skill.versionRef.versionId};
 const updated:any=await service('a','skill_update',args,'owned-update',()=>{});
 const restarted=createSkillService(home,store);expect(await restarted('a','skill_update',args,'owned-update',()=>{})).toEqual(updated);
 expect((await restarted('a','skill_versions',{skillId:first.skill.id},'',()=>{}) as any).items).toHaveLength(2);
 await expect(restarted('a','skill_update',{...args,content:content+'\nDifferent'},'owned-update',()=>{})).rejects.toMatchObject({status:409});
});
test('new Skills stay private to their creator until an explicit assignment shares them',async()=>{
 const service=createSkillService(home,store),first:any=await service('a','skill_register',{name:'review',content},'private',()=>{});
 expect(await service('b','skill_find',{},'',()=>{})).toMatchObject({items:[]});
 await expect(service('b','skill_read',{skillId:first.skill.id},'',()=>{})).rejects.toMatchObject({status:403});
 const snapshot=await readConfig(home);snapshot.config.agents[1].skillIds=[first.skill.id];await writeConfig(home,snapshot.config,snapshot.revision);
 expect(await service('b','skill_read',{skillId:first.skill.id},'',()=>{})).toMatchObject({content});
});
test('Project sharing is confined to the active bound Project',async()=>{
 const service=createSkillService(home,store),first:any=await service('a','skill_register',{name:'review',content},'project-private',()=>{});
 const snapshot=await readConfig(home);snapshot.config.projects=['p','other'].map(id=>({id,name:id,cwd:home,agentIds:['a','b'],resources:[],skills:[],mcp:[],...(id==='p'?{skillIds:[first.skill.id]}:{})}));await writeConfig(home,snapshot.config,snapshot.revision);
 await expect(service('b','skill_read',{skillId:first.skill.id},'',()=>{},undefined,{projectId:'other'})).rejects.toMatchObject({status:403});
 expect(await service('b','skill_read',{skillId:first.skill.id},'',()=>{},undefined,{projectId:'p'})).toMatchObject({content});
});
test('an external directory receives a suggestion without reading or rewriting its source',async()=>{
 const snapshot=await readConfig(home);snapshot.config.skillLibrary=[{id:'external-stable',name:'review',path:'/private/unreadable-source'}];await writeConfig(home,snapshot.config,snapshot.revision);
 const service=createSkillService(home,store),result:any=await service('a','skill_update',{skillId:'external-stable',content,expectedVersionId:null},'external-proposal',()=>{});
 expect(result.suggestion.status).toBe('pending');expect((await readConfig(home)).config.skillLibrary![0]).toMatchObject({id:'external-stable',path:'/private/unreadable-source'});
});
test('native materialization and later body revisions preserve Skill resource files from the canonical manifest',async()=>{
 const {createAssetFiles}=await import('../server/asset-files'),{createAssets}=await import('../server/assets'),{workspacePrincipal}=await import('../server/workspace-identity'),{writeFile,mkdir}=await import('node:fs/promises');
 const files=createAssetFiles(home),assets=createAssets(store,files),root=workspacePrincipal(store),source=join(home,'source-skill');await mkdir(join(source,'references'),{recursive:true});await writeFile(join(source,'SKILL.md'),content);await writeFile(join(source,'references','check.txt'),'resource evidence',{mode:0o700});
 const staged=await files.stageFiles(root,null,[{allowedRoot:source,relativePath:'SKILL.md',manifestPath:'SKILL.md'},{allowedRoot:source,relativePath:'references/check.txt',manifestPath:'references/check.txt'}]);const asset=assets.createAsset(root,{kind:'skill',title:'review',owner:{userId:root.userId,agentId:'a'}}),version=assets.publishAssetVersion(root,{assetId:asset.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{sourceVersions:[],skill:{creatorAgentId:'a'}}},'resource-version');
 let snapshot=await readConfig(home);snapshot.config.skillLibrary=[{id:'resource-stable',name:'review',path:'',content,versionRef:{assetId:asset.id,versionId:version.id},creatorAgentId:'a'}];snapshot.config.agents[0].skillIds=['resource-stable'];await writeConfig(home,snapshot.config,snapshot.revision);
 const {createSkillCatalog}=await import('../server/skill-catalog'),{linkedCapabilities}=await import('../shared/catalog'),{prepareCapabilityRuntime}=await import('../server/omp');snapshot=await readConfig(home);const resolved=createSkillCatalog(home,store).resolve(snapshot.config,'a');const runtime=await prepareCapabilityRuntime(home,'resource-test',[],linkedCapabilities(resolved,resolved.agents[0]).skills);expect(await readFile(join(runtime,'skills','review','references','check.txt'),'utf8')).toBe('resource evidence');
 snapshot.config.skillLibrary![0].content=content+'\nNew body';await writeConfig(home,snapshot.config,snapshot.revision);const revised=(await readConfig(home)).config.skillLibrary![0];expect(assets.getAuthorizedVersion(root,revised.versionRef!).files.find(file=>file.path==='references/check.txt')?.executable).toBe(true);
 const latest=await readConfig(home),again=createSkillCatalog(home,store).resolve(latest.config,'a');const nextRuntime=await prepareCapabilityRuntime(home,'resource-next',[],linkedCapabilities(again,again.agents[0]).skills);expect(((await (await import('node:fs/promises')).stat(join(nextRuntime,'skills','review','references','check.txt'))).mode&0o111)!==0).toBe(true);
});
test('failed config CAS keeps the Files head and published history on the previous Skill version',async()=>{
 const service=createSkillService(home,store),registered:any=await service('a','skill_register',{name:'review',content},'head-cas',()=>{}),snapshot=await readConfig(home);
 snapshot.config.skillLibrary![0].content=content+'\nCandidate body';let checks=0;
 const {readFileSync,writeFileSync}=await import('node:fs');
 await expect(writeConfig(home,snapshot.config,snapshot.revision,()=>{if(++checks===2){const path=join(home,'config.json'),raw=JSON.parse(readFileSync(path,'utf8'));raw.agents[1].name='Concurrent edit';writeFileSync(path,JSON.stringify(raw));}})).rejects.toThrow('configuration changed');
 const row=store.database.prepare('SELECT data FROM assets WHERE id=?').get(registered.skill.versionRef.assetId)!;expect(JSON.parse(row.data as string).headVersionId).toBe(registered.skill.versionRef.versionId);
 const versions:any=await service('a','skill_versions',{skillId:registered.skill.id},'',()=>{});expect(versions.items).toHaveLength(1);expect((await readConfig(home)).config.agents[1].name).toBe('Concurrent edit');
});
test('failure while journaling an immutable candidate rolls back its head and version atomically',async()=>{
 const service=createSkillService(home,store),registered:any=await service('a','skill_register',{name:'review',content},'journal-atomic',()=>{}),snapshot=await readConfig(home);snapshot.config.skillLibrary![0].content=content+'\nCandidate body';
 store.database.exec("CREATE TRIGGER reject_skill_stage BEFORE INSERT ON skill_publication_journal BEGIN SELECT RAISE(ABORT,'stage-fault'); END");
 await expect(writeConfig(home,snapshot.config,snapshot.revision)).rejects.toThrow();
 expect(JSON.parse(store.database.prepare('SELECT data FROM assets WHERE id=?').get(registered.skill.versionRef.assetId)!.data as string).headVersionId).toBe(registered.skill.versionRef.versionId);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM asset_versions').get()!.n).toBe(1);
});

test('configured system identity uses an explicitly Project-shared Skill without membership',async()=>{
 const {ensureMandalaConfig}=await import('../server/config');const {config}=await ensureConfiguredMandala(home),systemId=config.mandala!.agentId;
 const service=createSkillService(home,store),created:any=await service('a','skill_register',{name:'review',content},'system-project',()=>{});
 const snapshot=await readConfig(home);snapshot.config.projects=[{id:'p',name:'Project',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[],skillIds:[created.skill.id]}];await writeConfig(home,snapshot.config,snapshot.revision);
 expect(await service(systemId,'skill_read',{skillId:created.skill.id},'',()=>{},undefined,{projectId:'p'})).toMatchObject({content});
 await expect(service('b','skill_read',{skillId:created.skill.id},'',()=>{},undefined,{projectId:'p'})).rejects.toMatchObject({status:403});
 await expect(service(systemId,'skill_read',{skillId:created.skill.id},'',()=>{})).rejects.toMatchObject({status:403});
 expect((await readConfig(home)).config.projects[0].agentIds).toEqual(['a']);
});
