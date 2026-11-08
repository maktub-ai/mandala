// Opt-in semantic acceptance. Requires an already prepared, isolated native CODEX_HOME.
import {mkdir,mkdtemp,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {ensureMandalaConfig,readConfig,writeConfig} from '../server/config';
import {ensureMandalaConversation} from '../server/mandala';
import {createSessionManager} from '../server/sessions';
import {openStore} from '../server/store';
const nativeHome=await realpath(process.env.CODEX_HOME??'');
const temporary=await realpath(tmpdir()),nativeRelative=relative(temporary,nativeHome);
// macOS /private/tmp is also a safe temporary parent, independent of per-user TMPDIR.
const systemTemporary=await realpath('/tmp'),systemRelative=relative(systemTemporary,nativeHome);
if(![nativeRelative,systemRelative].some(p=>p&&!p.startsWith('..')&&!isAbsolute(p)))throw Error('Set CODEX_HOME to a dedicated temporary native home before running');
const home=await mkdtemp(join(tmpdir(),'mandala-context-smoke-'));
process.env.MANDALA_HOME=home;
await mkdir(join(home,'research'));
const initial=await ensureMandalaConfig(home);
await writeConfig(home,{...initial.config,runtimes:['codex'],system:{cli:'codex',automaticTitles:false,automaticTaskProgress:false,memoryCapture:false,skillLearning:false},
 agents:[...initial.config.agents,{id:'researcher',name:'Researcher',instructions:'Synthetic research executor',defaultCli:'codex',models:{},mcp:[],skills:[]}],
 projects:[{id:'research',name:'Research Lab',cwd:join(home,'research'),agentIds:['researcher'],resources:[],mcp:[],skills:[]}]},initial.revision);
const store=openStore(home),manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
const calls:{name:string;ok:boolean}[]=[],original=manager.callBoundTool.bind(manager);
manager.callBoundTool=async(...args)=>{const call={name:args[1],ok:false};calls.push(call);const result=await original(...args);call.ok=true;return result;};
const chat=ensureMandalaConversation(store,(await readConfig(home)).config),turns:{prompt:string;reply:string}[]=[];
async function turn(prompt:string){
 const after=store.listEvents(chat.id,0).at(-1)?.id??0;
 await manager.send(chat.id,prompt);
 const deadline=Date.now()+180000;
 while(['running','approval'].includes(store.getConversation(chat.id)!.status)){
  if(store.getConversation(chat.id)!.status==='approval')throw Error('Native approval required; smoke does not grant broader permissions');
  if(Date.now()>deadline)throw Error('Native turn timed out');
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 if(store.getConversation(chat.id)!.status!=='idle')throw Error('Native turn did not settle successfully');
 const fragments=new Map<string,string>();
 for(const event of store.listEvents(chat.id,after)){
  const data=event.data as {text?:string;phase?:string;itemId?:string;snapshot?:boolean};
  if(event.kind==='text'&&data.text&&data.phase!=='commentary'&&data.phase!=='analysis'){
   const key=data.itemId??String(event.id);fragments.set(key,data.snapshot?data.text:(fragments.get(key)??'')+data.text);
  }
 }
 const reply=[...fragments.values()].join('\n');turns.push({prompt,reply});console.log(JSON.stringify({prompt,reply}));
 return reply;
}
let passed=false,error:string|undefined;
try{
 const greeting=await turn('你好');
 if(!/Mandala/i.test(greeting)||!/协调|统筹|组织|coordinat|orchestrat/i.test(greeting))throw Error('Greeting did not explain coordinator identity');
 // The inventory changes after the first turn, forcing fresh discovery rather than remembered context.
 const current=await readConfig(home);await writeConfig(home,{...current.config,agents:current.config.agents.map(a=>a.id==='researcher'?{...a,name:'Research specialist'}:a)},current.revision);
 const team=await turn('我的团队有哪些成员，分别在哪些项目？');
 if(!calls.some(c=>c.name==='mandala_directory'&&c.ok)||!team.includes('Research specialist')||!team.includes('Research Lab'))throw Error('Team response did not use current directory and configured membership');
 passed=true;
}catch(cause){error=cause instanceof Error?cause.message:String(cause);process.exitCode=1;}
finally{
 await manager.close();store.close();
 await writeFile(join(home,'semantic-acceptance.json'),JSON.stringify({passed,error,turns,calls},null,2),{mode:0o600});
 console.log(JSON.stringify({passed,error,evidence:join(home,'semantic-acceptance.json')}));
}
