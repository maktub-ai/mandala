import {createPublicKey, verify} from 'node:crypto';

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
