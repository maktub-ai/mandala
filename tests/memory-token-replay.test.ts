import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {openStore} from '../server/store';
import {memoryServices} from '../server/memory-runtime';
import {createUsageRecorder} from '../server/usage';
const homes:string[]=[];afterEach(()=>homes.splice(0).forEach(home=>rmSync(home,{recursive:true,force:true})));
it.each(['old-job','historical-usage'])('refuses %s before any native replay can process data or count old tokens',kind=>{
 const home=mkdtempSync(join(tmpdir(),'memory-token-replay-'));homes.push(home);const store=openStore(home);memoryServices(home,store);const recorder=createUsageRecorder(store);
 if(kind==='old-job')store.database.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run('foreign','foreign',JSON.stringify({state:'queued',availableAt:'2000-01-01T00:00:00Z'}));
 else{recorder.begin({executionId:'historical',category:'memory',cli:'omp',stage:'extract'});recorder.finish('completed');}
 store.close();const database=join(home,'state.sqlite'),manifest=join(home,'manifest.json'),output=join(home,'output');
 writeFileSync(manifest,JSON.stringify({model:'synthetic-unused',maxCalls:0,maxReportedTokens:0,samples:[{name:'sample',database,sha256:createHash('sha256').update(readFileSync(database)).digest('hex'),job:{id:'sample'}}]}));
 const result=spawnSync(process.execPath,['--import','tsx',resolve('scripts/memory-token-replay.ts'),manifest,output],{encoding:'utf8',timeout:15000});
 expect(result.status).toBe(1);expect(result.stderr).toContain(kind==='old-job'?'empty job queue':'no historical usage');expect(existsSync(join(output,'sample','calls.jsonl'))).toBe(false);
});
