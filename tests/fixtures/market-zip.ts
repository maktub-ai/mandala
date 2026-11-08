import { deflateRawSync } from "node:zlib";

// Synthetic ZIPs let source tests exercise traversal, symlinks and manifest integrity.
export function marketZip(files: { path: string; content: string; mode?: number }[]) {
  const locals: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path), data = Buffer.from(file.content), compressed = deflateRawSync(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); directory.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const entries = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(entries.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, entries, end]);
}
