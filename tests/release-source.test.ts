import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const script=resolve('scripts/check-release-source.mjs'),homes:string[]=[];
afterEach(()=>homes.splice(0).forEach(home=>rmSync(home,{recursive:true,force:true})));
function fixture(){const home=mkdtempSync(join(tmpdir(),'mandala-release-source-'));homes.push(home);execFileSync('git',['init','-q'],{cwd:home});writeFileSync(join(home,'.gitignore'),'*.log\n');writeFileSync(join(home,'main.ts'),'export const version=1;\n');execFileSync('git',['add','.gitignore','main.ts'],{cwd:home});return home;}
it('accepts tracked source while leaving ignored local evidence alone',()=>{
 const home=fixture();writeFileSync(join(home,'private.log'),'synthetic local evidence');
 const result=spawnSync(process.execPath,[script],{cwd:home,encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);
});
it('blocks already tracked ignored files even after an ignore rule is added',()=>{
 const home=fixture();writeFileSync(join(home,'private.log'),'synthetic local evidence');execFileSync('git',['add','-f','private.log'],{cwd:home});
 const result=spawnSync(process.execPath,[script],{cwd:home,encoding:'utf8'});
 expect(result.status).not.toBe(0);expect(result.stderr).toContain('Tracked files excluded from distribution');expect(result.stderr).toContain('private.log');
});
