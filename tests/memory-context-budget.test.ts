import {expect,test} from 'vitest';
import {buildMemoryContext} from '../server/memory-context';

test('large invalidation histories stay bounded and require rereading memories whose changes were omitted',()=>{
 const notices=Array.from({length:100},(_,i)=>({recordId:`historical-record-${i}`,revision:2,status:'retracted'}));
 const result=buildMemoryContext({profile:null,facts:[],scenes:[],query:'continue',notices});
 expect(Buffer.byteLength(result.instructions,'utf8')).toBeLessThanOrEqual(6000);
 expect(result.instructions).toContain('memory_changed');
 expect(result.instructions).toContain('re-read any earlier memory before using it');
 expect(result.instructions).toContain('retracted');
 expect(result.items).toEqual([]);
});

test('no matches and no changes add no memory context',()=>{
 expect(buildMemoryContext({profile:null,facts:[],scenes:[],query:'new topic',notices:[]})).toEqual({items:[],instructions:''});
});
