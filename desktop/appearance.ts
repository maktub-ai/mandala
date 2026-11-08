import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// This store accepts one bounded JSON document, never a renderer-selected file path.
function validate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4 * 1024 * 1024) throw Error('Invalid desktop appearance');
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || parsed.version !== 1) throw Error('Invalid desktop appearance');
}
export function readDesktopAppearance(home: string): string | null {
  try {
    const path = join(home, 'desktop-appearance.json');
    if (statSync(path).size > 4 * 1024 * 1024) throw Error('Invalid desktop appearance');
    const value = readFileSync(path, 'utf8'); validate(value); return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function writeDesktopAppearance(home: string, value: unknown): void {
  validate(value);
  const path = join(home, 'desktop-appearance.json'), temporary = path + '.tmp';
  writeFileSync(temporary, value, { mode: 0o600 }); renameSync(temporary, path);
}
