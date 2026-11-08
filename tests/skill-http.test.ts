import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof fs>();return {...actual,writeFile:vi.fn(actual.writeFile)};});
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openStore } from '../server/store';
import { readConfig, writeConfig } from '../server/config';
import { createSkillService } from '../server/skill-service';
import { createHttpServer } from '../server/http';
import type { SessionManager } from '../server/sessions';
let home:string,store:ReturnType<typeof openStore>,server:Server,base:string;
const content='---\nname: review\ndescription: Review changes\n---\nInspect the saved result.';
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'skill-http-'));store=openStore(home);const snapshot=await readConfig(home);await writeConfig(home,{...snapshot.config,agents:['a','b'].map(id=>({id,name:id,instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}))},snapshot.revision);server=createHttpServer({home,store,manager:{} as SessionManager,requireIdentity:false});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as any).port}/api/skills`;});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await rm(home,{recursive:true,force:true});});
test('Skill library reads immutable history and lets the user accept a baselined suggestion',async()=>{
 const service=createSkillService(home,store),first:any=await service('a','skill_register',{name:'review',content},'first',()=>{});
 const snapshot=await readConfig(home);snapshot.config.agents[1].skillIds=[first.skill.id];await writeConfig(home,snapshot.config,snapshot.revision);
 const proposal:any=await service('b','skill_update',{skillId:first.skill.id,content:content+'\nSuggested check',expectedVersionId:first.skill.versionRef.versionId},'propose',()=>{});
 const detail=await fetch(base+'/'+first.skill.id);expect(detail.status).toBe(200);const body=await detail.json();expect(body.versions).toHaveLength(1);expect(body.suggestions).toHaveLength(1);
 const response=await fetch(base+'/'+first.skill.id+'/suggestions/'+proposal.suggestion.id+'/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersionId:first.skill.versionRef.versionId})});expect(response.status).toBe(200);expect((await response.json()).skill.content).toContain('Suggested check');
 const history=await (await fetch(base+'/'+first.skill.id)).json();expect(history.versions).toHaveLength(2);expect(history.suggestions[0].status).toBe('accepted');
});


test('human acceptance rechecks the canonical maintainer after staging, including reused candidates',async()=>{
 const {createAssetFiles}=await import('../server/asset-files'),{createAssets}=await import('../server/assets'),{workspacePrincipal}=await import('../server/workspace-identity');
 const root=workspacePrincipal(store),files=createAssetFiles(home),assets=createAssets(store,files);await fs.writeFile(join(home,'support.txt'),'Shared supporting evidence');const staged=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'support.txt',manifestPath:'support.txt'}]),support=assets.importAsset(root,{kind:'file',title:'Support',agentId:'b',submissionId:staged.submissionId},'support');const access=(mode:'all'|'selected')=>assets.setAccess(root,support.asset.id,{mode,...(mode==='selected'?{agentIds:['b']}:{})},assets.getAuthorizedAsset(root,support.asset.id).revision);access('all');
 const service=createSkillService(home,store),first:any=await service('a','skill_register',{name:'review',content},'first',()=>{}),snapshot=await readConfig(home);snapshot.config.agents[1].skillIds=[first.skill.id];await writeConfig(home,snapshot.config,snapshot.revision);
 const proposal:any=await service('b','skill_update',{skillId:first.skill.id,content:content+' supported change',expectedVersionId:first.skill.versionRef.versionId},'propose',()=>{},{method:'agent',verification:'draft',agentId:'b',sourceVersions:[{assetId:support.asset.id,versionId:support.version.id}]});
 const accept=()=>fetch(base+'/'+first.skill.id+'/suggestions/'+proposal.suggestion.id+'/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersionId:first.skill.versionRef.versionId})});let candidateId:string|undefined;const write=(await vi.importActual<typeof fs>('node:fs/promises')).writeFile;
 for(let attempt=0;attempt<2;attempt++){
  let release!:()=>void,pausedId:string|undefined;const gate=new Promise<void>(resolve=>{release=resolve;});
  const pause=vi.mocked(fs.writeFile).mockImplementation(async(...args)=>{await write(...args);if(String(args[0]).startsWith(join(home,'config-'))&&String(args[0]).endsWith('.tmp')){const row=store.database.prepare("SELECT version_id FROM skill_publication_journal WHERE asset_id=? AND state='staged'").get(first.skill.versionRef.assetId);if(row){pausedId=row.version_id as string;await gate;}}});
  const pending=accept();try{
   await vi.waitFor(()=>expect(pausedId).toBeTruthy());if(candidateId)expect(pausedId).toBe(candidateId);candidateId=pausedId;
   access('selected');expect(assets.getAuthorizedVersion({...root,agentId:'b'},{assetId:support.asset.id,versionId:support.version.id}).id).toBe(support.version.id);release();const response=await pending;expect(response.status).toBe(403);
   expect((await readConfig(home)).config.skillLibrary![0].versionRef).toEqual(first.skill.versionRef);expect(assets.getAuthorizedAsset(root,first.skill.versionRef.assetId).headVersionId).toBe(first.skill.versionRef.versionId);expect((await (await fetch(base+'/'+first.skill.id)).json()).suggestions[0].status).toBe('pending');
  }finally{release();await pending;pause.mockImplementation(write);}
  access('all');
 }
 const accepted=await accept();expect(accepted.status).toBe(200);const result=await accepted.json();expect(result.skill.versionRef.versionId).toBe(candidateId);expect(result.skill.creatorAgentId).toBe('a');expect(result.skill.content).toContain('supported change');expect(result.skill.unavailable).not.toBe(true);expect(assets.getAuthorizedAsset(root,first.skill.versionRef.assetId).headVersionId).toBe(candidateId);
});
