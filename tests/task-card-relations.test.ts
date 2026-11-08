import {expect,test} from 'vitest';
import type {Task,TaskExecution,Run} from '../shared/tasks';
import {attentionChats,executionChatState,executionChatsFor,taskHasAttention,taskLaneState} from '../src/task-relations';
import type {ConversationProgress} from '../shared/conversation-progress';
const execution=(conversationId:string,state:Run['state']|null=null)=>({id:conversationId,conversationId,agentId:'agent',projectId:null,title:'Execute '+conversationId,createdAt:'2026-11-04T00:00:00Z',latestRun:state?{state}:null} as TaskExecution);
const task=(executions:TaskExecution[]=[])=>({id:'goal',goal:'Same business title',executions,originConversationId:'main',state:'todo'} as Task);
const row=(id:string,extra:Partial<ConversationProgress>={})=>({id,taskIds:['goal'],state:'recent',executionStatus:'idle',active:true,...extra} as ConversationProgress);
test('attention belongs only to execution chats and does not change terminal task lanes',()=>{
 for(const state of ['todo','running','waiting','review','completed','cancelled'] as const){
  const goal={...task([execution('exec')]),state},rows=[row('exec',{state:'attention'})];
  expect(taskHasAttention(goal,[goal],rows)).toBe(true);
  expect(taskLaneState(goal,[goal],rows)).toBe(state==='completed'||state==='cancelled'?state:'waiting');
  expect(taskHasAttention(goal,[goal],[row('main',{state:'attention'})])).toBe(false);
  expect(taskHasAttention(goal,[goal],[row('exec',{active:false,state:'attention'})])).toBe(false);
 }
});
test('executions are visible before progress exists and ordinary source chats are excluded',()=>{
 const goal=task([execution('first','succeeded'),execution('second','queued')]);
 const rows=executionChatsFor('goal',[goal],[row('main'),row('unrelated')]);
 expect(rows.map(item=>item.id)).toEqual(['first','second']);
 expect(rows[0]).toMatchObject({title:'Execute first',agentId:'agent',taskIds:['goal']});
 expect(executionChatState(rows[0],[goal])).toBe('replied');
 expect(executionChatState(rows[1],[goal])).toBe('queued');
 expect(executionChatsFor('goal',[goal],[], 'second').map(item=>item.id)).toEqual(['first']);
});
test('current execution progress overrides its latest run and task acceptance state',()=>{
 const goal={...task([execution('exec','succeeded')]),state:'review' as const};
 expect(executionChatState(row('exec',{executionStatus:'running'}),[goal])).toBe('running');
 expect(executionChatState(row('exec',{executionStatus:'approval'}),[goal])).toBe('approval');
 expect(executionChatState(row('exec'),[{...goal,executions:[execution('exec','failed')]}])).toBe('failed');
 expect(executionChatState(row('exec'),[{...goal,executions:[execution('exec')]}])).toBe('todo');
});
test.each(['failed','unknown','interrupted'] as const)('a superseded %s execution stays visible without moving a successful retry out of review',state=>{
 const old={...execution('old',state),supersededByExecutionId:'retry'},retry=execution('retry','succeeded'),goal={...task([old,retry]),state:'review' as const};
 const rows=[row('old',{state:'attention',executionStatus:'error'}),row('retry')];
 expect(executionChatsFor(goal.id,[goal],rows).map(item=>item.id)).toEqual(['old','retry']);
 expect(taskHasAttention(goal,[goal],rows)).toBe(false);
 expect(taskLaneState(goal,[goal],rows)).toBe('review');
 expect(taskHasAttention(goal,[goal],[])).toBe(false);
 expect(taskLaneState(goal,[goal],[])).toBe('review');
 const currentAttention=[...rows.slice(0,1),row('retry',{state:'attention',executionStatus:'approval'})];
 expect(taskHasAttention(goal,[goal],currentAttention)).toBe(true);
 expect(taskLaneState(goal,[goal],currentAttention)).toBe('waiting');
});
test('a failed or approval-waiting execution moves an unfinished task to the attention lane',()=>{
 const review={...task([execution('ok','succeeded'),execution('bad','failed')]),state:'review' as const},rows=[row('ok'),row('bad')];
 expect(attentionChats(review,[review],rows).map(item=>[item.row.id,item.state])).toEqual([['bad','failed']]);
 expect(taskLaneState(review,[review],rows)).toBe('waiting');
 expect(taskLaneState({...review,state:'completed'},[review],rows)).toBe('completed');
 const running={...task([execution('ask','approval'),execution('idle')]),state:'running' as const};
 expect(attentionChats(running,[running],[row('ask'),row('idle')]).map(item=>item.state)).toEqual(['approval']);
 const fine={...task([execution('ok','succeeded'),execution('idle')]),state:'review' as const};
 expect(taskLaneState(fine,[fine],[row('ok'),row('idle')])).toBe('review');
});
