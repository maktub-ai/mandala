import {isSystemAgent} from './conversation-context';
import { assertSkillEvidence, skillEvidenceProject } from './skill-evidence';
import { createHash } from 'node:crypto';
import { skillResources } from "../shared/skills";
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir, cp, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config, SkillDefinition } from '../shared/types';
import type { Asset,AssetVersion } from '../shared/assets';
import type { Store } from './store';
import { createAssets } from './assets';
import { createAssetFiles } from './asset-files';
import { workspacePrincipal } from './workspace-identity';
import { DomainError, type VersionRef } from '../shared/workspace-contracts';

// Configuration contains references. AssetVersion + its immutable manifest are the body authority.
export function createSkillCatalog(home:string,store:Store) {
 const files=createAssetFiles(home),assets=createAssets(store,files),root=workspacePrincipal(store);
 store.database.exec(`CREATE TABLE IF NOT EXISTS skill_publication_journal(version_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,skill_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL)`);
 const recover=(config:Config)=>store.transaction(()=>{
  for(const row of store.database.prepare("SELECT * FROM skill_publication_journal WHERE state='staged'").all()){
   const selected=config.skillLibrary?.some(skill=>skill.id===row.skill_id&&skill.versionRef?.versionId===row.version_id);
   if(selected){const asset=JSON.parse(store.database.prepare('SELECT data FROM assets WHERE id=?').get(row.asset_id as string)!.data as string);const next={...asset,headVersionId:row.version_id,lifecycle:'active',revision:asset.revision+1};store.database.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(next),asset.id);store.enqueueOutbox({type:'asset.version_published',aggregateId:asset.id,aggregateRevision:next.revision,causationId:'skill-commit:'+row.version_id,payload:{assetId:asset.id,versionId:row.version_id}});}
   store.database.prepare('UPDATE skill_publication_journal SET state=? WHERE version_id=?').run(selected?'published':'abandoned',row.version_id as string);
  }
 });
 const assertEvidence=(skill:SkillDefinition,source=skill.source,agentId?:string,config?:Config,projectId='')=>{
  assertSkillEvidence(store,source,skill.creatorAgentId,{...root,...(agentId?{agentId}:{})},config);
  if(source?.sourceVersions?.length){
   for(const creator of new Set([source.agentId,skill.creatorAgentId].filter((id):id is string=>!!id))){const scoped=createAssets(store,files,p=>skillEvidenceProject(store,p,source.projectId??''));for(const ref of source.sourceVersions)scoped.getAuthorizedVersion({...root,agentId:creator},ref);}
   const scoped=createAssets(store,files,p=>skillEvidenceProject(store,p,projectId));for(const ref of source.sourceVersions)scoped.getAuthorizedVersion({...root,...(agentId?{agentId}:{})},ref);
  }
 };
 const read=(skill:SkillDefinition,agentId?:string,config?:Config,projectId=''):SkillDefinition=>{
  if(!skill.versionRef)return {...skill};
  const ref=skill.versionRef,asset=assets.getAuthorizedAsset(root,ref.assetId);
  if(asset.kind!=='skill')throw new DomainError('invalid_skill_version',409,'Invalid Skill asset');
  const version=assets.getAuthorizedVersion(root,ref);
  skill={...skill,...(version.provenance.skill??{})};
  if(agentId&&skill.creatorAgentId&&skill.creatorAgentId!==agentId&&(!config||!config.agents.find(agent=>agent.id===agentId)?.skillIds?.includes(skill.id)&&!config.projects.some(project=>project.id===projectId&&(project.agentIds.includes(agentId)||isSystemAgent(config,agentId))&&project.skillIds?.includes(skill.id))))throw new DomainError('forbidden',403,'Skill is not shared with this Agent');
  assertEvidence(skill,skill.source,agentId,config,projectId);
  // Explicit Skill sharing never widens the reader's permissions to original evidence.
  if(agentId){const scoped=createAssets(store,files,p=>skillEvidenceProject(store,p,projectId));for(const source of version.provenance.sourceVersions)scoped.getAuthorizedVersion({...root,agentId},source);}
  const body=version.files.findIndex(file=>file.path==='SKILL.md');
  if(body<0)throw new DomainError('invalid_skill_version',409,'Missing SKILL.md');
  return {...skill,unavailable:undefined,content:readFileSync(assets.readAssetFile(root,ref,String(body)).blobPath,'utf8')};
 };
 return {
  assets,read,assertEvidence,recover,
  resolve(config:Config,agentId:string,projectId=''):Config {
   const result=structuredClone(config);
   result.skillLibrary=result.skillLibrary?.map(skill=>{
    try{const resolved=read(skill,agentId,config,projectId);if(skill.versionRef){const version=assets.getAuthorizedVersion(root,skill.versionRef);resolved[skillResources]=version.files.flatMap((file,index)=>file.path==='SKILL.md'?[]:[{path:file.path,blobPath:assets.readAssetFile(root,skill.versionRef!,String(index)).blobPath,executable:file.executable}]);}return resolved;}catch(error){
     if(error instanceof DomainError){return {...skill,content:undefined,path:'',unavailable:true};}throw error;
    }
   });return result;
  },
  versions(skill:SkillDefinition,agentId?:string,config?:Config,projectId=''){return skill.versionRef?assets.listVersions(root,skill.versionRef.assetId).map(version=>{assertEvidence({...skill,...version.provenance.skill},version.provenance.skill?.source,agentId,config,projectId);if(agentId){const scoped=createAssets(store,files,p=>skillEvidenceProject(store,p,projectId));for(const ref of version.provenance.sourceVersions)scoped.getAuthorizedVersion({...root,agentId},ref);}return version;}):[];},
  async persist(skill:SkillDefinition,assertActive:()=>void=()=>{}):Promise<SkillDefinition>{
   if(skill.path!==''||typeof skill.content!=='string')return skill;
   assertEvidence(skill);
   const current=skill.versionRef?read(skill):undefined;
   if(current?.content===skill.content){const {content:_,unavailable:_availability,...metadata}=skill;return {...metadata,...(current.source?{source:current.source}:{}),...(current.creatorAgentId?{creatorAgentId:current.creatorAgentId}:{})};}
   const fingerprint=createHash('sha256').update(JSON.stringify([skill.id,skill.versionRef??null,skill.content,skill.source])).digest('hex');
   const prior=store.database.prepare("SELECT * FROM skill_publication_journal WHERE skill_id=? AND fingerprint=? AND state IN ('staged','abandoned') ORDER BY rowid DESC LIMIT 1").get(skill.id,fingerprint);
   if(prior){assertActive();store.database.prepare("UPDATE skill_publication_journal SET state='staged' WHERE version_id=?").run(prior.version_id as string);const {content:_,...metadata}=skill;return {...metadata,versionRef:{assetId:prior.asset_id as string,versionId:prior.version_id as string}};}
   const directory=await mkdtemp(join(tmpdir(),'mandala-skill-'));
   try{
    await writeFile(join(directory,'SKILL.md'),skill.content,{mode:0o600});
    const sources=[{allowedRoot:directory,relativePath:'SKILL.md',manifestPath:'SKILL.md'}];
    if(skill.versionRef){const version=assets.getAuthorizedVersion(root,skill.versionRef);for(const [index,file]of version.files.entries())if(file.path!=='SKILL.md'){const target=join(directory,file.path);await mkdir(dirname(target),{recursive:true});await cp(assets.readAssetFile(root,skill.versionRef,String(index)).blobPath,target);await chmod(target,file.executable?0o700:0o600);sources.push({allowedRoot:directory,relativePath:file.path,manifestPath:file.path});}}
    const staged=await files.stageFiles(root,null,sources);
    assertActive();assertEvidence(skill);
    // The publication callback runs inside the Asset transaction: a crash can never expose a
    // candidate head without its journal record. Config commit chooses which candidate is live.
    const stage=(version:AssetVersion,previous:Asset)=>{
      store.database.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(previous),previous.id);
      store.database.prepare("DELETE FROM outbox WHERE aggregate_id=? AND type='asset.version_published' AND json_extract(payload,'$.versionId')=?").run(previous.id,version.id);
      store.database.prepare("INSERT INTO skill_publication_journal VALUES(?,?,?,?,'staged')").run(version.id,previous.id,skill.id,fingerprint);
    };
    let version:AssetVersion;
    if(skill.versionRef){
      const asset=assets.getAuthorizedAsset(root,skill.versionRef.assetId);
      version=assets.publishAssetVersion(root,{assetId:asset.id,expectedHeadVersionId:asset.headVersionId,submissionId:staged.submissionId,files:staged.files,provenance:{sourceVersions:skill.source?.sourceVersions??[],skill:{source:skill.source,creatorAgentId:skill.creatorAgentId}}},'skill:'+fingerprint,undefined,undefined,value=>stage(value,asset));
    }else{
      const imported=assets.importAsset(root,{kind:'skill',title:skill.name,agentId:skill.creatorAgentId,submissionId:staged.submissionId,sourceVersions:skill.source?.sourceVersions??[]},'skill:'+fingerprint,undefined,({asset,version})=>{
        version.provenance.skill={source:skill.source,creatorAgentId:skill.creatorAgentId};store.database.prepare('UPDATE asset_versions SET data=? WHERE id=?').run(JSON.stringify(version),version.id);
        stage(version,{...asset,headVersionId:null,lifecycle:'archived'});
      },true);version=imported.version;
    }
    const {content:_,unavailable:_availability,...metadata}=skill;
    return {...metadata,versionRef:{assetId:version.assetId,versionId:version.id},...(!skill.creatorAgentId?{humanMaintained:true}:{})};
   }finally{await rm(directory,{recursive:true,force:true});}
  },
  assertSources(refs:VersionRef[],agentId:string,projectId=''){const scoped=createAssets(store,files,p=>skillEvidenceProject(store,p,projectId));for(const ref of refs)scoped.getAuthorizedVersion({...root,agentId},ref);},
 };
}
