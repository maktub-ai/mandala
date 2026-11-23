import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleId = 'com.maktubcn.mandala';
const sha256 = /^[a-f0-9]{64}$/;
const stableZip = /^Mandala-((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))-mac-(arm64|x64)\.zip$/;
const maximumZip = 2 * 1024 * 1024 * 1024;

async function hashArchive(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximumZip) throw Error('Expected a bounded regular Mac ZIP file');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > maximumZip) throw Error('Mac ZIP exceeds release size limit');
    hash.update(chunk);
  }
  if (stat.size !== size) throw Error('Mac ZIP size changed during verification');
  return { sha256: hash.digest('hex'), size };
}

async function artifact(input) {
  const { archive, commit, expectedHash, teamId, publicKey } = input;
  const match = stableZip.exec(basename(archive));
  if (!match || !match[1].split('.').every(n => Number.isSafeInteger(Number(n)))) throw Error('Expected canonical stable Mac ZIP name');
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !/^[A-Z0-9]{10}$/.test(teamId ?? '') || !sha256.test(expectedHash ?? '')) {
    throw Error('Expected a fixed source commit, Developer ID Team ID, and independently recorded ZIP SHA-256');
  }
  ed25519PublicKey(publicKey);
  const metadata = await hashArchive(archive);
  if (metadata.sha256 !== expectedHash) throw Error('Mac ZIP SHA-256 does not match the reviewed release artifact');
  const manifest = {
    schema: 1, version: match[1], platform: 'darwin', arch: match[2],
    name: basename(archive), size: metadata.size, sha256: metadata.sha256, bundleId, teamId,
  };
  const prefix = archive.slice(0, -4);
  return { archive, commit, publicKey, manifest, path: prefix + '.update.json', signaturePath: prefix + '.update.sig' };
}

function run(path, args) {
  const result = spawnSync(path, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 512 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  if (result.error || result.status !== 0) throw Error('Mac release evidence failed: ' + basename(path));
  return (result.stdout ?? '') + (result.stderr ?? '');
}

async function verifyAppleArchive({ archive, commit, manifest, publicKey }) {
  if (process.platform !== 'darwin') throw Error('Apple release evidence must be verified natively on macOS');
  const root = await mkdtemp(join(tmpdir(), 'mandala-apple-release-'));
  try {
    const copy = join(root, manifest.name), output = join(root, 'app');
    await copyFile(archive, copy);
    const beforeExtract = await hashArchive(copy);
    if (beforeExtract.sha256 !== manifest.sha256 || beforeExtract.size !== manifest.size) throw Error('Mac ZIP SHA-256 changed before extraction');
    run('/usr/bin/ditto', ['-x', '-k', copy, output]);
    const app = join(output, 'Mandala.app');
    const top = await readdir(output);
    if (top.length !== 1 || top[0] !== 'Mandala.app' || !(await lstat(app)).isDirectory()) throw Error('Canonical Mandala.app missing from reviewed ZIP');
    const plist = join(app, 'Contents', 'Info.plist');
    const field = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
    if (field('CFBundleIdentifier') !== manifest.bundleId || field('CFBundleShortVersionString') !== manifest.version) {
      throw Error('App bundle ID or version does not match the manifest');
    }
    const requirement = 'anchor apple generic and identifier "' + manifest.bundleId +
      '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' +
      ' and certificate leaf[subject.OU] = "' + manifest.teamId + '"';
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    run('/usr/bin/codesign', ['--verify', '--strict', '-R=' + requirement, app]);
    const gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    if (!/^source=Notarized Developer ID$/m.test(gatekeeper)) throw Error('Gatekeeper did not identify a notarized Developer ID app');
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    const executable = field('CFBundleExecutable');
    if (!/^[A-Za-z0-9_.-]+$/.test(executable) || executable === '.' || executable === '..') {
      throw Error('Invalid App bundle executable name');
    }
    const actualArch = run('/usr/bin/lipo', ['-archs', join(app, 'Contents', 'MacOS', executable)]).trim();
    if (actualArch !== (manifest.arch === 'arm64' ? 'arm64' : 'x86_64')) throw Error('App executable architecture does not match the manifest');
    const runtime = join(app, 'Contents', 'Resources', 'runtime');
    const configuration = JSON.parse(await readFile(join(runtime, 'public-update.json'), 'utf8'));
    if (!configuration || Array.isArray(configuration) || Object.keys(configuration).length !== 3 ||
        configuration.schema !== 1 || configuration.teamId !== manifest.teamId || configuration.publicKey !== publicKey) {
      throw Error('Signed app does not pin the intended release key and Developer ID team');
    }
    const build = JSON.parse(await readFile(join(runtime, 'build.json'), 'utf8'));
    if (build.version !== manifest.version || build.commit !== commit || build.platform !== 'darwin' ||
        build.arch !== manifest.arch || build.sourceDirty !== false || build.signingRequested !== true) {
      throw Error('App build receipt does not match the reviewed signed clean source, version and architecture');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertArchiveUnchanged({ archive, manifest }) {
  const latest = await hashArchive(archive);
  if (latest.sha256 !== manifest.sha256 || latest.size !== manifest.size) throw Error('Mac ZIP SHA-256 changed during Apple verification');
}

export async function prepareUpdateManifest(input, proveApple = verifyAppleArchive) {
  const data = await artifact(input);
  await proveApple(data);
  await assertArchiveUnchanged(data);
  await writeFile(data.path, JSON.stringify(data.manifest) + '\n', { mode: 0o644, flag: 'wx' });
  return data;
}

async function smallFile(path, max) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > max) throw Error('Release manifest or signature has invalid size');
  const contents = await readFile(path);
  if (contents.length !== stat.size) throw Error('Release metadata changed while verifying');
  return contents;
}

function ed25519PublicKey(pinned) {
  if (typeof pinned !== 'string' || !/^[A-Za-z0-9+/]{59}=$/.test(pinned)) throw Error('Invalid pinned Ed25519 public key encoding');
  const der = Buffer.from(pinned, 'base64');
  if (der.toString('base64') !== pinned) throw Error('Invalid pinned Ed25519 public key encoding');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Expected an Ed25519 release public key');
  return key;
}

export async function verifyUpdateFiles(input, proveApple = verifyAppleArchive) {
  const data = await artifact(input);
  const [bytes, signatureBytes] = await Promise.all([smallFile(data.path, 4096), smallFile(data.signaturePath, 89)]);
  const raw = signatureBytes.toString('utf8').replace(/\n$/, '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(raw)) throw Error('Invalid release signature encoding');
  const signature = Buffer.from(raw, 'base64');
  if (signature.toString('base64') !== raw || !verify(null, bytes, ed25519PublicKey(input.publicKey), signature)) {
    throw Error('Invalid release manifest signature');
  }
  if (!bytes.equals(Buffer.from(JSON.stringify(data.manifest) + '\n'))) throw Error('Signed release manifest does not match the exact canonical update artifact');
  await proveApple(data);
  await assertArchiveUnchanged(data);
  return data;
}

function isEntrypoint(path) {
  try { return realpathSync(path) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (process.argv[1] && isEntrypoint(process.argv[1])) {
  try {
    const [mode, archive, expectedHash, commit, ...extra] = process.argv.slice(2);
    if (!archive || extra.length > 0 || !['prepare', 'verify'].includes(mode)) {
      throw Error('Usage: node scripts/mac-public-update-release.mjs <prepare|verify> <canonical.zip> <recorded-sha256> <reviewed-source-commit>');
    }
    const input = { archive: resolve(archive), expectedHash, commit,
      teamId: process.env.MANDALA_PUBLIC_UPDATE_TEAM_ID, publicKey: process.env.MANDALA_PUBLIC_UPDATE_PUBLIC_KEY };
    const result = await (mode === 'prepare' ? prepareUpdateManifest(input) : verifyUpdateFiles(input));
    console.log(JSON.stringify({ mode, manifest: result.path, version: result.manifest.version, arch: result.manifest.arch, sha256: result.manifest.sha256 }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mac release verification failed');
    process.exitCode = 1;
  }
}
