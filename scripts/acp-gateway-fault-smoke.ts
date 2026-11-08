// Opt-in destructive fault of a Gateway process created ONLY by this script.
// Uses an isolated native profile and a controlled localhost model endpoint;
// this is real-program protocol testing, not real-model acceptance.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startNativeRuntime} from '../server/native-runtime';
import type {CodexClient} from '../server/codex';
const cli=process.argv[2];if(cli!=='hermes'&&cli!=='openclaw')throw new Error('Choose hermes or openclaw');
const home=await mkdtemp(join(tmpdir(),`mandala-fault-${cli}-`)),native=join(home,'native');await mkdir(native,{mode:0o700});
const evidence:Record<string,unknown>={cli,home,kind:'real-program-controlled-endpoint',startedAt:new Date().toISOString()};
const events:any[]=[],exits:string[]=[];let calls=0,totalRequests=0,client:CodexClient|undefined;
const endpoint=createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fault-model',object:'model',owned_by:'local-test'}]}));return;}
 let body='';for await(const chunk of req)body+=chunk;totalRequests++;const main=body.includes('Wait for the controlled endpoint response.');if(main)calls++;
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
 res.write('data: '+JSON.stringify({id:'fault-response',object:'chat.completion.chunk',created:1,model:'fault-model',choices:[{index:0,delta:{role:'assistant',content:'CONTROLLED_PARTIAL'},finish_reason:null}]})+'\n\n');
 if(!main){res.write('data: '+JSON.stringify({id:'metadata',object:'chat.completion.chunk',created:1,model:'fault-model',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');res.end();}
 // Intentionally keep the main model response open until the owned Gateway is killed.
});
await new Promise<void>(r=>endpoint.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`;
const nativeEnv={HERMES_TUI_GATEWAY_URL:'',OPENCLAW_GATEWAY_URL:'',OPENAI_API_KEY:'protocol-test-not-a-secret',OPENAI_BASE_URL:base,...(cli==='hermes'?{HERMES_HOME:native}:{OPENCLAW_STATE_DIR:native,OPENCLAW_CONFIG_PATH:join(native,'openclaw.json')})};
const env={...process.env,...nativeEnv};
if(cli==='hermes')await writeFile(join(native,'config.yaml'),`model:\n  provider: custom\n  default: fault-model\n  base_url: ${base}\n  api_key: protocol-test-not-a-secret\ngateway:\n  auto_multiplex_migration: false\nagent:\n  max_iterations: 3\n`,{mode:0o600});
else{
 const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
 await writeFile(join(native,'openclaw.json'),JSON.stringify({gateway:{mode:'local',port,bind:'loopback',auth:{mode:'none'}},agents:{defaults:{model:{primary:'fault/fault-model'},workspace:home,heartbeat:{every:'0m'}}},models:{providers:{fault:{baseUrl:base,api:'openai-completions',apiKey:'protocol-test-not-a-secret',models:[{id:'fault-model',name:'Controlled protocol endpoint',contextWindow:128000,maxTokens:4096}]}}}}),{mode:0o600});
}
const ownGroup=process.platform!=='win32';
let gateway:ReturnType<typeof spawn>|undefined,gatewayFailure:Error|undefined;
const killOwned=()=>{if(!gateway)return;if(ownGroup&&gateway.pid)try{process.kill(-gateway.pid,'SIGKILL');return;}catch{}gateway.kill('SIGKILL');};
const wait=async(check:()=>boolean,ms=60000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('Fault smoke timed out');await new Promise(r=>setTimeout(r,100));}};
try{
 if(cli==='hermes')await new Promise<void>((resolve,reject)=>{const check=spawn(cli,['acp','--check'],{env,stdio:'ignore',shell:false});const timer=setTimeout(()=>{check.kill();reject(new Error('Hermes isolated dependency preparation timed out'));},240000);check.on('error',error=>{clearTimeout(timer);reject(error);});check.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Hermes isolated dependency check failed'));});});
 gateway=spawn(cli,['gateway','run'],{env,stdio:'ignore',shell:false,detached:ownGroup});gateway.on('error',error=>{gatewayFailure=error;});
 await new Promise(r=>setTimeout(r,cli==='openclaw'?12000:8000));
 if(gatewayFailure)throw gatewayFailure;
 if(gateway.exitCode!==null)throw new Error('Owned test Gateway failed to start');
 client=await startNativeRuntime(cli,{cwd:home,env:nativeEnv,onEvent:e=>events.push(e),onApproval(){throw new Error('Unexpected native permission');},onExit:reason=>exits.push(reason)});
 const options={cwd:home,env:nativeEnv,onEvent:(e:unknown)=>events.push(e),onApproval(){throw new Error('Unexpected native permission');},onExit:(reason:string)=>exits.push(reason)};
 const id=await client.startThread({cwd:home,instructions:'Controlled localhost protocol fault test; do not use tools.'});evidence.nativeId=id;
 await client.close();await new Promise(r=>setTimeout(r,200));
 if(gateway.exitCode!==null||!gateway.pid)throw new Error('Owned Gateway stopped with its ACP adapter');process.kill(gateway.pid,0);evidence.sameOwnedGatewaySurvivesAdapterClose=true;
 client=await startNativeRuntime(cli,options);await client.resumeThread(id,[],'Controlled localhost fault test; do not use tools.');
 await client.startTurn(id,'Wait for the controlled endpoint response.','auto');await wait(()=>calls>0);
 killOwned();evidence.killedOwnedGatewayPid=gateway.pid;
 await wait(()=>exits.length>0||events.some(e=>e.method==='turn/completed'),45000);
 const completed=events.find(e=>e.method==='turn/completed');
 if(completed?.params?.turn?.status==='completed')throw new Error('Gateway loss reported success');
 await new Promise(r=>setTimeout(r,2000));if(calls!==1)throw new Error('Uncertain model work was resent');
 evidence.explicitFailure=exits.length>0||!!completed?.params?.turn?.error||completed?.params?.turn?.status==='interrupted';
 evidence.modelRequests=calls;evidence.totalProviderRequests=totalRequests;evidence.noAutomaticResend=true;evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await client?.close();if(gateway?.exitCode===null)killOwned();endpoint.closeAllConnections();await new Promise<void>(r=>endpoint.close(()=>r()));evidence.finishedAt=new Date().toISOString();await writeFile(join(home,'verification.json'),JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence,null,2));}
