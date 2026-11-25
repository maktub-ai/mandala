import type {Task,TaskExecution} from '../shared/tasks';

type ParticipatingTask=Pick<Task,'assigneeAgentId'|'participantAgentIds'> & {
 executions?:readonly Pick<TaskExecution,'agentId'|'projectId'|'attributedProjectId'|'supersededByExecutionId'>[];
};

export function projectParticipantIds(projectId:string,projectTasks:readonly ParticipatingTask[],projectChats:readonly {agentId:string|null}[]) {
 const ids=new Set<string>();
 for(const task of projectTasks){
  if(task.assigneeAgentId)ids.add(task.assigneeAgentId);
  for(const id of task.participantAgentIds??[])ids.add(id);
  for(const execution of task.executions??[]){
   if(!execution.supersededByExecutionId&&(execution.attributedProjectId??execution.projectId)===projectId&&execution.agentId)ids.add(execution.agentId);
  }
 }
 for(const chat of projectChats)if(chat.agentId)ids.add(chat.agentId);
 return ids;
}
