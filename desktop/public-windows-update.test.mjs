import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {prepareWindowsReceipt} from '../scripts/windows-release-receipt.mjs';

function journal(){
  let state=null, owner;
  return { read:()=>state,
    tryBegin(){if(state)return null; state='pending'; return owner=Symbol();},
    settle(token,result){assert.equal(token,owner); state=result; return true;}
  };
}

test('only exact signed Windows bytes and a bound trusted native publisher can reach the idle install gate', async () => {
  const {createWindowsUpdateGate,createWindowsInstallAction} = await import('./public-windows-update.cjs');
  const scratch = await mkdtemp(join(tmpdir(),'mandala-win-update-'));
  try {
    const home = await realpath(scratch);
    const data = Buffer.from('Synthetic test bytes; no executable.');
    const path = join(home,'Mandala-1.0.5-win-x64.exe');
    await writeFile(path,data);
    const {publicKey,privateKey} = generateKeyPairSync('ed25519');
    const publisherSpkiSha256 = 'a'.repeat(64);
    const trust = {publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),publisherSpkiSha256};
    const expected = {version:'1.0.5',platform:'win32',arch:'x64',name:'Mandala-1.0.5-win-x64.exe',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),commit:'1'.repeat(40),publisherSpkiSha256};
    const receipt = prepareWindowsReceipt(expected);
    const signature = Buffer.from(sign(null,receipt,privateKey).toString('base64'));
    const input = {path,receipt,signature,version:expected.version};
    let attempts=0, launches=0, drains=0;
    let returnFromStart='started';
    let trustResult={status:'valid',revocation:'verified',source:'embedded',platform:'win32',arch:'x64',publisherSpkiSha256};
    let ready=true;
    const native = {
      async withLockedInstaller(pathGiven, metadata, use) {
        attempts++;
        assert.equal(pathGiven,path);
        assert.equal(metadata.sha256,expected.sha256);
        // Synthetic stand-in for a handle held with deny-write/delete sharing
        // through authentication, idle drain and handoff to the installer.
        return use({sha256:expected.sha256,size:expected.size,...trustResult}, async () => {launches++; return returnFromStart;});
      }
    };
    assert.equal(createWindowsUpdateGate({version:'1.0.4',arch:'x64',trust}),null,'no native implementation is never enabled');
    const gate = createWindowsUpdateGate({version:'1.0.4',arch:'x64',trust,native});
    const drain=async ()=>{drains++; return ready?()=>{}:null;};
    await assert.rejects(()=>gate.install({...input,signature:Buffer.alloc(88)},drain),/verify/i);
    assert.equal(attempts,0);
    await writeFile(path,Buffer.alloc(data.length,1));
    await assert.rejects(()=>gate.install(input,drain),/verify/i);
    assert.equal(attempts,0);
    await writeFile(path,data);
    const valid=trustResult;
    for (const variation of [{status:'untrusted'},{publisherSpkiSha256:'b'.repeat(64)},{revocation:'unknown'},{source:'catalog'},{arch:'arm64'},{sha256:'b'.repeat(64)},{size:data.length+1}]) {
      trustResult={...valid,...variation};
      await assert.rejects(()=>gate.install(input,drain),/verify/i);
    }
    assert.equal(drains,0);
    assert.equal(launches,0);
    trustResult=valid;
    ready=false;
    assert.equal(await gate.install(input,drain),'busy');
    assert.equal(launches,0);
    ready=true;
    assert.equal(await gate.install(input,drain),'started');
    assert.equal(launches,1);
    assert.equal(await gate.install(input,drain),'busy');
    assert.equal(launches,1);
    returnFromStart='did not acknowledge';
    const unknown=createWindowsUpdateGate({version:'1.0.4',arch:'x64',trust,native});
    assert.equal(await unknown.install(input,drain),'unknown');
    assert.equal(await unknown.install(input,drain),'busy');
    assert.equal(launches,2);
    returnFromStart='started';
    const protectedGate=createWindowsUpdateGate({version:'1.0.4',arch:'x64',trust,native});
    const calls=[];
    const action=createWindowsInstallAction({
      confirm:async()=>{calls.push('confirm');return true;},
      canUnload:async()=>{calls.push('check drafts');return true;},
      inhibitInput:block=>calls.push(block?'block input':'unblock input'),
      stopIfIdle:async()=>{calls.push('drain');return true;},
      claimQuiescentHome:()=>{calls.push('claim');return ()=>calls.push('release');},
      resumeUnchanged:async()=>{throw Error('Unexpected recovery after handoff');},
      installVerified:authorize=>protectedGate.install(input,authorize)
    });
    const {createUpdateController}=await import('./updates.cjs');
    let stage={version:expected.version,publicWindows:true,notes:'https://example.invalid',size:data.length};
    const controller=createUpdateController({version:'1.0.4',platform:'win32',arch:'x64',
      publicWindows:{ready:()=>stage}, handoffJournal:journal(),
      async installPublic(){const result=await action(); if(result==='started')stage=null; return result;},
    });
    assert.equal(controller.state().status,'ready');
    await controller.check('auto');
    assert.equal(launches,2);
    await controller.install();
    assert.equal(controller.state().status,'handoff');
    assert.equal(launches,3);
    assert.deepEqual(calls,['confirm','check drafts','block input','check drafts','drain','claim']);
  } finally { await rm(scratch,{recursive:true,force:true}); }
});

test('Windows signed candidate only invokes confirmed guarded handoff from explicit install, not from checks/downloads', async () => {
  const {createUpdateController}=await import('./updates.cjs');
  const version='1.0.5', tag='v'+version, name='Mandala-'+version+'-win-x64.exe';
  const repo='https://github.com/maktub-ai/mandala-releases/releases';
  const notes=repo+'/tag/'+tag, url=repo+'/download/'+tag+'/'+name;
  let downloaded=false, installations=0, external=0, confirmations=0, accepted=false;
  const {createWindowsInstallAction}=await import('./public-windows-update.cjs');
  const installPublic=createWindowsInstallAction({confirm:async()=>{installations++;return accepted;},
    canUnload:async()=>true,installVerified:async()=>'unknown'});
  const update={version,notes,size:42,publicWindows:true};
  const publicWindows={
    check(offered){ assert.equal(offered.url,url); return update; },
    ready(){ return downloaded?update:null; },
    download(){ downloaded=true; }
  };
  const controller=createUpdateController({version:'1.0.4',platform:'win32',arch:'x64',
    fetch:async()=>({ok:true,json:async()=>({schema:1,releases:[{tag,url:notes,assets:[{name,url,size:42}]}]})}),
    publicWindows, handoffJournal:journal(), installPublic,
    showMessage:async()=>{confirmations++; return {response:0};},openExternal:()=>{external++;}
  });
  assert.equal((await controller.check('auto')).channel,'signed-windows');
  assert.equal(controller.state().status,'available');
  await controller.download();
  await controller.check('auto');
  assert.equal(controller.state().status,'ready');
  assert.equal(confirmations,0);
  assert.equal(installations,0);
  assert.equal(external,0);
  await controller.install();
  assert.equal(installations,1);
  assert.equal(controller.state().status,'ready');
  accepted=true;
  await controller.install();
  assert.equal(controller.state().status,'error');
  assert.equal(controller.state().error,'signed_handoff_unknown');
  await controller.install();
  await controller.check('auto');
  assert.equal(controller.state().error,'signed_handoff_unknown');
  assert.equal(installations,2);
});

test('Windows confirmation prevents premature drain and preserves the barrier on uncertain adapter outcome', async ()=>{
  const {createWindowsInstallAction,consumeWindowsPrelaunchFailure}=await import('./public-windows-update.cjs');
  const calls=[];
  let accepted=false,unsaved=false;
  const update={version:'1.0.5'};
  const install=createWindowsInstallAction({
    confirm:async()=>{calls.push('confirm');return accepted;},
    canUnload:async()=>{calls.push('unload');return !unsaved;},
    inhibitInput(value){calls.push(value?'block':'unblock');},
    async stopIfIdle(){calls.push('idle-drain');return true;},
    claimQuiescentHome(){calls.push('claim');return null;},
    async installVerified(authorize){
      calls.push('verified');
      const release=await authorize();
      if(!release) return 'busy';
      try { calls.push('native'); return 'unknown'; }
      finally {release();}
    }
  });
  const cancelled=Object.freeze({});
  assert.equal(consumeWindowsPrelaunchFailure(await install(update,cancelled),update,cancelled),'cancelled');
  assert.deepEqual(calls.splice(0),['confirm']);
  accepted=true; unsaved=true;
  const drafts=Object.freeze({});
  assert.equal(consumeWindowsPrelaunchFailure(await install(update,drafts),update,drafts),'unsaved');
  assert.deepEqual(calls.splice(0),['confirm','unload']);
  unsaved=false;
  assert.equal(await install(update,Object.freeze({})),'unknown');
  assert.deepEqual(calls.splice(0),['confirm','unload','verified','block','unload','idle-drain','claim']);
  assert.equal(await install(),'unknown','unknown native handoff never retries');
  assert.deepEqual(calls,[]);
});

test('ordinary Windows never activates a signed adapter or install from release feed flags', async ()=>{
  const {createUpdateController}=await import('./updates.cjs');
  const name='Mandala-1.0.5-win-x64.exe', version='1.0.5';
  const url='https://github.com/maktub-ai/mandala-releases/releases/download/v'+version+'/'+name;
  let blocked=0, external=null;
  const controller=createUpdateController({version:'1.0.4',platform:'win32',arch:'x64',
    fetch:async()=>({ok:true,json:async()=>({schema:1,releases:[{
      tag:'v'+version, publicWindows:true, assets:[{name,url,size:300,publicWindows:true}]
    }]})}),
    publicMac:{check(){throw Error('wrong platform source');},ready(){throw Error('wrong platform source');}},
    installPublic:async()=>{blocked++;},openExternal:value=>{external=value;}
  });
  await controller.check();
  assert.equal(controller.state().channel,'installer');
  assert.equal(controller.state().update.publicWindows,undefined);
  await controller.install();
  assert.equal(blocked,0);
  assert.equal(external,null);
  await controller.download();
  assert.equal(external,url);
});


test('a durable pending or started Windows handoff blocks new calls and survives reopening Settings and app restart', async ()=>{
  const {createUpdateController}=await import('./updates.cjs');
  let attempts=0, resolve;
  const ready={publicWindows:true,version:'1.1.1',size:8,notes:'https://example.invalid'};
  const handoffJournal=journal();
  const configure=()=>createUpdateController({version:'1.0.4',platform:'win32',arch:'x64',
    publicWindows:{ready:()=>ready},handoffJournal,
    installPublic:()=>{attempts++; return new Promise(r=>{resolve=r;});}
  });
  const first=configure();
  const pending=first.install();
  assert.equal(handoffJournal.read(),'pending');
  const reopened=configure();
  assert.equal(reopened.state().error,'signed_handoff_unknown');
  await reopened.install();
  await first.install();
  assert.equal(attempts,1);
  resolve('started');
  await pending;
  assert.equal(first.state().status,'handoff');
  assert.equal(configure().state().status,'handoff');
  await first.check('auto');
  await first.install();
  assert.equal(attempts,1);
});
