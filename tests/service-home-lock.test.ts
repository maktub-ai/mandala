import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimServiceHome } from '../server/service-home-lock';
const homes:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const temporary=()=>{const home=mkdtempSync(join(tmpdir(),'service-lock-'));homes.push(home);return home;};
test('separate service processes cannot claim one HOME and another HOME remains independent',()=>{
 const home=temporary(),lock=claimServiceHome(home);
 try{const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {claimServiceHome} from './server/service-home-lock.ts';try{claimServiceHome(process.argv[1]);console.log('claimed')}catch(e){console.log(e.message)}",home],{encoding:'utf8'});expect(result.trim()).toBe('service_home_in_use');const other=claimServiceHome(temporary());other.release();}finally{lock.release();}
 claimServiceHome(home).release();
});
test('recovers a dead process record and release never deletes a replaced token',()=>{
 const home=temporary();writeFileSync(join(home,'.service-home-lock'),JSON.stringify({pid:2147483647,token:'dead'}),{mode:0o600});const lock=claimServiceHome(home);
 const record=JSON.parse(readFileSync(join(home,'.service-home-lock'),'utf8'));expect(record.pid).toBe(process.pid);
 writeFileSync(join(home,'.service-home-lock'),JSON.stringify({...record,token:'other'}));lock.release();expect(JSON.parse(readFileSync(join(home,'.service-home-lock'),'utf8')).token).toBe('other');
});
test('permission-denied PID probes remain occupied and unsafe lock paths are rejected',()=>{
 const home=temporary();writeFileSync(join(home,'.service-home-lock'),JSON.stringify({pid:process.pid,token:'active'}),{mode:0o600});vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});});expect(()=>claimServiceHome(home)).toThrow('service_home_in_use');
 chmodSync(join(home,'.service-home-lock'),0o644);expect(()=>claimServiceHome(home)).toThrow('unsafe_service_home_lock');rmSync(join(home,'.service-home-lock'));symlinkSync(join(home,'missing'),join(home,'.service-home-lock'));expect(()=>claimServiceHome(home)).toThrow('unsafe_service_home_lock');
});
