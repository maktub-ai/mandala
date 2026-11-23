import {expect,it} from 'vitest';
import {mandalaDirectory,mandalaRoutingDirectory} from '../server/mandala-directory';
import {mandalaInstructions} from '../server/mandala';
import {validateConfig} from '../server/config';
import {COMMANDS} from '../cli/commands.mjs';
import {projectIcons} from '../shared/identity';
import type {Config,Conversation} from '../shared/types';
it('does not label legacy execution defaults as registered discovery sources',()=>{
 const directory=mandalaDirectory({version:2,projects:[],agents:[]});
 expect(directory.registeredRuntimes).toEqual([]);
 expect(mandalaDirectory({...config,runtimes:['claude']}).registeredRuntimes).toEqual(['claude']);
});
const config:Config={version:2,runtimes:['codex','gemini'],mandala:{agentId:'main',soul:'Preference',maxParallel:2},
 agents:[{id:'main',name:'Mandala',systemRole:'mandala',instructions:'PRIVATE',defaultCli:'codex',models:{},mcp:[],skills:[]},
 {id:'worker',name:'Researcher',instructions:'PRIVATE INSTRUCTIONS',defaultCli:'gemini',models:{gemini:'chosen'},mcp:[],skills:[],connectionIds:['c'],skillIds:['s'],runtime:{gemini:{env:{SECRET:'${PRIVATE_REFERENCE}'},args:['PRIVATE_ARG']}}}],
 projects:[{id:'p',name:'Research',cwd:'/project',agentIds:['worker'],resources:[{id:'r',label:'Private resource',kind:'local',location:'/PRIVATE_RESOURCE'}],mcp:[],skills:[],connectionIds:['override'],background:'PRIVATE BACKGROUND'}],
 connections:[{id:'c',name:'Research tool',transport:'http',url:'https://SECRET_URL',env:{SECRET:'${PRIVATE_REFERENCE}'}},{id:'override',name:'Research tool',transport:'stdio',command:'PRIVATE_COMMAND',args:['PRIVATE_ARG']}],
 skillLibrary:[{id:'s',name:'Research skill',path:'/PRIVATE_PATH',content:'PRIVATE CONTENT'}]};
it('reports explicit configuration metadata and effective bindings without exposing private definitions',()=>{
 const directory=mandalaDirectory(config);
 expect(directory.runtimes).toContainEqual({id:'gemini',enabled:true,availability:'unverified'});
 expect(directory.projects[0]).toMatchObject({id:'p',cwd:'/project',agentIds:['worker']});
 expect(directory.agents[0]).toMatchObject({id:'worker',models:{gemini:'chosen'},projectIds:['p']});
 expect(directory.bindings.find(b=>b.projectId==='p')).toMatchObject({agentId:'worker',mcp:[{name:'Research tool',source:'project',status:'unverified'}],skills:[{name:'Research skill',source:'agent',status:'unverified'}]});
 expect(directory.management.fields.agent).toContain('models');
 expect(directory.management.fields.project).toContain('agentIds');
 expect(directory.management.uiOnly).toContain('Mandala identity, soul, runtime/model and concurrency');
 expect(directory.commands).toEqual(COMMANDS.filter(c=>c.boundTool).map(c=>({name:c.name,fields:c.boundFields??[]})));
 expect(JSON.stringify(directory)).not.toMatch(/PRIVATE|SECRET/);
});
it('provides a bounded, current coordinator introduction without granting directory access',()=>{
 const many={...config,agents:[config.agents[0],...Array.from({length:100},(_,i)=>({...config.agents[1],id:'worker-'+i,name:'N'.repeat(2000)}))]};
 const text=mandalaInstructions(many,{agentId:'main',purpose:'mandala-main'} as Conversation);
 expect(text).toContain("user's system coordinator");expect(text).toContain('Before asking the user to restate');
 expect(text).toContain('MANDALA_DIRECTORY_SUMMARY_JSON');expect(text.length).toBeLessThan(14000);
 expect(text).not.toContain('PRIVATE');expect(text).toContain('metadata, never filesystem or memory access');
 config.agents[1].name='Renamed researcher';
 expect(mandalaInstructions(config,{agentId:'main'} as Conversation)).toContain('Renamed researcher');
});

it('exposes configuration completeness and valid icons without exposing private content',()=>{
 const incomplete=mandalaDirectory({...config,projects:[{...config.projects[0],background:'  ',skills:[{name:'project-skill',path:'/PRIVATE_PACKAGE'}]}],agents:config.agents.map(a=>a.systemRole?a:{...a,instructions:'\n',skills:[{name:'module-skill',path:'/PRIVATE_PACKAGE'}]})});
 expect(incomplete.projects[0]).toMatchObject({icon:null,backgroundConfigured:false,directBindings:{skills:['project-skill'],mcp:[]}});
 expect(incomplete.agents[0]).toMatchObject({instructionsConfigured:false,directBindings:{skills:['module-skill'],mcp:[]}});
 expect(incomplete.management.projectIcons).toEqual(projectIcons);
 const configured=mandalaDirectory({...config,projects:[{...config.projects[0],icon:'database'}]});
 expect(configured.projects[0]).toMatchObject({icon:'database',backgroundConfigured:true});
 expect(configured.agents[0]).toMatchObject({instructionsConfigured:true});
 expect(JSON.stringify(incomplete)+JSON.stringify(configured)).not.toMatch(/PRIVATE|SECRET/);
});

it('directs current primary hands-on work to an authorized specialist before self-work, without requiring a Task',()=>{
 const primary=mandalaInstructions(config,{agentId:'main',purpose:'mandala-main'} as Conversation);
 expect(primary).toMatch(/Before starting hands-on work, use mandala directory/);
 expect(primary).toMatch(/messages ask for a one-off investigation without creating a Task/);
 expect(primary).toMatch(/If the user explicitly asks you to do the work yourself/);
 expect(primary).toMatch(/if no suitable Agent is available/);
 expect(mandalaInstructions(config,{agentId:'main',purpose:'mandala-background'} as Conversation))
   .not.toMatch(/Before starting hands-on work, use mandala directory/);
});

it('validates remit length and single-line plain text while retaining optional legacy shape',()=>{
 const a={version:2,projects:[],agents:[{id:'test',name:'Test',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}]} as const;
 expect(()=>validateConfig(a)).not.toThrow();
 for(const routingRemit of ['界'.repeat(201),'not\nplain',{}])expect(()=>validateConfig({...a,agents:[{...a.agents[0],routingRemit}]})).toThrow();
 expect(()=>validateConfig({...a,agents:[{...a.agents[0],routingRemit:'界'.repeat(200)}]})).not.toThrow();
});

it('ranks public remit evidence before opaque fillers, not by vendor or array order',()=>{
 const worker=config.agents[1], search='排查同步失败', remit='排查同步失败、诊断后台数据';
 const a={...worker,id:'alpha',name:'Opaque Alpha',defaultCli:'codex' as const,routingRemit:remit};
 const b={...worker,id:'beta',name:'Opaque Beta',routingRemit:'UI colors and typography'};
 const filler=Array.from({length:10},(_,i)=>({...worker,id:'filler'+i,name:'Filler '+i}));
 const wrong={...a,id:'wrong'}, temp={...a,id:'temp',temporary:true}, archived={...a,id:'archived',archivedAt:'yesterday'};
 const disabled={...a,id:'disabled',defaultCli:'claude' as const};
 const off={...a,id:'offline',runtime:{codex:{gateway:'unavailable' as const}}};
 const project={...config.projects[0],agentIds:[...filler,a,b,temp,archived,disabled,off].map(x=>x.id)};
 const input={query:search,projectId:project.id};
 const scoped={...config,projects:[project],agents:[config.agents[0],...filler,a,b,wrong,temp,archived,disabled,off]};
 const result=mandalaRoutingDirectory(scoped,input);
 expect(result.eligibleCount).toBe(12);
 expect(result.candidates[0]).toMatchObject({id:a.id,routingRemit:remit,evidence:'keyword_overlap',readiness:'unverified'});
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|wrong|temp|archived|disabled|offline/);
 const reordered=mandalaRoutingDirectory({...scoped,agents:[...scoped.agents].reverse()},input);
 expect(reordered.candidates.map(x=>x.id)).toEqual(result.candidates.map(x=>x.id));
 const swapped=mandalaRoutingDirectory({...scoped,agents:scoped.agents.map(x=>x.id===a.id?{...x,routingRemit:b.routingRemit}:x.id===b.id?{...x,routingRemit:a.routingRemit}:x)},input);
 expect(swapped.candidates[0].id).toBe(b.id);
 const noMatch=mandalaRoutingDirectory(scoped,{...input,query:'snowboard'});
 expect(noMatch.candidates.length).toBeGreaterThan(0);
 expect(noMatch.candidates.every(x=>x.evidence==='no_keyword_overlap')).toBe(true);
 expect(()=>mandalaRoutingDirectory({...scoped,projects:[{...project,archivedAt:'yesterday'}]},input)).toThrow();
});

it('distinguishes explicit unbound routing from an omitted Project filter',()=>{
 const agent={...config.agents[1],id:'unbound',routingRemit:'Database reconciliation'};
 const model={...config,agents:[...config.agents,agent]};
 const unbound=mandalaRoutingDirectory(model,{query:'Database',projectId:null});
 expect(unbound.scope).toBe('unbound');
 expect(unbound.candidates).toEqual(expect.arrayContaining([expect.objectContaining({id:'unbound',projectIds:[]}),expect.objectContaining({id:'worker',projectIds:[]})]));
 const discover=mandalaRoutingDirectory(model,{query:'Database'});
 expect(discover.scope).toBe('projects');
 expect(discover.candidates).toEqual([expect.objectContaining({id:'worker',projectIds:['p']})]);
});
