import type {MemoryRevision,MemoryProfileScope} from '../shared/memory';
import type {MemoryStore} from './memory-store';
import {parseSceneBlock} from './vendor/tencentdb/scene-format';
import {buildSceneExtractionPrompt} from './vendor/tencentdb/scene-extraction';
import {buildPersonaPrompt} from './vendor/tencentdb/persona-generation';
const sceneRecord=(r:MemoryRevision)=>r.layer==='L2'&&r.semanticKey?.startsWith('scene.')&&r.semanticKey!=='session.context';
// Engineering index mirrors upstream syncSceneIndex: filenames become authoritative record IDs.
function indexScenes(records:MemoryRevision[],hits=new Map<string,number>()){return records.filter(r=>r.status==='active'&&sceneRecord(r)).map(r=>{const {meta}=parseSceneBlock(r.text,r.recordId);return {filename:r.recordId,...meta,heat:hits.get(r.collectionId+'@'+r.semanticKey)??meta.heat};});}
function navigation(records:MemoryRevision[],hits:Map<string,number>):string{
 const entries=indexScenes(records,hits).sort((a,b)=>b.heat-a.heat);if(!entries.length)return '';
 const fire=(heat:number)=>heat>=1000?' 🔥🔥🔥🔥🔥':heat>=500?' 🔥🔥🔥🔥':heat>=200?' 🔥🔥🔥':heat>=100?' 🔥🔥':heat>=50?' 🔥':'';
 return `---\n## 🗺️ Scene Navigation (Scene Index)\n*This is the current scene-memory index. Use recordId with the authorized memory-read interface to read details.*\n\n${entries.map(e=>`### Record: ${e.filename}\n**Heat**: ${e.heat}${fire(e.heat)}${e.updated?` | **Updated**: ${e.updated}`:''}\nSummary: ${e.summary}`).join('\n\n')}\n\n📌 Usage:\n- Record is a scene recordId within the current authorized scope\n- Heat: cumulative memory hits for this scene; higher values indicate greater importance\n- Summary: the scene\'s core points`;
}
export function createMemoryScenes(memory:MemoryStore){
 const db=memory.store.database;
 db.exec('CREATE TABLE IF NOT EXISTS memory_scene_hits(collection_id TEXT NOT NULL,semantic_key TEXT NOT NULL,hits INTEGER NOT NULL,PRIMARY KEY(collection_id,semantic_key))');
 db.exec(`CREATE TABLE IF NOT EXISTS memory_scene_cursors(collection_id TEXT NOT NULL,kind TEXT NOT NULL,record_id TEXT NOT NULL,revision INTEGER NOT NULL,committed_at TEXT NOT NULL,PRIMARY KEY(collection_id,kind,record_id));CREATE TABLE IF NOT EXISTS memory_scene_checkpoints(collection_id TEXT PRIMARY KEY,scenes_processed INTEGER NOT NULL DEFAULT 0,last_persona_time TEXT NOT NULL DEFAULT '');`);
 const atomic=(fn:()=>void)=>{if(db.isTransaction){fn();return;}db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}};
 const cursor=(collectionId:string,kind:string)=>new Map(db.prepare('SELECT record_id,revision FROM memory_scene_cursors WHERE collection_id=? AND kind=?').all(collectionId,kind).map(row=>[row.record_id as string,row.revision as number]));
 const scoped=(collectionId:string,records:MemoryRevision[])=>records.filter(r=>r.collectionId===collectionId);
 const writeCursor=(collectionId:string,kind:string,records:MemoryRevision[],now:string)=>{for(const r of scoped(collectionId,records).filter(r=>r.layer==='L1'&&r.status==='active'))db.prepare('INSERT INTO memory_scene_cursors VALUES(?,?,?,?,?) ON CONFLICT(collection_id,kind,record_id) DO UPDATE SET revision=excluded.revision,committed_at=excluded.committed_at').run(collectionId,kind,r.recordId,r.revision,now);};
 return {
  prepare(collectionId:string,records:MemoryRevision[]){
   const local=scoped(collectionId,records),consumed=cursor(collectionId,'scene'),hits=new Map(db.prepare('SELECT collection_id,semantic_key,hits FROM memory_scene_hits WHERE collection_id=?').all(collectionId).map(row=>[row.collection_id+'@'+row.semantic_key,row.hits as number]));
   const scenes=local.filter(r=>sceneRecord(r)&&(r.status==='active'||r.status==='stale'));
   const currentFacts=new Map(local.filter(r=>r.layer==='L1'&&r.status==='active').map(r=>[r.recordId,r]));
   const compatible=(id:string,revision:number,current:MemoryRevision)=>memory.compatibleRevision({recordId:id,revision},current);
   const rebuild=new Set(scenes.flatMap(r=>r.dependencies.filter(d=>{const current=currentFacts.get(d.recordId);return !current||!compatible(d.recordId,d.revision,current);}).map(d=>d.recordId)));
   // Advance only full-history-compatible evidence progress, including a profile cursor that already consumed it.
   const acknowledged={scene:consumed,profile:cursor(collectionId,'profile')};
   atomic(()=>{for(const r of currentFacts.values())for(const [kind,progress] of Object.entries(acknowledged)){
    const previous=progress.get(r.recordId);
    if(previous!==undefined&&previous!==r.revision&&!rebuild.has(r.recordId)&&compatible(r.recordId,previous,r)){
     db.prepare("UPDATE memory_scene_cursors SET revision=? WHERE collection_id=? AND kind=? AND record_id=?").run(r.revision,collectionId,kind,r.recordId);progress.set(r.recordId,r.revision);
    }
   }});
   const newFacts=local.filter(r=>r.layer==='L1'&&r.status==='active'&&(consumed.get(r.recordId)!==r.revision||rebuild.has(r.recordId)));
   return {newFacts,scenes,index:JSON.stringify(indexScenes(local,hits),null,2),navigation:navigation(local,hits)};
  },
  commit(collectionId:string,records:MemoryRevision[],now:string){atomic(()=>{writeCursor(collectionId,'scene',records,now);db.prepare("INSERT INTO memory_scene_checkpoints(collection_id,scenes_processed) VALUES(?,1) ON CONFLICT(collection_id) DO UPDATE SET scenes_processed=scenes_processed+1").run(collectionId);});},
  profileTrigger(collectionId:string,records:MemoryRevision[],explicit=false,scope?:MemoryProfileScope){
   if(explicit)return {should:true,reason:'主动请求: Agent 请求更新'};
   const local=scoped(collectionId,records),hasScenes=local.some(r=>sceneRecord(r)&&r.status==='active'),hasPersona=(scope?records:local).some(r=>r.layer==='L3'&&r.status==='active'&&r.text.trim()&&(!scope||r.profileScope?.projectId===scope.projectId&&r.profileScope?.agentId===scope.agentId));
   if(!hasScenes)return {should:false,reason:''};
   const cp=db.prepare('SELECT scenes_processed,last_persona_time FROM memory_scene_checkpoints WHERE collection_id=?').get(collectionId);
   if(hasScenes&&!hasPersona)return {should:true,reason:cp?.last_persona_time?'恢复：persona.md 正文丢失或为空，需要重新生成':'首次冷启动：首次提取完成且有场景文件'};
   const previous=cursor(scope?collectionId+'|profile|'+JSON.stringify(scope):collectionId,'profile'),processed=cursor(collectionId,'scene');
   const count=[...processed].filter(([id,revision])=>previous.get(id)!==revision).length;
   if(cp?.scenes_processed===1&&count>0)return {should:true,reason:'首次 Scene Block 提取完成'};
   return count>=50?{should:true,reason:`达到阈值: ${count} >= 50`}:{should:false,reason:''};
  },
  profileCommitted(collectionId:string,records:MemoryRevision[],now:string,scope?:MemoryProfileScope){atomic(()=>{
   const key=scope?collectionId+'|profile|'+JSON.stringify(scope):collectionId;
   // A successful profile acknowledges the entire consumed scene checkpoint, including revoked facts absent from the current authorized record set.
   db.prepare("INSERT INTO memory_scene_cursors(collection_id,kind,record_id,revision,committed_at) SELECT ?,'profile',record_id,revision,? FROM memory_scene_cursors WHERE collection_id=? AND kind='scene' ON CONFLICT(collection_id,kind,record_id) DO UPDATE SET revision=excluded.revision,committed_at=excluded.committed_at").run(key,now,collectionId);
   for(const r of scoped(collectionId,records).filter(r=>r.layer==='L1'&&r.status==='active'))db.prepare('INSERT INTO memory_scene_cursors VALUES(?,?,?,?,?) ON CONFLICT(collection_id,kind,record_id) DO UPDATE SET revision=excluded.revision,committed_at=excluded.committed_at').run(key,'profile',r.recordId,r.revision,now);db.prepare("INSERT INTO memory_scene_checkpoints(collection_id,last_persona_time) VALUES(?,?) ON CONFLICT(collection_id) DO UPDATE SET last_persona_time=excluded.last_persona_time").run(collectionId,now);});},
 };
}
const proposalProtocol=`\n## Mandala authoritative storage adaptation (overrides ALL file-tool instructions above)\nFile names are logical scene semanticKey names, not disk paths. All current authorized record content is supplied as data. Do not call read/write/edit or any business tool. Return revisioned MemoryProposal operations in the caller's JSON schema: store for Create, update/merge for Integrate/Rewrite, skip for no change, retract for [DELETED] soft-delete. Existing records must appear in replaces with their exact recordId/revision; dependencies must list exact currently supplied active source fact revisions used by each scene. Preserve separate named scenes (semanticKey scene.<name>), Markdown META metadata, created time, summary and heat. Corrections/revocations require rebuilding from current facts; never retain superseded narrative claims. Return full replacement Markdown text, not a patch. Persona uses L3 semanticKey persona.operating-doctrine and authorized L2 dependencies. Engineering builds index/navigation separately. All evidence/support/provenance must reference supplied source data. Global user preferences require explicit user support; work principles may derive from tool-verified scene evidence.\n`;
export function buildSceneInstructions(promptMode:'chat'|'code'='code'):string{return buildSceneExtractionPrompt({memoriesJson:'',sceneSummaries:'',currentTimestamp:'',maxScenes:100,promptMode}).systemPrompt+proposalProtocol;}
export function buildProfileInstructions(promptMode:'chat'|'code'='code'):string{return buildPersonaPrompt({mode:'incremental',promptMode,currentTime:'',totalProcessed:0,sceneCount:0,changedSceneCount:0,changedScenesContent:'',personaFilePath:'',checkpointPath:''}).systemPrompt+proposalProtocol;}
