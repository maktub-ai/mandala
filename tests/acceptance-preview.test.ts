import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHttpServer } from '../server/http';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import { readConfig } from '../server/config';

afterEach(() => vi.unstubAllEnvs());
test.each([false, true])('local sessions identify an explicit acceptance preview: %s', async preview => {
  vi.stubEnv('MANDALA_ACCEPTANCE_PREVIEW', preview ? '1' : '0');
  const home = mkdtempSync(join(tmpdir(), 'mandala-preview-test-'));
  const store = openStore(home), manager = createSessionManager(store, async () => (await readConfig(home)).config, undefined, undefined, home);
  const servers = [createHttpServer({ home, store, manager })];
  try {
    for (const server of servers) {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const session = await (await fetch(origin + '/auth/session')).json();
      expect(session.preview).toBe(preview ? true : undefined);
      expect(session.user).toBeNull();
    }
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    await manager.close(); store.close(); rmSync(home, { recursive: true, force: true });
  }
});
