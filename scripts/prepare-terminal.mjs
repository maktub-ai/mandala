// node-pty 1.1.0 ships its macOS spawn helper without executable permissions.
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
if (process.platform === 'darwin') {
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  for (const folder of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, folder, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
