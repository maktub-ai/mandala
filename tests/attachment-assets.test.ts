import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssetFiles } from '../server/asset-files';
import { createAssets } from '../server/assets';
import { saveAttachment } from '../server/attachments';
import { createAttachmentAssets } from '../server/attachment-assets';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(fn=>fn()));
function setup(){const home=mkdtempSync(join(tmpdir(),'attachment-assets-')),store=openStore(home),files=createAssetFiles(home),assets=createAssets(store,files);clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});return {home,store,assets,service:createAttachmentAssets(home,store,files,assets)};}
test('only accepted IDs import; replay and service restart retain one private identity',async()=>{
 const {home,store,assets,service}=setup();const uploaded=await saveAttachment(home,'chat','input.txt',Buffer.from('private input'));
 expect(assets.listAssets({userId:'local'})).toHaveLength(0);
 service.accept({userId:'local'},'chat',[uploaded.id],'submit',{agentId:'a',projectId:'p'});
 const [ref]=await service.resolve({userId:'local'},'chat',[uploaded.id]);
 const again=createAttachmentAssets(home,store,createAssetFiles(home),assets);
 expect(await again.resolve({userId:'local'},'chat',[uploaded.id])).toEqual([ref]);
 expect(assets.listAssets({userId:'local'})).toHaveLength(1);
 expect(assets.getAuthorizedAsset({userId:'local'},ref.assetId)).toMatchObject({owner:{userId:'local',agentId:'a'},accessPolicy:{mode:'owner'}});
 expect(()=>assets.getAuthorizedVersion({userId:'local',agentId:'b'},ref)).toThrow();
 expect(assets.listBindings({userId:'local'},'project','p')).toHaveLength(1);
 expect(()=>service.accept({userId:'local'},'chat',[uploaded.id],'later',{agentId:'b'})).toThrow();
});
test('same content in another chat stays separate; missing accepted bytes retain pending identity',async()=>{
 const {home,store,assets,service}=setup();const one=await saveAttachment(home,'one','a.txt',Buffer.from('same')),two=await saveAttachment(home,'two','a.txt',Buffer.from('same'));
 for(const [chat,item] of [['one',one],['two',two]] as const)service.accept({userId:'local'},chat,[item.id],'submit',{});
 const a=await service.resolve({userId:'local'},'one',[one.id]),b=await service.resolve({userId:'local'},'two',[two.id]);expect(a[0].assetId).not.toBe(b[0].assetId);
 service.accept({userId:'local'},'three',[one.id],'missing',{});await expect(service.resolve({userId:'local'},'three',[one.id])).rejects.toThrow();
 expect(store.database.prepare("SELECT state FROM attachment_asset_links WHERE conversation_id='three'").get()!.state).toBe('pending');
 expect(assets.listAssets({userId:'local'})).toHaveLength(2);
});
test('historical reconciliation is bounded to persisted submissions and defaults old attachments to human-private',async()=>{
 const {home,store,assets,service}=setup();const c=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const accepted=await saveAttachment(home,c.id,'accepted.txt',Buffer.from('saved')),orphan=await saveAttachment(home,c.id,'orphan.txt',Buffer.from('upload only'));
 store.appendEvent(c.id,'user',{text:'submitted',attachments:[accepted]});await service.reconcileSubmitted({userId:'local'},()=>{});
 const imported=assets.listAssets({userId:'local'});expect(imported).toHaveLength(1);expect(imported[0]).toMatchObject({title:'accepted.txt',owner:{userId:'local'},accessPolicy:{mode:'owner'}});
 expect(()=>assets.getAuthorizedAsset({userId:'local',agentId:'a'},imported[0].id)).toThrow();expect(store.database.prepare('SELECT * FROM attachment_asset_links WHERE attachment_id=?').get(orphan.id)).toBeUndefined();
 await service.reconcileSubmitted({userId:'local'},()=>{});expect(assets.listAssets({userId:'local'})).toHaveLength(1);
});
test('historical branch copies resolve the original accepted attachment without a second identity or pending missing upload',async()=>{
 const {home,store,assets,service}=setup();const original=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});const uploaded=await saveAttachment(home,original.id,'input.txt',Buffer.from('bytes'));const event=store.appendEvent(original.id,'user',{text:'input',attachments:[uploaded],fileScope:{agentId:'a',projectId:'p'}});
 const branch=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null,branchedFrom:{conversationId:original.id,eventId:event.id}});store.appendEvent(branch.id,'user',event.data);
 await service.reconcileSubmitted({userId:'local'},()=>{});expect(assets.listAssets({userId:'local'})).toHaveLength(1);expect(service.status({userId:'local'},()=>{})).toHaveLength(1);expect(service.status({userId:'local'},()=>{})[0].state).toBe('imported');
});
test('persisted retry cursor fairly reaches a restored upload among more than 32 missing accepted links',async()=>{
 const {home,store,assets,service}=setup();const c=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});const uploads=[];
 for(let index=0;index<65;index++){const item=await saveAttachment(home,c.id,`file-${index}.txt`,Buffer.from('restored'));uploads.push(item);service.accept({userId:'local'},c.id,[item.id],`submission-${index}`,{});rmSync(join(home,'attachments',c.id,item.id,'files',item.name));}
 for(let cycle=0;cycle<3;cycle++)await service.reconcileSubmitted({userId:'local'},()=>{});
 const restored=uploads[0];const {writeFile}=await import('node:fs/promises');await writeFile(join(home,'attachments',c.id,restored.id,'files',restored.name),'restored');
 const restarted=createAttachmentAssets(home,store,createAssetFiles(home),assets);for(let cycle=0;cycle<4;cycle++)await restarted.reconcileSubmitted({userId:'local'},()=>{});
 expect(assets.listAssets({userId:'local'})).toHaveLength(1);expect(restarted.status({userId:'local'},()=>{}).find(item=>item.attachmentId===restored.id)!.state).toBe('imported');
});

test('execution lineage excludes earlier attachments while default historical lineage remains complete',async()=>{
 const {home,store,assets,service}=setup(),p={userId:store.ownerUserId},chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const old=await saveAttachment(home,chat.id,'old.txt',Buffer.from('old')),fresh=await saveAttachment(home,chat.id,'fresh.txt',Buffer.from('fresh'));
 service.accept(p,chat.id,[old.id,fresh.id],'submit',{agentId:'a'});const refs=await service.resolve(p,chat.id,[old.id,fresh.id]);
 store.appendEvent(chat.id,'user',{text:'Old',attachments:[old],fileScope:{agentId:'a'}});
 const boundary=store.appendEvent(chat.id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked'}});
 store.appendEvent(chat.id,'user',{text:'Fresh',attachments:[fresh],fileScope:{agentId:'a'}});
 expect(service.lineage(p,chat.id,()=>{}).refs).toEqual(refs);
 expect(service.lineage(p,chat.id,()=>{},boundary.id).refs).toEqual([refs[1]]);
 assets.setAccess(p,refs[0].assetId,{mode:'selected',agentIds:['b']},assets.getAuthorizedAsset(p,refs[0].assetId).revision);
 await expect(service.resolve({...p,agentId:'b'},chat.id,[fresh.id])).rejects.toMatchObject({status:403});
});
