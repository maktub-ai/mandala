import {test,expect} from 'vitest';
import {buildTaskProgressIndex,taskInProgressWindow} from '../src/progress-presentation';
import type {Task} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
const now=Date.parse('2026-10-26T12:00:00Z'),at=(minutes:number)=>new Date(now-minutes*60000).toISOString();
const task={id:'task',createdAt:at(720),state:'review'} as Task;
const activity=(item:Task,rows:ConversationProgress[]=[])=>buildTaskProgressIndex([item],rows).get(item.id)!;
test('six-hour idle task threshold is strict and does not complete an expired goal',()=>{
 for(const age of [359.999,360,360.001])expect(taskInProgressWindow(activity({...task,activityAt:at(age)}),360,now)).toBe(age<360);
 expect(task.state).toBe('review');
});
test('objective activity stays visible outside window, stale running and unknown do not',()=>{
 expect(taskInProgressWindow(activity({...task,live:true}),360,now)).toBe(true);
 expect(taskInProgressWindow(activity({...task,state:'running'}),360,now)).toBe(false);
 expect(taskInProgressWindow(activity(task,[{taskIds:['task'],activityAt:at(720),live:true} as ConversationProgress]),360,now)).toBe(true);
 expect(taskInProgressWindow(activity(task,[{taskIds:['other'],activityAt:at(1),live:true} as ConversationProgress]),360,now)).toBe(false);
 expect(taskInProgressWindow(activity(task,[{taskIds:['task'],activityAt:at(10),live:false} as ConversationProgress]),360,now)).toBe(true);
});

test('card activity and ordering use the same linked activity as expiry',()=>{
 const linked={taskIds:['task'],activityAt:at(10),live:false} as ConversationProgress;
 expect(activity(task,[linked]).activityAt).toBe(at(10));
 expect(activity({...task,activityAt:at(1)},[linked]).activityAt).toBe(at(1));
});

test('linked activity combines multiple chats without changing task state or importing unrelated activity',()=>{
 const completed={...task,state:'completed',completion:{acceptedAt:at(5)}} as Task;
 const linked=[
  {taskIds:['task','shared'],activityAt:at(15),live:true},
  {taskIds:['task'],activityAt:at(10),live:false},
  {taskIds:['unrelated'],activityAt:at(1),live:true},
 ] as ConversationProgress[];
 expect(activity(completed,linked).activityAt).toBe(at(5));
 expect(activity({...task,id:'shared'},linked).activityAt).toBe(at(15));
 expect(activity(task,linked).live).toBe(true);
 expect(taskInProgressWindow(activity(task,linked),360,now+86400000)).toBe(true);
 expect(taskInProgressWindow(activity({...task,id:'unlinked'},linked),360,now)).toBe(false);
 expect(completed.state).toBe('completed');
 expect(linked[0].taskIds).toEqual(['task','shared']);
});

test('filtering and ordering a task batch reads each conversation relationship only once',()=>{
 let relationshipReads=0;
 const tasks=Array.from({length:64},(_,index)=>({...task,id:'task-'+index}));
 const conversations=tasks.map((item,index)=>({
  get taskIds(){relationshipReads++;return [item.id];},activityAt:at(index+1),live:false,
 })) as ConversationProgress[];
 const index=buildTaskProgressIndex(tasks,conversations);
 const visible=tasks.filter(item=>taskInProgressWindow(index.get(item.id)!,360,now))
  .sort((a,b)=>index.get(b.id)!.activityAt.localeCompare(index.get(a.id)!.activityAt)||a.id.localeCompare(b.id));
 expect(visible.map(item=>item.id)).toEqual(tasks.map(item=>item.id));
 expect(relationshipReads).toBe(conversations.length);
});

test('a retained activity index still expires at the current window boundary and keeps equal-time ordering',()=>{
 const tasks=[{...task,id:'b',activityAt:at(359)},{...task,id:'a',activityAt:at(359)}];
 const index=buildTaskProgressIndex(tasks,[]);
 expect(taskInProgressWindow(index.get('a')!,360,now)).toBe(true);
 expect(taskInProgressWindow(index.get('a')!,360,now+60000)).toBe(false);
 for(const order of ['oldest','newest']){
  const ordered=[...tasks].sort((a,b)=>(order==='oldest'?index.get(a.id)!.activityAt.localeCompare(index.get(b.id)!.activityAt):index.get(b.id)!.activityAt.localeCompare(index.get(a.id)!.activityAt))||a.id.localeCompare(b.id));
  expect(ordered.map(item=>item.id)).toEqual(['a','b']);
 }
});
