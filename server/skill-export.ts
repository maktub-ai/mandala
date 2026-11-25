import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import type { Config } from '../shared/types';
import { DomainError } from '../shared/workspace-contracts';
import { readConfig } from './config';
import { createSkillCatalog } from './skill-catalog';
import { SKILL_PACKAGE_FILE_LIMIT } from './skill-package';
import type { Store } from './store';
import { workspacePrincipal } from './workspace-identity';

// ZIP stores the immutable bytes without compression; Unix attributes preserve script permissions.
function packageZip(files: { path: string; data: Buffer; executable: boolean }[]): Buffer {
  const localParts: Buffer[] = [], directoryParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path), checksum = crc32(file.data);
    if (name.length > 65535) throw new DomainError('invalid_skill_package', 422, 'Skill file path is too long');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(file.data.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((file.executable ? 0o100700 : 0o100600) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, name, file.data); directoryParts.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

export async function exportSkillPackage(home: string, store: Store, skillId: string, versionId: string): Promise<{ filename: string; data: Buffer }> {
  const catalog = createSkillCatalog(home, store), principal = workspacePrincipal(store);
  const select = (config: Config) => {
    const skill = config.skillLibrary?.find(item => item.id === skillId);
    if (!skill?.versionRef) throw new DomainError('not_found', 404, 'Managed Skill not found');
    const selected = { ...skill, versionRef: { assetId: skill.versionRef.assetId, versionId } };
    catalog.read(selected, undefined, config);
    return selected;
  };
  const skill = select((await readConfig(home)).config), ref = skill.versionRef;
  const version = catalog.assets.getAuthorizedVersion(principal, ref);
  if (version.files.length > SKILL_PACKAGE_FILE_LIMIT || version.files.reduce((total, file) => total + file.size, 0) > 250 * 1024 * 1024)
    throw new DomainError('invalid_skill_package', 422, 'Skill package exceeds export limits');
  const files: Parameters<typeof packageZip>[0] = [];
  for (const [index, file] of version.files.entries()) {
    if (file.size < 0 || file.size > 100 * 1024 * 1024 || !file.path || /[\\\0]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new DomainError('invalid_skill_package', 422, 'Invalid Skill package file');
    const authorized = catalog.assets.readAssetFile(principal, ref, String(index));
    const input = await open(authorized.blobPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      const info = await input.stat();
      if (!info.isFile() || info.size !== file.size) throw new DomainError('blob_changed', 409, 'Skill resource changed');
      const buffer = Buffer.alloc(file.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await input.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      data = buffer.subarray(0, total);
      if (total !== file.size || createHash('sha256').update(data).digest('hex') !== file.blobHash)
        throw new DomainError('blob_changed', 409, 'Skill resource changed');
    } finally { await input.close(); }
    files.push({ path: `${skill.name}/${file.path}`, data, executable: file.executable });
  }
  // Authorization can change during I/O; never send a partially authorized archive.
  if (select((await readConfig(home)).config).versionRef.assetId !== ref.assetId)
    throw new DomainError('skill_changed', 409, 'Skill registration changed');
  return { filename: `${skill.name}-v${version.ordinal}.zip`, data: packageZip(files) };
}
