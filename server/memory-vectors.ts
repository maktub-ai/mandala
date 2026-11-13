import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {MemoryRevision} from '../shared/memory';
import {normalized} from './memory-search';
export const LOCAL_EMBEDDING_MODEL='embeddinggemma:latest';
// Frozen local-model calibration: gold facts >= .4115; four unrelated negatives <= .2387.
export const LOCAL_MIN_RELEVANCE=0.4;
export type MemoryVectorOptions={model?:string;embed?:(texts:string[])=>Promise<number[][]>;signal?:AbortSignal;revalidate?:()=>Promise<void>};
// Effective semantics and collection scope; evidence/revision/time-of-extraction do not change vectors.
export const semanticHash=(record:MemoryRevision,text=record.text)=>createHash('sha256').update(JSON.stringify(['embeddinggemma-search-v1',record.collectionId,record.layer,record.contentType,record.semanticKey??null,record.validUntil,record.effectiveFrom,record.verification,text])).digest('hex');
// Fixed loopback endpoint: memory text never goes to a configured cloud model or URL.
export async function localEmbed(texts:string[],signal?:AbortSignal):Promise<number[][]>{
 const response=await fetch('http://127.0.0.1:11434/api/embed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:LOCAL_EMBEDDING_MODEL,input:texts,truncate:false,keep_alive:'5m'}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('local_embedding_unavailable');
 const result=await response.json() as {embeddings?:number[][]};
 if(!Array.isArray(result.embeddings)||result.embeddings.length!==texts.length)throw new Error('invalid_local_embeddings');
 return result.embeddings;
}
export function createMemoryVectors(db:DatabaseSync,options:MemoryVectorOptions={}) {
 let model=options.model??LOCAL_EMBEDDING_MODEL;const embed=options.embed??((texts:string[])=>localEmbed(texts,options.signal));
 const resolveModel=async(checkpoint?:()=>Promise<void>,signal=options.signal)=>{
  if(options.embed)return model;
  const response=await fetch('http://127.0.0.1:11434/api/tags',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1500)]):AbortSignal.timeout(1500)});
  await checkpoint?.();
  if(!response.ok)throw new Error('local_embedding_model_unavailable');
  const result=await response.json() as {models?:{name:string;digest:string}[]};await checkpoint?.();const entry=result.models?.find(m=>m.name===LOCAL_EMBEDDING_MODEL);
  if(!entry?.digest)throw new Error('local_embedding_model_unavailable');
  model=LOCAL_EMBEDDING_MODEL+'@'+entry.digest;return model;
 };
 db.exec('CREATE TABLE IF NOT EXISTS memory_vectors(model TEXT NOT NULL,semantic_hash TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(model,semantic_hash)); CREATE TABLE IF NOT EXISTS memory_vector_models(model TEXT PRIMARY KEY,dimensions INTEGER NOT NULL)');
 const lookup=db.prepare('SELECT vector FROM memory_vectors WHERE model=? AND semantic_hash=?');
 const dimensions=()=>db.prepare('SELECT dimensions FROM memory_vector_models WHERE model=?').get(model)?.dimensions as number|undefined??(!options.embed?768:undefined);
 const readVector=(hash:string):number[]|undefined=>{const row=lookup.get(model,hash);if(!row)return;try{return normalized(JSON.parse(row.vector as string),dimensions());}catch{db.prepare('DELETE FROM memory_vectors WHERE model=? AND semantic_hash=?').run(model,hash);}};
 const cached=(r:MemoryRevision)=>readVector(semanticHash(r));
 // Bound each input below the model's 2K-token window even with byte-fallback tokens.
 const chunks=(text:string):string[]=>{
  const letters=Array.from(text),result:string[]=[];let start=0;
  while(start<letters.length){let end=start,bytes=0;while(end<letters.length&&bytes+Buffer.byteLength(letters[end],'utf8')<=1200){bytes+=Buffer.byteLength(letters[end++],'utf8');}result.push(letters.slice(start,end).join(''));if(end===letters.length)break;start=Math.max(start+1,end-40);}
  return result;
 };
 const put=(hash:string,vector:number[])=>db.prepare('INSERT INTO memory_vectors VALUES(?,?,?) ON CONFLICT(model,semantic_hash) DO UPDATE SET vector=excluded.vector').run(model,hash,JSON.stringify(vector));
 const chunkHash=(record:MemoryRevision,text:string)=>semanticHash(record,'embeddinggemma-chunk-v1:'+text);
 const chunkVector=(record:MemoryRevision,text:string)=>readVector(chunkHash(record,text));
 // At most 64 records and 64 missing chunks per refresh; partial long documents resume later.
 async function refresh(pool:MemoryRevision[],current:(r:MemoryRevision)=>MemoryRevision|undefined):Promise<void>{
  const identity=await resolveModel();
  const missing=[...new Map(pool.filter(r=>!cached(r)).map(r=>[semanticHash(r),r])).values()].slice(0,64);
  const documents=missing.map(record=>({record,texts:chunks(record.text)}));
  const units=new Map<string,{text:string;key:string;documents:typeof documents}>();
  for(const doc of documents)for(const text of doc.texts){
   if(doc.texts.length>1&&chunkVector(doc.record,text))continue;
   const key=chunkHash(doc.record,text),unit=units.get(key);if(unit)unit.documents.push(doc);else units.set(key,{text,key,documents:[doc]});
  }
  const pending=[...units.values()].slice(0,64);
  const generated=new Map<string,number[]>();
  for(let offset=0;offset<pending.length;offset+=16){
   const batch=pending.slice(offset,offset+16).filter(unit=>unit.documents.some(doc=>current(doc.record)));if(!batch.length)continue;
   const values=await embed(batch.map(unit=>'title: memory | text: '+unit.text));
   await options.revalidate?.();
   if(await resolveModel()!==identity)throw new Error('local_embedding_model_changed');
   if(values.length!==batch.length)throw new Error('invalid_local_embeddings');
   const result=values.map(v=>normalized(v,dimensions()??values[0]?.length));
   db.prepare('INSERT INTO memory_vector_models VALUES(?,?) ON CONFLICT(model) DO NOTHING').run(model,result[0].length);
   for(let i=0;i<batch.length;i++)if(batch[i].documents.some(doc=>current(doc.record))){generated.set(batch[i].key,result[i]);if(batch[i].documents.some(doc=>doc.texts.length>1))put(batch[i].key,result[i]);}
  }
  for(const doc of documents){
   if(!current(doc.record))continue;
   const values=doc.texts.map(text=>generated.get(chunkHash(doc.record,text))??chunkVector(doc.record,text));if(values.some(value=>!value))continue;
   const dimensions=values[0]!.length;
   if(values.some(value=>value!.length!==dimensions))throw new Error('invalid_local_embeddings');
   const average=Array.from({length:dimensions},(_,i)=>values.reduce((sum,value)=>sum+value![i],0)/values.length);
   put(semanticHash(doc.record),normalized(average));
  }
 }
 return {refresh,prepare:resolveModel,
  async query(text:string,checkpoint?:()=>Promise<void>,signal=options.signal){
   const identity=await resolveModel(checkpoint,signal);
   await checkpoint?.();
   signal?.throwIfAborted();
   const parts=chunks(text),inputs=parts.map(part=>'task: search result | query: '+part);
   const values=await (options.embed?options.embed(inputs):localEmbed(inputs,signal));
   signal?.throwIfAborted();
   await checkpoint?.();await options.revalidate?.();await checkpoint?.();
   signal?.throwIfAborted();
   if(await resolveModel(checkpoint,signal)!==identity)throw new Error('local_embedding_model_changed');
   if(values.length!==parts.length)throw new Error('invalid_local_embeddings');
   const checked=values.map(v=>normalized(v,dimensions()??values[0]?.length));
   return normalized(checked[0].map((_,i)=>checked.reduce((sum,v)=>sum+v[i],0)/checked.length));
  },
  vectors(pool:MemoryRevision[]){return Object.fromEntries(pool.flatMap(r=>{const v=cached(r);return v?[[r.recordId,v]]:[];}));},
  lag(pool:MemoryRevision[]){return pool.filter(r=>!cached(r)).length;},
 };
}
