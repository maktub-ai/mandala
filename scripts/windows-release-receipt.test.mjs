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
