// Synthetic E2E adapter boundary only. Never mounted by production server/main.ts.
import type { IncomingMessage,ServerResponse } from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../../server/store';
import type { SessionManager } from '../../server/sessions';
import type { CodexOptions } from '../../server/codex';
import { createAssetFiles } from '../../server/asset-files';
import { createAssets } from '../../server/assets';
import { createRunArtifacts } from '../../server/run-artifacts';
export async function taskFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store,manager:SessionManager,native:Map<string,CodexOptions>){
 if(!['/__test__/task-output','/__test__/task-unknown'].includes(req.url??'')||req.method!=='POST')return false;
 try{
  let body='';for await(const part of req)body+=part;const {taskId,runId}=JSON.parse(body),p={userId:'local'},task=manager.taskService.getTask(p,taskId),runs=manager.taskService.listRuns(p,taskId),run=runId?runs.find(run=>run.id===runId)!:runs.at(-1)!;
  if(run.state!=='running'||!run.nativeSessionId||!run.nativeTurnId||!native.has(run.nativeSessionId))throw Error('Expected live fake turn');
  if(req.url==='/__test__/task-unknown'){manager.taskService.markUnknown(run.id);store.updateConversation(run.routing!.executionConversationId,{status:'interrupted'});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(manager.taskService.getTask(p,taskId)));return true;}
  const root=join(home,'outputs',run.id);await mkdir(root,{recursive:true});await writeFile(join(root,'report.md'),'Synthetic research report\nSources checked in the fixture.\n');
  const files=createAssetFiles(home),assets=createAssets(store,files),publisher=createRunArtifacts({store,files,assets,principal:{...p,agentId:task.executions.find(execution=>execution.id===run.executionId)!.agentId,runId:run.id},outputRoot:root,sourceVersions:manager.taskService.getContextSnapshot(p,run.id)!.sourceVersions,assertActive(){if(manager.taskService.getRunControl(p,run.id).state!=='running')throw Error('Run no longer active');}});
  const result=await publisher.publish({title:'Task research report',files:[{path:'report.md'}]},'fixture-output');
  const options=native.get(run.nativeSessionId)!;
  options.onEvent({method:'item/agentMessage/delta',params:{threadId:run.nativeSessionId,turnId:run.nativeTurnId,itemId:'fixture-final',delta:'The fixed report is ready.'}});
  options.onEvent({method:'turn/completed',params:{threadId:run.nativeSessionId,turn:{id:run.nativeTurnId,status:'completed'}}});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
 return true;
}
