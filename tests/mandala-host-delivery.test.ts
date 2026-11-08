import {ensureConfiguredMandala} from './configured-mandala';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {readConfig,writeConfig,updateMandalaSettings} from '../server/config';
import {ensureMandalaConversation} from '../server/mandala';
import {createSessionManager} from '../server/sessions';
import {startAcp} from '../server/acp';
import type {CodexClient,CodexOptions} from '../server/codex';
vi.mock('../server/acp',()=>({startAcp:vi.fn()}));
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.clearAllMocks();});
it.each(['codex','omp','claude','gemini','opencode'] as const)('%s receives current coordinator context on initial, resumed and continuity-reset turns',async cli=>{
 const home=await mkdtemp(join(tmpdir(),'mandala-host-delivery-')),store=openStore(home);
 cleanup.push(async()=>{store.close();await rm(home,{recursive:true,force:true});});
 const initial=await ensureConfiguredMandala(home);
 await writeConfig(home,{...initial.config,runtimes:[cli]},initial.revision);
 const next=await readConfig(home);await updateMandalaSettings(home,{name:'Mandala',soul:'',cli,maxParallel:3},next.revision);
 const entries:{options:CodexOptions;instructions:string;native:string;prompt:string}[]=[];
 const received:string[]=[];
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{
  const entry={options,instructions:'',native:'native-'+entries.length,prompt:''};entries.push(entry);
  return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],
   startThread:async p=>{entry.instructions=p.instructions;return entry.native;},
   resumeThread:async(id,_m,instructions)=>{entry.native=id;entry.instructions=instructions!;},
   startTurn:async(_id,text)=>{entry.prompt=text;received.push(entry.instructions);return 'turn';},interrupt:async()=>{},replyApproval(){},close(){}};
 };
 vi.mocked(startAcp).mockImplementation(async(_cli,options)=>factory(options));
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config,factory,async options=>{
  const client=await factory(options),entry=entries.at(-1)!;entry.instructions=await readFile(options.instructions!,'utf8');
  if(options.resume)entry.native=options.resume;
  return {...client,startThread:async()=>entry.native};
 },home);
 cleanup.push(()=>manager.close());
 const chat=ensureMandalaConversation(store,(await readConfig(home)).config);
 const finish=()=>{const e=entries.at(-1)!;e.options.onEvent({method:'turn/completed',params:{threadId:e.native,turn:{id:'turn',status:'completed'}}});};
 await manager.send(chat.id,'你好');finish();
 const current=await readConfig(home);await writeConfig(home,{...current.config,agents:[...current.config.agents,{id:'research',name:'New researcher',instructions:'PRIVATE',defaultCli:cli,models:{},mcp:[],skills:[]}]},current.revision);
 await manager.send(chat.id,'我的团队有哪些成员？');finish();
 store.updateConversation(chat.id,{nativeId:null,turnId:null,continuityPending:true});
 await manager.send(chat.id,'接着说');
 expect(received).toHaveLength(3);
 for(const text of received){expect(text).toContain("user's system coordinator");expect(text).toContain('MANDALA_DIRECTORY_SUMMARY_JSON');expect(text).toContain('Available commands: mandala directory;');expect(text).not.toContain('PRIVATE');
  const command=text.match(/^Mandala CLI command: (.+)$/m)![1];
  expect(text).toContain(command+' mandala planning-guide');expect(text).toContain(command+' mandala discover-work --data');
  expect(text).not.toContain('name: mandala-work-team-planning');
  expect(text).toContain('business module whose knowledge is reusable across tasks');
  expect(text).toContain('potentially multiple repositories and workspaces, with shared Project Wiki');
  expect(text).toContain('business scope, Project and working paths, business modules and knowledge boundaries, then Agents and capabilities');
 }
 expect(received[0]).not.toContain('New researcher');expect(received[1]).toContain('New researcher');expect(received[2]).toContain('New researcher');
 expect(entries.at(-1)!.prompt).toContain('bounded visible-history excerpt');
});
