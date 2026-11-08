import {COMMANDS} from '../cli/commands.mjs';
import {linkedCapabilities} from '../shared/catalog';
import {managedChangeFields} from '../shared/mandala-coordination';
import {projectIcons} from '../shared/identity';
import {enabledRuntimes,runtimeIds} from '../shared/runtimes';
import type {Agent,Config,Project} from '../shared/types';
import {resolveCapabilities} from './capabilities';

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
   uiOnly:['Mandala identity, soul, runtime/model and concurrency','Enabled runtimes and global runtime defaults','Global system tasks, memory generation/reading preferences and response style','Direct global connection editing/removal and library installation/removal','Native runtime login and credentials'],
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
