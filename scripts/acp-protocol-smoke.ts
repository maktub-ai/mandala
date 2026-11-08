// Opt-in: real installed Gateway/ACP lifecycle only. Never calls a model.
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startNativeRuntime} from '../server/native-runtime';
import type {Cli} from '../shared/types';
import type {CodexClient} from '../server/codex';
import {nativeApprovalResponse} from '../shared/approvals';
const cli=process.argv[2] as Cli;
if(cli!=='hermes'&&cli!=='openclaw')throw new Error('Choose hermes or openclaw');
const cwd=await mkdtemp(join(tmpdir(),`mandala-protocol-${cli}-`));
const events:any[]=[],approvals:any[]=[],exits:string[]=[];
const options={cwd,onEvent:(e:unknown)=>events.push(e),onApproval:(a:unknown)=>approvals.push(a),onExit:(reason:string)=>exits.push(reason)};
const evidence:Record<string,unknown>={cli,cwd,kind:'real-program-protocol-no-model',startedAt:new Date().toISOString()};
const wait=async(check:()=>boolean)=>{const end=Date.now()+15000;while(!check()){if(Date.now()>end)throw new Error('Protocol completion timed out');await new Promise(r=>setTimeout(r,50));}};
let client:CodexClient|undefined;
try{
 client=await startNativeRuntime(cli,options);evidence.status=await client.getStatus();
 const models=await client.listModels();evidence.models=models.length;evidence.defaultModel=models.find(m=>m.isDefault)?.id??null;
 const id=await client.startThread({cwd,instructions:'Temporary protocol verification only. Do not execute work without a whole-turn grant.'});
 evidence.nativeId=id;await client.close();client=await startNativeRuntime(cli,options);
 await client.resumeThread(id,[],'Updated instructions after adapter restart');evidence.resumeSameSession=true;
 await client.startTurn(id,'Do not execute this rejected protocol-test task.','strict');
 await wait(()=>approvals.length>0);const approval=approvals.at(-1);
 if(!approval.params.wholeTurnApproval)throw new Error('Missing whole-turn grant');
 client.replyApproval(approval.id,nativeApprovalResponse(approval,'reject'));
 await wait(()=>events.some(e=>e.method==='turn/completed'));
 if(events.at(-1)?.params?.turn?.status!=='interrupted')throw new Error('Rejected turn did not stop');evidence.rejectBeforeDispatch=true;
 const turn=await client.startTurn(id,'Do not execute this stopped protocol-test task.','strict');
 await wait(()=>approvals.length>1);await client.interrupt(id,turn);
 await wait(()=>events.filter(e=>e.method==='turn/completed').length===2);evidence.stopPendingGrant=true;
 {
  try{await client.resumeThread(id,[{name:'unsupported',transport:'stdio',command:'node'}]);throw new Error('MCP accepted');}catch(error){if(!String(error).includes('session MCP'))throw error;evidence.mcpRejected=true;}
 }
 await client.close();client=await startNativeRuntime(cli,options);
 try{await client.resumeThread('mandala-nonexistent-session-for-protocol-check',[]);throw new Error('Missing native session accepted');}catch(error){if(String(error).includes('Missing native session accepted'))throw error;evidence.missingSessionRejected=true;}
 await client.close();client=await startNativeRuntime(cli,options);evidence.gatewayReconnectsAfterAdapterClose=(await client.getStatus()).status==='ready';
 evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await client?.close();evidence.finishedAt=new Date().toISOString();await writeFile(join(cwd,'verification.json'),JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence,null,2));}
