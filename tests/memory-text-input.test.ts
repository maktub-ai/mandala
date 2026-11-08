import { expect, test } from 'vitest';
import { memoryExtractionBatches } from '../server/memory-chunks';
import type { MemorySource } from '../shared/memory';
const source=(events:MemorySource['events']):MemorySource=>({id:'source',revision:1,kind:'conversation',events,eventIds:events.map(e=>e.id),text:events.map(e=>e.text).join('\n')} as MemorySource);
const event=(id:number,kind:string,text:string)=>({id,kind,text,hash:'original',createdAt:'2026-10-08T00:00:00Z'});
test('one request with 265000 tool characters processes only user and assistant text, retaining raw evidence',()=>{
 const raw=source([event(1,'user','本项目使用 pnpm。'),event(2,'tool','TOOL_PAYLOAD'.repeat(24000)),event(3,'text','已处理。\n```ts\nASSISTANT_CODE\n```\n下一步请验收。')]);
 const before=JSON.stringify(raw),batches=memoryExtractionBatches([raw]);
 expect(batches).toHaveLength(1);
 expect(batches[0][0].events.map(e=>e.kind)).toEqual(['user','text']);
 expect(JSON.stringify(batches)).not.toContain('TOOL_PAYLOAD');expect(JSON.stringify(batches)).not.toContain('ASSISTANT_CODE');
 expect(batches[0][0].text).toContain('下一步请验收。');expect(JSON.stringify(raw)).toBe(before);
 expect(batches[0][0].events[0]).toMatchObject({id:1,hash:'original',text:'本项目使用 pnpm。'});
});
test('user code remains evidence, assistant fenced blocks and injected recall are excluded',()=>{
 const raw=source([event(1,'user','我偏好这个配置：\n```json\n{"theme":"dark"}\n```'),event(2,'text','解释。\n~~~js\nNOISE\n~~~\n结论。'),event(3,'user','<relevant-memories>OLD_CONTEXT</relevant-memories>\n项目使用 bun。'),{...event(4,'user','RECALLED'),contextOnly:true}]);
 const text=JSON.stringify(memoryExtractionBatches([raw]));
 expect(text).toContain('theme');expect(text).toContain('结论');expect(text).not.toContain('NOISE');expect(text).not.toContain('OLD_CONTEXT');expect(text).not.toContain('RECALLED');
});
test('text windows cover all selected blocks chronologically, ten per batch rather than dropping older turns',()=>{
 const events=Array.from({length:24},(_,i)=>event(i+1,i%2?'text':'user',`文本 ${i+1}`)),batches=memoryExtractionBatches([source(events)]);
 expect(batches).toHaveLength(3);expect(batches.flat().flatMap(s=>s.events).map(e=>e.id)).toEqual(events.map(e=>e.id));
 expect(batches.every(b=>b.flatMap(s=>s.events).length<=10)).toBe(true);
});
test('a platform task status is retained as structured evidence, not mistaken for a conversation tool transcript',()=>{
 const raw={...source([event(1,'tool','平台状态 completed；不证明业务结论。')]),kind:'task' as const};
 expect(memoryExtractionBatches([raw])[0][0].events[0].text).toContain('平台状态');
});
