import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, open, realpath, rm, symlink, writeFile, copyFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';

const helper = process.env.MANDALA_WINDOWS_TRUST_HELPER;
test('rejects a staged unsigned artifact, wrong size, wrong digest, and directory alias', {
  skip: process.platform !== 'win32' || !helper,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mandala-native-trust-test-'));
  try {
    const root = await realpath(dir);
    const payload = Buffer.from('synthetic inert unsigned bytes');
    const name = 'Mandala-1.0.4-win-x64.exe';
    const path = join(root, name);
    await writeFile(path, payload);
    const expected = createHash('sha256').update(payload).digest('hex');
    const run = (file, size=payload.length, hash=expected, pin='1'.repeat(64)) => {
      const result = spawnSync(helper, [file, String(size), hash, pin], {encoding:'utf8', windowsHide:true, timeout:10000});
      assert.ifError(result.error);
      return result.status;
    };
    assert.equal(run(path), 20, 'native trust must reject a byte-exact unsigned fixture');
    const writer = await open(path, 'r+');
    try { assert.equal(run(path), 11, 'active writable handle must prevent native verification'); }
    finally { await writer.close(); }
    assert.equal(run(path,payload.length+1), 12, 'candidate size mismatch');
    assert.equal(run(path,payload.length,'2'.repeat(64)), 13, 'candidate digest mismatch');
    assert.equal(run(path,payload.length,expected,'invalid'), 10, 'malformed publisher pin');
    const target = join(root,'target'), alias = join(root,'alias');
    await mkdir(target);
    await writeFile(join(target,name),payload);
    await symlink(target,alias,'junction');
    assert.equal(run(join(alias,name)), 11, 'directory junction must be rejected');
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

const trustedFixture = process.env.MANDALA_WINDOWS_TRUST_FIXTURE;
const fixturePin = process.env.MANDALA_WINDOWS_TRUST_FIXTURE_PIN;
test('native cache-only trust must bind the sole embedded signature and match the independently supplied pin', {
  skip: process.platform !== 'win32' || !helper || !trustedFixture || !fixturePin,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'mandala-native-trust-signed-'));
  try {
    const target = join(await realpath(dir),'Mandala-1.0.5-win-x64.exe');
    await copyFile(trustedFixture,target);
    const bytes = await readFile(target);
    const digest = createHash('sha256').update(bytes).digest('hex');
    // Exact existing Microsoft Windows SDK 10.0.22621.0 x64 test data only.
    assert.equal(digest,'8cfd7441d53c3418ec4ca4436644020f7a1a4a9ccb7d102aed53a61e2a89e405');
    assert.match(fixturePin,/^[a-f0-9]{64}$/);
    const run = (asset, contents, pin) => {
      const hash = createHash('sha256').update(contents).digest('hex');
      const result = spawnSync(helper,[asset,String(contents.length),hash,pin],{encoding:'utf8',windowsHide:true,timeout:10000});
      assert.ifError(result.error);
      return result.status;
    };
    assert.equal(run(target,bytes,fixturePin),0,'valid embedded signature with exact pinned publisher');
    const wrongPin=(fixturePin[0]==='0'?'1':'0')+fixturePin.slice(1);
    assert.equal(run(target,bytes,wrongPin),22,'valid platform trust cannot override another publisher');
    const forged=Buffer.from(bytes);
    const pe=forged.readInt32LE(0x3c);
    const sectionTable=pe+24+forged.readUInt16LE(pe+20);
    const offset=forged.readUInt32LE(sectionTable+20);
    assert.ok(offset>sectionTable && offset<forged.length);
    forged[offset]^=1;
    const changed=join(await realpath(dir),'Mandala-1.0.6-win-x64.exe');
    await writeFile(changed,forged);
    assert.equal(run(changed,forged,fixturePin),20,'changing an authenticated section still fails OS verification');
  } finally {
    const absolute=await realpath(dir);
    assert.equal(dirname(absolute),await realpath(tmpdir()));
    assert.match(basename(absolute),/^mandala-native-trust-signed-[0-9A-Za-z]+$/);
    await rm(absolute,{recursive:true,force:true});
  }
});
