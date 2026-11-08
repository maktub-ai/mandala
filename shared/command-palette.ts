import type { Config, Conversation } from './types';
import type { WorkbenchSnapshot } from './workbench';

export type WorkspaceSearchResult = {kind:'conversation'|'task'|'project'|'agent'|'asset'|'memory';id:string;title:string;snippet:string;href:string};
export type PaletteAction =
 | {type:'new-chat';projectId?:string;agentId?:string}
 | {type:'model';conversationId:string;model:string|null}
 | {type:'terminal';conversationId:string}
 | {type:'stop';conversationId:string}
 | {type:'theme'};
export type PaletteContext = {conversation?:Conversation|null;projectId?:string;agentId?:string;taskId?:string;navigationLocked?:boolean};
export type PaletteCommand = {id:string;label:[string,string];keywords:string;target?:'task'|'agent'};
export const paletteCommands:PaletteCommand[] = [
 {id:'usage',label:['查看用量','View usage'],keywords:'usage token 用量 统计 导航'},
 {id:'conversations',label:['打开对话','Open conversations'],keywords:'聊天 chat conversation 导航'},
 {id:'tasks',label:['打开任务','Open tasks'],keywords:'task 目标 导航'},
 {id:'projects',label:['打开项目设置','Open project settings'],keywords:'project 项目 导航'},
 {id:'agents',label:['打开智能体设置','Open Agent settings'],keywords:'agent 智能体 配置 导航'},
 {id:'assets',label:['打开资料库','Open library'],keywords:'asset document file 文档 资料 文件 导航'},
 {id:'memory',label:['查看记忆','View memory'],keywords:'memory 记忆 导航'},
 {id:'skills',label:['查看 Skill','View Skills'],keywords:'skill 技能 草稿 导航'},
 {id:'new-chat',label:['开始新对话','Start new chat'],keywords:'新建 创建 聊天 对话 new conversation'},
 {id:'model',label:['切换当前对话模型','Change current chat model'],keywords:'switch model 切换 模型'},
 {id:'task-create',label:['创建任务','Create task'],keywords:'new task 新建 创建 目标'},
 {id:'task-edit',label:['编辑任务','Edit task'],keywords:'edit task 修改 编辑',target:'task'},
 {id:'task-link',label:['设为执行对话','Set execution Chat'],keywords:'task link execution chat conversation 关联 执行 任务 对话',target:'task'},
 {id:'task-subtask',label:['添加子任务','Add subtask'],keywords:'task child subtask 添加 子任务',target:'task'},
 {id:'task-review',label:['打开任务验收','Open task review'],keywords:'task review accept 验收 审核 确认',target:'task'},
 {id:'agent-runs',label:['查看智能体执行','View Agent runs'],keywords:'agent execution runs 执行 工作',target:'agent'},
 {id:'agent-config',label:['配置智能体','Configure Agent'],keywords:'agent settings config 配置 设置',target:'agent'},
 {id:'terminal',label:['打开当前对话终端','Open current chat terminal'],keywords:'terminal 终端'},
 {id:'stop',label:['停止指定对话执行','Stop a conversation execution'],keywords:'stop 停止 执行'},
 {id:'theme',label:['切换深浅主题','Toggle light and dark theme'],keywords:'theme appearance dark light 主题 深色 浅色'},
];
export const normalizePaletteText=(text:string)=>text.normalize('NFKC').toLowerCase().trim();
export function parsePaletteQuery(text:string):{mode:'commands'|'objects'|'help';query:string} {
 const normalized=normalizePaletteText(text);
 return normalized.startsWith('?')?{mode:'help',query:normalized.slice(1).trim()}:normalized.startsWith('>')?{mode:'commands',query:normalized.slice(1).trim()}:{mode:'objects',query:normalized};
}
export function matchPaletteCommands(query:string):PaletteCommand[] {
 const terms=normalizePaletteText(query).split(/\s+/).filter(Boolean);
 return paletteCommands.filter(command=>{const haystack=normalizePaletteText([...command.label,command.keywords].join(' '));return terms.every(term=>haystack.includes(term));});
}
export function paletteCommandUnavailable(id:string,context:PaletteContext):'locked'|'conversation'|'running'|null {
 if(context.navigationLocked&&id!=='theme')return 'locked';
 if(['model','terminal'].includes(id)&&!context.conversation)return 'conversation';
 if(id==='model'&&['running','approval'].includes(context.conversation?.status??''))return 'running';
 return null;
}
export function preselectPaletteTarget(items:{id:string}[],id?:string):number {const index=items.findIndex(item=>item.id===id);return index>=0?index:items.length?0:-1;}
export function createPaletteRequestGate(){let revision=0;return {next:()=>++revision,isCurrent:(value:number)=>value===revision};}
export function paletteKeyIntent(event:{key:string;isComposing?:boolean;keyCode?:number;metaKey?:boolean;ctrlKey?:boolean;altKey?:boolean}):'execute'|'next'|'previous'|'back'|null {
 if(event.isComposing||event.keyCode===229||event.metaKey||event.ctrlKey||event.altKey)return null;
 return event.key==='Enter'?'execute':event.key==='ArrowDown'?'next':event.key==='ArrowUp'?'previous':event.key==='Escape'?'back':null;
}
export function recentPaletteCommands(value:unknown):string[] {
 return Array.isArray(value)?[...new Set(value.filter((id):id is string=>typeof id==='string'&&paletteCommands.some(c=>c.id===id)))].slice(0,6):[];
}

export function stoppablePaletteTargets(snapshot:WorkbenchSnapshot,config:Config,query:string):WorkspaceSearchResult[] {
 const terms=normalizePaletteText(query).split(/\s+/).filter(Boolean),targets=new Map<string,WorkspaceSearchResult>();
 for(const agent of snapshot.agents)for(const execution of agent.executions){
  if(!execution.accessible||!execution.conversationId||!execution.href||!['running','approval'].includes(execution.state))continue;
  const id=execution.conversationId,title=execution.title||'未命名对话';
  const snippet=[config.projects.find(project=>project.id===execution.projectId)?.name,config.agents.find(agent=>agent.id===execution.agentId)?.name,execution.state].filter(Boolean).join(' · ');
  const text=normalizePaletteText([id,title,snippet].join(' '));
  if(terms.every(term=>text.includes(term)))targets.set(id,{kind:'conversation',id,title:Array.from(title.replace(/\s+/g,' ').trim()).slice(0,120).join(''),snippet,href:execution.href});
 }
 return [...targets.values()].slice(0,60);
}
