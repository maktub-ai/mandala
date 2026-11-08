import { legacyWiki } from './legacy-wiki-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createHttpServer } from '../server/http';
import { openStore, type Store } from '../server/store';
import type { SessionManager } from '../server/sessions';
import { createAssetFiles } from '../server/asset-files';
import { openLocalAsset } from '../server/asset-local-open';
vi.mock('../server/asset-local-open',()=>({openLocalAsset:vi.fn(async()=>{})}));
let home:string,store:Store,server:Server,base:string;
beforeEach(async()=>{ home=mkdtempSync(join(tmpdir(),'assets-http-'));store=openStore(home);server=createHttpServer({requireIdentity:false,home,store,manager:{} as SessionManager});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v2/assets`;});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(home,{recursive:true,force:true});});
const json=(url:string,method:string,data:unknown,key?:string)=>fetch(url,{method,headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(data)});
async function publish(name='report.html',bytes='0123456789abcdefghij'){
 const uploaded=await fetch(base+'/uploads?name='+name,{method:'POST',body:bytes});expect(uploaded.status).toBe(201);const stage=await uploaded.json();
 const created=await json(base,'POST',{kind:'file',title:'Report'});expect(created.status).toBe(201);const asset=await created.json();
 const input={expectedHeadVersionId:null,submissionId:stage.submissionId,provenance:{sourceVersions:[]}};
 const response=await json(base+'/'+asset.id+'/versions','POST',input,'publish-'+asset.id);expect(response.status).toBe(201);const version=await response.json();
 return {asset,version,input,bytes,url:base+'/'+asset.id+'/versions/'+version.id+'/files/0'};
}
it('downloads authorized immutable bytes with secure headers, ranges and replay',async()=>{
 const p=await publish();const response=await fetch(p.url);expect(response.status).toBe(200);expect(response.headers.get('content-disposition')).toContain('attachment');expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('etag')).toBe('"'+createHash('sha256').update(p.bytes).digest('hex')+'"');expect(await response.text()).toBe(p.bytes);
 const partial=await fetch(p.url,{headers:{Range:'bytes=0-9'}});expect(partial.status).toBe(206);expect(partial.headers.get('content-range')).toBe('bytes 0-9/20');expect(await partial.text()).toBe('0123456789');
 expect((await fetch(p.url,{headers:{Range:'bytes=20-30'}})).status).toBe(416);
 expect((await fetch(p.url,{headers:{Range:'bytes=0-9','If-Range':'"old"'}})).status).toBe(200);
 const replay=await json(base+'/'+p.asset.id+'/versions','POST',p.input,'publish-'+p.asset.id);expect((await replay.json()).id).toBe(p.version.id);
 expect((await json(base+'/'+p.asset.id+'/versions','POST',{...p.input,expectedHeadVersionId:p.version.id},'publish-'+p.asset.id)).status).toBe(409);
 expect((await fetch(p.url.replace(/0$/,'etc%2Fpasswd'))).status).toBe(404);
});
it('serves media previews inline and HTML only inside a sandboxed policy',async()=>{
 for(const [name,type] of [['photo.webp','image/webp'],['clip.mp4','video/mp4'],['sound.mp3','audio/mpeg'],['report.pdf','application/pdf']]){
  const p=await publish(name,'synthetic media');
  const preview=await fetch(p.url+'?preview=1');
  expect(preview.status).toBe(200);
  expect(preview.headers.get('content-type')).toBe(type);
  expect(preview.headers.get('content-disposition')).toContain('inline');
  expect((await fetch(p.url)).headers.get('content-disposition')).toContain('attachment');
  await json(base+'/'+p.asset.id+'/lifecycle','PUT',{lifecycle:'retracted',expectedRevision:2});
  expect((await fetch(p.url+'?preview=1')).status).toBe(403);
 }
 const html=await publish('page.html','<script>alert(1)</script>');
 const page=await fetch(html.url+'?preview=1');
 expect(page.status).toBe(200);
 expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
 expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts;.*connect-src 'none'/);
 expect((await fetch(html.url)).headers.get('content-disposition')).toContain('attachment');
 expect((await fetch((await publish('notes.json','{}')).url+'?preview=1')).status).toBe(415);
});
it('local opening validates actions and version access before invoking the OS',async()=>{
 vi.mocked(openLocalAsset).mockClear();const p=await publish('reports%2Fbudget.xlsx','original');
 const url=p.url+'/open';
 expect((await json(url,'POST',{action:'reveal',path:'/etc/passwd'})).status).toBe(422);
 expect((await json(url,'POST',{action:'delete'})).status).toBe(422);
 expect((await json(url.replace('/files/0/','/files/1/'),'POST',{action:'open'})).status).toBe(404);
 expect(openLocalAsset).not.toHaveBeenCalled();
 expect((await json(url,'POST',{action:'open'})).status).toBe(200);
 expect(vi.mocked(openLocalAsset).mock.calls[0][1]).toMatchObject({name:'reports/budget.xlsx',size:8});
 await json(base+'/'+p.asset.id+'/lifecycle','PUT',{lifecycle:'retracted',expectedRevision:2});
 expect((await json(url,'POST',{action:'reveal'})).status).toBe(403);expect(openLocalAsset).toHaveBeenCalledTimes(1);
});
it('reports missing blobs and rejects withdrawn assets and client principals',async()=>{
 const p=await publish();rmSync(createAssetFiles(home).blobPath(p.version.files[0].blobHash));const missing=await fetch(p.url);expect(missing.status).toBe(409);expect((await missing.json()).code).toBe('blob_missing');
 expect((await json(base,'POST',{kind:'file',title:'Bad',owner:{userId:'other'},principal:{userId:'other'}})).status).toBe(422);
 const q=await publish('test.txt');expect((await json(base+'/'+q.asset.id+'/lifecycle','PUT',{lifecycle:'retracted',expectedRevision:2})).status).toBe(200);expect((await fetch(q.url)).status).toBe(403);
});
it('atomically imports first version and replays without an empty asset after transaction failure',async()=>{
 const upload=await fetch(base+'/uploads?name=document.md',{method:'POST',body:'Atomic report'});const stage=await upload.json();
 const input={kind:'document',title:'Atomic',submissionId:stage.submissionId};
 const before=store.database.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n;
 store.database.exec("CREATE TRIGGER fail_import AFTER INSERT ON command_dedup BEGIN SELECT RAISE(ABORT,'fault'); END");
 expect((await json(base+'/imports','POST',input,'import-key')).status).toBe(500);
 for(const table of ['assets','asset_versions','asset_version_files','artifact_links','command_dedup','blobs'])expect(store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n).toBe(before);
 expect(await (await fetch(base)).json()).toEqual([]);
 store.database.exec('DROP TRIGGER fail_import');
 const created=await json(base+'/imports','POST',input,'import-key');expect(created.status).toBe(201);const first=await created.json();
 const replay=await json(base+'/imports','POST',input,'import-key');expect(await replay.json()).toEqual(first);
 expect((await json(base+'/imports','POST',{...input,title:'Different'},'import-key')).status).toBe(409);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n).toBe(1);
});
it('preserves historical downloads across a new head and validates project bindings and scope targets',async()=>{
 const p=await publish('document.md','old version');
 const stage=await (await fetch(base+'/uploads?name=document.md',{method:'POST',body:'new version'})).json();
 const updated=await json(base+'/'+p.asset.id+'/versions','POST',{expectedHeadVersionId:p.version.id,submissionId:stage.submissionId,provenance:{sourceVersions:[]}},'new-version');expect(updated.status).toBe(201);
 expect(await (await fetch(p.url)).text()).toBe('old version');
 expect((await json(base+'/'+p.asset.id+'/versions','POST',{expectedHeadVersionId:p.version.id,submissionId:stage.submissionId,provenance:{sourceVersions:[]}},'stale')).status).toBe(409);
 expect((await json(base+'/'+p.asset.id+'/bindings','POST',{ownerType:'project',ownerId:'unknown',versionPolicy:'latest'})).status).toBe(422);
 expect((await json(base+'/'+p.asset.id+'/access','PUT',{policy:{mode:'selected',agentIds:['unknown']},expectedRevision:3})).status).toBe(422);
 expect((await fetch(p.url+'?userId=another')).status).toBe(422);
 expect((await fetch(p.url,{headers:{Range:'bytes=-3'}})).status).toBe(206);
 expect(await (await fetch(p.url,{headers:{Range:'bytes=-3'}})).text()).toBe('ion');
 expect((await fetch(p.url,{headers:{Range:'bytes=0-1,4-5'}})).status).toBe(416);
 expect((await fetch(p.url,{headers:{Origin:'https://evil.example'}})).status).toBe(403);
});
it('reevaluates necessary source authorization on historical downloads',async()=>{
 const source=await publish('source.txt','source evidence');
 const upload=await (await fetch(base+'/uploads?name=derived.txt',{method:'POST',body:'derived evidence'})).json();
 const asset=await (await json(base,'POST',{kind:'file',title:'Derived'})).json();
 const version=await (await json(base+'/'+asset.id+'/versions','POST',{expectedHeadVersionId:null,submissionId:upload.submissionId,provenance:{sourceVersions:[{assetId:source.asset.id,versionId:source.version.id}]}},'derived')).json();
 const url=base+'/'+asset.id+'/versions/'+version.id+'/files/0';expect((await fetch(url)).status).toBe(200);
 await json(base+'/'+source.asset.id+'/lifecycle','PUT',{lifecycle:'retracted',expectedRevision:2});
 const denied=await fetch(url);expect(denied.status).toBe(403);expect(await denied.text()).not.toContain('derived evidence');
});
it('explicit views reorder recent files; polling and HEAD do not and withdrawn versions cannot record activity',async()=>{
 const first=await publish('first.txt');await new Promise(r=>setTimeout(r,5));const second=await publish('second.txt');
 expect((await (await fetch(base)).json())[0].id).toBe(second.asset.id);
 await fetch(first.url,{method:'HEAD'});await fetch(base+'/'+first.asset.id+'/versions/'+first.version.id);
 expect((await (await fetch(base)).json())[0].id).toBe(second.asset.id);
 expect((await json(base+'/'+first.asset.id+'/activity','POST',{kind:'view',versionId:first.version.id})).status).toBe(200);
 expect((await (await fetch(base)).json())[0]).toMatchObject({id:first.asset.id,lastViewedAt:expect.any(String)});
 expect((await json(base+'/'+first.asset.id+'/activity','POST',{kind:'view',versionId:second.version.id})).status).toBe(403);
 expect((await json(base+'/'+first.asset.id+'/activity','POST',{kind:'view',versionId:first.version.id,at:'2099-01-01'})).status).toBe(422);
});
it('stages safe relative manifest names for text version edits without allowing host paths or traversal',async()=>{
 expect((await fetch(base+'/uploads?name=notes%2Fhistory.txt',{method:'POST',body:'nested text'})).status).toBe(201);
 for(const name of ['/etc/passwd','../outside.txt','notes/../../outside.txt','notes\\outside.txt'])expect((await fetch(base+'/uploads?name='+encodeURIComponent(name),{method:'POST',body:'bad'})).status).toBe(422);
});

it('a revoked dialogue Skill cannot break healthy Wiki list reloads or permission saves',async()=>{
 const {readConfig,writeConfig}=await import('../server/config'),{createSkillService}=await import('../server/skill-service'),{createKnowledgeBase}=await import('../server/knowledge-base'),{workspacePrincipal}=await import('../server/workspace-identity');
 const config=await readConfig(home);config.config.agents=['source-agent','maintainer'].map(id=>({id,name:id,instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}));await writeConfig(home,config.config,config.revision);
 const c=store.createConversation({projectId:'',agentId:'source-agent',cli:'codex',model:null}),event=store.appendEvent(c.id,'user',{text:'PRIVATE_DIALOGUE_EVIDENCE'});const registered:any=await createSkillService(home,store)('source-agent','skill_register',{name:'private-skill',content:'---\nname: private-skill\ndescription: Private procedure\n---\nPRIVATE_DIALOGUE_EVIDENCE'},'dialogue',()=>{},{method:'dialogue',verification:'draft',agentId:'source-agent',conversationId:c.id,eventIds:[event.id],eventFingerprints:{[event.id]:createHash('sha256').update(JSON.stringify(event)).digest('hex')}});
 const next=await readConfig(home);next.config.agents=next.config.agents.filter(a=>a.id==='maintainer');await writeConfig(home,next.config,next.revision);
 const root=workspacePrincipal(store),wiki=createKnowledgeBase({home,store,loadConfig:async()=>(await readConfig(home)).config});try{
  const healthy=await legacyWiki(home,store,wiki,{name:'Healthy Wiki',purpose:'Existing supported content',maintainerAgentId:'maintainer',automatic:false,reception:{enabled:false}});
  const listing=await fetch(base),rows=await listing.json();expect({status:listing.status,rows}).toMatchObject({status:200,rows:expect.any(Array)});
  expect(rows.find((row:any)=>row.id===healthy.id)).toBeTruthy();const denied=rows.find((row:any)=>row.id===registered.skill.versionRef.assetId);expect(denied).toMatchObject({availability:'access_denied',versionOrdinal:null,updatedAt:null});expect(denied.file).toBeUndefined();expect(JSON.stringify(denied)).not.toContain('PRIVATE_DIALOGUE_EVIDENCE');expect(JSON.stringify(denied)).not.toContain(c.id);expect(JSON.stringify(denied)).not.toContain('SKILL.md');
  const updated=await wiki.configure(root,healthy.id,{automatic:false,reception:{enabled:true,agentId:'maintainer'},expectedRevision:wiki.get(root,healthy.id).revision});
  const reloaded=await (await fetch(base)).json(),current=reloaded.find((row:any)=>row.id===healthy.id);expect(updated.reception.enabled).toBe(true);
  const saved=await json(base+'/'+healthy.id+'/access','PUT',{policy:{mode:'owner'},expectedRevision:current.revision});expect(saved.status).toBe(200);expect((await fetch(base)).status).toBe(200);
  expect((await fetch(base+'/'+registered.skill.versionRef.assetId+'/versions')).status).toBe(403);const direct=await fetch(base+'/'+registered.skill.versionRef.assetId+'/versions/'+registered.skill.versionRef.versionId+'/files/0');expect(direct.status).toBe(403);expect(await direct.json()).toMatchObject({code:'skill_source_replaced',error:'Original Skill evidence is unavailable'});
 }finally{await wiki.close();}
});

it('reads one asset binding list with current targets and enforces asset access',async()=>{
 const {readConfig,writeConfig}=await import('../server/config');
 const {config,revision}=await readConfig(home);
 config.projects=[{id:'binding-project',name:'Project',cwd:'/tmp',agentIds:['binding-agent'],resources:[],mcp:[],skills:[]}];
 config.agents=[{id:'binding-agent',name:'Agent',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];
 await writeConfig(home,config,revision);
 const p=await publish('bindings.md');
 for(const [ownerType,ownerId] of [['project','binding-project'],['agent','binding-agent']])expect((await json(base+'/'+p.asset.id+'/bindings','POST',{ownerType,ownerId,versionPolicy:'latest'})).status).toBe(200);
 const listed=await fetch(base+'/'+p.asset.id+'/bindings');expect(listed.status).toBe(200);
 expect(await listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({assetId:p.asset.id,ownerType:'project',ownerId:'binding-project'}),expect.objectContaining({assetId:p.asset.id,ownerType:'agent',ownerId:'binding-agent'})]));
 const next=await readConfig(home);await writeConfig(home,{...next.config,agents:[],projects:next.config.projects.map(project=>({...project,agentIds:[]}))},next.revision);
 expect(await(await fetch(base+'/'+p.asset.id+'/bindings')).json()).toEqual([expect.objectContaining({ownerType:'project'})]);
 expect((await json(base+'/'+p.asset.id+'/lifecycle','PUT',{lifecycle:'retracted',expectedRevision:2})).status).toBe(200);
 expect((await fetch(base+'/'+p.asset.id+'/bindings')).status).toBe(403);
});

it('rechecks binding access after asynchronous configuration loading',async()=>{
 const configModule=await import('../server/config');const read=configModule.readConfig;
 const p=await publish('binding-revocation.md');
 const spy=vi.spyOn(configModule,'readConfig').mockImplementation(async(...args)=>{
  const value=await read(...args);
  expect((await json(base+'/'+p.asset.id+'/lifecycle','PUT',{lifecycle:'retracted',expectedRevision:2})).status).toBe(200);
  return value;
 });
 try{expect((await fetch(base+'/'+p.asset.id+'/bindings')).status).toBe(403);}finally{spy.mockRestore();}
});

it('Project-owned Wiki listing survives a missing usage binding and cannot appear in another Project',async()=>{const {readConfig,writeConfig}=await import('../server/config'),{createKnowledgeBase}=await import('../server/knowledge-base'),{workspacePrincipal}=await import('../server/workspace-identity');const current=await readConfig(home);current.config.projects=['owned-p','other-q'].map(id=>({id,name:id,cwd:home,agentIds:[],resources:[],skills:[],mcp:[]}));await writeConfig(home,current.config,current.revision);const wiki=createKnowledgeBase({home,store,loadConfig:async()=>(await readConfig(home)).config});try{const owned=await wiki.create(workspacePrincipal(store),{name:'Owned knowledge',purpose:'Project identity',projectId:'owned-p',automatic:false,reception:{enabled:false}});store.database.prepare('DELETE FROM asset_bindings WHERE asset_id=?').run(owned.id);const rows=await(await fetch(base+'?ownerType=project&ownerId=owned-p')).json();expect(rows.map((a:any)=>a.id)).toContain(owned.id);const other=await(await fetch(base+'?ownerType=project&ownerId=other-q')).json();expect(other.map((a:any)=>a.id)).not.toContain(owned.id);}finally{await wiki.close();}});
