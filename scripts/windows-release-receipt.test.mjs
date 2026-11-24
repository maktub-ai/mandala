import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {test} from 'node:test';

const fixture = {
  version: '1.0.4', platform: 'win32', arch: 'x64',
  name: 'Mandala-1.0.4-win-x64.exe', size: 200, sha256: 'a'.repeat(64),
  commit: 'b'.repeat(40), publisherSpkiSha256: 'c'.repeat(64),
};
const {publicKey, privateKey} = generateKeyPairSync('ed25519');
const trust = publicKey.export({type:'spki',format:'der'}).toString('base64');
const envelope = bytes => Buffer.from(sign(null,bytes,privateKey).toString('base64')+'\n');

test('prepares and checks an exact authenticated Windows installer receipt offline', async () => {
  const {prepareWindowsReceipt,verifyWindowsReceipt} = await import('./windows-release-receipt.mjs');
  const bytes = prepareWindowsReceipt(fixture);
  assert.equal(verifyWindowsReceipt(bytes,envelope(bytes),fixture,trust), true);
  assert.equal(verifyWindowsReceipt(bytes,envelope(bytes).subarray(0,-1),fixture,trust), true);
  assert.throws(() => verifyWindowsReceipt(bytes,envelope(bytes),{...fixture,size:201},trust));
  assert.throws(() => verifyWindowsReceipt(bytes,envelope(bytes),{...fixture,sha256:'b'.repeat(64)},trust));
  assert.throws(() => verifyWindowsReceipt(bytes,envelope(bytes),{...fixture,publisherSpkiSha256:'d'.repeat(64)},trust));
});

test('rejects platform confusion, bad input, wrong signer and noncanonical signed bytes', async () => {
  const {prepareWindowsReceipt,verifyWindowsReceipt} = await import('./windows-release-receipt.mjs');
  for (const variant of [{platform:'darwin'},{arch:'arm64'},{name:'../'+fixture.name},{version:'v1.0.4'},{size:0},{sha256:'A'.repeat(64)},{commit:'main'},{sha256:'a'.repeat(63)+'\n'},{version:'1.0.4\n',name:'Mandala-1.0.4\n-win-x64.exe'}]) {
    assert.throws(() => prepareWindowsReceipt({...fixture,...variant}));
  }
  const bytes = prepareWindowsReceipt(fixture);
  const other = generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64');
  assert.throws(() => verifyWindowsReceipt(bytes,envelope(bytes),fixture,other));
  const nonCanonical = Buffer.from(JSON.stringify(JSON.parse(bytes),null,2)+'\n');
  assert.throws(() => verifyWindowsReceipt(nonCanonical,envelope(nonCanonical),fixture,trust));
  assert.throws(() => verifyWindowsReceipt(bytes,Buffer.concat([envelope(bytes),Buffer.from('\n')]),fixture,trust));
  assert.throws(() => verifyWindowsReceipt(bytes,Buffer.concat([envelope(bytes).subarray(0,-1),Buffer.from('\r\n')]),fixture,trust));
  assert.throws(() => verifyWindowsReceipt(bytes,envelope(bytes),fixture,trust+'\n'));
});

test('checks the exact newer installer bytes but does not claim Authenticode trust', async () => {
  const {prepareWindowsReceipt,verifyWindowsInstallerBytes} = await import('./windows-release-receipt.mjs');
  assert.equal(typeof verifyWindowsInstallerBytes,'function');
  const {mkdtemp,realpath,writeFile,rm,symlink,mkdir} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const {createHash} = await import('node:crypto');
  const scratch = await mkdtemp(join(tmpdir(),'mandala-win-receipt-'));
  try {
    const root=await realpath(scratch), data=Buffer.from('synthetic installer bytes; not executable');
    const expected={...fixture,size:data.length,sha256:createHash('sha256').update(data).digest('hex')};
    const path=join(root,expected.name);
    await writeFile(path,data);
    const bytes=prepareWindowsReceipt(expected), proof=envelope(bytes);
    const review=(input=path,current='1.0.3')=>verifyWindowsInstallerBytes(input,bytes,proof,expected,trust,current);
    const receipt=await review();
    assert.deepEqual(receipt,{sha256:expected.sha256,size:expected.size,commit:expected.commit,version:expected.version,platform:'win32',arch:'x64',publisherSpkiSha256:expected.publisherSpkiSha256,authenticode:'required'});
    assert.ok(Object.isFrozen(receipt));
    await assert.rejects(()=>review(path,'1.0.4'),/newer/);
    await assert.rejects(()=>review(path,'1.0.5'),/newer/);
    await assert.rejects(()=>review(path,'1.0.3-preview.1'),/stable/);
    await assert.rejects(()=>review(join(root,'renamed.exe')),/canonical/);
    const alias=join(root,'alias');
    await symlink(root,alias,process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>review(join(alias,expected.name)),/canonical|regular/);
    if (process.platform !== 'win32') {
      const fileAlias=join(root,'file-alias');
      await mkdir(fileAlias);
      await symlink(path,join(fileAlias,expected.name),'file');
      await assert.rejects(()=>review(join(fileAlias,expected.name)),/canonical|regular/);
    }
    await writeFile(path,Buffer.alloc(data.length,1));
    await assert.rejects(()=>review(),/SHA-256/);
    await writeFile(path,Buffer.concat([data,Buffer.from('!')]));
    await assert.rejects(()=>review(),/size/);
  } finally {await rm(scratch,{recursive:true,force:true});}
});
