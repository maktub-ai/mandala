// Opt-in real-model browser acceptance against an isolated local service.
// Requires a successful acp-live-smoke home. No user-account credentials are used.
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openStore} from '../server/store';
import {createSessionManager} from '../server/sessions';
import {createHttpServer} from '../server/http';
import {readConfig,writeConfig} from '../server/config';
import {tmpdir} from 'node:os';
import {chromium} from '@playwright/test';
const referenceHome=process.env.CLI_SMOKE_BROWSER_HOME;
if(!referenceHome)throw new Error('Set CLI_SMOKE_BROWSER_HOME to a successful isolated acceptance home');
const proof=JSON.parse(await readFile(join(referenceHome,'verification.json'),'utf8'));
if(proof.kind!=='real-model'||!proof.passed||resolve(proof.home)!==resolve(referenceHome))throw new Error('Use a successful isolated real-model acceptance home');
const home=await mkdtemp(join(tmpdir(),`mandala-browser-${proof.cli}-`));
const config=(await readConfig(referenceHome)).config;
delete config.mandala;config.agents=config.agents.filter(agent=>!agent.systemRole);
const project=config.projects.find(p=>p.id==='smoke')!;project.cwd=home;delete project.workspaces;
const current=await readConfig(home);await writeConfig(home,config,current.revision);
// Only account handling is a fixture. Session management, native ACP, Gateway,
// model calls, tools, persisted events and the rendered frontend are real.
const store=openStore(home),manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
const server=createHttpServer({home,store,manager,requireIdentity:false});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const chat=await manager.create('smoke','checker',undefined,proof.cli,{approvalMode:'auto'});
const port=(server.address() as {port:number}).port;process.env.MANDALA_PORT=String(port);const url=`http://127.0.0.1:${port}`;
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1280,height:900}});
const result:Record<string,unknown>={cli:proof.cli,home,kind:'real-model-browser',startedAt:new Date().toISOString()};
try{
 await page.goto(url+'/?project=smoke&agent=checker&conversation='+chat.id);
 await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();result.nativeConversationId=chat.id;
 const prefix='BROWSER_STREAM_'+randomBytes(4).toString('hex');
 await page.getByRole('textbox',{name:'Message',exact:true}).fill(`Do not use tools. Output exactly 30 lines, one line for each number from 01 through 30. Each line must be ${prefix}_ followed by that two-digit number. Do not add explanations.`);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 // Unphased ACP chunks render as public live output until the turn settles.
 const snapshots=new Set<string>(),statuses=new Set<string>();let duringRun=false;const end=Date.now()+180000;
 while(true){
  const text=(await page.locator('.agent-reply .message-content, .agent-reply .run-commentary[data-source=output], .agent-reply .explicit-progress[data-progress-source=output]').allTextContents()).join('\n');
  const status=store.getConversation(chat.id)!.status;statuses.add(status);
  if(text.includes(prefix)&&status==='running'){snapshots.add(text);duringRun=true;}
  if(text.includes(prefix+'_30')&&status==='idle')break;
  if(status==='error'||status==='interrupted')throw new Error('Real browser turn '+status);
  if(Date.now()>end)throw new Error('Real browser turn timed out');await page.waitForTimeout(50);
 }
 const text=(await page.locator('.agent-reply .message-content, .agent-reply .run-commentary[data-source=output], .agent-reply .explicit-progress[data-progress-source=output]').allTextContents()).join('\n');
 result.backendStatuses=[...statuses];result.partialRenderSnapshots=snapshots.size;result.sawFinal=text.includes(prefix+'_30');result.duringRun=duringRun;
 if(!text.includes(prefix+'_30')||!duringRun||snapshots.size<2)throw new Error('Real incremental assistant rendering was not observed');
 result.partialRenderSnapshots=snapshots.size;result.streamVisibleWhileRunning=true;
 await page.reload();await page.getByText(prefix+'_30',{exact:false}).last().waitFor({timeout:20000});result.replySurvivesReload=true;
 await page.screenshot({path:join(home,'real-browser-reply.png'),fullPage:true,animations:'disabled'});result.passed=true;
}catch(error){result.assistantRegions=await page.locator('.agent-reply').count();await page.screenshot({path:join(home,'real-browser-failure.png'),fullPage:true,animations:'disabled'});result.passed=false;result.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await browser.close();await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();result.finishedAt=new Date().toISOString();await writeFile(join(home,'browser-verification.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result,null,2));}
