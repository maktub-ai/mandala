import {expect,test} from 'vitest';
import {memoryThinking} from '../server/memory-thinking';
import type {MemoryGeneratorInput} from '../server/memory-pipeline';
const input=(stage:MemoryGeneratorInput['stage'],extra:Partial<MemoryGeneratorInput>={}):MemoryGeneratorInput=>({stage,job:{error:null} as MemoryGeneratorInput['job'],sources:[],records:[],signal:new AbortController().signal,...extra});
test.each(['scene','profile','consolidate'] as const)('keeps reasoning for %s generation and independent audit',stage=>{
 expect(memoryThinking(input(stage))).toBe('low');expect(memoryThinking(input('verify',{reviewStage:stage}))).toBe('low');
});
test.each(['extract','conflict'] as const)('requests the economical selector for ordinary %s generation and review',stage=>{
 expect(memoryThinking(input(stage))).toBe('off');expect(memoryThinking(input('verify',{reviewStage:stage}))).toBe('off');
});
test('conflict correction repairs use low only with a precise correction and original authoritative evidence',()=>{
 const quote='Correction: use pnpm.',proposal={explicitChange:true,support:[{sourceId:'source',eventId:1,quote}]} as NonNullable<MemoryGeneratorInput['repairDrafts']>[number],sources=[{id:'source',events:[{id:1,kind:'user',text:quote}]}] as MemoryGeneratorInput['sources'];
 expect(memoryThinking(input('conflict',{repairDrafts:[proposal],callKind:'repair',sources}))).toBe('low');
 expect(memoryThinking(input('verify',{reviewStage:'conflict',drafts:[proposal],callKind:'repair',sources}))).toBe('low');
 expect(memoryThinking(input('conflict',{repairDrafts:[proposal],callKind:'repair'}))).toBe('off');
 expect(memoryThinking(input('conflict',{repairDrafts:[proposal],sources}))).toBe('off');
 expect(memoryThinking(input('extract',{repairDrafts:[proposal],callKind:'repair',sources}))).toBe('off');
});
