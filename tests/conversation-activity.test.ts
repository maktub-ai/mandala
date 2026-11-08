import {expect,it} from 'vitest';
import type {DisplayEvent} from '../shared/types';
import {groupChatTurns} from '../src/chatTurns';
import {presentRun} from '../src/runView';
import {reasoningTitle} from '../src/activity-presentation';

const event=(id:number,kind:DisplayEvent['kind'],data:unknown):DisplayEvent=>({id,kind,data,conversationId:'c',createdAt:new Date(1793336400000+id*1000).toISOString()});
const tool=(id:number,name:string,extra:Record<string,unknown>={})=>event(id,'tool',{method:'item/completed',params:{item:{id:name,type:'mcpToolCall',server:'OMP',tool:'read',arguments:{path:'docs/'+name+'.md'},status:'completed',...extra}}});
const view=(events:DisplayEvent[])=>presentRun(groupChatTurns([event(1,'user',{text:'Inspect',runId:'r'}),...events])[0]);
const request=(id:string,nativeRequestId:number)=>({id,nativeRequestId,conversationId:'c',method:'omp/confirm',params:{title:'Run validation',message:'Allow this command?',turnId:'t',threadId:'n'}});

it('recognizes known OMP read and command fields without turning another server read tool into file evidence',()=>{
  const run=view([tool(2,'read-a'),tool(3,'bash',{tool:'bash',arguments:{command:'node check.mjs'}}),tool(4,'unknown',{server:'external',tool:'read',arguments:{path:'secret.md'}})]);
  expect((run.operations[0] as any).presentation).toMatchObject({category:'read',target:'docs/read-a.md'});
  expect((run.operations[1] as any).presentation).toMatchObject({category:'command',target:'node check.mjs'});
  expect((run.operations[2] as any).presentation).toMatchObject({category:'tool'});
});

it('uses ACP structured kind and locations rather than interpreting a natural-language tool title',()=>{
  const run=view([tool(2,'native',{server:'ACP',tool:'Inspect project',kind:'read',locations:[{path:'/workspace/a.ts',line:8}]}),tool(3,'unknown',{server:'ACP',tool:'Reading every document'})]);
  expect((run.operations[0] as any).presentation).toMatchObject({category:'read',target:'/workspace/a.ts'});
  expect((run.operations[1] as any).presentation).toMatchObject({category:'tool'});
});

it('groups adjacent completed reads but never crosses a commentary, report or reasoning boundary',()=>{
  const run=view([tool(2,'a'),tool(3,'b'),
    event(4,'tool',{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Checking the contract'}}}),
    tool(5,'c'),event(6,'progress',{runId:'r',source:'cli',text:'Checking',steps:[{text:'Validate',status:'running'}]}),
    tool(7,'d'),event(8,'tool',{method:'item/completed',params:{item:{id:'reason',type:'reasoning',summary:['Check source fields']}}}),tool(9,'e')]);
  expect((run as any).activityTimeline.map((entry:any)=>entry.kind)).toEqual(['operationGroup','message','operation','progress','operation','reasoning','operation']);
  expect((run as any).activityTimeline[0].operations.map((operation:any)=>operation.item.id)).toEqual(['a','b']);
  expect(run.timeline.map(entry=>entry.kind)).toEqual(['operation','operation','message','operation','progress','operation','reasoning','operation']);
});

it('keeps a failed read and a running read separate from completed groups',()=>{
  const run=view([tool(2,'a'),tool(3,'b',{status:'failed',error:'Denied'}),tool(4,'c',{status:'inProgress'}),tool(5,'d')]);
  expect((run as any).activityTimeline.map((entry:any)=>entry.kind)).toEqual(['operation','operation','operation','operation']);
});

it('retains partial command output and the report snapshot after interruption',()=>{
  const steps=[{text:'Inspect',status:'completed'},{text:'Validate',status:'running'}];
  const run=view([event(2,'progress',{text:'Validating',source:'cli',runId:'r',steps}),tool(3,'bash',{tool:'bash',arguments:{command:'node check.mjs'},status:'inProgress',aggregatedOutput:'Read 1/3'}),event(4,'status',{status:'interrupted'})]);
  expect(run.operations[0]).toMatchObject({status:'interrupted',output:'Read 1/3'});
  expect(run.timeline.find(entry=>entry.kind==='progress')).toMatchObject({progress:{steps,historical:true}});
});

it('records the exact request decision without erasing a later independent request',()=>{
  const run=view([event(2,'approval',request('first',11)),event(3,'metadata',{approvalDecision:{approvalId:'first',decision:'reject'}}),event(4,'approval',request('second',12)),event(5,'status',{status:'approval'})]);
  expect(run.timeline.filter(entry=>entry.kind==='approval').map((entry:any)=>entry.approval)).toMatchObject([
    {request:{id:'first'},state:'rejected',decision:'reject'},{request:{id:'second'},state:'pending'}
  ]);
});

it.each(['approve','approve-session','approve-rule','approve-always','approve-conversation'])('preserves the submitted approval scope %s',decision=>{
  const run=view([event(2,'approval',request('a',11)),event(3,'metadata',{approvalDecision:{approvalId:'a',decision}}),event(4,'status',{status:'idle'})]);
  expect((run.timeline.find(entry=>entry.kind==='approval') as any).approval).toMatchObject({state:'approved',decision});
});

it('does not infer an approval outcome from successful or interrupted execution',()=>{
  for(const status of ['idle','interrupted']){
    const run=view([event(2,'approval',request('a',11)),event(3,'status',{status})]);
    expect((run.timeline.find(entry=>entry.kind==='approval') as any).approval).toMatchObject({state:'unknown'});
  }
});

it('marks a native-resolved request as ended without assuming it was approved',()=>{
  const run=view([event(2,'approval',request('a',11)),event(3,'metadata',{resolvedRequestId:11}),event(4,'status',{status:'running'})]);
  expect((run.timeline.find(entry=>entry.kind==='approval') as any).approval).toMatchObject({state:'resolved'});
});
it('does not apply an earlier native resolution to a later request that reuses the same native ID',()=>{
 const run=view([event(2,'approval',request('first',11)),event(3,'metadata',{resolvedRequestId:11}),event(4,'approval',request('second',11)),event(5,'status',{status:'approval'})]);
 expect(run.timeline.filter(entry=>entry.kind==='approval').map((entry:any)=>entry.approval.state)).toEqual(['resolved','pending']);
});
it('keeps an explicitly provided native plan as an inspectable activity at its first update',()=>{
  const run=view([event(2,'tool',{method:'turn/plan/updated',params:{turnId:'t',explanation:'Check source',plan:[{step:'Read contract',status:'completed'},{step:'Validate',status:'in_progress'}]}}),tool(3,'a')]);
  expect(run.operations[0].item).toMatchObject({type:'plan',plan:[{step:'Read contract',status:'completed'},{step:'Validate',status:'in_progress'}]});
  expect(run.timeline.map(entry=>entry.kind)).toEqual(['operation','operation']);
});

const thought=(id:number,name='reason')=>event(id,'tool',{method:'item/completed',params:{item:{id:name,type:'reasoning',summary:['Inspect the export contract']}}});
const command=(id:number,status='completed')=>tool(id,'cmd-'+id,{type:'commandExecution',command:'node check-'+id+'.mjs',server:undefined,tool:undefined,status});
const runtime=(cli:string)=>event(2,'metadata',{status:'loaded',cli});

it('folds Codex reasoning and its adjacent completed operations without changing the source timeline',()=>{
 const run=view([runtime('codex'),thought(3),command(4),command(5)]);
 expect(run.activityTimeline).toMatchObject([{kind:'reasoningGroup',key:'reasoning:reason',text:'Inspect the export contract',operations:[{item:{id:'cmd-4'}},{item:{id:'cmd-5'}}]}]);
 expect(run.timeline.map(entry=>entry.kind)).toEqual(['reasoning','operation','operation']);
});

it.each(['omp','claude','gemini','codebuddy','unknown'])('leaves reasoning/action grouping unchanged for %s',cli=>{
 expect(view([runtime(cli),thought(3),command(4),command(5)]).activityTimeline.map(entry=>entry.kind)).toEqual(['reasoning','operation','operation']);
});

it.each(['inProgress','failed','interrupted','unknown','blocked'])('keeps a %s operation outside the reasoning group',status=>{
 const run=view([runtime('codex'),thought(3),command(4),command(5,status),command(6)]);
 expect(run.activityTimeline.map(entry=>entry.kind)).toEqual(['reasoningGroup','operation','operation']);
 expect(run.activityTimeline[0]).toMatchObject({operations:[{item:{id:'cmd-4'}}]});
});

it('ends a reasoning group at commentary, progress, approval, error and the next reasoning',()=>{
 const boundaries=[event(5,'tool',{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Checking'}}}),event(5,'progress',{runId:'r',source:'cli',text:'Checking'}),event(5,'approval',request('a',11)),event(5,'error',{message:'Failure'}),thought(5,'next')];
 for(const boundary of boundaries){
  const run=view([runtime('codex'),thought(3),command(4),boundary,command(6)]);
  expect(run.activityTimeline[0]).toMatchObject({kind:'reasoningGroup',operations:[{item:{id:'cmd-4'}}]});
  expect(run.activityTimeline).toHaveLength(boundary===boundaries.at(-1)?2:3);
 }
});

it.each([['omp','codex','reasoning'],['codex','omp','reasoningGroup']])('uses the %s session runtime despite a later %s background task',(cli,background,expected)=>{
 const run=view([runtime(cli),thought(3),command(4),event(5,'metadata',{systemTask:'title',status:'loaded',cli:background,sourceEventId:1})]);
 expect(run.activityTimeline[0].kind).toBe(expected);
});

it('does not infer a runtime for legacy turns without session runtime metadata',()=>{
 expect(view([thought(3),command(4),event(5,'metadata',{cli:'codex',systemTask:'title',status:'loaded'})]).activityTimeline.map(entry=>entry.kind)).toEqual(['reasoning','operation']);
});

it('uses the latest reasoning heading as the group title, falling back to the last nonempty line',()=>{
 expect(reasoningTitle('**Inspect files**\n\nRead the contract.\n\n## Validate fields\n\nNow run checks.')).toBe('Validate fields');
 expect(reasoningTitle('Initial observation\n\n**Check the export**\n\nMore detail')).toBe('Check the export');
 expect(reasoningTitle('Initial observation\n\nCheck the export\n')).toBe('Check the export');
 expect(reasoningTitle('  \n')).toBeUndefined();
});
