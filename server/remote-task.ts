import {createHash} from 'node:crypto';
import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
import {DomainError} from '../shared/workspace-contracts';
import type {Store} from './store';
import type {createTasks} from './tasks';
import {workspacePrincipal} from './workspace-identity';
import {remoteRequestAllowed} from './remote-policy';
import type {RemoteRequest} from './remote-transport';

const receipt=({id,goal,projectId,assigneeAgentId,state,revision}:Task)=>({id,goal,projectId,assigneeAgentId,state,revision});

// Called only by the paired, encrypted transport. The caller's peer is also the
// receipt namespace, so a command key from another pairing cannot read a Task.
export async function remoteTaskRequest(request:Pick<RemoteRequest,'method'|'path'|'body'>,currentPeer:()=>string|undefined,
 signal:AbortSignal,store:Store,tasks:ReturnType<typeof createTasks>,loadConfig:()=>Promise<Config>):Promise<Response>{
 const peer=currentPeer(),principal=workspacePrincipal(store);
 const denied=()=>Response.json({error:'Remote access revoked'},{status:403});
 if(!peer||signal.aborted)return denied();
 const input=request.method==='POST'?JSON.parse(new TextDecoder().decode(request.body)):undefined;
 if(!remoteRequestAllowed(request.method,request.path,input))return Response.json({error:'Remote operation forbidden'},{status:403});
 const command=input?.commandKey??request.path.split('/').at(-1);
 const key='remote-task:'+createHash('sha256').update(JSON.stringify([peer,command])).digest('hex');
 try{
  const prior=tasks.findTaskCommand(principal,key);
  if(request.method==='GET')return Response.json({task:prior?receipt(prior):null});
  const {goal,projectId=null,assigneeAgentId=null}=input;
  if(!prior){
   const config=await loadConfig();
   if(currentPeer()!==peer||signal.aborted)return denied();
   const project=config.projects.find(p=>p.id===projectId&&!p.archivedAt);
   const agent=config.agents.find(a=>a.id===assigneeAgentId&&!a.archivedAt&&!a.temporary&&!a.systemRole);
   if(projectId&&!project||assigneeAgentId&&(!agent||project&&!project.agentIds.includes(agent.id)))
    return Response.json({error:'Task target unavailable'},{status:409});
  }
  // createTask atomically verifies the payload, saves the task and records the
  // command receipt. The same command with different input remains a conflict.
  const task=tasks.createTask(principal,{goal,projectId,assigneeAgentId,automaticProgress:false},key);
  return Response.json({task:receipt(task)},{status:201});
 }catch(error){
  if(error instanceof DomainError)return Response.json({error:error.code},{status:error.status});
  throw error;
 }
}
