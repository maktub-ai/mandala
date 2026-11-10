import {executionResultsFixture} from './execution-results-fixture';
import {notificationInboxFixture} from './notification-inbox-fixture';
import {operationCardsFixture} from './operation-cards-fixture';
import {mandalaPanelsFixture} from './mandala-panels-fixture';
import {conversationActivityFixture} from './conversation-activity-fixture';
import {liveOutputFixture} from './live-output-fixture';
import {progressFixture} from './progress-fixture';
import {deliverableFixture} from './deliverable-fixture';
import { wikiFixture, wikiFixtureGenerate } from './wiki-fixture';
import { skillFixture } from "./skill-fixture";
import { productEnv } from "../../cli/product-env.mjs";
import { businessCliContext } from '../business-cli-context';
import { createMarket } from "../../server/market";
import { marketSource } from "./helpers/market-source";
import { createMemoryRuntime } from "../../server/memory-runtime";
import { fixtureMemoryEmbed } from './helpers/memory-embedding';
import { fixtureMemoryProfile } from './helpers/memory-profile';
import {taskFixture} from './task-fixture';
import {personalChatFixture} from './personal-chat-fixture';
import type {CodexOptions} from '../../server/codex';
const native = new Map<string,CodexOptions>();
const responseInstructions = new Map<string, string>();
import { createServer } from "node:http";
import { createAutomations } from "../../server/automations";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRpcClient } from "../../server/rpc";
import { connectCodex } from "../../server/codex";
import { readConfig, writeConfig } from "../../server/config";
import { openStore } from "../../server/store";
import { migrateWorkspace } from "../../server/workspace-migrations";
import { createSessionManager } from "../../server/sessions";
import { createSystemTasks } from "../../server/system-tasks";
import { createHttpServer } from "../../server/http";
const home = mkdtempSync(join(tmpdir(), "mana-e2e-"));
const initialConfig=await readConfig(home);
await writeConfig(home,{...initialConfig.config,runtimes:["codex","omp"]},initialConfig.revision);
await migrateWorkspace(home, "apply");
const store = openStore(home);
const memoryRuntime = createMemoryRuntime({verifyOutput:false,schedule:false,home,store,embed:fixtureMemoryEmbed,loadConfig:async()=>(await readConfig(home)).config,authorizeConversationRead:(_p,id)=>manager.authorizeConversationRead(id),generate:async(_config,prompt)=>{
 const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
 const wrap=(result:unknown)=>JSON.stringify(data.referenceDictionary?{referenceReceipt:data.referenceDictionary.receipt,result}:result);
 if(data.stage==='conflict')return wrap(data.atoms);
 const layer=data.stage==='extract'?'L1':data.stage==='profile'?'L3':'L2';
 if(layer==='L3')return wrap(fixtureMemoryProfile(data));
 if(layer==='L2')return wrap(data.records.filter((r:any)=>r.layer==='L1'&&r.collectionId===data.collectionId).slice(0,8).map((r:any)=>({collectionId:data.collectionId,layer,semanticKey:data.stage==='scene'?'scene.synthetic.'+r.recordId:'session.context',contentType:r.contentType,text:r.text,operation:'store',replaces:[],evidence:r.evidence,support:[],dependencies:[{recordId:r.recordId,revision:r.revision}],validUntil:null,certainty:'observed'})));
 const proposals=data.sources.flatMap((source:any)=>source.events.filter((event:any)=>(event.kind==='user'||source.kind==='task'&&event.kind==='tool')&&event.text).map((event:any)=>({collectionId:data.collectionId,layer,contentType:'fact',text:event.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],dependencies:layer==='L1'?[]:data.records.filter((record:any)=>record.layer==='L1'&&record.text===event.text).map(({recordId,revision}:any)=>({recordId,revision})),validUntil:null,certainty:'user_asserted'}))).filter((proposal:any)=>layer==='L1'||proposal.dependencies.length).slice(0,8);
 return wrap(data.kind==='session'&&data.stage==='extract'?{proposals,summary:data.sources.map((source:any)=>source.text).join('\n')}:proposals);
}});
 await memoryRuntime.initialize();
const manager = createSessionManager(
  store,
  async () => (await readConfig(home)).config,
  async (options) => {
    const client = await connectCodex(
      createRpcClient(
        spawn(process.execPath, ["tests/fixtures/fake-cli.mjs", "--chat", "--state", join(home, "native-threads.json"), ...(options.extraArgs ?? [])], {
          stdio: "pipe", signal: options.signal,
        }),
        {
          onNotification: event=>{const id=(event.params as {threadId?:string})?.threadId;if(id)native.set(id,options);options.onEvent(event);},
          onRequest: options.onApproval,
          onExit: options.onExit,
        },
      ),
    );
    let token = '';
    return {...client,
      async startThread(params) { token=businessCliContext(params.instructions).token;const id=await client.startThread(params);native.set(id,options);responseInstructions.set(id,params.instructions);return id; },
      async resumeThread(id,mcp,instructions,model) { token=businessCliContext(instructions).token;await client.resumeThread(id,mcp,instructions,model);native.set(id,options);responseInstructions.set(id,instructions ?? ""); },
      async startTurn(id,text,approvalMode,roots,turnOptions) {
        const turnId=await client.startTurn(id,text,approvalMode,roots,turnOptions);
        if(text.startsWith('fixture-delegate:'))setImmediate(async()=>{
          try {
            const accepted=await manager.callBoundTool(token,'delegate',{targetAgentId:text.slice('fixture-delegate:'.length),request:'hold',policy:'notify'},'fixture-delegate:'+turnId) as {status:string};
            if(accepted.status!=='queued')throw new Error('Expected accepted queued task');
            options.onEvent({method:'turn/completed',params:{threadId:id,turn:{id:turnId,status:'completed'}}});
          } catch(error) {
            options.onEvent({method:'turn/completed',params:{threadId:id,turn:{id:turnId,status:'failed',error:{message:String(error)}}}});
          }
        });
        return turnId;
      },
    };
  },
  undefined,
  home,
  (id, round) => { void systemTasks.onSettled(id, round).catch(() => {}); },
  id => { void systemTasks.onMessage(id).catch(() => {}); },
  memoryRuntime,
  {wikiGenerate:wikiFixtureGenerate,generate:async(_config,prompt)=>prompt.includes('skill-learning-fixture')?JSON.stringify({action:'new',name:'dialogue-inspect',content:'---\nname: dialogue-inspect\ndescription: Inspect a persisted fixture result\n---\nRead back stored state and verify related states.'}):JSON.stringify({action:'skip'})},
);
 const systemTasks = createSystemTasks({ home, store, memoryRuntime, tasks:manager.taskService, loadConfig: async () => (await readConfig(home)).config,
  generate: async (_config, prompt) => {
    if(prompt.includes('Evaluate progress toward each explicitly linked task'))return '[]';
    const source = JSON.parse(prompt.split("SOURCE_JSON:\n")[1]);
    return prompt.includes("conversation title") ? "Synthetic title: " + source.user.slice(0, 40) :
      JSON.stringify([{ title: "Synthetic reusable conclusion", content: source.reply }]);
  } });
memoryRuntime.start();
manager.knowledgeBase.start();
const automations = createAutomations({ home, store, manager, loadConfig: async () => (await readConfig(home)).config });
automations.start();
const apiServer = createHttpServer({taskDraftGenerate:async(description)=>({goal:description,criteria:[]}),requireIdentity:false, home, store, manager, systemTasks, automations, memoryRuntime, market: createMarket(home, marketSource) });
const vite = productEnv('E2E_SOURCE') === "1" ? await (await import("vite")).createServer({
  resolve: { alias: { "@": join(process.cwd(), "src") } },
  configFile: false, root: process.cwd(), appType: "spa", server: { middlewareMode: true, hmr: false, ws: { host: "127.0.0.1", port: Number(productEnv('E2E_PORT') ?? 4318) + 10000 } },
}) : undefined;
const server = createServer(async(req,res)=>{
  if (req.method === 'GET' && req.url?.startsWith('/__test__/response-instructions?')) {
    const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('conversationId') ?? '';
    const chat = store.getConversation(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ instructions: responseInstructions.get(chat?.nativeId ?? '') ?? '' }));
    return;
  }
  if(notificationInboxFixture(req,res,store,manager))return;
  if(await executionResultsFixture(req,res,home,store,manager,automations))return;
  if(await operationCardsFixture(req,res,home,store,manager))return;
  if(await mandalaPanelsFixture(req,res,home,store,manager,automations))return;
  if(await conversationActivityFixture(req,res,store,manager,native))return;
  if(await liveOutputFixture(req,res,store,manager,native))return;
  if (req.method === 'POST' && req.url === '/__test__/chat-history') {
    const { ensureMandalaConfig } = await import('../../server/config');
    const { ensureMandalaConversation } = await import('../../server/mandala');
    const { config } = await ensureMandalaConfig(home);
    const chats = [
      store.createConversation({ projectId: '', agentId: '', cli: 'codex', model: null, workspaceId: null }),
      ensureMandalaConversation(store, config),
    ];
    for (const chat of chats) for (let i = 1; i <= 25; i++) {
      const runId = 'history-' + i;
      store.appendEvent(chat.id, 'user', { text: 'History request ' + i, runId });
      store.appendEvent(chat.id, 'text', { text: 'History answer ' + i, runId });
      store.appendEvent(chat.id, 'status', { status: 'idle', runId });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ordinary: chats[0].id, mandala: chats[1].id }));
    return;
  }
  if(req.method==='POST'&&req.url==='/__test__/mandala-proposal'){
    const {ensureMandalaConfig}=await import('../../server/config'),{ensureMandalaConversation}=await import('../../server/mandala');
    const {config}=await ensureMandalaConfig(home),chat=ensureMandalaConversation(store,config);
    const event=store.appendEvent(chat.id,'user',{text:'请建议一个资料整理助手',invocationId:'fixture-proposal'});
    const proposal=await manager.coordination.configure({agentId:chat.agentId,conversationId:chat.id,invocationId:'fixture-proposal',humanEventId:event.id},{kind:'agent',action:'create',values:{id:'proposal-helper-'+event.id,name:'资料整理助手',instructions:'整理资料并明确报告可验证结果。',defaultCli:'codex',models:{},mcp:[],skills:[]}},'propose','fixture-proposal-'+event.id,()=>{});
    store.appendEvent(chat.id,'status',{status:'idle'});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(proposal));return;
  }
  if(await deliverableFixture(req,res,home,store))return;
  if(await progressFixture(req,res,store,manager,home,native))return;
  if (req.method === 'POST' && req.url === '/__test__/execution-directory') {
    const directory = mkdtempSync(join(home, 'execution-'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ directory }));
    return;
  }
  if(await wikiFixture(req,res,home,store,manager.knowledgeBase))return;
  if(await skillFixture(req,res,home,store))return;
  if(req.method==='POST'&&req.url==='/__test__/message-finish'){
    let body='';for await(const chunk of req)body+=chunk;const {messageId,text}=JSON.parse(body);
    const message=manager.getAgentMessage(messageId),chat=store.getConversation(message.targetConversationId)!,options=native.get(chat.nativeId!)!;
    if(!options||!chat.turnId){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Native message turn is not ready'}));return;}
    options.onEvent({method:'item/completed',params:{threadId:chat.nativeId,turnId:chat.turnId,item:{id:'message-final',type:'agentMessage',phase:'final_answer',text}}});
    options.onEvent({method:'turn/completed',params:{threadId:chat.nativeId,turn:{id:chat.turnId,status:'completed'}}});
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;
  }
  if(await personalChatFixture(req,res,store))return;
  if(await taskFixture(req,res,home,store,manager,native))return;
  if(vite&&!req.url?.startsWith('/api/')&&!req.url?.startsWith('/auth/'))vite.middlewares(req,res);else apiServer.emit('request',req,res);
});
server.listen(Number(productEnv('E2E_PORT') ?? 4318), "127.0.0.1");
process.on("SIGTERM", async () => {
  automations.close();
  systemTasks.close();
  await manager.close();
  await memoryRuntime.close();
  server.closeAllConnections();
  server.close(async () => {
    await vite?.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
});
