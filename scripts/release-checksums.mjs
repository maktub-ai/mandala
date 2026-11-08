import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const directory = resolve(process.argv[2] ?? 'release/desktop');
const files = (await readdir(directory)).filter(name => /\.(dmg|zip|exe|tar\.gz)$/.test(name)).sort();
if (!files.length) throw new Error('No release installers or service archives to checksum');
const rows = await Promise.all(files.map(async name => createHash('sha256').update(await readFile(join(directory, name))).digest('hex') + '  ' + name));
await writeFile(join(directory, 'SHA256SUMS.txt'), rows.join('\n') + '\n');
console.log(rows.join('\n'));
