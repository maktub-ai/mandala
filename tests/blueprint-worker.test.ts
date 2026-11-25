import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {openStore} from '../server/store';
import {readConfig,writeConfig} from '../server/config';
import {createBlueprintService} from '../server/blueprint';
import {createSessionManager} from '../server/sessions';
import {businessCliContext} from './business-cli-context';
import type {CodexClient,CodexOptions} from '../server/codex';
import * as nativeRuntime from '../server/native-runtime';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it.each(['codex','claude'] as const)('registers fresh and resumed %s workers and gates recording by actual task acceptance',async cli=>{
 const root=await mkdtemp(join(tmpdir(),'worker-plan-')),home=join(root,'profile'),repo=join(root,'repo');
 vi.stubEnv('OMINO_HOME',join(root,'plan-data'));await mkdir(home);await mkdir(repo);
 const {config,revision}=await readConfig(home);config.runtimes=['codex','claude'];
 config.agents=[{id:'writer',name:'Writer',instructions:'',defaultCli:cli,models:{},skills:[],mcp:[]}];
 config.projects=[{id:'desktop',name:'Desktop',cwd:repo,resources:[],skills:[],mcp:[],agentIds:['writer']}];
 await writeConfig(home,config,revision);
 const plans=createBlueprintService(home,{draft:async()=>['Reader']});
 await plans.enable('desktop');const draft=await plans.draft('desktop');await plans.confirm('desktop',draft.draftId,['Reader']);
 const store=openStore(home),owner={userId:store.ownerUserId};
 let options:CodexOptions,turn=0;const loads:{instructions:string;mode:string;token:string}[]=[];
 const capture=(mode:string,instructions:string)=>loads.push({mode,instructions,token:businessCliContext(instructions).token});
 const factory=async(o:CodexOptions):Promise<CodexClient>=>{options=o;return {
  getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{capture('new',p.instructions);return 'native';},
  resumeThread:async(_id,_mcp,instructions)=>{capture('resume',instructions!);},startTurn:async()=>'turn-'+ ++turn,interrupt:async()=>{},close(){},replyApproval(){}
 };};
 vi.spyOn(nativeRuntime,'startNativeRuntime').mockImplementation(async(_cli,o)=>factory(o));
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);
 try{
  const chat=await manager.create('desktop','writer',undefined,cli);
  const goal=manager.taskService.createTaskFromChat(owner,{goal:'Verify screen',projectId:'desktop',moduleRef:{projectId:'desktop',lane:'Reader'}},chat.id,'fixture');
  await manager.send(chat.id,'Implement the requested changes');
  expect(loads[0].mode).toBe('new');expect(loads[0].instructions).toContain('blueprint record');
  expect(await manager.callBoundTool(loads[0].token,'blueprint_summary',{},'summary')).toMatchObject({modules:[{lane:'Reader'}]});
  await expect(manager.callBoundTool(loads[0].token,'blueprint_record',{result:goal.id,lanes:['Reader']},'id')).rejects.toMatchObject({status:422});
  await manager.callBoundTool(loads[0].token,'blueprint_record',{result:'Readable on narrow screens',decisions:['Keep the two-line title'],lanes:['Reader']},'stage');
  expect((await plans.readSummary('desktop')).records.some(r=>r.result==='Readable on narrow screens')).toBe(false);
  const end=()=>options.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn-'+turn,status:'completed'}}});
  end();
  await manager.send(chat.id,'Continue verification');
  expect(loads.at(-1)!.mode).toBe('resume');expect(loads.at(-1)!.instructions).toContain('blueprint record');
  await expect(manager.callBoundTool(loads[0].token,'blueprint_summary',{},'expired')).rejects.toMatchObject({status:403});
  manager.taskService.moveTask(owner,goal.id,manager.taskService.getTask(owner,goal.id).revision,'completed',null,'accept');
  await expect.poll(async()=>(await plans.readSummary('desktop')).records.some(r=>r.result==='Readable on narrow screens'),{timeout:15000,interval:150}).toBe(true);
  const report=await manager.callBoundTool(loads.at(-1)!.token,'blueprint_report',{taskId:goal.id},'report');
  expect(report).toMatchObject([{projectId:'desktop',modules:[{lane:'Reader'}],records:expect.arrayContaining([expect.objectContaining({source:'accepted-task',href:expect.stringContaining('lane=Reader&record=')})])}]);
  const revoke=await readConfig(home);revoke.config.projects[0].agentIds=[];await writeConfig(home,revoke.config,revoke.revision);
  await expect(manager.callBoundTool(loads.at(-1)!.token,'blueprint_summary',{},'revoked')).rejects.toMatchObject({status:403});
  expect(await manager.callBoundTool(loads.at(-1)!.token,'blueprint_report',{taskId:goal.id},'no-facts')).toEqual([]);
  const restore=await readConfig(home);restore.config.projects[0].agentIds=['writer'];await writeConfig(home,restore.config,restore.revision);
  end();await plans.disable('desktop');
  await manager.send(chat.id,'Next request');expect(loads.at(-1)!.instructions).not.toContain('blueprint record');
  await expect(manager.callBoundTool(loads.at(-1)!.token,'blueprint_summary',{},'closed')).rejects.toMatchObject({status:403});
  expect(store.database.prepare('SELECT count(*) AS n FROM blueprint_workers').get()?.n).toBe(2);
 }finally{await manager.close();store.close();await rm(root,{recursive:true,force:true});}
},60000);
