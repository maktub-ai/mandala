import {COMMANDS} from '../cli/commands.mjs';
import {linkedCapabilities} from '../shared/catalog';
import {managedChangeFields} from '../shared/mandala-coordination';
import {projectIcons} from '../shared/identity';
import {effectiveRuntime,enabledRuntimes,runtimeIds} from '../shared/runtimes';
import type {Agent,Config,Project} from '../shared/types';
import {resolveCapabilities} from './capabilities';
import {DomainError} from '../shared/workspace-contracts';

// Configuration metadata only. Do not serialize owners, capability definitions or native settings.
export function mandalaDirectory(config:Config) {
 const enabled=enabledRuntimes(config),executors=config.agents.filter(a=>!a.systemRole);
 const references=(owner:Agent|Project)=>({connectionIds:owner.connectionIds??[],skillIds:owner.skillIds??[],disabledConnectionIds:owner.disabledConnectionIds??[],disabledSkillIds:owner.disabledSkillIds??[],directBindings:{skills:owner.skills.map(s=>s.name),mcp:owner.mcp.map(m=>m.name)}});
 const bindings=config.agents.flatMap(agent=>[undefined,...config.projects.filter(p=>p.agentIds.includes(agent.id))].map(project=>{
  const resolved=resolveCapabilities({...project,...(project?linkedCapabilities(config,project):{mcp:[],skills:[]})} as Project,{...agent,...linkedCapabilities(config,agent)},{mcp:[],skills:[]});
  const metadata=(items:typeof resolved.mcp|typeof resolved.skills)=>items.map(({name,source,status})=>({name,source,status}));
  return {agentId:agent.id,projectId:project?.id??null,mcp:metadata(resolved.mcp),skills:metadata(resolved.skills)};
 }));
 const coordinator=config.agents.find(a=>a.id===config.mandala?.agentId&&a.systemRole==='mandala');
 return {
  registeredRuntimes:[...(config.runtimes??[])],
  runtimes:runtimeIds.map(id=>({id,enabled:config.runtimes?.includes(id)??false,availability:'unverified' as const})),
  coordinator:coordinator?{id:coordinator.id,name:coordinator.name,cli:coordinator.defaultCli,models:coordinator.models,maxParallel:config.mandala!.maxParallel}:null,
  projects:config.projects.map(p=>({id:p.id,name:p.name,icon:p.icon??null,emoji:p.emoji??null,backgroundConfigured:!!p.background?.trim(),cwd:p.cwd,workspaces:(p.workspaces??[]).map(w=>({id:w.id,name:w.name,cwd:w.cwd})),agentIds:p.agentIds,available:!p.archivedAt,...references(p)})),
  agents:executors.map(a=>({id:a.id,name:a.name,instructionsConfigured:!!a.instructions.trim(),cli:a.defaultCli,models:a.models,maxParallel:a.maxParallel??3,temporary:a.temporary??false,available:!a.archivedAt&&enabled.includes(a.defaultCli),projectIds:config.projects.filter(p=>p.agentIds.includes(a.id)).map(p=>p.id),...references(a)})),
  connections:(config.connections??[]).map(c=>({id:c.id,name:c.name,transport:c.transport,state:'configured' as const})),
  skills:(config.skillLibrary??[]).map(s=>({id:s.id,name:s.name,available:!s.unavailable})),
  bindings,
  commands:COMMANDS.filter(c=>c.boundTool).map(c=>({name:c.name,fields:c.boundFields??[]})),
  management:{command:'mandala configure',fields:managedChangeFields,actions:{agent:['create','update','archive','promote'],project:['create','update','archive']},
   projectIcons,
   createRequired:{agent:['id','name','instructions','defaultCli','models','mcp','skills'],project:['id','name','cwd','agentIds','resources','mcp','skills']},
   example:{change:{kind:'agent',action:'update',id:'<agent-id>',values:{name:'<new name>'}},mode:'direct'},
   uiOnly:['Mandala identity, soul, runtime/model and concurrency','Enabled runtimes and global runtime defaults','Global system tasks, memory generation/reading preferences and response style','Agent routing remits (owner Settings only)','Direct global connection editing/removal and library installation/removal','Native runtime login and credentials'],
   policy:'Direct requires an explicit request in the current human turn. Proactive changes require propose and human approval; promotion always requires approval. Delete means archive. System identity remains protected.'},
  limits:'Directory paths and memberships are metadata, never filesystem or memory access. Bindings are configured selections, not live tool health; native tool inventory and login are unverified. Command inventory is the bound CLI schema, not an access grant: consult invocation availability and each command ACL. No raw config, secrets, private instructions, memory, messages or resource contents are returned. Use the exact current invocation launcher and --help; config get/put are not bound tools.',
 };
}

export function mandalaDirectorySummary(config:Config) {
 const agents=config.agents.filter(a=>!a.systemRole&&!a.archivedAt),projects=config.projects.filter(p=>!p.archivedAt);
 return {enabledRuntimes:[...(config.runtimes??[])],registeredRuntimes:[...(config.runtimes??[])],agentCount:agents.length,projectCount:projects.length,
  agents:agents.slice(0,10).map(a=>({id:a.id,name:a.name.slice(0,120),cli:a.defaultCli})),
  projects:projects.slice(0,10).map(p=>({id:p.id,name:p.name.slice(0,120)})),
  truncated:agents.length>10||projects.length>10,refresh:'mandala directory'};
}

const routingTokens=(value:string)=>{
 const tokens=new Set<string>();
 for(const match of value.normalize('NFKC').toLowerCase().matchAll(/\p{Script=Han}+|[\p{L}\p{N}]+/gu)){
  const word=match[0];
  if(/\p{Script=Han}/u.test(word)){
   const chars=Array.from(word);
   if(chars.length===1)tokens.add(word);
   for(let i=1;i<chars.length;i++)tokens.add(chars[i-1]+chars[i]);
  }else if(word.length>1)tokens.add(word);
 }
 return tokens;
};

export function mandalaRoutingDirectory(config:Config,input:{query?:unknown;projectId?:unknown}) {
 const {query,projectId}=input;
 if(typeof query!=='string'||!query.trim()||query.length>200||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(query)||
    projectId!=null&&(typeof projectId!=='string'||!projectId||projectId.length>100))
  throw new DomainError('invalid_tool_arguments',422,'Provide a short routing query and optional project ID');
 const unbound=projectId===null;
 const projects=unbound?[]:config.projects.filter(p=>!p.archivedAt&&(projectId===undefined||p.id===projectId));
 if(projectId!=null&&!projects.length)throw new DomainError('project_not_found',404,'Project is not available for routing');
 const enabled=enabledRuntimes(config),queryTokens=routingTokens(query);
 const ordered=config.agents.flatMap(agent=>{
  if(agent.systemRole||agent.id===config.mandala?.agentId||agent.temporary||agent.archivedAt||
     !enabled.includes(agent.defaultCli)||
     effectiveRuntime(agent.defaultCli,agent.runtime,config.runtimeDefaults).gateway==='unavailable')return [];
  const membership=projects.filter(p=>p.agentIds.includes(agent.id)).map(p=>p.id).sort();
  if(!unbound&&!membership.length)return [];
  const routingRemit=agent.routingRemit?.trim()||null;
  const score=routingRemit?[...routingTokens(routingRemit)].filter(word=>queryTokens.has(word)).length:0;
  return [{score,id:agent.id,name:agent.name.slice(0,120),projectIds:membership.slice(0,20),routingRemit,
    evidence:score>0?'keyword_overlap' as const:'no_keyword_overlap' as const,readiness:'unverified' as const}];
 }).sort((a,b)=>b.score-a.score||Number(!!b.routingRemit)-Number(!!a.routingRemit)||(a.id<b.id?-1:a.id>b.id?1:0));
 return {scope:unbound?'unbound' as const:projectId===undefined?'projects' as const:'project' as const,projectId:projectId??null,eligibleCount:ordered.length,truncated:ordered.length>12,
  candidates:ordered.slice(0,12).map(({score,...candidate})=>candidate),
  note:'Keyword overlap is only evidence; compare remits by meaning. No keyword evidence is not proof of no fit. Lookup is not authorization or a launch guarantee; a request can be queued before its runtime is available.'};
}
