import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const modulePath=fileURLToPath(new URL('./windows-handoff-journal.cjs',import.meta.url));
function child(home,source,...args) {
  return spawnSync(process.execPath,['-e',
    "const {createWindowsHandoffJournal}=require(process.argv[1]);const j=createWindowsHandoffJournal({home:process.argv[2]});"+source,
    modulePath,home,...args],{encoding:'utf8',timeout:5000,windowsHide:true});
}
const W='Windows needs a separately reviewed ACL and namespace durability adapter';

test('exclusive pending survives process exit and cannot be settled by a sibling owner',{skip:process.platform==='win32'&&W},()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'mandala-handoff-')));
  try {
    const crash=child(home,"if (!j.tryBegin()) process.exit(9); process.exit(7);");
    assert.equal(crash.status,7,crash.stderr);
    const reopened=child(home,"console.log(j.read());if(j.tryBegin()!==null||j.settle('0'.repeat(64),null)!==false)process.exit(9);");
    assert.equal(reopened.status,0,reopened.stderr);
    assert.equal(reopened.stdout.trim(),'pending');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('known prelaunch can clear only its own checkpoint, started remains after process restart',{skip:process.platform==='win32'&&W},()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'mandala-handoff-')));
  try {
    const first=child(home,"const t=j.tryBegin();if(!t||j.settle(t,null)!==true||j.read()!==null)process.exit(9);");
    assert.equal(first.status,0,first.stderr);
    const second=child(home,"const t=j.tryBegin();if(!t||j.settle(t,'started')!==true)process.exit(9);");
    assert.equal(second.status,0,second.stderr);
    const reopen=child(home,"console.log(j.read());if(j.tryBegin()!==null)process.exit(9);");
    assert.equal(reopen.status,0,reopen.stderr);
    assert.equal(reopen.stdout.trim(),'started');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('corruption and nonprivate home fail closed',{skip:process.platform==='win32'&&W},()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'mandala-handoff-')));
  try {
    const module=child(home,"if(!j.tryBegin())process.exit(9);");
    assert.equal(module.status,0,module.stderr);
    const reserved=join(home,'.mandala-windows-handoff-v1');
    writeFileSync(reserved,'short or partially written\n');
    const reopen=child(home,"console.log(j.read());if(j.tryBegin()!==null)process.exit(9);");
    assert.equal(reopen.status,0,reopen.stderr);
    assert.equal(reopen.stdout.trim(),'unknown');
    chmodSync(home,0o777);
    const unsafe=child(home,"console.log(j.read());if(j.tryBegin()!==null)process.exit(9);");
    assert.equal(unsafe.status,0,unsafe.stderr);
    assert.equal(unsafe.stdout.trim(),'unknown');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('desktop state reconstructs an actual pending checkpoint in a fresh process without installing',{skip:process.platform==='win32'&&W},()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'mandala-handoff-')));
  try {
    const updates=fileURLToPath(new URL('./updates.cjs',import.meta.url));
    const setup=`const {createUpdateController}=require(process.argv[3]);
      const state={publicWindows:true,version:'1.0.5'};
      const u=createUpdateController({version:'1.0.4',platform:'win32',arch:'x64',
        publicWindows:{ready:()=>state},handoffJournal:j,
        installPublic:async()=>{process.exit(7);} });`;
    assert.equal(child(home,setup+'void u.install();',updates).status,7);
    const reopened=child(home,setup+`if(u.state().error!=='signed_handoff_unknown')process.exit(9);
       void u.install().then(()=>console.log('not-retried'));`,updates);
    assert.equal(reopened.status,0,reopened.stderr);
    assert.equal(reopened.stdout.trim(),'not-retried');
  }finally{rmSync(home,{recursive:true,force:true});}
});
