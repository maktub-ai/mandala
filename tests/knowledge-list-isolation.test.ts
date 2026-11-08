import {afterEach,beforeEach,expect,test} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readConfig,writeConfig} from '../server/config';
import {migrateWorkspace} from '../server/workspace-migrations';
import {openStore} from '../server/store';
import {createKnowledge,readKnowledge,readKnowledgeEntry} from '../server/knowledge';
import {createSkillService} from '../server/skill-service';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
let home:string,store:ReturnType<typeof openStore>;
const root={userId:'local'};
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),'knowledge-list-'));
 const initial=await readConfig(home);initial.config.agents=[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];await writeConfig(home,initial.config,initial.revision);
 await createKnowledge(home,{kind:'memory',title:'Legacy history',content:'Preserved history',scope:'global',status:'candidate',level:'L2'},initial.config);
 await migrateWorkspace(home,'apply');store=openStore(home);
});
afterEach(()=>{store?.close();rmSync(home,{recursive:true,force:true});});
async function document(){return createKnowledge(home,{kind:'document',title:'Healthy document',content:'Healthy document body',scope:'global',status:'active'},(await readConfig(home)).config,false,store);}
test('unavailable Skill evidence cannot hide healthy canonical entries or legacy history, while direct reads remain forbidden',async()=>{
 const original=readFileSync(join(home,'knowledge.json'),'utf8'),doc=await document(),chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}),event=store.appendEvent(chat.id,'user',{text:'Synthetic evidence'});
 const source={agentId:'a',projectId:'',method:'dialogue' as const,verification:'draft' as const,conversationId:chat.id,eventIds:[event.id],eventFingerprints:{[event.id]:createHash('sha256').update(JSON.stringify(event)).digest('hex')}};
 const service=createSkillService(home,store),content='---\nname: derived\ndescription: Synthetic skill\n---\nSynthetic evidence';
 const derived:any=await service('a','skill_register',{name:'derived',content},'derived',()=>{},source),healthy:any=await service('a','skill_register',{name:'healthy',content:content.replace('name: derived','name: healthy')},'healthy',()=>{});
 expect(await readKnowledge(home,store)).toHaveLength(4);
 const next=await readConfig(home);next.config.agents=[{id:'b',name:'B',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];await writeConfig(home,next.config,next.revision);
 await expect(readKnowledgeEntry(home,derived.skill.versionRef.assetId,store)).rejects.toMatchObject({code:'skill_source_replaced',status:403});
 const entries=await readKnowledge(home,store);
 expect(entries.map(entry=>entry.id)).toEqual(expect.arrayContaining([doc.id,healthy.skill.versionRef.assetId]));
 expect(entries.find(entry=>entry.title==='Legacy history')).toMatchObject({content:'Preserved history',status:'candidate'});
 expect(entries).toHaveLength(3);expect(entries.some(entry=>entry.id===derived.skill.versionRef.assetId)).toBe(false);
 expect(readFileSync(join(home,'knowledge.json'),'utf8')).toBe(original);
});
test('aggregate knowledge propagates missing blob conflicts',async()=>{
 const doc=await document(),assets=createAssets(store,createAssetFiles(home)),asset=assets.getAuthorizedAsset(root,doc.id),file=assets.readAssetFile(root,{assetId:doc.id,versionId:asset.headVersionId!},'0');unlinkSync(file.blobPath);
 await expect(readKnowledge(home,store)).rejects.toMatchObject({code:'blob_missing',status:409});
});
test('aggregate knowledge propagates unexpected malformed version data',async()=>{
 const doc=await document(),asset=createAssets(store,createAssetFiles(home)).getAuthorizedAsset(root,doc.id);
 store.database.prepare('UPDATE asset_versions SET data=? WHERE id=?').run('{',asset.headVersionId!);
 await expect(readKnowledge(home,store)).rejects.toBeInstanceOf(SyntaxError);
});
