import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, open, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
