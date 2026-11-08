import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateWorkspace } from '../server/workspace-migrations';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createKnowledge, updateKnowledge, readKnowledge, recallMemory, deleteKnowledge, previewKnowledge } from '../server/knowledge';
import type { Config } from '../shared/types';
const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const config:Config={version:2,projects:[{id:'p',name:'P',agentIds:['a'],cwd:'/tmp',resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}]};
const home=()=>{const h=mkdtempSync(join(tmpdir(),'mana-bridge-'));homes.push(h);return h;};
const input={kind:'document',title:'reading policy',content:'reading policy v1',scope:'agent',agentId:'a',status:'active',access:{mode:'private'}};
test('after cutover legacy CRUD uses canonical head without rewriting historical JSON; reopen download agrees',async()=>{
 const h=home();const old=await createKnowledge(h,input,config);const original=readFileSync(join(h,'knowledge.json'),'utf8');await migrateWorkspace(h,'apply');
 const migrated=openStore(h);try{expect(createAssets(migrated,createAssetFiles(h)).getKnowledgeMetadata({userId:'local'},old.id)).not.toHaveProperty('content');}finally{migrated.close();}
 const next=await updateKnowledge(h,old.id,{content:'reading policy v2',access:{mode:'selected',agentIds:['a']}},config);
 const store=openStore(h),assets=createAssets(store,createAssetFiles(h));
 try{
  const asset=assets.getAuthorizedAsset({userId:'local'},old.id);
  expect(asset.headVersionId).not.toBeNull();expect(assets.listVersions({userId:'local'},old.id)).toHaveLength(2);
  expect(readFileSync(assets.readAssetFile({userId:'local'},{assetId:old.id,versionId:asset.headVersionId!},'0').blobPath,'utf8')).toBe(next.content);
  expect((await readKnowledge(h)).find(e=>e.id===old.id)?.content).toBe('reading policy v2');
  const renamed=await updateKnowledge(h,old.id,{title:'renamed policy'},config);
  expect(assets.listVersions({userId:'local'},old.id)).toHaveLength(2);
  expect((await readKnowledge(h)).find(e=>e.id===old.id)).toMatchObject({title:'renamed policy',updatedAt:renamed.updatedAt,access:{mode:'selected',agentIds:['a']}});
  expect(readFileSync(join(h,'knowledge.json'),'utf8')).toBe(original);
  const created=await createKnowledge(h,{...input,title:'new canonical',status:'candidate'},config);
  expect(assets.getAuthorizedAsset({userId:'local'},created.id).headVersionId).not.toBeNull();
  await deleteKnowledge(h,created.id);expect((await readKnowledge(h)).some(e=>e.id===created.id)).toBe(false);
 }finally{store.close();}
 const reopened=openStore(h);try{expect((await readKnowledge(h)).find(e=>e.id===old.id)?.content).toBe('reading policy v2');}finally{reopened.close();}
});
test('recall rejects private/candidate/current recursive source revocation and binds fixed authorized versions',async()=>{
 const h=home();await migrateWorkspace(h,'apply');const store=openStore(h),files=createAssetFiles(h),assets=createAssets(store,files),user={userId:'local'};
 try{
  const doc=await createKnowledge(h,input,config);
  const context={agentId:'a',projectId:'p',query:'reading policy',documentIds:[doc.id]};
  expect((await recallMemory(h,context)).entries).toEqual([]);
  await updateKnowledge(h,doc.id,{access:{mode:'all'},status:'candidate'},config);expect((await recallMemory(h,context)).entries).toEqual([]);
  await updateKnowledge(h,doc.id,{status:'active'},config);const first=assets.getAuthorizedAsset(user,doc.id).headVersionId!;
  assets.bind(user,{ownerType:'project',ownerId:'p',assetId:doc.id,versionPolicy:'pinned',versionId:first});
  await updateKnowledge(h,doc.id,{content:'reading policy v2'},config);
  const recalled=(await recallMemory(h,context)).entries[0];expect(recalled.content).toBe('reading policy v1');expect(recalled).toMatchObject({assetId:doc.id,versionId:first});
  const source=await createKnowledge(h,{...input,title:'source',access:{mode:'all'}},config);const sourceHead=assets.getAuthorizedAsset(user,source.id).headVersionId!;
  writeFileSync(join(h,'derived.txt'),'reading policy derived');const staged=await files.stageFiles(user,null,[{allowedRoot:h,relativePath:'derived.txt',manifestPath:'document.md'}]);
  const derived=assets.importAsset(user,{kind:'document',title:'derived',submissionId:staged.submissionId},'derived');
  assets.setAccess(user,derived.asset.id,{mode:'all'},derived.asset.revision);
  assets.publishAssetVersion(user,{assetId:derived.asset.id,expectedHeadVersionId:derived.version.id,submissionId:staged.submissionId,files:staged.files,provenance:{sourceVersions:[{assetId:source.id,versionId:sourceHead}]}},'derived-source');
  assets.bind(user,{ownerType:'agent',ownerId:'a',assetId:derived.asset.id,versionPolicy:'latest'});
  expect((await recallMemory(h,{...context,documentIds:[]})).entries.some(e=>e.id===derived.asset.id)).toBe(true);
  const current=assets.getAuthorizedAsset(user,source.id);assets.setAccess(user,source.id,{mode:'private'},current.revision);
  expect((await recallMemory(h,{...context,documentIds:[]})).entries.some(e=>e.id===derived.asset.id)).toBe(false);
 }finally{store.close();}
});
test('an imported PDF cannot break unrelated legacy reads, writes, or context loading',async()=>{
 const h=home();await migrateWorkspace(h,'apply');const store=openStore(h),files=createAssetFiles(h),assets=createAssets(store,files),user={userId:'local'};
 try{
  const text=await createKnowledge(h,{...input,access:{mode:'all'}},config);
  const memory=await createKnowledge(h,{kind:'memory',title:'remember',content:'safe memory',scope:'global',status:'active',level:'L3'},config);
  writeFileSync(join(h,'opaque.pdf'),'%PDF-1.4');
  const staged=await files.stageFiles(user,null,[{allowedRoot:h,relativePath:'opaque.pdf',manifestPath:'opaque.pdf'}]);
  const pdf=assets.importAsset(user,{kind:'document',title:'opaque PDF',submissionId:staged.submissionId},'pdf');
  assets.setAccess(user,pdf.asset.id,{mode:'all'},pdf.asset.revision);
  assets.bind(user,{ownerType:'agent',ownerId:'a',assetId:pdf.asset.id,versionPolicy:'latest'});
  expect((await readKnowledge(h,store)).map(entry=>entry.id)).toEqual([memory.id,text.id]);
  expect(await previewKnowledge(h,{projectId:'p',agentId:'a'},[text.id],store)).toEqual([{id:text.id,title:text.title,status:'eligible'}]);
  const recalled=await recallMemory(h,{projectId:'p',agentId:'a',query:'reading',documentIds:[text.id]},store);
  expect(recalled.entries.map(entry=>entry.id)).toContain(text.id);
  expect(recalled.entries.map(entry=>entry.id)).not.toContain(pdf.asset.id);
  expect(recalled.truncated).toBe(true);
  expect((await updateKnowledge(h,text.id,{title:'new reading title'},config,store)).title).toBe('new reading title');
  expect((await updateKnowledge(h,memory.id,{title:'new memory'},config,store)).title).toBe('new memory');
  await deleteKnowledge(h,memory.id,store);
  await expect(updateKnowledge(h,pdf.asset.id,{title:'wrong endpoint'},config,store)).rejects.toMatchObject({code:'unsupported_knowledge_content'});
 }finally{store.close();}
});
test('failed first publication leaves no headless Asset from an old document POST',async()=>{
 const h=home();await migrateWorkspace(h,'apply');const store=openStore(h),assets=createAssets(store,createAssetFiles(h)),user={userId:'local'};
 try{
  store.database.exec("CREATE TRIGGER fail_first_version BEFORE INSERT ON asset_versions BEGIN SELECT RAISE(ABORT,'injected version failure'); END");
  await expect(createKnowledge(h,input,config,false,store)).rejects.toThrow();
  expect(assets.listAssets(user)).toEqual([]);
  expect(await readKnowledge(h,store)).toEqual([]);
 }finally{store.close();}
});
test.each([
 ['title-only',{title:'renamed during revocation'}],
 ['body',{content:'replacement during revocation'}],
] as const)('%s old PATCH conflicts with a completed Asset permission revocation',async(_caseName,patch)=>{
 const h=home();await migrateWorkspace(h,'apply');const store=openStore(h),files=createAssetFiles(h),assets=createAssets(store,files),user={userId:'local'};
 const originalRead=fs.readFileSync;
 try{
  const doc=await createKnowledge(h,{...input,access:{mode:'all'}},config,false,store);
  const initial=assets.getAuthorizedAsset(user,doc.id),head=initial.headVersionId!;
  const blob=files.blobPath(assets.getAuthorizedVersion(user,{assetId:doc.id,versionId:head}).files[0].blobHash);
  let scheduled=false;
  fs.readFileSync=((...args:unknown[])=>{
   const result=Reflect.apply(originalRead,fs,args);
   if(args[0]===blob&&!scheduled){scheduled=true;queueMicrotask(()=>{const latest=assets.getAuthorizedAsset(user,doc.id);assets.setAccess(user,doc.id,{mode:'private'},latest.revision);});}
   return result;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  await expect(updateKnowledge(h,doc.id,patch,config,store)).rejects.toMatchObject({code:'revision_conflict',status:409});
  expect(scheduled).toBe(true);
  const current=assets.getAuthorizedAsset(user,doc.id);
  expect(current.accessPolicy).toEqual({mode:'private'});
  expect(current.headVersionId).toBe(head);
  expect(assets.listVersions(user,doc.id)).toHaveLength(1);
  expect(await readKnowledge(h,store)).toContainEqual(expect.objectContaining({id:doc.id,title:doc.title,content:doc.content,access:{mode:'private'}}));
 }finally{fs.readFileSync=originalRead;syncBuiltinESMExports();store.close();}
});
test('large bound Markdown reads only a bounded prefix before context rendering',async()=>{
 const h=home();await migrateWorkspace(h,'apply');const store=openStore(h),files=createAssetFiles(h),assets=createAssets(store,files),user={userId:'local'};
 try{
  writeFileSync(join(h,'large.md'),'x'.repeat(4*1024*1024));
  const staged=await files.stageFiles(user,null,[{allowedRoot:h,relativePath:'large.md',manifestPath:'document.md'}]);
  const asset=assets.importAsset(user,{kind:'document',title:'reading large',submissionId:staged.submissionId},'large');
  assets.setAccess(user,asset.asset.id,{mode:'all'},asset.asset.revision);
  assets.bind(user,{ownerType:'agent',ownerId:'a',assetId:asset.asset.id,versionPolicy:'latest'});
  const blob=files.blobPath(staged.files[0].blobHash),readFile=fs.readFileSync,read=fs.readSync;
  let bytes=0;
  fs.readFileSync=((...args:unknown[])=>{const result=Reflect.apply(readFile,fs,args);if(args[0]===blob)bytes+=Buffer.byteLength(result);return result;}) as typeof fs.readFileSync;
  fs.readSync=((...args:unknown[])=>{const result=Reflect.apply(read,fs,args);bytes+=result;return result;}) as typeof fs.readSync;
  syncBuiltinESMExports();
  try{
   expect(await previewKnowledge(h,{projectId:'p',agentId:'a'},[asset.asset.id],store)).toEqual([{id:asset.asset.id,title:'reading large',status:'eligible'}]);
   expect(bytes).toBe(0);
   const recalled=await recallMemory(h,{projectId:'p',agentId:'a',query:'reading'},store);
   expect(recalled.entries[0].content.length).toBeLessThanOrEqual(1600);
   expect(recalled.truncated).toBe(true);
   expect(bytes).toBeGreaterThan(0);
   expect(bytes).toBeLessThanOrEqual(6400);
  }finally{fs.readFileSync=readFile;fs.readSync=read;syncBuiltinESMExports();}
 }finally{store.close();}
});
