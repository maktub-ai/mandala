import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import type {Config} from '../shared/types';
import {discoverTeamCapabilities} from '../server/team-capability-discovery';

const homes:string[]=[];
afterEach(async()=>{for(const home of homes.splice(0))await rm(home,{recursive:true,force:true});});
const config:Config={version:2,runtimes:['codex','omp'],agents:[],projects:[],connections:[{id:'db',name:'warehouse',transport:'http',url:'https://SECRET',env:{TOKEN:'SECRET'}}],skillLibrary:[]};
it.each([undefined,[]])('discovers user skills without inventing native registrations (%j)',async runtimes=>{
 const {home,put}=await fixture();let nativeCalls=0;
 await put('.agents/skills/user-skill/SKILL.md','---\nname: user-skill\ndescription: Current user capability\n---');
 await put('.codex/skills/unselected/SKILL.md','---\nname: unselected\n---');
 const result=await discoverTeamCapabilities({...config,runtimes},{},{userHome:home,codexMcpList:async()=>{nativeCalls++;return [];}});
 expect(result.selection.runtimes).toEqual([]);expect(nativeCalls).toBe(0);
 expect(result.items.map(i=>i.name)).toEqual(['warehouse','user-skill']);
 expect(result.sources.every(s=>!s.runtime)).toBe(true);
});
it('does not inspect other native skill roots when only Claude is registered',async()=>{
 const {home,put}=await fixture();let nativeCalls=0;
 for(const runtime of ['claude','codex','omp/agent'])await put(`.${runtime}/skills/example/SKILL.md`,`---\nname: ${runtime.replace('/','-')}\n---`);
 const result=await discoverTeamCapabilities({...config,runtimes:['claude']},{},{userHome:home,codexMcpList:async()=>{nativeCalls++;return [];}});
 expect(result.items.filter(i=>i.kind==='skill').map(i=>i.name)).toEqual(['claude']);expect(nativeCalls).toBe(0);
 expect(result.sources.every(s=>!s.runtime||s.runtime==='claude')).toBe(true);
});
async function fixture(){const home=await mkdtemp(join(tmpdir(),'mandala-team-capabilities-'));homes.push(home);return {home,put:async(path:string,body:string)=>{const file=join(home,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,body);return file;}};}
it('discovers runtime and plugin packages with provenance, descriptions and resource presence, without claiming they are loaded',async()=>{
 const {home,put}=await fixture();
 const path=await put('.codex/skills/lineage/SKILL.md','---\nname: lineage\ndescription: Trace business tables\n---\nPRIVATE BODY');
 await put('.codex/skills/lineage/scripts/read.py','PRIVATE SCRIPT');
 await put('.codex/plugins/cache/vendor/data/1/skills/quality/SKILL.md','---\nname: quality\ndescription: Check data quality\n---\nPRIVATE BODY');
 const before=await readFile(path,'utf8');
 const result=await discoverTeamCapabilities(config,{runtimes:['codex']},{userHome:home,codexHome:join(home,'.codex'),codexMcpList:async()=>[]});
 expect(result.selection).toEqual({basis:'user_selected',runtimes:['codex']});
 expect(result.items).toEqual(expect.arrayContaining([
  expect.objectContaining({kind:'skill',name:'lineage',description:'Trace business tables',runtime:'codex',scope:'user',resources:['scripts'],status:'discovered',verification:'not_checked'}),
  expect.objectContaining({kind:'skill',name:'quality',scope:'plugin_cache',activation:'unknown'}),
  expect.objectContaining({kind:'mcp',name:'warehouse',catalogId:'db',status:'configured'}),
 ]));
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET/);expect(await readFile(path,'utf8')).toBe(before);
});
it('redacts native MCP definitions, distinguishes sources and disabled entries, and keeps repeated skill names',async()=>{
 const {home,put}=await fixture();const cwd=join(home,'work');
 const payload=JSON.stringify({mcpServers:{warehouse:{command:'SECRET_COMMAND',args:['SECRET_ARG'],env:{KEY:'SECRET_ENV'},enabled:false},remote:{url:'https://SECRET',headers:{Authorization:'SECRET_HEADER'}}}});
 await put('.omp/agent/mcp.json',payload);await put('work/.mcp.json',payload);
 await put('.omp/agent/skills/review/SKILL.md','---\nname: review\ndescription: User review\n---');
 await put('work/.claude/skills/review/SKILL.md','---\nname: review\ndescription: Project review\n---');
 const result=await discoverTeamCapabilities(config,{runtimes:['omp'],directories:[cwd]},{userHome:home});
 expect(result.items.filter(i=>i.kind==='skill'&&i.name==='review')).toHaveLength(2);
 expect(result.items).toContainEqual(expect.objectContaining({kind:'mcp',name:'warehouse',runtime:'omp',enabled:false,scope:'directory',verification:'not_checked'}));
 expect(JSON.stringify(result)).not.toContain('SECRET');
 expect(result.sources).toContainEqual(expect.objectContaining({status:'missing',path:join(home,'.pi/agent/mcp.json')}));
 expect(result.items.every(i=>i.verification==='not_checked')).toBe(true);
});
it('does not hide unsupported, malformed, oversized or failed sources and bounds output with query filtering',async()=>{
 const {home,put}=await fixture();
 await put('.claude.json','{malformed SECRET');await put('.gemini/settings.json','x'.repeat(1024*1024+1));
 await put('.agents/skills/a/SKILL.md','---\nname: a\ndescription: first\n---');
 await put('.agents/skills/b/SKILL.md','---\nname: b\ndescription: second\n---');
 await symlink(join(home,'.agents/skills'),join(home,'.agents/skills/loop'));
 const result=await discoverTeamCapabilities(config,{runtimes:['codex','claude','gemini','opencode'],limit:1},{userHome:home,codexMcpList:async()=>{throw Error('SECRET');}});
 expect(result.truncated).toBe(true);expect(result.items).toHaveLength(1);
 expect(result.sources.filter(s=>s.kind==='mcp'&&s.status==='unavailable').map(s=>s.runtime)).toEqual(['codex','claude','gemini']);
 expect(result.sources).toContainEqual(expect.objectContaining({runtime:'opencode',status:'unsupported'}));expect(JSON.stringify(result)).not.toContain('SECRET');
 const filtered=await discoverTeamCapabilities(config,{runtimes:['omp'],query:'second'},{userHome:home});expect(filtered.items.map(i=>i.name)).toEqual(['b']);
});
it('defaults to registered runtimes and rejects forged host paths and invalid input before invoking a native command',async()=>{
 const {home}=await fixture();let calls=0;const host={userHome:home,codexMcpList:async()=>{calls++;return [];}};
 for(const input of [{userHome:'/secret'},{directories:['relative']},{runtimes:['unknown']},{limit:0},{query:1}])await expect(discoverTeamCapabilities(config,input as any,host)).rejects.toMatchObject({status:422});
 expect(calls).toBe(0);
 const result=await discoverTeamCapabilities({...config,runtimes:['omp']},{},host);expect(result.selection).toEqual({basis:'registered_runtimes',runtimes:['omp']});expect(calls).toBe(0);
});
