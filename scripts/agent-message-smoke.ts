import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {readConfig,writeConfig} from '../server/config';
import {openStore} from '../server/store';
import {createSessionManager} from '../server/sessions';
import {createHttpServer} from '../server/http';

const cli=process.env.OPEN_MANA_SMOKE_CLI==='omp'?'omp':'codex';
const home=await mkdtemp(join(tmpdir(),'mana-agent-message-smoke-'));
console.log(execFileSync(cli,['--version'],{encoding:'utf8'}).trim());
const initial=await readConfig(home);
await writeConfig(home,{...initial.config,runtimes:[cli],system:{cli,memory:{request:{generate:false,read:false},session:{generate:false,read:false}}},
 projects:[{id:'sample',name:'Personal confirmation sample',cwd:'',agentIds:['a','b'],resources:[],mcp:[],skills:[]}],
 agents:['a','b'].map(id=>({id,name:id==='a'?'Coordinator':'Helper',instructions:'Use only the synthetic sample. Never read personal files or credentials. Use the supplied Mandala CLI for platform commands.',defaultCli:cli,models:{},mcp:[],skills:[],runtime:{[cli]:{approvalMode:'auto' as const,...(cli==='codex'?{fullAccess:true}:{})}}}))},initial.revision);
const store=openStore(home),manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
const server=createHttpServer({home,store,manager,requireIdentity:false});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const priorPort=process.env.OPEN_MANA_PORT;process.env.OPEN_MANA_PORT=String((server.address() as {port:number}).port);
const wait=async(check:()=>boolean,label:string)=>{const end=Date.now()+240000;while(!check()){if(Date.now()>end)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,100));}};
const idle=(id:string)=>store.getConversation(id)?.status==='idle';
const final=(id:string)=>store.listEvents(id,0).flatMap(e=>{const data=e.data as {text?:string;method?:string;params?:{item?:{type:string;phase?:string;text?:string}}};const item=data.params?.item;return e.kind==='text'?[data.text??'']:data.method==='item/completed'&&item?.type==='agentMessage'&&item.phase==='final_answer'?[item.text??'']:[];}).join('\n');
const taskCounts=()=>['work_tasks','task_runs','task_receipts','tasks'].map(table=>Number(store.database.prepare('SELECT count(*) n FROM '+table).get()!.n));
const ids:string[]=[];
const invoke=manager.callBoundTool.bind(manager);
manager.callBoundTool=async(token,name,args,key)=>{const result=await invoke(token,name,args,key);if(name==='message_ask'&&!ids.includes((result as {id:string}).id))ids.push((result as {id:string}).id);return result;};
try{
 const a=await manager.create('sample','a',undefined,cli,{workspaceId:null});
 await manager.send(a.id,'Run the exact Mandala CLI in your instructions: messages ask --data {"targetAgentId":"b","text":"Do not use tools. Reply exactly MESSAGE_CONFIRMED."} --key native-confirm. Omit policy. After sending, end your turn. When the helper reply arrives in a later turn, use it and reply exactly SOURCE_RESUMED. Do not resend or poll.');
 await wait(()=>ids.length===1,'native Agent messages ask');
 await wait(()=>manager.getAgentMessage(ids[0]).replyState==='consumed'&&idle(a.id),'A automatic continuation');
 if(!final(a.id).includes('SOURCE_RESUMED')||!manager.getAgentMessage(ids[0]).reply?.includes('MESSAGE_CONFIRMED'))throw Error('Native confirmation answer mismatch');
 if(taskCounts().some(n=>n!==0))throw Error('Lightweight confirmation created Tasks');
 console.log('PASS native CLI message ask/readback, default resume, A/B/A, zero Task rows');

 const stopped=await manager.create('sample','a',undefined,cli,{workspaceId:null});
 await manager.send(stopped.id,'Run messages ask through the exact supplied Mandala CLI with --data {"targetAgentId":"b","text":"Use your shell tool to run sleep 12, then reply exactly LATE_CONFIRMATION. Do not read any files."} --key native-stop. Omit policy. After sending, end your turn with WAITING. Do not poll.');
 await wait(()=>ids.length===2&&idle(stopped.id),'source yields while B works');
 await manager.stop(stopped.id);
 await wait(()=>manager.getAgentMessage(ids[1]).reply?.includes('LATE_CONFIRMATION')===true,'late B answer');
 if(manager.getAgentMessage(ids[1]).replyState!=='parked')throw Error('Stopped A was resumed');
 await manager.continue(stopped.id,'Do not use tools. Reply exactly NEW_TOPIC_OK.');await wait(()=>idle(stopped.id),'explicit new topic');
 if(manager.getAgentMessage(ids[1]).replyState!=='parked'||taskCounts().some(n=>n!==0))throw Error('Old message revived');
 console.log('PASS stop idle A, B continues, late reply saved, explicit continue cannot revive old reply');

 const delegated=await manager.create('sample','a',undefined,cli,{workspaceId:null});
 await manager.send(delegated.id,'Use the exact supplied Mandala CLI: tasks delegate --data {"targetAgentId":"b","request":"Do not use tools. Reply exactly DELEGATE_RESULT_OK."} --key native-delegate. Omit policy. End your turn after sending. When its reply arrives, reply exactly SOURCE_DELEGATE_RESUMED. Do not poll or resend.');
 await wait(()=>store.database.prepare("SELECT id FROM task_receipts WHERE task_id IS NOT NULL AND policy='resume' AND delivery_state='consumed'").get()!==undefined&&idle(delegated.id),'true delegated Task resumes A');
 if(!final(delegated.id).includes('SOURCE_DELEGATE_RESUMED'))throw Error('Delegation continuation answer mismatch');
 const rows=store.database.prepare('SELECT policy,delivery_state FROM task_receipts WHERE task_id IS NOT NULL').all();
 if(!rows.some(r=>r.policy==='resume'&&r.delivery_state==='consumed'))throw Error('Missing consumed Task resume receipt');
 console.log('PASS real delegation defaults resume and keeps its coordinating parent Task');
 console.log(JSON.stringify({cli,home,messageIds:ids,taskCounts:taskCounts()}));
}catch(error){
 console.error(JSON.stringify({home,messages:ids.map(id=>manager.getAgentMessage(id)),chats:store.listConversations().map(c=>({id:c.id,status:c.status,errors:store.listEvents(c.id,0).filter(e=>e.kind==='error').map(e=>e.data)}))}));throw error;
}finally{
 if(priorPort===undefined)delete process.env.OPEN_MANA_PORT;else process.env.OPEN_MANA_PORT=priorPort;
 await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();
}
