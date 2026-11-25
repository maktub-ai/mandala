import {afterEach, beforeEach, expect, test} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig, writeConfig} from '../server/config';
import {openStore} from '../server/store';
import {createSkillCatalog} from '../server/skill-catalog';
import {createSkillService} from '../server/skill-service';
import {createSkillManagement} from '../server/skill-http';
import {prepareCapabilityRuntime} from '../server/omp';
import {linkedCapabilities} from '../shared/catalog';

let home:string, source:string, store:ReturnType<typeof openStore>;
const body='---\nname: review\ndescription: Review a package\n---\nRead references/guide.md and run scripts/check.sh.';
const binary=Buffer.from([0,255,137,80,78,71]);
beforeEach(async()=>{
 home=await mkdtemp(join(tmpdir(),'skill-package-publication-'));source=join(home,'source');
 for(const directory of ['references','scripts','assets'])await mkdir(join(source,directory),{recursive:true});
 await writeFile(join(source,'SKILL.md'),body);
 await writeFile(join(source,'references/guide.md'),'Original guide');
 await writeFile(join(source,'scripts/check.sh'),'#!/bin/sh\nexit 0\n',{mode:0o700});
 await writeFile(join(source,'assets/sample.bin'),binary);
 const initial=await readConfig(home);
 await writeConfig(home,{...initial.config,agents:[{id:'a',name:'Agent',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[],skillIds:['review']}],skillLibrary:[{id:'review',name:'review',path:source}]},initial.revision);
 store=openStore(home);
});
afterEach(async()=>{store.close();await rm(home,{recursive:true,force:true});});
async function publishPackage(){
 const snapshot=await readConfig(home);snapshot.config.skillLibrary![0]={...snapshot.config.skillLibrary![0],path:'',content:body};
 await writeConfig(home,snapshot.config,snapshot.revision,undefined,undefined,new Map([['review',source]]));
 return (await readConfig(home)).config.skillLibrary![0];
}
async function runtime(){
 const snapshot=await readConfig(home),resolved=createSkillCatalog(home,store).resolve(snapshot.config,'a');
 return join(await prepareCapabilityRuntime(home,'fixture',[],linkedCapabilities(resolved,resolved.agents[0]).skills),'skills/review');
}

test('accepting an external Skill suggestion publishes the complete package without changing its source',async()=>{
 const proposal:any=await createSkillService(home,store)('a','skill_update',{skillId:'review',content:body+'\nReviewed',expectedVersionId:null},'proposal',()=>{});
 const accepted=await createSkillManagement(home,store).decide('review',proposal.suggestion.id,'accept',null);
 const root=await runtime();
 expect(await readFile(join(root,'references/guide.md'),'utf8')).toBe('Original guide');
 expect(await readFile(join(root,'assets/sample.bin'))).toEqual(binary);
 expect((await stat(join(root,'scripts/check.sh'))).mode&0o111).not.toBe(0);
 expect(await readFile(join(root,'SKILL.md'),'utf8')).toBe(body+'\nReviewed');
 expect(await readFile(join(source,'SKILL.md'),'utf8')).toBe(body);
 expect(accepted.skill.id).toBe('review');
 expect((await readConfig(home)).config.agents[0].skillIds).toEqual(['review']);
});

test('package replacement publishes resource-only edits and removes deleted files while retaining history',async()=>{
 const first=await publishPackage();
 await writeFile(join(source,'references/guide.md'),'Updated guide');await rm(join(source,'assets/sample.bin'));
 const second=await publishPackage();
 expect(second.versionRef?.assetId).toBe(first.versionRef?.assetId);
 expect(second.versionRef?.versionId).not.toBe(first.versionRef?.versionId);
 const root=await runtime();expect(await readFile(join(root,'references/guide.md'),'utf8')).toBe('Updated guide');
 await expect(stat(join(root,'assets/sample.bin'))).rejects.toMatchObject({code:'ENOENT'});
 const versions=createSkillCatalog(home,store).versions(second);
 expect(versions).toHaveLength(2);expect(versions[1].files.map(file=>file.path)).toContain('assets/sample.bin');
 const third=await publishPackage();expect(third.versionRef).toEqual(second.versionRef);
 expect(createSkillCatalog(home,store).versions(third)).toHaveLength(2);
});

test('unsafe package links reject conversion and leave its pending suggestion and binding untouched',async()=>{
 await writeFile(join(home,'private.txt'),'Do not import');await symlink(join(home,'private.txt'),join(source,'references/link'));
 const proposal:any=await createSkillService(home,store)('a','skill_update',{skillId:'review',content:body,expectedVersionId:null},'unsafe',()=>{});
 await expect(createSkillManagement(home,store).decide('review',proposal.suggestion.id,'accept',null)).rejects.toThrow(/symlink/i);
 const detail=await createSkillManagement(home,store).detail('review');
 expect(detail.skill.path).toBe(source);expect(detail.skill.versionRef).toBeUndefined();expect(detail.suggestions[0].status).toBe('pending');
});

test('a market-sized package retains all 200 files and its repository license',async()=>{
 await rm(source,{recursive:true,force:true});await mkdir(source);
 await writeFile(join(source,'SKILL.md'),body);
 for(let i=0;i<199;i++)await writeFile(join(source,`reference-${i}.txt`),String(i));
 await writeFile(join(source,'REPOSITORY-LICENSE.txt'),'License');
 const skill=await publishPackage();expect(createSkillCatalog(home,store).versions(skill)[0].files).toHaveLength(201);
},30000);

test('manually editing a source-managed package marks it as human maintained',async()=>{
 await publishPackage();let snapshot=await readConfig(home);snapshot.config.skillLibrary![0].humanMaintained=false;
 await writeConfig(home,snapshot.config,snapshot.revision);
 snapshot=await readConfig(home);snapshot.config.skillLibrary![0].content=body+'\nLocal edit';
 await writeConfig(home,snapshot.config,snapshot.revision);
 expect((await readConfig(home)).config.skillLibrary![0].humanMaintained).toBe(true);
});

test('a failed package config commit keeps the previous version and retries changed resources correctly',async()=>{
 const first=await publishPackage();await writeFile(join(source,'references/guide.md'),'Unpublished guide');
 const snapshot=await readConfig(home);let checks=0;
 await expect(writeConfig(home,snapshot.config,snapshot.revision,()=>{if(++checks===3)throw new Error('authorization changed');},undefined,new Map([['review',source]]))).rejects.toThrow('authorization changed');
 expect((await readConfig(home)).config.skillLibrary![0].versionRef).toEqual(first.versionRef);
 await writeFile(join(source,'references/guide.md'),'Final guide');const next=await publishPackage();
 expect(createSkillCatalog(home,store).versions(next)).toHaveLength(2);
 expect(await readFile(join(await runtime(),'references/guide.md'),'utf8')).toBe('Final guide');
});
