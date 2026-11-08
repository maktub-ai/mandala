import { workspacePrincipal } from './workspace-identity';
import type { Config } from '../shared/types';
import { normalizePaletteText, type WorkspaceSearchResult } from '../shared/command-palette';
import { DomainError } from '../shared/workspace-contracts';
import { groupChatTurns } from '../shared/chat-turns';
import type { Store } from './store';
import type { SessionManager } from './sessions';
import type { MemoryRuntime } from './memory-runtime';
import { memoryServices } from './memory-runtime';
import { createAssets } from './assets';
import { createAssetFiles } from './asset-files';

export async function searchWorkspace({home,store,manager,config,memoryRuntime,query,kind}:{home:string;store:Store;manager:SessionManager;config:Config;memoryRuntime?:MemoryRuntime;query:string;kind?:WorkspaceSearchResult['kind']}):Promise<WorkspaceSearchResult[]> {
 if(typeof query!=='string'||query.length>2000)throw new DomainError('invalid_query',422,'Search query must be at most 2000 characters');
 if(kind!==undefined&&!['conversation','task','project','agent','asset','memory'].includes(kind))throw new DomainError('invalid_query',422,'Invalid search kind');
 const terms=normalizePaletteText(query).split(/\s+/).filter(Boolean),result:WorkspaceSearchResult[]=[],p=workspacePrincipal(store);
 const matches=(...parts:(string|null|undefined)[])=>{const text=normalizePaletteText(parts.filter(Boolean).join('\n'));return terms.every(term=>text.includes(term));};
 const compact=(text:string)=>Array.from(text.replace(/\s+/g,' ').trim()).slice(0,120).join('');
 const allowed=(read:()=>void)=>{try{read();return true;}catch(error){if(error instanceof DomainError&&[403,404,409].includes(error.status))return false;throw error;}};
 if(kind===undefined||kind==='conversation')for(const chat of store.listConversations()){
  if(chat.archivedAt||!allowed(()=>manager.authorizeConversationRead(chat.id)))continue;
  const project=config.projects.find(item=>item.id===chat.projectId)?.name,agent=config.agents.find(item=>item.id===chat.agentId)?.name;
  const title=chat.title||'未命名对话',snippet=[project,agent].filter(Boolean).join(' · ');
  let match=matches(title,chat.id,project,agent);
  if(!match&&terms.length){const messages=groupChatTurns(store.listEvents(chat.id,0)).flatMap(turn=>turn.messages).filter(message=>message.kind!=='error').map(message=>message.text);match=matches(title,chat.id,project,agent,...messages);}
  if(match)result.push({kind:'conversation',id:chat.id,title:compact(title),snippet:compact(snippet),href:'/?conversation='+encodeURIComponent(chat.id)+(chat.projectId?'&project='+encodeURIComponent(chat.projectId):'')});
 }
 if(kind===undefined||kind==='task')for(const listed of manager.taskService.listTasks(p)){
  // The task control record alone does not prove that its source content is readable.
  if(!allowed(()=>{const runs=manager.taskService.listRuns(p,listed.id);for(const run of runs)manager.taskService.getContextSnapshot(p,run.id);}))continue;
  const task=manager.taskService.getTask(p,listed.id),project=config.projects.find(item=>item.id===task.projectId)?.name,agent=config.agents.find(item=>item.id===task.assigneeAgentId)?.name;
  if(matches(task.goal,task.id,project,agent))result.push({kind:'task',id:task.id,title:compact(task.goal.split('\n')[0]),snippet:compact([project,agent,task.state].filter(Boolean).join(' · ')),href:'/tasks/'+encodeURIComponent(task.id)});
 }
 if(kind===undefined||kind==='project')for(const project of config.projects)if(matches(project.name,project.id))result.push({kind:'project',id:project.id,title:project.name,snippet:'项目 · Project',href:'/projects/'+encodeURIComponent(project.id)+'/workbench'});
 if(kind===undefined||kind==='agent')for(const agent of config.agents)if(matches(agent.name,agent.id))result.push({kind:'agent',id:agent.id,title:agent.name,snippet:'Agent',href:'/settings/agents?agent='+encodeURIComponent(agent.id)});
 if(kind===undefined||kind==='asset'){
 const assets=createAssets(store,createAssetFiles(home));
 for(const asset of assets.listAssets(p)){
  if(asset.kind==='memory_collection'||!allowed(()=>{if(asset.headVersionId)assets.getAuthorizedVersion(p,{assetId:asset.id,versionId:asset.headVersionId});}))continue;
  if(matches(asset.title,asset.id,asset.kind))result.push({kind:'asset',id:asset.id,title:compact(asset.title),snippet:asset.kind,href:'/assets/'+encodeURIComponent(asset.id)});
 }
 }
 if(kind===undefined||kind==='memory'){
 const memory=memoryRuntime?.memory??memoryServices(home,store,(_principal,id)=>manager.authorizeConversationRead(id)).memory;
 for(const record of memory.listAll(p).filter(item=>['active','proposed'].includes(item.status))){
  if(matches(record.text,record.recordId,record.legacy?.title))result.push({kind:'memory',id:record.recordId,title:compact(record.legacy?.title??record.text),snippet:compact(record.layer+' · '+record.status),href:'/mana?tab=memory&recordId='+encodeURIComponent(record.recordId)});
 }
 }
 // One shared endpoint returns a bounded metadata projection, never transcript or file content.
 return result.slice(0,60);
}
