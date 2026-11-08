import {afterEach,expect,test,vi} from 'vitest';
import type {MemoryRevision} from '../shared/memory';
afterEach(()=>{vi.doUnmock('@tencentdb-agent-memory/tcvdb-text');vi.resetModules();});
test('the pretrained encoder loads only for a nonempty ranking pool and is reused afterwards',async()=>{
 const encoder={encodeQueries:vi.fn(()=>[['fact',1]]),encodeTexts:vi.fn(()=>[['fact',1]])},load=vi.fn(()=>encoder);
 vi.doMock('@tencentdb-agent-memory/tcvdb-text',()=>({BM25Encoder:{default:load}}));
 const {rankMemoryCandidates}=await import('../server/memory-search');
 expect(load).not.toHaveBeenCalled();
 expect(rankMemoryCandidates([],'fact')).toEqual([]);expect(load).not.toHaveBeenCalled();
 const record={recordId:'fact',revision:1,status:'active',validUntil:null,text:'fact'} as MemoryRevision;
 expect(rankMemoryCandidates([record],'fact',{limit:0})).toEqual([]);expect(load).not.toHaveBeenCalled();
 expect(rankMemoryCandidates([record],'fact')[0].record).toBe(record);
 expect(rankMemoryCandidates([record],'fact')[0].record).toBe(record);
 expect(load).toHaveBeenCalledExactlyOnceWith('zh');
});
