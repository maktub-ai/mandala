import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type Store} from '../server/store';
import {createTasks} from '../server/tasks';
import {createBlueprintService} from '../server/blueprint';
import {createBlueprintRouting} from '../server/blueprint-routing';
import {createMandalaCoordination} from '../server/mandala-coordination';
import {ensureConfiguredMandala} from './configured-mandala';
import {ensureMandalaConversation} from '../server/mandala';
import {readConfig,writeConfig} from '../server/config';

let temp:string,home:string,store:Store,tasks:ReturnType<typeof createTasks>;
const input={goal:'Improve rendering output',projectId:'editor',criteria:[{id:'proof',text:'Output verified',checkRef:null}]};
const decision={projectId:'editor',lane:'Rendering',assigneeAgentId:'observer'};
beforeEach(async()=>{
 temp=await mkdtemp(join(tmpdir(),'blueprint-route-'));home=join(temp,'profile');await mkdir(home);
 vi.stubEnv('OMINO_HOME',join(temp,'plan-data'));store=openStore(home);tasks=createTasks(store);
 const {config,revision}=await readConfig(home);
 config.projects=['editor','other'].map(id=>({id,name:id,cwd:join(temp,id),agentIds:['observer'],mcp:[],skills:[],resources:[]}));
 config.agents=[{id:'observer',name:'Review',instructions:'Review rendering',defaultCli:'codex',mcp:[],skills:[],models:{}}];
 await mkdir(join(temp,'editor'));await mkdir(join(temp,'other'));await writeConfig(home,config,revision);
 const bp=createBlueprintService(home,{draft:async()=>['Rendering','Storage']});await bp.enable('editor');const d=await bp.draft('editor');await bp.confirm('editor',d.draftId,d.modules);
});
afterEach(async()=>{store.close();vi.unstubAllEnvs();await rm(temp,{recursive:true,force:true});});
it('accepts and amends recommendations, records the comparison and creates exactly one task per confirmation',async()=>{
 const generate=vi.fn(async()=>JSON.stringify(decision));
 const r=createBlueprintRouting(home,store,tasks,()=>{},generate),root={userId:store.ownerUserId};
 const review=(await r.preview(input,'new'))!;
 expect(review.suggestion).toEqual(decision);expect(tasks.listTasks(root)).toEqual([]);
 const other={...decision,lane:'Storage'};
 const [a,b]=await Promise.all([r.decide(review.id,other),r.decide(review.id,other)]);
 expect(a.taskId).toBe(b.taskId);expect(r.read(review.id)).toMatchObject({selection:other,matched:false,suggestion:decision});
 expect(tasks.listTasks(root)).toHaveLength(1);expect(tasks.getTask(root,a.taskId!)).toMatchObject({projectId:'editor',moduleRef:{projectId:'editor',lane:'Storage'},assigneeAgentId:'observer'});
 await expect(r.decide(review.id,decision)).rejects.toThrow();
 const next=(await r.preview(input,'again'))!;expect((await r.decide(next.id,decision)).matched).toBe(true);
});
it('skips disabled projects, rejects deleted modules and can dismiss without creating',async()=>{
 const r=createBlueprintRouting(home,store,tasks,()=>{},vi.fn(async()=>''));
 expect(await r.preview({...input,projectId:'other'},'off')).toBeNull();
 const review=(await r.preview(input,'pending'))!;await createBlueprintService(home).disable('editor');
 await expect(r.decide(review.id,decision)).rejects.toThrow();
 expect((await r.decide(review.id,null)).status).toBe('dismissed');
 expect(tasks.listTasks({userId:store.ownerUserId})).toHaveLength(0);
});
it('shows an opaque pending proposal in the coordinator chat and preserves task ownership after human approval',async()=>{
 const {config}=await ensureConfiguredMandala(home),chat=ensureMandalaConversation(store,config);
 // Stub the configured coordinator generator in this isolated profile.
 const gen=await import('../server/system-tasks');
 const model=vi.spyOn(gen,'nativeGenerate').mockResolvedValue(JSON.stringify(decision));
 try{
  const service=createMandalaCoordination({home,store,tasks});
  const event=store.appendEvent(chat.id,'user',{text:'Create a rendering task',invocationId:'request'});
  const source={agentId:chat.agentId,conversationId:chat.id,invocationId:'request',humanEventId:event.id};
  const response=await service.requestCreation(source,input,'create');
  expect(response).toEqual({status:'awaiting_confirmation',reviewId:expect.any(String)});
  if(!('reviewId' in response))throw Error('Missing review');
  expect(store.listEvents(chat.id,0).at(-1)?.data).toMatchObject({blueprintRouteReview:response.reviewId,sourceEventId:event.id});
  expect(service.list()).toHaveLength(0);
  const other=store.createConversation({projectId:'',agentId:chat.agentId,cli:'codex',model:null});
  await expect(service.routes.readForChat(response.reviewId,other.id)).rejects.toMatchObject({status:404});
  const form=await service.routes.preview(input,'form');
  await expect(service.routes.decideForChat(form!.id,chat.id,decision)).rejects.toMatchObject({status:404});
  expect((await service.routes.readForChat(response.reviewId,chat.id)).id).toBe(response.reviewId);
  const approved=await service.routes.decide(response.reviewId,decision);
  expect(service.ownership(approved.taskId!)).toMatchObject({agentId:chat.agentId,sourceEventId:event.id});
  expect(tasks.getTask({userId:store.ownerUserId},approved.taskId!).creatorAgentId).toBe(chat.agentId);
 }finally{model.mockRestore();}
});
