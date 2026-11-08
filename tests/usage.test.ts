import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../server/store';
import { createUsageRecorder, getUsage, meterGeneration } from '../server/usage';

const homes: string[] = [], stores: Store[] = [];
function setup() { const home=mkdtempSync(join(tmpdir(),'mana-usage-'));homes.push(home);const store=openStore(home);stores.push(store);return store; }
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const context=(executionId='execution',cli:'codex'|'omp'='codex')=>({executionId,category:'conversation' as const,cli,model:'native-model',conversationId:'chat',projectId:'project',agentId:'agent'});
// Codex 0.160.0: total is session cumulative; last is the latest request, not the turn.
const snapshot=(threadId:string,turnId:string,input:number,output:number,cached=0,reasoning=0,lastInput=input)=>({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:{inputTokens:input,outputTokens:output,cachedInputTokens:cached,cacheWriteInputTokens:0,reasoningOutputTokens:reasoning,totalTokens:input+output},last:{inputTokens:lastInput,outputTokens:output,cachedInputTokens:cached,cacheWriteInputTokens:0,reasoningOutputTokens:reasoning,totalTokens:lastInput+output},modelContextWindow:200000}}});
const summary=(store:Store)=>getUsage(store,{period:'today',timeZone:'UTC'});

it('reads only window and scope candidates from SQLite while retaining cross-window observations',()=>{
 const store=setup(),r=createUsageRecorder(store),now='2026-10-10T12:00:00.000Z';
 for(let i=0;i<20;i++){r.begin({...context('old'+i),projectId:'other'},'2026-01-01T00:00:00.000Z');r.finish('completed','2026-01-01T00:01:00.000Z');}
 r.begin({...context('visible'),projectId:'chosen'},'2026-10-10T01:00:00.000Z');r.finish('completed','2026-10-10T02:00:00.000Z');
 r.begin({...context('foreign'),projectId:'other'},'2026-10-10T01:00:00.000Z');r.finish('completed','2026-10-10T02:00:00.000Z');
 r.begin({...context('late'),projectId:'chosen'},'2026-10-08T01:00:00.000Z');r.finish('completed','2026-10-08T02:00:00.000Z');
 store.database.prepare('INSERT INTO usage_observations VALUES (?,?,?,?)').run('late-observation','late','2026-10-10T04:00:00.000Z',JSON.stringify({model:'native-model',tokens:{inputTokens:4,outputTokens:2,totalTokens:6,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}}));
 const prepare=store.database.prepare.bind(store.database),readCounts:number[]=[];
 const spy=vi.spyOn(store.database,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql);
  if(/^SELECT data FROM usage_executions/.test(sql)){const all=statement.all.bind(statement);vi.spyOn(statement,'all').mockImplementation((...args)=>{const rows=all(...args);readCounts.push(rows.length);return rows;});}
  return statement;
 });
 try{const value=getUsage(store,{period:'today',timeZone:'UTC',projectId:'chosen',now});expect(value.recent.map(e=>e.executionId).sort()).toEqual(['late','visible']);expect(value.totals.totalTokens).toBe(6);expect(readCounts).toEqual([2]);}finally{spy.mockRestore();}
});

it('counts cumulative increments once, keeps cached/reasoning as subsets and persists without transcript copying',()=>{
 const store=setup(),r=createUsageRecorder(store);r.event({method:'openmana/usageBaseline',params:{threadId:'native',fresh:true}});
 r.begin(context());r.event({method:'turn/started',params:{threadId:'native',turn:{id:'turn'}}});
 r.event(snapshot('native','turn',100,20,30,5));r.event(snapshot('native','turn',100,20,30,5));
 r.event(snapshot('native','turn',160,40,50,10,60));r.finish('completed');
 expect(summary(store).totals).toEqual({inputTokens:160,outputTokens:40,totalTokens:200,cachedInputTokens:50,cacheWriteInputTokens:0,reasoningOutputTokens:10});
 expect(summary(store).coverage).toMatchObject({observed:1,partial:0,unknown:0});
 expect(summary(store).recent[0]).toMatchObject({executionId:'execution',nativeSessionId:'native',nativeTurnId:'turn',conversationId:'chat',status:'completed'});
 const home=homes[0];store.close();stores.splice(stores.indexOf(store),1);const reopened=openStore(home);stores.push(reopened);
 expect(summary(reopened).totals.totalTokens).toBe(200);
});

it('uses restored totals only as baseline, excludes foreign turn and late replay',()=>{
 const store=setup(),r=createUsageRecorder(store);
 r.event({method:'openmana/usageBaseline',params:{threadId:'old',fresh:false}});r.event(snapshot('old','old-turn',1000,200));
 r.begin(context());r.event({method:'turn/started',params:{threadId:'old',turn:{id:'new'}}});
 r.event(snapshot('other','new',9999,9999));r.event(snapshot('old','old-turn',1200,240));
 r.event(snapshot('old','new',1100,220,20,5,100));r.finish('interrupted');r.event(snapshot('old','new',1100,220));
 expect(summary(store).totals.totalTokens).toBe(120);expect(summary(store).recent[0].status).toBe('interrupted');
});

it('marks missing baseline, compaction estimates and counter rollback as partial instead of guessing',()=>{
 const store=setup(),r=createUsageRecorder(store);r.begin(context());r.event({method:'turn/started',params:{threadId:'restored',turn:{id:'t'}}});
 r.event(snapshot('restored','t',1000,200));r.event(snapshot('restored','t',1100,220,0,0,100));
 r.event(snapshot('restored','t',50,10));r.event(snapshot('restored','t',80,20,0,0,30));r.finish('failed');
 expect(summary(store).totals.totalTokens).toBe(160);expect(summary(store).coverage.partial).toBe(1);
 const compact=createUsageRecorder(store);compact.event({method:'openmana/usageBaseline',params:{threadId:'compact',fresh:true}});compact.begin(context('compaction'));
 compact.event({method:'turn/started',params:{threadId:'compact',turn:{id:'c'}}});
 const estimate=snapshot('compact','c',999,0);estimate.params.tokenUsage.last={inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,totalTokens:0};compact.event(estimate);compact.finish('completed');
 expect(summary(store).totals.totalTokens).toBe(160);expect(summary(store).coverage).toMatchObject({partial:1,unknown:1});
});

it('deduplicates OMP 18.6.1 native message IDs and includes cache in input without counting agent_end messages',()=>{
 const store=setup(),r=createUsageRecorder(store);r.begin(context('omp','omp'));
 r.event({method:'turn/started',params:{threadId:'omp-session',turn:{id:'omp-turn'}}});
 const event={method:'openmana/usageMessage',params:{threadId:'omp-session',turnId:'omp-turn',messageId:'native-message',model:'model-actual',usage:{input:10,output:5,cacheRead:20,cacheWrite:3,reasoningTokens:2}}};
 r.event(event);r.event(event);r.finish('failed');
 expect(summary(store).totals).toEqual({inputTokens:33,outputTokens:5,totalTokens:38,cachedInputTokens:20,cacheWriteInputTokens:3,reasoningOutputTokens:2});
 expect(summary(store).recent[0]).toMatchObject({model:'model-actual',source:'omp:message_end',status:'failed'});
});

it('records unknown system calls while preserving string generators and concurrent invocation identity',async()=>{
 const store=setup();await Promise.all(['title','memory','taskProgress'].map(category=>meterGeneration(store,async()=> 'text',{...context(category,'omp'),category:category as 'title'|'memory'|'taskProgress'},{cli:'omp'},'secret prompt',new AbortController().signal)));
 expect(summary(store).coverage).toMatchObject({observed:0,unknown:3});expect(summary(store).totals.totalTokens).toBeNull();
 expect(new Set(summary(store).recent.map(row=>row.executionId)).size).toBe(3);
 expect(JSON.stringify(store.database.prepare('SELECT * FROM usage_executions').all())).not.toContain('secret prompt');
});

it('aggregates by local observation day, includes DST windows, filters and does not multiply task-linked calls',()=>{
 const store=setup(),r=createUsageRecorder(store);r.begin({...context('run','omp'),category:'task',taskId:'task',runId:'run'},'2026-11-01T05:30:00.000Z');r.event({method:'turn/started',params:{threadId:'s',turn:{id:'t'}}});r.event({method:'openmana/usageMessage',params:{threadId:'s',turnId:'t',messageId:'m',usage:{input:10,output:5,cacheRead:0,cacheWrite:0}}},'2026-11-01T06:30:00.000Z');r.finish('completed');
 const value=getUsage(store,{period:'today',timeZone:'America/New_York',projectId:'project',now:'2026-11-01T12:00:00.000Z'});
 expect(value.window).toMatchObject({start:'2026-11-01T04:00:00.000Z',end:'2026-11-02T05:00:00.000Z'});expect(value.daily[0].totals.totalTokens).toBe(15);expect(value.recent).toHaveLength(1);
 expect(getUsage(store,{period:'week',timeZone:'UTC',projectId:'other',now:'2026-11-01T12:00:00.000Z'}).recent).toEqual([]);
});

it('ignores late old-turn snapshots between turns instead of replacing the next baseline',()=>{
 const store=setup(),r=createUsageRecorder(store);r.event({method:'openmana/usageBaseline',params:{threadId:'s',fresh:true}});
 r.begin(context('one'));r.bind('s','one');r.event(snapshot('s','one',100,10));r.finish('completed');
 r.begin(context('two'));r.bind('s','two');r.event(snapshot('s','two',200,20));r.finish('completed');
 r.event(snapshot('s','one',100,10));r.begin(context('three'));r.bind('s','three');r.event(snapshot('s','three',300,30));r.finish('completed');
 expect(summary(store).totals.totalTokens).toBe(330);
});

it('ignores seen snapshots before changing a same-turn baseline while accepting an unseen rollback as partial',()=>{
 const store=setup(),r=createUsageRecorder(store);r.event({method:'openmana/usageBaseline',params:{threadId:'s',fresh:true}});r.begin(context());r.bind('s','t');
 for(const total of [100,160,100,200])r.event(snapshot('s','t',total,0));
 expect(summary(store).totals.totalTokens).toBe(200);expect(summary(store).coverage.observed).toBe(1);expect(summary(store).recent[0].reasons).not.toContain('counter_rollback');
 r.event(snapshot('s','t',80,0));r.event(snapshot('s','t',120,0));r.finish('failed');
 expect(summary(store).totals.totalTokens).toBe(240);expect(summary(store).coverage.partial).toBe(1);expect(summary(store).recent[0].reasons).toContain('counter_rollback');
});

it.each([
 {timeZone:'America/Santiago',date:'2026-09-06',start:'2026-09-06T04:00:00.000Z',end:'2026-09-07T03:00:00.000Z'},
 {timeZone:'America/Havana',date:'2026-03-08',start:'2026-03-08T05:00:00.000Z',end:'2026-03-09T04:00:00.000Z'},
])('starts the $timeZone midnight-gap day at its first valid instant without counting the prior day',({timeZone,date,start,end})=>{
 const store=setup(),boundary=Date.parse(start);
 for(const [index,input]of [99,11].entries()) {
  const at=new Date(boundary+(index===0?-1800000:1800000)).toISOString(),r=createUsageRecorder(store);r.begin(context('day-'+index,'omp'),at);r.bind('s','t'+index);
  r.event({method:'openmana/usageMessage',params:{threadId:'s',turnId:'t'+index,messageId:'m'+index,usage:{input,output:0,cacheRead:0,cacheWrite:0}}},at);r.finish('completed',at);
 }
 const value=getUsage(store,{period:'today',timeZone,now:date+'T12:00:00.000Z'});
 expect(value.window).toMatchObject({start,end});expect(value.totals.totalTokens).toBe(11);expect(value.recent).toHaveLength(1);expect(value.daily[0]).toMatchObject({date,totals:{totalTokens:11}});
});

it('groups actual model calls separately when a turn uses multiple OMP models',()=>{
 const store=setup(),r=createUsageRecorder(store);r.begin(context('mixed','omp'));r.bind('s','t');
 for(const [messageId,model,input] of [['first','model-a',10],['second','model-b',20]] as const)r.event({method:'openmana/usageMessage',params:{threadId:'s',turnId:'t',messageId,model,usage:{input,output:0,cacheRead:0,cacheWrite:0}}});
 r.finish('completed');
 expect(summary(store).groups.model.map(group=>({key:group.key,tokens:group.totals.totalTokens}))).toEqual([{key:'model-a',tokens:10},{key:'model-b',tokens:20}]);
 expect(getUsage(store,{period:'today',timeZone:'UTC',model:'model-a'}).totals.totalTokens).toBe(10);
 expect(summary(store).recent[0].model).toBeNull();
});

it('isolates concurrent generation observers, records failed usage, and hides unreadable source executions',async()=>{
 const store=setup();await Promise.all([1,2,3].map(async index=>{
  try{await meterGeneration(store,async(_config,_prompt,_signal,observer)=>{
   observer!.event({method:'openmana/usageBaseline',params:{threadId:'s'+index,fresh:true}});observer!.bind('s'+index,'t'+index);
   await Promise.resolve();observer!.event(snapshot('s'+index,'t'+index,index*10,index));
   if(index===2)throw new Error('native failed');return 'text';
  },context('generation'+index),{cli:'codex'},'not persisted',new AbortController().signal);}catch{}
 }));
 expect(summary(store).totals.totalTokens).toBe(66);expect(summary(store).coverage.observed).toBe(3);expect(summary(store).recent.find(row=>row.executionId==='generation2')?.status).toBe('failed');
 const visible=getUsage(store,{period:'today',timeZone:'UTC'},{canReadExecution:row=>row.executionId==='generation1'});expect(visible.totals.totalTokens).toBe(11);expect(visible.coverage.total).toBe(1);expect(visible.recent).toHaveLength(1);
});

it('finishes metering on cancellation even when an injected generator never settles',async()=>{
 const store=setup(),controller=new AbortController();void meterGeneration(store,()=>new Promise(()=>{}),context('ignored','omp'),{cli:'omp'},'not persisted',controller.signal);
 controller.abort();expect(summary(store).recent[0]).toMatchObject({status:'interrupted',coverage:'unknown'});
});

it.each(['stop','error','aborted'])('treats OMP initialized zero usage as unknown for %s messages',stopReason=>{
 const store=setup(),r=createUsageRecorder(store);r.begin(context('zero','omp'));r.bind('s','t');
 r.event({method:'openmana/usageMessage',params:{threadId:'s',turnId:'t',messageId:'msg-1',stopReason,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0}}});r.finish(stopReason==='stop'?'completed':'failed');
 expect(summary(store).totals.totalTokens).toBeNull();expect(summary(store).coverage.unknown).toBe(1);expect(summary(store).recent[0].reasons).toContain('empty_native_usage');
});

it('replays locally captured Codex 0.160.0 two-turn/resume timing without charging restored history',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/codex-0160-usage.json',import.meta.url),'utf8'));
 const store=setup();let recorder=createUsageRecorder(store);
 for(const event of fixture.events) {
  if(event.phase==='first-turn'&&event.method==='turn/started')recorder.event({method:'openmana/usageBaseline',params:{threadId:event.threadId,fresh:true}});
  if(event.phase==='resume'){recorder=createUsageRecorder(store);recorder.event({method:'openmana/usageBaseline',params:{threadId:event.threadId,fresh:false}});}
  if(event.method==='turn/started')recorder.begin(context(event.phase));
  recorder.event({method:event.method,params:{threadId:event.threadId,turnId:event.turnId,tokenUsage:event.tokenUsage,turn:{id:event.turnId,status:event.status}}});
  if(event.method==='turn/completed')recorder.finish('completed');
 }
 const usage=summary(store);expect(usage.totals).toMatchObject({inputTokens:80664,outputTokens:15,totalTokens:80679,cachedInputTokens:60160});
 expect(usage.recent.find(row=>row.executionId==='resumed-turn')?.totals.totalTokens).toBe(27303);expect(usage.coverage.observed).toBe(3);
});

it('replays locally captured OMP 18.6.1 envelope identity and reasoning subset',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/omp-1861-usage.json',import.meta.url),'utf8'));
 const store=setup(),recorder=createUsageRecorder(store);recorder.begin(context('native-omp','omp'));recorder.bind('s','t');
 for(const event of fixture.events)recorder.event({method:'openmana/usageMessage',params:{threadId:'s',turnId:'t',...event}});
 recorder.finish('completed');expect(summary(store).totals).toMatchObject({inputTokens:1893,outputTokens:35,totalTokens:1928,reasoningOutputTokens:21});
});

it('summarizes memory stage, audited stage and repair calls without counting replayed observations twice',()=>{
 const store=setup(),r=createUsageRecorder(store);
 for(const [id,stage,reviewStage,callKind] of [['scene','scene',null,'initial'],['audit','verify','scene','repair']] as const){
  r.event({method:'openmana/usageBaseline',params:{threadId:id,fresh:true}});
  r.begin({...context(id,'omp'),category:'memory',stage,reviewStage,callKind});r.bind(id,'t');
  const event={method:'openmana/usageMessage',params:{threadId:id,turnId:'t',messageId:'m',usage:{input:10,output:5,cacheRead:2,cacheWrite:0,reasoningTokens:3}}};
  r.event(event);r.event(event);r.finish('completed');
 }
 r.begin({...context('unknown','omp'),category:'memory',stage:'extract',callKind:'retry'});r.finish('failed');
 const value=summary(store);expect(value.totals.totalTokens).toBe(34);expect(value.coverage.unknown).toBe(1);
 expect(value.groups.stage).toEqual(expect.arrayContaining([expect.objectContaining({key:'scene',totals:expect.objectContaining({totalTokens:17})}),expect.objectContaining({key:'extract',totals:expect.objectContaining({totalTokens:null})})]));
 expect(value.groups.reviewStage).toContainEqual(expect.objectContaining({key:'scene',coverage:expect.objectContaining({total:1})}));
 expect(value.groups.callKind).toContainEqual(expect.objectContaining({key:'repair',coverage:expect.objectContaining({total:1})}));
});

it('formats usage days with bounded formatter setup as observation history grows',()=>{
 const store=setup(),r=createUsageRecorder(store);
 r.event({method:'openmana/usageBaseline',params:{threadId:'bulk',fresh:true}});
 r.begin(context('bulk'),'2026-10-18T23:59:00Z');r.event({method:'turn/started',params:{threadId:'bulk',turn:{id:'turn'}}});
 for(let i=1;i<=100;i++)r.event(snapshot('bulk','turn',i,0),i<=50?'2026-10-18T23:59:01Z':'2026-10-19T00:00:01Z');
 r.finish('completed','2026-10-19T00:00:02Z');
 const formatter=vi.spyOn(Intl,'DateTimeFormat');
 try {
  const value=getUsage(store,{period:'week',timeZone:'UTC',now:'2026-10-19T12:00:00Z'});
  expect(value.daily.slice(-2).map(day=>day.totals.totalTokens)).toEqual([50,50]);
  expect(formatter.mock.calls.length).toBeLessThanOrEqual(3);
 }finally{formatter.mockRestore();}
});
