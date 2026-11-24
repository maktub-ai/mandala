import {DatabaseSync} from 'node:sqlite';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createWindowsInstallAction,createWindowsUpdateGate} from './public-windows-update.cjs';
import {createSqliteHandoffJournal} from './windows-sqlite-handoff-journal.cjs';
import {createUpdateController} from './updates.cjs';
import {prepareWindowsReceipt} from '../scripts/windows-release-receipt.mjs';

function fixture(run) {
  const tmp=realpathSync.native(tmpdir());
  const home=realpathSync.native(mkdtempSync(join(tmp,'mandala-win-recovery-')));
  const db=new DatabaseSync(join(home,'.mandala-windows-handoff.sqlite'));
  try {
    db.exec("PRAGMA application_id=1296321621; PRAGMA user_version=1; PRAGMA synchronous=EXTRA; CREATE TABLE windows_handoff (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('clear','pending','started','unknown'))) STRICT; INSERT INTO windows_handoff VALUES(1,'','clear');");
  }finally{db.close();}
  const journal=()=>createSqliteHandoffJournal({home,isPrivateLocal:(root,paths)=>root===home&&paths.every(path=>dirname(path)===home)});
  return Promise.resolve().then(()=>run(home,journal)).finally(()=>{
    assert.equal(dirname(realpathSync.native(home)),tmp);
    assert.match(basename(home),/^mandala-win-recovery-[0-9A-Za-z]+$/);
    rmSync(home,{recursive:true,force:true});
  });
}

const staged={version:'1.0.5',publicWindows:true};
const makeController=(journal,installPublic)=>{
  const restore=createWindowsInstallAction({confirm:async()=>true,canUnload:async()=>true,
    inhibitInput(){},stopIfIdle:async()=>true,claimQuiescentHome:()=>()=>{},
    resumeUnchanged:async()=>{},installVerified:installPublic});
  return createUpdateController({platform:'win32',arch:'x64',version:'1.0.4',
    publicWindows:{ready:()=>staged},handoffJournal:journal,installPublic:restore});
};

test('known bad bytes clear only the pending journal owner; uncertain launch remains non-retriable after reopen',()=>fixture(async(home,journal)=>{
  const name='Mandala-1.0.5-win-x64.exe',path=join(home,name),payload=Buffer.from('Signed synthetic inert updater fixture');
  const publisherSpkiSha256='a'.repeat(64), pair=generateKeyPairSync('ed25519');
  const trust={publisherSpkiSha256,publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64')};
  const expected={name,version:staged.version,platform:'win32',arch:'x64',size:payload.length,
    sha256:createHash('sha256').update(payload).digest('hex'),commit:'1'.repeat(40),publisherSpkiSha256};
  const receipt=prepareWindowsReceipt(expected),signature=Buffer.from(sign(null,receipt,pair.privateKey).toString('base64'));
  const entry={path,receipt,signature,version:expected.version};
  let entered=0, started=0;
  const gate=createWindowsUpdateGate({version:'1.0.4',arch:'x64',trust,native:{
    async withLockedInstaller(_file,metadata,use){
      entered++;
      await use({...metadata,status:'valid',revocation:'verified',source:'embedded'},async()=>{
        started++;
        throw Object.assign(Error('SYNTHETIC private diagnostic'),{name:'PublicUpdateVerificationError'});
      });
    }
  }});
  const configure=()=>makeController(journal(),authorize=>gate.install(entry,authorize));
  writeFileSync(path,Buffer.alloc(payload.length,0xff));
  const first=configure();
  await first.install();
  assert.equal(first.state().error,'signed_verification');
  assert.equal(journal().read(),null);
  assert.equal(entered+started,0);

  writeFileSync(path,payload);
  const reopened=configure();
  await reopened.check('auto');
  assert.equal(started,0);
  await reopened.install();
  assert.equal(started,1);
  assert.equal(journal().read(),'unknown');
  assert.equal(reopened.state().error,'signed_handoff_unknown');
  const restart=configure();
  await restart.check('auto');
  await restart.install();
  assert.equal(restart.state().error,'signed_handoff_unknown');
  assert.equal(started,1);
}));

test('an unbranded look-alike error cannot turn an indeterminate result into retry permission',()=>fixture(async(_home,journal)=>{
  let calls=0;
  const configure=()=>makeController(journal(),async()=>{
    calls++;
    throw Object.assign(Error('synthetic fabricated classification'),{name:'PublicUpdateVerificationError'});
  });
  await assert.rejects(()=>configure().install());
  assert.equal(journal().read(),'unknown');
  const restart=configure();
  await restart.install();
  assert.equal(calls,1);
  assert.equal(restart.state().error,'signed_handoff_unknown');
}));

test('a retained gate error cannot clear a later authorization attempt',()=>fixture(async(_home,journal)=>{
  const keys=generateKeyPairSync('ed25519');
  const gate=createWindowsUpdateGate({version:'1.0.4',arch:'x64',
    trust:{publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),publisherSpkiSha256:'a'.repeat(64)},
    native:{async withLockedInstaller(){throw Error('Unsigned stub should not run');}}
  });
  const stale=await gate.install({},async()=>null).catch(error=>error);
  let idleClaims=0;
  const action=createWindowsInstallAction({
    confirm:async()=>true,canUnload:async()=>true,inhibitInput(){},
    stopIfIdle:async()=>true,claimQuiescentHome:()=>{idleClaims++;return ()=>{};},
    resumeUnchanged:async()=>{},installVerified:async authorize=>{const release=await authorize();await release();throw stale;}
  });
  const controller=createUpdateController({platform:'win32',arch:'x64',version:'1.0.4',
    publicWindows:{ready:()=>staged},handoffJournal:journal(),installPublic:action});
  await assert.rejects(()=>controller.install());
  assert.equal(idleClaims,1);
  assert.equal(journal().read(),'unknown');
}));

test('raw or stale prelaunch outputs never clear another attempt',()=>fixture(async(_home,journal)=>{
  let calls=0;
  const configure=()=>createUpdateController({platform:'win32',arch:'x64',version:'1.0.4',
    publicWindows:{ready:()=>staged},handoffJournal:journal(),installPublic:async()=>{calls++;return 'prelaunch_failed';}});
  const first=configure();
  await first.install();
  assert.equal(journal().read(),'unknown');
  const reopened=configure();
  await reopened.install();
  assert.equal(reopened.state().error,'signed_handoff_unknown');
  assert.equal(calls,1);
}));

test('prelaunch proof is exact-stage and exact-challenge, one-use, with no late idle authorization',async()=>{
  const {consumeWindowsPrelaunchFailure}=await import('./public-windows-update.cjs');
  const keys=generateKeyPairSync('ed25519');
  const gate=createWindowsUpdateGate({version:'1.0.4',arch:'x64',
    trust:{publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),publisherSpkiSha256:'a'.repeat(64)},
    native:{async withLockedInstaller(){throw Error('Unsigned stub should not run');}}
  });
  let late, idleCalls=0;
  const action=createWindowsInstallAction({
    confirm:async()=>true,canUnload:async()=>true,inhibitInput(){},
    stopIfIdle:async()=>{idleCalls++;return true;},claimQuiescentHome:()=>()=>{},
    resumeUnchanged:async()=>{},installVerified:authorize=>{late=authorize;return gate.install({},authorize);}
  });
  const challenge=Object.freeze({});
  const proof=await action(staged,challenge);
  assert.equal(consumeWindowsPrelaunchFailure(proof,{...staged},challenge),false);
  assert.equal(consumeWindowsPrelaunchFailure(proof,staged,Object.freeze({})),false);
  assert.equal(consumeWindowsPrelaunchFailure(proof,staged,challenge),'verification_failed');
  assert.equal(consumeWindowsPrelaunchFailure(proof,staged,challenge),false);
  assert.equal(await late(),null);
  assert.equal(idleCalls,0);
});

test('adapter cannot clear a reservation with any unverified no-handoff word',async()=>{
  for(const purported of ['busy','cancelled','unsaved','prelaunch_failed']){
    await fixture(async(_home,journal)=>{
      let attempts=0;
      const configure=()=>createUpdateController({platform:'win32',arch:'x64',version:'1.0.4',
        publicWindows:{ready:()=>staged},handoffJournal:journal(),
        installPublic:async()=>{attempts++;return purported;}});
      const original=configure();
      await original.install();
      const reopened=configure();
      await reopened.install();
      assert.equal(journal().read(),'unknown',purported);
      assert.equal(reopened.state().error,'signed_handoff_unknown',purported);
      assert.equal(attempts,1,purported);
    });
  }
});

test('adapter early busy cannot advance pending authorization or reopen the durable attempt',()=>fixture(async(_home,journal)=>{
  let release, lateAuthorization, reads=0, inputStarts=0, inputRestores=0, drains=0, claims=0, resumes=0;
  const delayed=new Promise(resolve=>{release=resolve;});
  const action=createWindowsInstallAction({
    confirm:async()=>true,canUnload:async()=>++reads===1?true:delayed,
    inhibitInput(value){if(value)inputStarts++;else inputRestores++;},
    stopIfIdle:async()=>{drains++;return true;},claimQuiescentHome:()=>{claims++;return ()=>{};},
    resumeUnchanged:async()=>{resumes++;},
    async installVerified(authorize){lateAuthorization=authorize(); return 'busy';}
  });
  const configure=()=>createUpdateController({platform:'win32',arch:'x64',version:'1.0.4',
    publicWindows:{ready:()=>staged},handoffJournal:journal(),installPublic:action});
  await configure().install();
  release(true);
  assert.equal(await lateAuthorization,null);
  const reopened=configure();
  await reopened.install();
  assert.equal(journal().read(),'unknown');
  assert.equal(reopened.state().error,'signed_handoff_unknown');
  assert.deepEqual({inputStarts,inputRestores,drains,claims,resumes},{inputStarts:1,inputRestores:0,drains:0,claims:0,resumes:0});
}));
