import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveClaudeLauncher, verifyClaudeBridge } from '../server/claude-bridge';

const roots: string[] = [];
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'mandala-claude-bridge-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

it.skipIf(process.platform === 'win32')('binds the first installed Claude and ignores a competing ACP adapter on PATH', async () => {
  const selected = await scratch(), competing = await scratch();
  for (const root of [selected, competing]) await writeFile(join(root, 'claude'), '', {mode: 0o700});
  await writeFile(join(selected, 'claude-agent-acp'), '', {mode: 0o700});
  const env = {PATH: [selected, competing].join(delimiter)};
  expect(resolveClaudeLauncher(env)).toEqual({state: 'executable', path: join(selected, 'claude')});
  expect(resolveClaudeLauncher({...env, CLAUDE_CODE_EXECUTABLE: join(competing, 'claude')}))
    .toEqual({state: 'executable', path: join(competing, 'claude')});
  expect(resolveClaudeLauncher({...env, CLAUDE_CODE_EXECUTABLE: './claude'})).toEqual({state: 'missing'});
});

it('refuses to launch missing or modified bridge bytes', async () => {
  const file = join(await scratch(), 'claude-agent-acp.mjs');
  const bytes = 'a known bridge fixture';
  const expected = createHash('sha256').update(bytes).digest('hex');
  await expect(verifyClaudeBridge(file, expected)).rejects.toMatchObject({code: 'claude-bridge-missing'});
  await writeFile(file, bytes);
  await expect(verifyClaudeBridge(file, expected)).resolves.toBeUndefined();
  await writeFile(file, bytes + '!');
  await expect(verifyClaudeBridge(file, expected)).rejects.toMatchObject({code: 'claude-bridge-integrity'});
});

it.skipIf(process.platform === 'win32')('rejects redirects even when the target bytes match', async () => {
  const root = await scratch(), file = join(root, 'bridge.mjs'), target = join(root, 'target.mjs');
  const expected = createHash('sha256').update('bytes').digest('hex');
  await writeFile(target, 'bytes');
  await symlink(target, file);
  await expect(verifyClaudeBridge(file, expected)).rejects.toMatchObject({code: 'claude-bridge-integrity'});
});
