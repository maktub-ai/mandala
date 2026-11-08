import { productEnv } from "../cli/product-env.mjs";
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, writeConfig } from '../server/config';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
import { createMemoryRuntime } from '../server/memory-runtime';
import { startCodex, connectCodex, type CodexOptions } from '../server/codex';
import { createRpcClient } from '../server/rpc';
import { spawn } from 'node:child_process';
const runFile=promisify(execFile), home=await mkdtemp(join(tmpdir(),'mandala-business-smoke-'));
const nativeCli=productEnv('SMOKE_CLI')==='omp'?'omp':'codex';
const initial=await readConfig(home),mode=productEnv('SMOKE_RESTRICTED'),restricted=mode==='1'||mode==='read-only',readOnly=mode==='read-only';
await writeConfig(home,{...initial.config,system:{cli:nativeCli,memory:{request:{generate:false,read:true},session:{generate:false,read:false}}},projects:[{id:'sample',name:'Synthetic CLI sample',cwd:'',agentIds:['coordinator','helper'],resources:[],mcp:[],skills:[]}],agents:['coordinator','helper'].map(id=>({id,name:id,instructions:'Use only the synthetic sample and declared output root. Use Mandala business CLI for platform actions.',defaultCli:nativeCli,models:{},mcp:[],skills:[],runtime:{[nativeCli]:{approvalMode:'auto' as const,...(nativeCli==='codex'?{fullAccess:!restricted}:{})}}}))},initial.revision);
await writeFile(join(home,'knowledge.json'),JSON.stringify([{id:'synthetic-memory',kind:'memory',title:'Synthetic probe',content:'synthetic-cli-probe: MEMORY_CLI_OK',scope:'project',projectId:'sample',access:{mode:'all'},status:'active',level:'L1',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]));
const store=openStore(home),load=async()=>(await readConfig(home)).config;
const memoryRuntime=createMemoryRuntime({home,store,loadConfig:load,schedule:false});await memoryRuntime.initialize();
const factory=async(options:CodexOptions)=>{
 if(!restricted)return startCodex(options);
 const rpc=createRpcClient(spawn('codex',['-c',`sandbox_mode="${readOnly?'read-only':'workspace-write'}"`,'-c','sandbox_workspace_write.network_access=false','app-server','--stdio'],{cwd:options.cwd,stdio:'pipe',shell:false}),{onNotification:options.onEvent,onRequest:options.onApproval,onExit:options.onExit});
 return connectCodex(rpc,options.cwd,false);
};
const manager=createSessionManager(store,load,factory,undefined,home,undefined,undefined,memoryRuntime),server=createHttpServer({home,store,manager,memoryRuntime});
server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
const boundCalls=new Set<string>(),originalBound=manager.callBoundTool.bind(manager);
manager.callBoundTool=async(...args)=>{const result=await originalBound(...args);boundCalls.add(args[1]);if(args[1]==='artifact_read'&&(result as any).text.trim()!=='BUSINESS_CLI_OUTPUT_OK')throw Error('Agent asset readback mismatch');return result;};
const previousPort=process.env.MANDALA_PORT;process.env.MANDALA_PORT=String(port);
const cli=async(args:string[])=>{
 const {stdout}=await runFile(process.execPath,['cli/mandala.mjs','--base-url',`http://127.0.0.1:${port}`,...args],{maxBuffer:1024*1024});
 const result=JSON.parse(stdout);if(!result.ok)throw Error(JSON.stringify(result));return result.data;
};
const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+(nativeCli==='omp'?300000:180000);while(!predicate()){if(Date.now()>deadline)throw Error(`Timed out: ${label}`);await new Promise(r=>setTimeout(r,100));}};
try{
 console.log((await runFile(nativeCli,['--version'])).stdout.trim());
 const status=await cli(['service','status']);if(status.status!=='ready')throw Error('Service not ready');
 const created=await cli(['conversations','create','--key','create-sample','--data',JSON.stringify({projectId:'sample',agentId:'coordinator'})]);
 const replay=await cli(['conversations','create','--key','create-sample','--data',JSON.stringify({projectId:'sample',agentId:'coordinator'})]);if(created.id!==replay.id)throw Error('Duplicate conversation');
 const helperRequest=(readOnly?'Use the existing seeded result.txt in your declared output root; do not write project files.':'Write result.txt in your declared output root containing exactly BUSINESS_CLI_OUTPUT_OK,')+' then publish it with Mandala CLI assets publish --data containing title Synthetic output and files [{path:result.txt}]. After publication run CLI assets read using the returned assetId, versionId and fileId 0, and verify BUSINESS_CLI_OUTPUT_OK. Do not report completion before publication and readback succeed.';
 const prompt='Use the exact Mandala CLI command in your instructions to run project agents. Run memory search with --data containing query synthetic-cli-probe, then memory read for the returned recordId and verify the text MEMORY_CLI_OK. Then run tasks delegate with --data containing targetAgentId helper, request "'+helperRequest+'", and policy notify. Use --key synthetic-delegation. Reply briefly with the task ID after delegation. Do not read any personal files.';
 await cli(['conversations','send',created.id,'--key','send-sample','--data',JSON.stringify({text:prompt})]);
 await wait(()=>manager.listTasks().length>0,'real Agent delegation');const task=manager.listTasks()[0];
 if(readOnly){const current=await cli(['tasks','get',task.id]);const output=join(home,'outputs',current.runs.at(-1).id);await mkdir(output,{recursive:true});await writeFile(join(output,'result.txt'),'BUSINESS_CLI_OUTPUT_OK');}
 await wait(()=>['completed','error','interrupted','cancelled'].includes(manager.listTasks().find(t=>t.id===task.id)!.status),'helper publication');
 const detail=await cli(['tasks','get',task.id]);const run=detail.runs.at(-1);
 if(run.state!=='succeeded'||!run.artifactVersions?.length)throw Error('Helper did not publish a successful fixed output: '+JSON.stringify({runState:run.state,summary:run.summary,artifacts:run.artifactVersions}));
 if(detail.receipts.length!==1)throw Error('Expected one receipt');
 const ref=run.artifactVersions[0];const version=await cli(['assets','version',ref.assetId,ref.versionId]);
 const target=join(home,'readback.txt');await cli(['assets','read',ref.assetId,ref.versionId,version.downloads[0].fileId,'--output',target]);
 const {readFile}=await import('node:fs/promises');if((await readFile(target,'utf8')).trim()!=='BUSINESS_CLI_OUTPUT_OK')throw Error('Output readback mismatch');
 await wait(()=>!['running','approval'].includes(store.getConversation(created.id)!.status),'source completion');
 const uses=store.listEvents(created.id,0).filter(e=>e.kind==='metadata'&&(e.data as any).memoryUse==='acknowledged');
 if(!uses.some(e=>(e.data as any).query==='synthetic-cli-probe'&&(e.data as any).items.length)||!uses.some(e=>(e.data as any).query?.startsWith('record:')))throw Error('Agent did not search and read the seeded authorized memory');
 if(boundCalls.size!==6)throw Error('Expected all six bound CLI operations: '+JSON.stringify([...boundCalls]));
 console.log('Native sandbox: '+(readOnly?'read-only; only private mailbox writable; network disabled':restricted?'workspace-write; network disabled':'full access'));
 console.log('PASS all six real Agent CLI operations; memory search/read; business CLI conversation replay, real Agent project query/delegation, helper publication, fixed-version bytes and one notify receipt');
 console.log(JSON.stringify({home,taskId:task.id,runId:run.id,assetId:ref.assetId,versionId:ref.versionId,receiptCount:detail.receipts.length}));
}catch(error){
 const diagnostics=store.listConversations().map(chat=>({id:chat.id,status:chat.status,errors:store.listEvents(chat.id,0).filter(e=>e.kind==='error').map(e=>e.data),lastText:store.listEvents(chat.id,0).filter(e=>e.kind==='text').at(-1)?.data}));
 console.error(JSON.stringify({diagnostics}));throw error;
}finally{
 if(previousPort===undefined)delete process.env.MANDALA_PORT;else process.env.MANDALA_PORT=previousPort;
 await manager.close();await memoryRuntime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();
 await rm(home,{recursive:true,force:true});
}
