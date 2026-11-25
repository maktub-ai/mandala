import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {BlueprintRoute,RouteProject,RouteReview} from '../shared/blueprint-routing';
import {enabledRuntimes,supportsSystemTasks} from '../shared/runtimes';
import type {Task,TaskInput} from '../shared/tasks';
import {DomainError} from '../shared/workspace-contracts';
import {createBlueprintService} from './blueprint';
import {readConfig} from './config';
import type {CoordinationSource} from './mandala-coordination';
import type {Store} from './store';
import {nativeGenerate,type SystemGenerator} from './system-tasks';
import {validateTaskConfiguration} from './task-input';
import type {createTasks} from './tasks';
import {workspacePrincipal} from './workspace-identity';

type Source=Omit<CoordinationSource,'assertActive'>&{managed:boolean};
type Stored={input:TaskInput; source:Source|null; review:RouteReview};
const conflict=()=>new DomainError('route_review_conflict',409,'The route changed. Review the project, module and observer.');
function valid(choice:BlueprintRoute,projects:RouteProject[]) {
  if(!choice||Object.keys(choice).sort().join(',')!=='assigneeAgentId,lane,projectId')return false;
  if(choice.projectId===null)return choice.lane===null&&choice.assigneeAgentId===null;
  const p=projects.find(item=>item.id===choice.projectId);
  return !!p&&(choice.lane===null||p.modules.includes(choice.lane))&&(choice.assigneeAgentId===null||p.observers.some(a=>a.id===choice.assigneeAgentId));
}
export function createBlueprintRouting(home:string,store:Store,tasks:ReturnType<typeof createTasks>,onOwned:(source:Source,task:Task)=>void,generate:SystemGenerator=nativeGenerate){
  const db=store.database,root=workspacePrincipal(store),blueprint=createBlueprintService(home);
  db.exec('CREATE TABLE IF NOT EXISTS blueprint_route_reviews(id TEXT PRIMARY KEY, command_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
  function load(id:string):Stored{
    const row=db.prepare('SELECT data FROM blueprint_route_reviews WHERE id=?').get(id);
    if(!row)throw new DomainError('route_review_missing',404,'Task creation suggestion not found');
    return JSON.parse(row.data as string);
  }
  async function options(input:Pick<TaskInput,'projectId'>){
    const {config}=await readConfig(home),projects=config.projects.filter(p=>!p.archivedAt);
    const enabled=(p:typeof projects[number])=>p.blueprintEnabled??config.blueprintDefaultEnabled??false;
    const scoped=input.projectId?projects.filter(p=>p.id===input.projectId):projects;
    if(!scoped.some(enabled))return {config,projects:[],ready:[]};
    const ready:string[]=[];
    const choices=await Promise.all(projects.map(async p=>{
      let modules:string[]=[];
      if(enabled(p)){
        const state=await blueprint.state(p.id);
        if(state.status==='ready'&&state.summary){ready.push(p.id);modules=state.summary.modules.map(m=>m.lane);}
      }
      return {id:p.id,name:p.name,modules,observers:config.agents.filter(a=>!a.archivedAt&&!a.systemRole&&!a.temporary&&p.agentIds.includes(a.id)).map(({id,name})=>({id,name}))};
    }));
    return {config,projects:choices,ready};
  }
  async function preview(input:TaskInput,key:string,source:Source|null=null,assertActive?:()=>void):Promise<RouteReview|null>{
    if(!key||key.length>230)throw new DomainError('invalid_command_key',422,'Invalid request key');
    const command=JSON.stringify([source?.conversationId,source?.managed,key]);
    const previous=()=>{
      const row=db.prepare('SELECT data FROM blueprint_route_reviews WHERE command_key=?').get(command);
      if(!row)return null;
      const saved=JSON.parse(row.data as string) as Stored;
      if(!isDeepStrictEqual(saved.input,input))throw conflict();
      return saved.review;
    };
    const prior=previous();if(prior)return prior;
    const {config,projects,ready}=await options(input);
    const candidates=projects.filter(p=>ready.includes(p.id)&&(!input.projectId||input.projectId===p.id));
    if(!candidates.length)return null;
    validateTaskConfiguration(config,input);
    tasks.prepareCreate(source?{...root,agentId:source.agentId}:root,input,key);
    const goal=input.goal.toLowerCase(),score=(s:string)=>goal.includes(s.toLowerCase())?s.length:0;
    const ranked=[...candidates].sort((a,b)=>Math.max(score(b.name),...b.modules.map(score))-Math.max(score(a.name),...a.modules.map(score)));
    const project=ranked[0];
    const lane=[...project.modules].sort((a,b)=>score(b)-score(a))[0];
    const observer=project.observers.find(a=>a.id===input.assigneeAgentId)||project.observers.find(a=>score(a.name))||(project.observers.length===1?project.observers[0]:undefined);
    let suggestion:BlueprintRoute={projectId:project.id,lane:lane&&(score(lane)||project.modules.length===1)?lane:null,assigneeAgentId:observer?.id??null};
    const coordinator=config.agents.find(a=>a.id===config.mandala?.agentId&&a.systemRole==='mandala'&&!a.archivedAt);
    const cli=coordinator?.defaultCli??config.system?.cli;
    if(cli&&enabledRuntimes(config).includes(cli)&&supportsSystemTasks(cli)){
      try{
        const raw=await generate({cli,model:coordinator?.models[cli]??config.system?.model,runtimeDefaults:config.runtimeDefaults},
          'Act as the task coordinator. Recommend a project, module and responsible observer from these blueprint options. Respect explicit choices. Return only JSON {"projectId":string,"lane":string|null,"assigneeAgentId":string|null}. Use only listed values. SOURCE_JSON:\n'+JSON.stringify({goal:input.goal,criteria:input.criteria?.map(c=>c.text),requestedObserver:input.assigneeAgentId,projects:candidates}),AbortSignal.timeout(15000));
        const selection=JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
        if(selection?.projectId&&valid(selection,candidates))suggestion=selection;
      }catch{/* Local blueprint matches remain available when generation is offline. */}
    }
    assertActive?.();
    return store.transaction(()=>{
      const existing=previous();if(existing)return existing;
      const review:RouteReview={id:randomUUID(),goal:input.goal,projects,suggestion,status:'pending',selection:null,matched:null,taskId:null};
      db.prepare('INSERT INTO blueprint_route_reviews VALUES (?,?,?)').run(review.id,command,JSON.stringify({input,source,review}));
      if(source)store.appendEvent(source.conversationId,'metadata',{blueprintRouteReview:review.id,sourceEventId:source.humanEventId??null,invocationId:source.invocationId});
      return review;
    });
  }
  async function decide(id:string,selection:BlueprintRoute|null){
    const initial=load(id);
    if(initial.review.status==='pending'&&selection){
      if(!valid(selection,initial.review.projects))throw conflict();
      const {config,projects}=await options({});
      const p=config.projects.find(p=>p.id===selection.projectId&&!p.archivedAt);
      if(selection.projectId&&(!p||selection.lane&&!projects.find(v=>v.id===p.id)?.modules.includes(selection.lane)||selection.assigneeAgentId&&!config.agents.some(a=>a.id===selection.assigneeAgentId&&!a.archivedAt&&!a.systemRole&&!a.temporary&&p.agentIds.includes(a.id))))throw conflict();
      if(initial.source&&!config.agents.some(a=>a.id===initial.source!.agentId&&a.systemRole==='mandala'&&config.mandala?.agentId===a.id))throw conflict();
      validateTaskConfiguration(config,{...initial.input,projectId:selection.projectId,assigneeAgentId:selection.assigneeAgentId});
    }
    return store.transaction(()=>{
      const saved=load(id),{source,input,review}=saved;
      if(review.status!=='pending'){
        if(!isDeepStrictEqual(review.selection,selection))throw conflict();
        return review;
      }
      if(selection){
        const {projectId,lane,assigneeAgentId}=selection;
        const principal=source?{...root,agentId:source.agentId}:root;
        const chat=source&&store.getConversation(source.conversationId);
        if(source&&!chat)throw conflict();
        const sourceChat=chat&&(source?.managed?chat.purpose!=='mandala-main':!input.originConversationId||input.originConversationId===chat.id)?chat.id:undefined;
        const moduleRef=projectId&&lane?{projectId,lane}:null;
        let task=tasks.prepareCreate(principal,{...input,projectId,assigneeAgentId,...(!source?{moduleRef}:{})},id,undefined,sourceChat).commit();
        if(source&&moduleRef)task=tasks.prepareUpdate(root,task.id,task.revision,{moduleRef},id+':module').commit();
        if(source?.managed)onOwned(source,task);
        review.taskId=task.id;review.status='confirmed';review.selection=selection;review.matched=isDeepStrictEqual(review.suggestion,selection);
      }else review.status='dismissed';
      db.prepare('UPDATE blueprint_route_reviews SET data=? WHERE id=?').run(JSON.stringify(saved),id);
      if(source)store.appendEvent(source.conversationId,'metadata',{blueprintRouteDecision:id,status:review.status,taskId:review.taskId});
      return review;
    });
  }
  async function readForChat(id:string,conversationId:string){
    const {config}=await readConfig(home),chat=store.getConversation(conversationId);
    const {source,review}=load(id);
    if(!source||chat?.purpose!=='mandala-main'||chat.agentId!==config.mandala?.agentId||
       source.conversationId!==chat.id||source.agentId!==chat.agentId){
      throw new DomainError('route_review_missing',404,'Task creation suggestion not found');
    }
    return review;
  }
  async function decideForChat(id:string,conversationId:string,choice:BlueprintRoute|null){
    await readForChat(id,conversationId);
    return decide(id,choice);
  }
  return {preview,read:(id:string)=>load(id).review,decide,readForChat,decideForChat};
}
