import type {Store} from '../../server/store';
import type {createTasks} from '../../server/tasks';
import type {TaskInput} from '../../shared/tasks';
import type {Principal} from '../../shared/workspace-contracts';
// Seed explicit execution registry entries without simulating public command revisions.
export function createTaskWithExecutions(store:Store,tasks:ReturnType<typeof createTasks>,principal:Principal,input:TaskInput,conversationIds:string[],key:string){
 const task=tasks.createTask(principal,input,key);
 for(const conversationId of conversationIds){
  // Fixture callers create the Chat first; the public attach API is tested separately.
  const chat=store.getConversation(conversationId)!;
  tasks.createExecution(principal,task.id,{conversationId,agentId:chat.agentId,projectId:chat.projectId||null,request:input.goal},key+':'+conversationId);
 }
 return tasks.getTask(principal,task.id);
}
