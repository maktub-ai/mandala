import {expect,test,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runOfflineRetrieval,scoreRecording,scoreRetrieval,scoreRuntimeFixtures,summarizeObservations,validateFixture,type PairedFixture,type PairedRecording,type RuntimeFixtures} from '../scripts/memory-paired-eval';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/memory-paired-personal.json',import.meta.url),'utf8')) as PairedFixture;
const recording=JSON.parse(readFileSync(new URL('./fixtures/memory-paired-recording.json',import.meta.url),'utf8')) as PairedRecording;
const runtimeFixtures=JSON.parse(readFileSync(new URL('./fixtures/memory-paired-runtime.json',import.meta.url),'utf8')) as RuntimeFixtures;
const correction=fixture.cases.find(c=>c.id==='correction-zh')!;
const hit={id:'m5',sourceRefs:[{sourceId:'s5',sourceRevision:1}],characters:7};
test('independent personal corpus stays fixed and malformed identity/provenance is rejected',()=>{
 expect(validateFixture(fixture)).toHaveLength(12);
 for(const mutate of [(f:PairedFixture)=>f.cases.push(f.cases[0]),(f:PairedFixture)=>f.cases[0].seedMemory[0].sourceRefs[0].sourceRevision++, (f:PairedFixture)=>f.cases[0].task.availableSourceIds.push('missing')]){
  const bad=structuredClone(fixture);mutate(bad);expect(()=>validateFixture(bad)).toThrow();
 }
});
test('scorer separates irrelevant returns, authority errors, duplicates and missing source revisions',()=>{
 expect(scoreRetrieval(correction,[hit])).toMatchObject({recallAt5:1,precisionAt5:1,authorityErrors:0,duplicateHits:0});
 expect(scoreRetrieval(correction,[hit,hit]).duplicateHits).toBe(1);
 expect(scoreRetrieval(correction,[{...hit,sourceRefs:[{sourceId:'s5',sourceRevision:2}]}]).sourceErrors).toBe(1);
 expect(scoreRetrieval(correction,[{...hit,text:'花盆标签蓝色。'}]).contentErrors).toBe(1);
 expect(scoreRetrieval(correction,[{...hit,id:'m4'}]).authorityErrors).toBeGreaterThan(0);
 const negative=fixture.cases.find(c=>c.category==='unanswerable')??fixture.cases.find(c=>c.id==='unanswerable-overlap-zh')!;
 const result=scoreRetrieval(negative,[{id:'m9',sourceRefs:[{sourceId:'s9',sourceRevision:1}],characters:9}]);
 expect(result).toMatchObject({recallAt5:null,precisionAt5:0,negativeFalsePositive:true,authorityErrors:0});
});
test('recording ignores claimed taskSuccess, grades answer facts and preserves unknown native costs',()=>{
 const scored=scoreRecording(correction,recording);
 expect(scored.lanes.every(l=>l.taskPass)).toBe(true);
 expect(scored).toMatchObject({answerBenefitMeasured:false,nativeTokenBenefitMeasured:false,pairedSaving:null,backgroundFactsSaved:null});
 expect(scored.lanes[0].usage.totalTokens).toBeNull();
 const bad=structuredClone(recording);bad.lanes[1].answer={color:'蓝色'};
 expect(scoreRecording(correction,bad).interference).toBe(true);
 bad.lanes[1].sourceReads=['s3'];expect(()=>scoreRecording(correction,bad)).toThrow(/source/i);
 const missing=structuredClone(recording);missing.lanes[1].answer={};expect(scoreRecording(correction,missing).lanes[1].taskPass).toBe(false);
 const questions=structuredClone(recording);questions.lanes[1].unnecessaryBackgroundQuestions=1;expect(scoreRecording(correction,questions).interference).toBe(true);
 const expiration=fixture.cases.find(c=>c.id==='expiration-zh')!,current=structuredClone(recording);current.taskId=expiration.id;
 for(const l of current.lanes){l.sourceReads=[];l.recalledMemoryIds=[];l.answer={state:'unknown',mustVerifyCurrent:false};}
 expect(scoreRecording(expiration,current).lanes.every(l=>!l.taskPass)).toBe(true);
});
test('every initiated call counts, cache/reasoning are subsets, and partial usage cannot be complete',()=>{
 const known={...recording.lanes[0].observations[0],status:'completed',coverage:'observed' as const,inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:50,reasoningOutputTokens:5,durationMs:10};
 const unknown={...known,executionId:'unknown',status:'failed',coverage:'unknown' as const,inputTokens:null,outputTokens:null,totalTokens:null,reasoningOutputTokens:null};
 expect(summarizeObservations([known])).toMatchObject({initiated:1,completed:1,reportedTotalTokens:120,totalTokens:120,inputTokens:100,outputTokens:20,reasoningOutputTokens:5});
 expect(summarizeObservations([known,unknown])).toMatchObject({initiated:2,failed:1,reportedTotalTokens:120,totalTokens:null,reasoningOutputTokens:null,complete:false});
 expect(summarizeObservations([known,known])).toMatchObject({initiated:1,totalTokens:120,duplicateSnapshots:1});
 expect(()=>summarizeObservations([known,{...known,totalTokens:121}])).toThrow(/conflict/i);
 const bad=structuredClone(recording);bad.lanes[0].nativeCallsInitiated=1;expect(()=>scoreRecording(correction,bad)).toThrow(/call/i);
});
test('independent nested runtime fixtures count complete cold cost, unknown failure and duplicate snapshots',()=>{
 const report=scoreRuntimeFixtures(runtimeFixtures);
 expect(report.fixtures).toHaveLength(4);expect(report.actualNativeCallsInitiated).toBe(0);
 const full=report.fixtures.find(f=>f.id==='complete-cost-split')!;
 expect(full.lanes.find(l=>l.lane==='with_memory')!.usage).toMatchObject({totalTokens:2350,reasoningOutputTokens:150,cachedInputTokens:250,initiated:6});
 expect(full.syntheticLifecycleSavingFraction).toBeCloseTo(-.6785714285714286);
 const unknown=report.fixtures.find(f=>f.id==='unknown-not-zero')!;
 expect(unknown.syntheticLifecycleSavingFraction).toBeNull();expect(unknown.lanes.find(l=>l.lane==='with_memory')!.usage).toMatchObject({reportedTotalTokens:1000,totalTokens:null,failed:1});
 expect(report.fixtures.find(f=>f.id==='reasoning-unobservable')!.lanes.find(l=>l.lane==='with_memory')!.usage.reasoningOutputTokens).toBeNull();
 expect(report.fixtures.find(f=>f.id==='duplicate-observation-no-double-count')!.lanes.find(l=>l.lane==='with_memory')!.usage).toMatchObject({initiated:1,totalTokens:1150,duplicateSnapshots:1});
 expect(report).toMatchObject({answerBenefitMeasured:false,nativeTokenBenefitMeasured:false});
});
test('production recall runs fictional authority/lifecycle samples without network or native generation',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('offline network forbidden');});
 try{
  const report=await runOfflineRetrieval(fixture);
  expect(report.cases).toHaveLength(12);expect(report.nativeCallsInitiated).toBe(0);expect(fetch).not.toHaveBeenCalled();
  for(const id of ['scope-project-zh','correction-zh','expiration-zh','assistant-claim-zh','source-revocation-zh','private-agent-en'])expect(report.cases.find(c=>c.id===id)!.score.authorityErrors).toBe(0);
  expect(report.cases.find(c=>c.id==='shared-project-en')!.returnedIds).toContain('m15');
  expect(report.cases.find(c=>c.id==='private-agent-en')!.returnedIds).not.toContain('m16');
  expect(report).toMatchObject({answerBenefitMeasured:false,nativeTokenBenefitMeasured:false});
 }finally{fetch.mockRestore();}
});
