import {createHash, createPublicKey, verify} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import {basename, isAbsolute, normalize} from 'node:path';

// Offline release metadata only: this module does not verify Authenticode and must
// not be used as proof that an executable is safe to launch or an update is enabled.
const versionPattern = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const maxInstaller = 2 * 1024 ** 3;

export function prepareWindowsReceipt(expected) {
  const {version, platform, arch, name, size, sha256, commit, publisherSpkiSha256} = expected ?? {};
  if (typeof version !== 'string' || !versionPattern.test(version) || platform !== 'win32' || arch !== 'x64' ||
      name !== `Mandala-${version}-win-${arch}.exe` || !Number.isSafeInteger(size) || size < 1 || size > maxInstaller ||
      !hex(sha256, 64) || !hex(commit, 40) || !hex(publisherSpkiSha256, 64)) {
    throw Error('Invalid reviewed Windows installer metadata');
  }
  return Buffer.from(JSON.stringify({schema: 1, version, platform, arch, name, size, sha256, commit, publisherSpkiSha256}) + '\n');
}

/** Verify that the exact canonical receipt matches independently reviewed metadata and the pinned release key. */
export function verifyWindowsReceipt(bytes, signature, expected, pinnedReleaseKey) {
  if (!Buffer.isBuffer(bytes) || !Buffer.isBuffer(signature) || !bytes.equals(prepareWindowsReceipt(expected))) {
    throw Error('Windows installer receipt does not match reviewed metadata');
  }
  if (typeof pinnedReleaseKey !== 'string' || !/^[A-Za-z0-9+/]{59}=$/.test(pinnedReleaseKey)) {
    throw Error('Invalid pinned Ed25519 release key');
  }
  const keyBytes = Buffer.from(pinnedReleaseKey, 'base64');
  if (keyBytes.toString('base64') !== pinnedReleaseKey) throw Error('Invalid pinned Ed25519 release key');
  const key = createPublicKey({key: keyBytes, type: 'spki', format: 'der'});
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({type: 'spki', format: 'der'}).equals(keyBytes)) {
    throw Error('Invalid pinned Ed25519 release key');
  }

  // Allow one optional LF, not CRLF or trailing whitespace.
  if (signature.length !== 88 && !(signature.length === 89 && signature[88] === 10)) {
    throw Error('Invalid Windows installer receipt signature');
  }
  const encoded = signature.subarray(0, 88).toString('latin1');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw Error('Invalid Windows installer receipt signature');
  const proof = Buffer.from(encoded, 'base64');
  if (proof.toString('base64') !== encoded || !verify(null, bytes, key, proof)) {
    throw Error('Invalid Windows installer receipt signature');
  }
  return true;
}

const sameFile = (first, other) => other.isFile() &&
  first.dev === other.dev && first.ino === other.ino && first.size === other.size &&
  first.mtimeNs === other.mtimeNs && first.ctimeNs === other.ctimeNs;

/**
 * Verify an already staged local installer against the authenticated receipt.
 * The result is NOT launch authorization. A future native verifier must prove
 * Authenticode/publisher/architecture of the exact same bytes at its own entry.
 */
export async function verifyWindowsInstallerBytes(path, bytes, signature, expected, pinnedReleaseKey, currentVersion) {
  verifyWindowsReceipt(bytes, signature, expected, pinnedReleaseKey);
  const {version, platform, arch, name, size, sha256, commit, publisherSpkiSha256} = JSON.parse(bytes.toString('utf8'));
  if (typeof currentVersion !== 'string' || !versionPattern.test(currentVersion)) {
    throw Error('Expected an installed stable Windows version');
  }
  const previous = currentVersion.split('.').map(Number);
  const next = version.split('.').map(Number);
  const difference = next.findIndex((value, index) => value !== previous[index]);
  if (difference < 0 || next[difference] < previous[difference]) throw Error('Windows installer must be newer');
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || basename(path) !== name ||
      await realpath(path) !== path) throw Error('Expected canonical Windows installer path');

  const before = await lstat(path, {bigint: true});
  if (!before.isFile()) throw Error('Expected a regular Windows installer file');
  if (before.size !== BigInt(size)) throw Error('Windows installer size does not match the receipt');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, await handle.stat({bigint: true}))) throw Error('Windows installer changed before reading');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total <= size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, size - total + 1), total);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      total += read.bytesRead;
    }
    if (total !== size) throw Error('Windows installer size changed during reading');
    if (!sameFile(before, await handle.stat({bigint: true})) || !sameFile(before, await lstat(path, {bigint: true})) ||
        await realpath(path) !== path) throw Error('Windows installer changed during reading');
    if (hash.digest('hex') !== sha256) throw Error('Windows installer SHA-256 does not match the receipt');
    return Object.freeze({sha256, size, commit, version, platform, arch, publisherSpkiSha256, authenticode: 'required'});
  } finally {
    await handle.close();
  }
}
