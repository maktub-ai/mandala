import {expect, it} from 'vitest';
import {nativeSubagents} from '../shared/native-subagents';
import type {DisplayEvent} from '../shared/types';

function frame(id:number,item:Record<string,unknown>):DisplayEvent {
  return {id,conversationId:'c',kind:'tool',createdAt:'',data:{method:'item/completed',params:{turnId:'t',item}}};
}

it('recovers Cursor task identities from old tool events and updates the original anonymous call',()=>{
  const call={type:'mcpToolCall',id:'delegate',server:'cursor',tool:'taskToolCall'};
  const started=frame(1,{...call,arguments:{description:'Check text'},status:'inProgress'});
  const ended=frame(2,{...call,result:{success:{agentId:'reader',isBackground:true}},status:'completed'});
  const other=frame(3,{...call,id:'unrelated',server:'custom',result:{success:{agentId:'not-cursor'}}});
  const rows=nativeSubagents([started,ended,other],'cursor');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({id:nativeSubagents([started],'cursor')[0].id,agentId:'reader',status:'dispatched',task:'Check text'});
  expect(nativeSubagents([started,ended],'codex')).toHaveLength(0);
});
it('recovers individual OMP task results without duplicating a current child or inventing an anonymous one',()=>{
  const old=frame(1,{type:'mcpToolCall',id:'task',server:'OMP',tool:'task',status:'completed',result:{details:{results:[
    {id:'one',agent:'explore',task:'Check text',exitCode:0,output:'Verified'},
    {id:'two',agent:'explore',task:'Check code',exitCode:1,error:'Read failed'},
    {agent:'no-id',task:'No identity',exitCode:0},
  ]}}});
  const modern=frame(2,{type:'nativeSubagent',id:'omp:subagent:one',agentId:'one',status:'completed',text:'Verified'});
  const empty=frame(3,{type:'mcpToolCall',id:'dispatch',server:'OMP',tool:'task',status:'completed',result:{details:{results:[],async:{state:'running'}}}});
  const foreign=frame(4,{type:'mcpToolCall',id:'foreign',server:'external',tool:'task',result:{details:{results:[{id:'foreign',exitCode:0}]}}});
  const rows=nativeSubagents([old,modern,empty,foreign],'omp');
  expect(rows.map(row=>[row.agentId,row.status,row.text])).toEqual([['one','completed','Verified'],['two','failed','Read failed']]);
});

it('excludes the Codex parent thread from both activity and collaboration targets',()=>{
  const scoped=(id:number,item:Record<string,unknown>):DisplayEvent=>({
    ...frame(id,item),data:{method:'item/completed',params:{threadId:'root',turnId:'t',item}},
  });
  const call={type:'collabAgentToolCall',tool:'sendInput',id:'call'};
  const rows=nativeSubagents([
    scoped(1,{type:'subAgentActivity',id:'activity',agentThreadId:'root',kind:'started'}),
    scoped(2,{...call,receiverThreadIds:['root'],agentsStates:{root:{status:'completed',message:'Parent message'}}}),
    scoped(3,{...call,id:'multi',receiverThreadIds:['root','child'],agentsStates:{root:{status:'completed'},child:{status:'running'}}}),
  ],'codex');
  expect(rows.map(row=>[row.agentId,row.status,row.text])).toEqual([['child','running',undefined]]);
});
