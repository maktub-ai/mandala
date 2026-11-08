import type {Task,TaskState} from '../shared/tasks';
import type {ConversationProgress,ConversationProgressState} from '../shared/conversation-progress';
export const progressLanes=[
 {id:'waiting',words:['待处理','Needs attention']},
 {id:'running',words:['进行中与最近','In progress & recent']},
 {id:'completed',words:['已完成','Completed']},
] as const;
export function taskProgressLane(state:TaskState){return state==='completed'||state==='cancelled'?'completed':state==='running'?'running':'waiting';}
export function chatProgressLane(state:ConversationProgressState){return state==='completed'?'completed':state==='attention'?'waiting':'running';}

type TaskProgressActivity={activityAt:string;live:boolean};
export function buildTaskProgressIndex(tasks:readonly Task[],conversations:readonly ConversationProgress[]){
 const index=new Map<string,TaskProgressActivity>(tasks.map(task=>[task.id,{
  activityAt:[task.createdAt,task.activityAt,task.completion?.acceptedAt].filter((value):value is string=>!!value).sort().at(-1)!,live:!!task.live,
 }]));
 for(const row of conversations){
  for(const id of row.taskIds){
   const activity=index.get(id);if(!activity)continue;
   if(row.activityAt>activity.activityAt)activity.activityAt=row.activityAt;
   activity.live ||= !!row.live;
  }
 }
 return index;
}
export function taskInProgressWindow(activity:TaskProgressActivity,windowMinutes:number,now=Date.now()){
 return activity.live||now-Date.parse(activity.activityAt)<windowMinutes*60000;
}

export function progressTitle(title:string){const text=title.replace(/\s+/g,' ').trim();return text.length>80?text.slice(0,80)+'…':text;}
export function progressExcerpt(title:string,preview?:string|null){
 const normalize=(text:string)=>text.replace(/\s+/g,'').replace(/[…\.]+$/g,'');
 const heading=normalize(title),excerpt=normalize(preview??'');
 return !excerpt||heading.startsWith(excerpt)||excerpt.startsWith(heading)?'':preview!;
}
