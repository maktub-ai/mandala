// Synthetic task-list calculation benchmark; run with: npx tsx scripts/performance-progress.ts
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import type {Task} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
import {buildTaskProgressIndex,taskInProgressWindow} from '../src/progress-presentation';

// Preserve the 7ce63b8 filter/sort path for a reproducible before/after comparison.
function baselineActivity(task:Task,conversations:ConversationProgress[]){
 return [task.createdAt,task.activityAt,task.completion?.acceptedAt,...conversations.filter(row=>row.taskIds.includes(task.id)).map(row=>row.activityAt)].filter((value):value is string=>!!value).sort().at(-1)!;
}
function baseline(tasks:Task[],conversations:ConversationProgress[],now:number){
 return tasks.filter(task=>task.live||conversations.some(row=>row.taskIds.includes(task.id)&&row.live)||now-Date.parse(baselineActivity(task,conversations))<360*60000)
  .sort((a,b)=>baselineActivity(b,conversations).localeCompare(baselineActivity(a,conversations))||a.id.localeCompare(b.id));
}
function indexed(tasks:Task[],conversations:ConversationProgress[],now:number){
 const index=buildTaskProgressIndex(tasks,conversations);
 return tasks.filter(task=>taskInProgressWindow(index.get(task.id)!,360,now))
  .sort((a,b)=>index.get(b.id)!.activityAt.localeCompare(index.get(a.id)!.activityAt)||a.id.localeCompare(b.id));
}
function median(work:()=>Task[]){
 work();
 const samples=Array.from({length:5},()=>{const start=performance.now();work();return performance.now()-start;});
 return Number(samples.sort((a,b)=>a-b)[2].toFixed(3));
}
const now=Date.parse('2026-11-04T00:00:00Z'),createdAt=new Date(now-86400000).toISOString();
for(const count of [100,500,1000,2000]){
 const tasks=Array.from({length:count},(_,i)=>({id:'t'+i,createdAt,activityAt:new Date(now-((i*7919)%count)*1000).toISOString(),state:'todo'})) as Task[];
 const conversations=tasks.map(task=>({id:'c'+task.id,taskIds:[task.id],activityAt:task.activityAt,live:false})) as ConversationProgress[];
 assert.deepEqual(indexed(tasks,conversations,now).map(task=>task.id),baseline(tasks,conversations,now).map(task=>task.id));
 console.log(JSON.stringify({tasks:count,conversations:count,baselineMedianMs:median(()=>baseline(tasks,conversations,now)),indexedMedianMs:median(()=>indexed(tasks,conversations,now))}));
}
