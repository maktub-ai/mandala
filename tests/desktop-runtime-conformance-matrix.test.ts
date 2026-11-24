import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runtimeCatalog, runtimeIds } from '../shared/runtimes';

const cases=JSON.parse(readFileSync(new URL('../scripts/desktop-runtime-conformance-cases.json',import.meta.url),'utf8')) as
  {cli:string;command:string;catalogArgs:string[];methods:string[];optionalMethods?:string[];probe:string;auth:string}[];

it('provides exactly one hermetic packaged test row for every advertised launcher and command',()=>{
 expect(cases.map(row=>row.cli)).toEqual(runtimeIds);
 expect(new Set(cases.map(row=>row.command)).size).toEqual(runtimeIds.length);
 expect(cases.map(row=>[row.command,row.catalogArgs])).toEqual(runtimeIds.map(cli=>[runtimeCatalog[cli].command,runtimeCatalog[cli].args]));
});

it('admits only finite preflight requests, never a prompt or tool operation',()=>{
 const expected:Record<string,string[]> = {
  account:['initialize','initialized','account/read'],
  rpc:['get_state'],
  acp:['initialize'],
  'version-only':[],
  'gateway-session':['initialize','session/new'],
 };
 for(const row of cases){
   expect(expected[row.probe],row.cli).toBeDefined();
   expect(row.methods,row.cli).toEqual(row.cli==='pi'?['get_state','get_commands']:row.cli==='claude'?['--version']:expected[row.probe]);
   expect(row.optionalMethods??[],row.cli).toEqual(row.cli==='hermes'?['session/load']:row.cli==='openclaw'?['session/resume']:[]);
   expect(row.auth,row.cli).toBe(row.probe==='account'||row.cli==='claude'?'native-account-ready':'not-verified');
 }
});

it('covers one synthetic first-turn operation and exact approval scope for each transport',()=>{
 const firstTurn={
   account:'turn/start', rpc:'prompt', acp:'session/prompt', 'version-only':'stream-result', 'gateway-session':'session/prompt',
 };
 for(const row of cases) {
   const fixture=(row as typeof row & {firstTurn?:{method:string;approval:boolean}}).firstTurn;
   expect(fixture,row.cli).toEqual({
     method:row.cli==='claude'?'sdk/user':firstTurn[row.probe as keyof typeof firstTurn],
     approval:['cursor','antigravity','dsh','hermes','openclaw'].includes(row.cli),
   });
 }
});
