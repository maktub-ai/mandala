import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareUpdateManifest, verifyUpdateFiles } from './mac-public-update-release.mjs';

const teamId = 'DEMO123456';
const commit = 'a'.repeat(40);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pinned = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const teamProof = async () => {};
async function fixture(t, name = 'Mandala-1.0.4-mac-arm64.zip') {
  const directory = await mkdtemp(join(tmpdir(), 'mandala-mac-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, name);
  const bytes = Buffer.from('only synthetic artifact bytes');
  await writeFile(archive, bytes);
  return { archive, commit, teamId, publicKey: pinned, expectedHash: createHash('sha256').update(bytes).digest('hex') };
}

test('derives exact runtime manifest fields only after proving the canonical reviewed archive', async t => {
  const input = await fixture(t);
  let proven = false;
  const result = await prepareUpdateManifest(input, async expected => {
    proven = true;
    assert.equal(expected.archive, input.archive);
    assert.equal(expected.commit, commit);
    assert.equal(expected.manifest.teamId, teamId);
  });
  assert.equal(proven, true);
  assert.equal(result.path, input.archive.replace(/\.zip$/, '.update.json'));
  assert.deepEqual(JSON.parse(await readFile(result.path, 'utf8')), {
    schema: 1, version: '1.0.4', platform: 'darwin', arch: 'arm64',
    name: 'Mandala-1.0.4-mac-arm64.zip', size: (await readFile(input.archive)).length,
    sha256: input.expectedHash, bundleId: 'com.maktubcn.mandala', teamId,
  });
  await assert.rejects(() => prepareUpdateManifest(input, teamProof), { code: 'EEXIST' });
});

test('rejects noncanonical releases and changed bytes before invoking platform verification', async t => {
  const input = await fixture(t);
  let checks = 0;
  const proof = async () => { checks++; };
  await assert.rejects(() => prepareUpdateManifest({ ...input, expectedHash: 'b'.repeat(64) }, proof), /SHA-256/);
  const preview = await fixture(t, 'Mandala-1.0.4-alpha.1-mac-arm64.zip');
  await assert.rejects(() => prepareUpdateManifest(preview, proof), /canonical stable Mac ZIP/);
  assert.equal(checks, 0);
  await assert.rejects(() => prepareUpdateManifest(input, async () => { throw Error('test Apple rejection'); }), /Apple rejection/);
  await assert.rejects(() => readFile(input.archive.replace(/\.zip$/, '.update.json')), { code: 'ENOENT' });
});

test('verifies detached exact-byte signature and artifact digest before any OS archive check', async t => {
  const input = await fixture(t);
  const result = await prepareUpdateManifest(input, teamProof);
  const signature = input.archive.replace(/\.zip$/, '.update.sig');
  const manifestBytes = await readFile(result.path);
  await writeFile(signature, sign(null, manifestBytes, privateKey).toString('base64') + '\n');
  let verified = 0;
  const proof = async () => { verified++; };
  await verifyUpdateFiles({ ...input, publicKey: pinned }, proof);
  assert.equal(verified, 1);
  await writeFile(result.path, Buffer.concat([manifestBytes, Buffer.from(' ')]));
  await assert.rejects(() => verifyUpdateFiles({ ...input, publicKey: pinned }, proof), /signature/);
  await writeFile(result.path, manifestBytes);
  await writeFile(input.archive, 'different unreviewed payload');
  await assert.rejects(() => verifyUpdateFiles({ ...input, publicKey: pinned }, proof), /SHA-256/);
  assert.equal(verified, 1);
});

test('does not issue a manifest if the ZIP is replaced during Apple proof', async t => {
  const input = await fixture(t);
  await assert.rejects(() => prepareUpdateManifest(input, async () => {
    await writeFile(input.archive, 'repacked after Apple proof');
  }), /SHA-256/);
  await assert.rejects(() => readFile(input.archive.replace(/\.zip$/, '.update.json')), { code: 'ENOENT' });
});
