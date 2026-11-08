import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canApproveAcpLocally} from '../server/approval-policy';
const homes:string[]=[];
afterEach(()=>homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true})));
it('approves structured local read/edit requests only; commands and missing scope still ask',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'approval-policy-'));homes.push(cwd);const path=join(cwd,'file.txt');writeFileSync(path,'sample');
 const tool=(kind:string,file=path)=>({kind,rawInput:{path:file},locations:[{path:file}]});
 expect(canApproveAcpLocally(tool('read'),cwd)).toBe(true);expect(canApproveAcpLocally(tool('edit'),cwd)).toBe(true);
 for(const input of [tool('execute'),tool('delete'),tool('read','/etc/hosts'),{kind:'edit',rawInput:{path},locations:[]},{kind:'read'},tool('other')])expect(canApproveAcpLocally(input,cwd)).toBe(false);
 const outside=mkdtempSync(join(tmpdir(),'approval-outside-'));homes.push(outside);symlinkSync(outside,join(cwd,'link'));
 expect(canApproveAcpLocally(tool('edit',join(cwd,'link','new.txt')),cwd)).toBe(false);
 mkdirSync(join(outside,'child'));symlinkSync(join(outside,'child'),join(cwd,'escape'));
 expect(canApproveAcpLocally(tool('read',cwd+'/escape/../secret.txt'),cwd)).toBe(false);
 mkdirSync(join(cwd,'new'));expect(canApproveAcpLocally(tool('edit',join(cwd,'new','file.txt')),cwd)).toBe(true);
 expect(canApproveAcpLocally({...tool('edit'),rawInput:{path:'/etc/hosts'}},cwd)).toBe(false);
});
