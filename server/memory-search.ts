import { BM25Encoder } from '@tencentdb-agent-memory/tcvdb-text';
import type { MemoryRevision } from '../shared/memory';
import { rrfMerge } from './vendor/tencentdb/search-utils';

export type MemoryCandidate = {record:MemoryRevision;score:number;reason:string};
export type MemorySearchOptions = {limit?:number;vectors?:Record<string,number[]>;queryVector?:number[];minVectorScore?:number};
// Exact pretrained encoder used by TencentDB's BM25LocalEncoder (97f9465).
let pretrained:ReturnType<typeof BM25Encoder.default>|undefined;
const compare = (a:MemoryCandidate,b:MemoryCandidate) => b.score-a.score || a.record.recordId.localeCompare(b.record.recordId);

export function normalized(vector:number[],dimensions=vector.length):number[]{
  if (!vector.length || vector.length!==dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid embedding vector dimensions or values');
  const scale = Math.max(...vector.map(Math.abs));
  if (!scale) throw new Error('Embedding vector must have a nonzero norm');
  const scaled=vector.map(x=>x/scale);
  const norm=Math.hypot(...scaled);
  return scaled.map(x=>x/norm);
}

/** Caller supplies the authorized pool; this function cannot expand scope. */
export function rankMemoryCandidates(records:MemoryRevision[],query:string,options:MemorySearchOptions={}):MemoryCandidate[]{
  const requested=options.limit??5;
  if (!Number.isFinite(requested)) throw new Error('Candidate limit must be finite');
  const limit=Math.min(100,Math.max(0,Math.floor(requested)));
  const latest=new Map<string,MemoryRevision>();
  for(const record of records) if(!latest.has(record.recordId)||latest.get(record.recordId)!.revision<record.revision) latest.set(record.recordId,record);
  const now=Date.now();
  const active=[...latest.values()].filter(record=>record.status==='active'&&(!record.validUntil||Date.parse(record.validUntil)>now)).sort((a,b)=>a.recordId.localeCompare(b.recordId));
  if(!limit||!active.length)return [];
  const encoder=pretrained??=BM25Encoder.default('zh');
  const queryWeights=new Map(encoder.encodeQueries(query));
  const identifiers=query.match(/[\w.-]*[\/\\][\w.\/\\-]+|\b[\w]+(?:[-_][\w]+)+\b/g)??[];
  const exact=active.filter(r=>query.trim()===r.recordId||identifiers.some(id=>r.text.includes(id))).map(record=>({record,score:Number.MAX_SAFE_INTEGER,reason:'exact'}));
  const pin=(ranked:MemoryCandidate[])=>[...exact,...ranked.filter(r=>!exact.some(e=>e.record.recordId===r.record.recordId))].slice(0,limit);
  let lexical=active.map(record=>({record,score:encoder.encodeTexts(record.text).reduce((sum,[token,weight])=>sum+(queryWeights.get(token)??0)*weight,0),reason:'bm25'})).filter(x=>x.score>0).sort(compare).slice(0,limit);
  if (!options.queryVector || !options.vectors) return pin(lexical);
  const queryVector=normalized(options.queryVector);
  const vectors:MemoryCandidate[]=[];
  for(const record of active){
    const supplied=options.vectors[record.recordId];
    if(!supplied) continue;
    const vector=normalized(supplied,queryVector.length);
    const score=vector.reduce((sum,value,i)=>sum+value*queryVector[i],0);
    if(score>0&&score>=(options.minVectorScore??0)) vectors.push({record,score,reason:'vector'});
  }
  if(options.minVectorScore){const qualified=new Set(vectors.map(v=>v.record.recordId)),literal=query.trim().toLowerCase();lexical=lexical.filter(hit=>!options.vectors![hit.record.recordId]||qualified.has(hit.record.recordId)||Boolean(literal&&hit.record.text.toLowerCase().includes(literal)));}
  vectors.sort(compare);
  const vectorRanks=vectors.slice(0,limit);
  if(!lexical.length) return pin(vectorRanks);
  if(!vectorRanks.length) return pin(lexical);
  const fused=rrfMerge([lexical,vectorRanks],x=>x.record.recordId).map(x=>({record:x.record,score:x.rrfScore,reason:'hybrid_rrf'})).sort(compare);
  // Keep the best semantic hit even when many weak lexical hits receive two-list votes.
  const anchor=fused.find(x=>x.record.recordId===vectorRanks[0].record.recordId)!;
  return pin([{...anchor,reason:'semantic_anchor'},...fused.filter(x=>x!==anchor)]);
}
