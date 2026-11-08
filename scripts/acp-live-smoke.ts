import {hasBusinessProgressReceipt} from './acp-smoke-evidence';
// Explicit opt-in acceptance. Native programs handle credentials; all Mandala data is temporary.
// CLI_SMOKE_KIND=real-program-controlled-endpoint labels a controlled provider honestly.
import {mkdtemp,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createSessionManager} from '../server/sessions';
import {createHttpServer} from '../server/http';
import {openStore} from '../server/store';
import {readConfig,writeConfig} from '../server/config';
import type {Cli,Config} from '../shared/types';
import {isCli,runtimeCatalog} from '../shared/runtimes';

const cli=process.argv[2];
if(!isCli(cli)||runtimeCatalog[cli].protocol!=='acp')throw new Error('Choose a registered ACP runtime');
const worker=process.argv.indexOf('--worker'),phase=worker>=0?process.argv[worker+2]:undefined;
const home=worker>=0?process.argv[worker+1]:await mkdtemp(join(tmpdir(),`mandala-live-${cli}-`));
const proofFile=join(home,'verification.json');
const delay=(ms=100)=>new Promise(resolve=>setTimeout(resolve,ms));
async function exists(path:string){try{await access(path);return true;}catch{return false;}}
if(worker<0){
 const evidence:Record<string,unknown>={cli,home,kind:process.env.CLI_SMOKE_KIND??'real-model',model:process.env.CLI_SMOKE_MODEL??'native default',startedAt:new Date().toISOString()};
 await writeFile(proofFile,JSON.stringify(evidence,null,2),{mode:0o600});
 try{
  for(const phase of ['first','resume',...(process.env.CLI_SMOKE_EXTENDED==='1'?['policy','stop']:[])]){
   console.log(JSON.stringify({cli,home,phase}));
   await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),cli,'--worker',home,phase],{env:{...process.env,MANDALA_HOME:home},stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(`Smoke worker ${phase} timed out; inspect its native session before retrying`));},240000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Smoke worker ${phase} failed (${code})`));});
   });
  }
  const result=JSON.parse(await readFile(proofFile,'utf8'));result.passed=true;result.finishedAt=new Date().toISOString();
  await writeFile(proofFile,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));
 }catch(error){
  const result=JSON.parse(await readFile(proofFile,'utf8'));result.passed=false;result.failure??=String(error);result.finishedAt=new Date().toISOString();
  await writeFile(proofFile,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));process.exitCode=1;
 }
}else{
 const evidence:Record<string,any>=JSON.parse(await readFile(proofFile,'utf8'));
 const store=openStore(home),model=process.env.CLI_SMOKE_MODEL;
 const initial:Config={version:2,runtimes:[cli],projects:[{id:'smoke',name:'Temporary CLI verification',cwd:home,agentIds:['checker'],resources:[],mcp:[],skills:[]}],agents:[{id:'checker',name:'CLI checker',instructions:'Work only in this temporary project. Do not inspect credentials, personal files or other projects. Never print authentication context. Do not message others or delegate tasks.',defaultCli:cli,models:model?{[cli]:model}:{},mcp:[],skills:[]}]};
 if(phase==='first'){const current=await readConfig(home);await writeConfig(home,initial,current.revision);}
 const config=(await readConfig(home)).config;
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 const server=createHttpServer({home,store,manager,requireIdentity:false});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.MANDALA_PORT=String((server.address() as {port:number}).port);
 const wait=async(check:()=>boolean|Promise<boolean>,description:string)=>{
  const deadline=Date.now()+180000;
  while(!await check()){if(Date.now()>deadline)throw new Error(description+' timed out');await delay();}
 };
 const settle=async(id:string,expected='idle')=>{
  await wait(()=>!['running','approval'].includes(store.getConversation(id)!.status),'Native turn');
  const status=store.getConversation(id)!.status;
  if(status!==expected){const errors=store.listEvents(id,0).filter(e=>e.kind==='error').map(e=>(e.data as {message?:string}).message);throw new Error(`Native turn ${status}: ${errors.join('; ').slice(0,1200)}`);}
 };
 try{
  if(phase==='first'){
   const chat=await manager.create('smoke','checker',model,cli,{approvalMode:'auto'});evidence.conversationId=chat.id;
   let sawStreaming=false;
   const stream=setInterval(()=>{if(store.listEvents(chat.id,0).some(e=>e.kind==='text'))sawStreaming=true;},20);
   try{await manager.send(chat.id,'Use a native file or shell tool to create cli-proof.txt in this working directory containing exactly MANDALA_REAL_CLI_OK. Then reply exactly MANDALA_REAL_CLI_OK.');await settle(chat.id);}finally{clearInterval(stream);}
   if((await readFile(join(home,'cli-proof.txt'),'utf8')).trim()!=='MANDALA_REAL_CLI_OK')throw new Error('Native file creation was not observed');
   evidence.nativeId=store.getConversation(chat.id)!.nativeId;if(!evidence.nativeId)throw new Error('Missing durable native ID');
   evidence.realToolWrite=true;evidence.streamingPersisted=sawStreaming;evidence.firstWorkerPid=process.pid;
  }else if(phase==='resume'){
   const chat=store.getConversation(evidence.conversationId)!;
   if(chat.nativeId!==evidence.nativeId)throw new Error('Persisted native session changed before resume');
   await manager.continue(chat.id,'Read cli-proof.txt using a native tool, append a new line containing exactly MANDALA_RESUME_OK, then read it again to verify. Use the Mandala CLI command from the current context to run progress report --key smoke-resume --data with JSON text MANDALA_BUSINESS_OK. Do not open or print the command context file. Finally reply exactly MANDALA_RESUME_OK.');
   await settle(chat.id);
   if(store.getConversation(chat.id)!.nativeId!==evidence.nativeId||!(await readFile(join(home,'cli-proof.txt'),'utf8')).includes('MANDALA_RESUME_OK'))throw new Error('Same-session recovery or native edit failed');
   const events=store.listEvents(chat.id,0);
   if(!events.filter(e=>e.kind==='text').map(e=>String((e.data as {text:string}).text)).join('').includes('MANDALA_RESUME_OK'))throw new Error('Reply was not persisted');
   evidence.processRestartResume=process.pid!==evidence.firstWorkerPid;evidence.resumeWorkerPid=process.pid;evidence.nativeReadModify=true;evidence.persistedReply=true;
   evidence.businessCli=hasBusinessProgressReceipt(events);
   if(!evidence.businessCli)throw new Error('Native tool did not produce a verified Mandala business progress event');
   evidence.configAfterRestart=config.runtimes?.includes(cli)===true;
  }else if(phase==='policy'){
   const chat=await manager.create('smoke','checker',model,cli,{approvalMode:'strict'});
   await manager.send(chat.id,'Create forbidden-after-rejection.txt with a native tool, then reply done.');
   await wait(()=>manager.getApprovals(chat.id).length>0||!['running','approval'].includes(store.getConversation(chat.id)!.status),'Whole-turn permission');
   const approval=manager.getApprovals(chat.id)[0];if(!approval)throw new Error('Expected whole-turn approval');
   if(!(approval.params as {wholeTurnApproval?:boolean})?.wholeTurnApproval)throw new Error('Unexpected permission granularity');
   if(await exists(join(home,'forbidden-after-rejection.txt')))throw new Error('Executed before approval');
   await manager.approve(chat.id,approval.id,'reject');await settle(chat.id,'interrupted');
   if(await exists(join(home,'forbidden-after-rejection.txt')))throw new Error('Executed rejected work');evidence.rejectBeforeDispatch=true;
   await manager.continue(chat.id,'Create allowed-after-grant.txt containing MANDALA_GRANTED using a native tool. Reply done.');
   await wait(()=>manager.getApprovals(chat.id).length>0,'Whole-turn grant');
   await manager.approve(chat.id,manager.getApprovals(chat.id)[0].id,'approve');await settle(chat.id);
   if((await readFile(join(home,'allowed-after-grant.txt'),'utf8')).trim()!=='MANDALA_GRANTED')throw new Error('Approved native tool did not execute');evidence.allowWholeTurn=true;
   await manager.continue(chat.id,'Create forbidden-after-stop.txt with a native tool.');await wait(()=>manager.getApprovals(chat.id).length>0,'Pending grant');
   await manager.stop(chat.id);if(await exists(join(home,'forbidden-after-stop.txt')))throw new Error('Pending stopped work executed');evidence.stopPendingGrant=true;
  }else if(phase==='stop'){
   const chat=await manager.create('smoke','checker',model,cli,{approvalMode:'auto'});
   await manager.send(chat.id,'Run one native terminal command in this working directory: printf started > stop-started.txt; sleep 30; printf UNEXPECTED > forbidden-running-stop.txt . Do not background it.');
   await wait(()=>exists(join(home,'stop-started.txt')),'Native command start');
   evidence.activeStopAcknowledged=await manager.stop(chat.id);
   await delay(32000);
   if(await exists(join(home,'forbidden-running-stop.txt')))throw new Error('Native command continued past acknowledged stop');evidence.stopNativeTool=true;
  }else throw new Error('Unknown worker phase');
 }catch(error){evidence.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
 finally{await manager.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await writeFile(proofFile,JSON.stringify(evidence,null,2),{mode:0o600});}
}
