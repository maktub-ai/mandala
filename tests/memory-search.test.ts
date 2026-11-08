import { describe,it,expect } from 'vitest';
import { BM25Encoder } from '@tencentdb-agent-memory/tcvdb-text';
import type { MemoryRevision } from '../shared/memory';
import { rankMemoryCandidates } from '../server/memory-search';
import { rrfMerge } from '../server/vendor/tencentdb/search-utils';
const record=(id:string,text:string,status:MemoryRevision['status']='active',revision=1):MemoryRevision=>({recordId:id,revision,collectionId:'authorized',layer:'L1',contentType:'fact',text,status,evidence:[],dependencies:[],observedAt:null,effectiveFrom:'2026-01-01',validUntil:null,extractedAt:'2026-01-01',verification:'source_extract',taskId:null,conversationId:null,contentHash:id});
const encoder=BM25Encoder.default('zh');
function upstreamScores(records:MemoryRevision[],query:string){ const q=new Map(encoder.encodeQueries(query)); return records.map(record=>({record,score:encoder.encodeTexts(record.text).reduce((sum,[token,weight])=>sum+(q.get(token)??0)*weight,0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score); }
describe('TencentDB candidate search',()=>{
 it('segments Chinese and matches exact upstream BM25 weights',()=>{const rows=[record('a','用户喜欢编程和TypeScript'),record('b','今天去日本旅行')]; const actual=rankMemoryCandidates(rows,'编程'); expect(actual.map(x=>x.record.recordId)).toEqual(['a']); expect(actual[0].score).toBe(upstreamScores(rows,'编程')[0].score);});
 it('preserves upstream rare term weighting over repeated common terms',()=>{const rows=[record('a','用户 用户 用户 用户 用户'),record('b','Kubernetes')];const expected=upstreamScores(rows,'用户 Kubernetes');expect(expected[0].record.recordId).toBe('b'); expect(rankMemoryCandidates(rows,'用户 Kubernetes').map(x=>x.score)).toEqual(expected.map(x=>x.score));});
 it('preserves English boundaries and upstream lack of stemming',()=>{const rows=[record('run','run'),record('running','running'),record('runner','runner')];expect(rankMemoryCandidates(rows,'running').map(x=>x.record.recordId)).toEqual(['running']);expect(rankMemoryCandidates(rows,'run').map(x=>x.record.recordId)).toEqual(['run']);});
 it('supports supplied semantic vectors without lexical overlap',()=>{const rows=[record('a','travels to Tokyo'),record('b','cooks pasta')]; const hits=rankMemoryCandidates(rows,'日本旅行',{queryVector:[1,0],vectors:{a:[1,0],b:[0,1]}});expect(hits.map(x=>x.record.recordId)).toEqual(['a']);expect(hits[0].reason).toBe('vector');});
 it('fuses supplied vector and BM25 lists using upstream RRF',()=>{const rows=[record('a','编程'),record('b','编程 编程'),record('c','旅行')];const lexical=upstreamScores(rows,'编程');const vector=[{record:rows[2],score:1},{record:rows[0],score:0.8}];const expected=rrfMerge([lexical,vector],x=>x.record.recordId);expect(rankMemoryCandidates(rows,'编程',{queryVector:[1,0],vectors:{a:[.8,.6],c:[1,0]}}).map(x=>[x.record.recordId,x.score])).toEqual([expected.find(x=>x.record.recordId==='c')!,...expected.filter(x=>x.record.recordId!=='c')].map(x=>[x.record.recordId,x.rrfScore]));});
 it('excludes inactive and obsolete revisions and never adds vector-only external IDs',()=>{const rows=[record('a','编程','active',1),record('a','旅行','stale',2),record('b','编程','retracted'),record('c','编程')];expect(rankMemoryCandidates(rows,'编程',{queryVector:[1,0],vectors:{external:[1,0]}}).map(x=>x.record.recordId)).toEqual(['c']);});
 it('validates dimensions, finite values and nonzero vector norm',()=>{for(const vector of [[1], [NaN,0],[Infinity,1],[0,0]])expect(()=>rankMemoryCandidates([record('a','编程')],'编程',{queryVector:[1,0],vectors:{a:vector}})).toThrow();});
 it('returns deterministic ties and bounds topK',()=>{const rows=[record('b','编程'),record('a','编程')];expect(rankMemoryCandidates(rows,'编程',{limit:1})[0].record.recordId).toBe('a');expect(rankMemoryCandidates(rows,'编程',{limit:0})).toEqual([]);expect(rankMemoryCandidates(rows,'zzz')).toEqual([]);});
});
it('keeps the strongest semantic candidate ahead of weak lexical double-votes while retaining exact paths',()=>{
 const rows=[record('target','a historical interface constraint'),...Array.from({length:12},(_,i)=>record(`noise${i}`,'visual state content'))];
 const vectors=Object.fromEntries(rows.map(r=>[r.recordId,r.recordId==='target'?[1,0]:[.5,.866]]));
 const result=rankMemoryCandidates(rows,'visual state',{limit:8,queryVector:[1,0],vectors});expect(result[0].record.recordId).toBe('target');expect(result[0].reason).toBe('semantic_anchor');
 const exact=record('path','server/example.ts');expect(rankMemoryCandidates([...rows,exact],'visual state server/example.ts',{limit:8,queryVector:[1,0],vectors:{...vectors,path:[0,1]}})[0].record.recordId).toBe('path');
});
it('does not fill semantic recall with weak matches but retains exact identifiers below the local relevance floor',()=>{
 const rows=[record('a','unrelated visual background'),record('b','server/answer.ts'),record('c','octopus')];
 const weak=[.2,Math.sqrt(.96)];expect(rankMemoryCandidates(rows,'underwater camouflage',{queryVector:[1,0],vectors:{a:weak,b:weak},minVectorScore:.4})).toEqual([]);
 expect(rankMemoryCandidates(rows,'server/answer.ts',{queryVector:[1,0],vectors:{a:weak,b:weak},minVectorScore:.4})[0].record.recordId).toBe('b');
 expect(rankMemoryCandidates(rows,'visual question',{queryVector:[1,0],vectors:{a:weak,b:weak},minVectorScore:.4})).toEqual([]);
});
