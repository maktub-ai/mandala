import {expect,it} from 'vitest';
import {mandalaDirectory} from '../server/mandala-directory';
import {mandalaInstructions} from '../server/mandala';
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
