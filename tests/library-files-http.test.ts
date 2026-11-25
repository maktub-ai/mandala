import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { githubPluginSource } from '../shared/market';
import { libraryFilesPath } from '../shared/library-files';
import { readConfig } from '../server/config';
import { createHttpServer } from '../server/http';
import { createMarket } from '../server/market';
import { createSessionManager } from '../server/sessions';
import { openStore } from '../server/store';
import { handbookEntry, handbookFiles, planEntry, planFiles } from './fixtures/data-plugin';

it('serves each installed section’s scoped file and grants loopback only when declared', async () => {
  const home = await mkdtemp(join(tmpdir(), 'todo-plan-http-'));
  const workspace = join(home, 'todo-workspace');
  const other = join(home, 'empty-workspace');
  const planDir = join(home, 'omino', 'projects', 'todo-weekly');
  vi.stubEnv('OMINO_HOME', join(home, 'omino'));
  const store = openStore(home);
  const manager = createSessionManager(store, async () => (await readConfig(home)).config);
  const market = createMarket(home, async url => {
    if (url.endsWith('/second/catalog/main/catalog.json')) return Response.json({ format: 'mandala-plugin-catalog', version: 1, items: [planEntry] });
    if (url.endsWith('/main/catalogs/v2/catalog.json')) return Response.json({ format: 'mandala-plugin-catalog', version: 1, items: [planEntry, handbookEntry] });
    const files = url.includes('/todo-handbook/') ? handbookFiles : planFiles;
    return new Response(files[url.split('/').pop()!]);
  });
  const server = createHttpServer({ home, store, manager, market, requireIdentity: false });
  try {
    await Promise.all([workspace, other, planDir].map(dir => mkdir(dir, { recursive: true })));
    const projects = [{ id: 'todo-app', cwd: workspace }, { id: 'side-project', cwd: other }].map(p => ({ ...p, name: p.id, agentIds: [], resources: [], mcp: [], skills: [] }));
    await writeFile(join(home, 'config.json'), JSON.stringify({ version: 2, projects, agents: [] }));
    await writeFile(join(workspace, '.omino.json'), JSON.stringify({ project: 'todo-weekly' }));
    await writeFile(join(planDir, 'view.html'), '<h1>Weekly tasks</h1>');
    await writeFile(join(planDir, '.serve.json'), 'private');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const listUrl = origin + '/api/v2/library-sections/plan/files';
    const catalogId = 'plugin:maktub-ai/mandala-plugins:' + planEntry.id;
    const providerFiles = origin + libraryFilesPath(catalogId);
    const viewUrl = providerFiles + '/todo-weekly/view.html?project=todo-app';
    expect((await fetch(listUrl)).status).toBe(404);
    expect((await fetch(viewUrl)).status).toBe(404);
    const installed = await market.extensions.install({ catalogId, version: planEntry.version, digest: planEntry.package.sha256, revision: (await market.extensions.read()).revision });
    const { projects: groups } = await (await fetch(listUrl)).json();
    expect(groups).toHaveLength(1);
    expect(origin + groups[0].files[0].viewUrl).toBe(viewUrl);
    const view = await fetch(viewUrl);
    expect(view.status).toBe(200);
    expect(view.headers.get('content-type')).toContain('text/html');
    expect(view.headers.get('referrer-policy')).toBe('no-referrer');
    expect(view.headers.get('content-security-policy')).toBe("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src http://127.0.0.1:*");
    expect(await view.text()).toBe('<h1>Weekly tasks</h1>');
    expect((await fetch(listUrl + '/todo-weekly/view.html?project=todo-app')).status).toBe(404);
    expect((await fetch(providerFiles + '/todo-weekly/.serve.json?project=todo-app')).status).toBe(404);
    expect((await fetch(providerFiles + '/todo-weekly/view.html?project=side-project')).status).toBe(404);
    expect((await fetch(providerFiles + '/bad%2fid/view.html?project=todo-app')).status).toBe(404);
    expect((await fetch(viewUrl, { method: 'POST' })).status).toBe(405);
    await mkdir(join(workspace, 'docs'));
    await writeFile(join(workspace, 'docs/handbook.html'), '<h1>Handbook</h1>');
    const bookUrl = origin + '/api/v2/library-sections/handbook/files';
    expect((await fetch(bookUrl)).status).toBe(404);
    const both = await market.extensions.install({ catalogId: 'plugin:maktub-ai/mandala-plugins:' + handbookEntry.id,
      version: handbookEntry.version, digest: handbookEntry.package.sha256, revision: installed.revision });
    const { projects: books } = await (await fetch(bookUrl)).json();
    const handbook = await fetch(origin + books[0].files[0].viewUrl);
    expect(await handbook.text()).toBe('<h1>Handbook</h1>');
    expect(handbook.headers.get('content-security-policy')).toMatch(/connect-src 'none'$/);
    expect((await fetch(bookUrl + '/todo-weekly/view.html?project=todo-app')).status).toBe(404);
    expect((await fetch(viewUrl.replace('todo-weekly', 'default'))).status).toBe(404);
    // A different provider can claim the short tab ID. Previously issued browser URLs stay provider-scoped.
    const source = githubPluginSource('Other catalog', 'https://github.com/second/catalog');
    const catalog = await market.sources();
    await market.saveSources({ sources: [source], enabled: [source.id], revision: catalog.revision });
    const otherId = 'plugin:second/catalog:' + planEntry.id;
    const collision = await market.extensions.install({ catalogId: otherId, version: planEntry.version,
      digest: planEntry.package.sha256, revision: both.revision });
    await market.extensions.uninstall(catalogId, collision.revision);
    const alias = await (await fetch(listUrl)).json();
    const replacementUrl = alias.projects[0].files[0].viewUrl;
    expect(replacementUrl).toBe(libraryFilesPath(otherId) + '/todo-weekly/view.html?project=todo-app');
    expect((await fetch(origin + replacementUrl)).status).toBe(200);
    expect((await fetch(origin + books[0].files[0].viewUrl)).status).toBe(200);
    expect((await fetch(viewUrl)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    manager.close(); store.close(); vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
