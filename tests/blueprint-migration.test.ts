import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { previewBlueprintMigration } from '../server/blueprint-migration';
import { planEntry, planManifest, planSection } from './fixtures/data-plugin';

let temp: string, profile: string, plans: string, store: string;
const write = async (path: string, content: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
};
const project = (id: string, ...paths: string[]) => ({
  id, name: id, cwd: paths[0], agentIds: [], resources: [], skills: [], mcp: [],
  workspaces: paths.map((cwd, i) => ({ id: 'w' + i, name: 'Workspace', cwd, resources: [] })),
});
const install = async (repository = 'maktub-ai/mandala-plugins') => {
  const catalogId = 'plugin:' + repository + ':omino';
  const plugin = { ...planEntry, id: 'omino', package: { ...planEntry.package, repository }, catalogId,
    installedAt: '2026-01-01T00:00:00Z', manifest: { ...planManifest, id: 'omino' },
    items: [{ catalogId: catalogId + '/library-section:plan', kind: 'library-section', data: planSection }],
  };
  await write(store, { version: 2, items: [], plugins: [plugin] });
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args]);
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'blueprint-upgrade-'));
  profile = join(temp, 'profile'); plans = join(temp, 'plans', 'projects');
  store = join(profile, 'market', 'ui-extensions.json');
  vi.stubEnv('OMINO_HOME', dirname(plans));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });

it('only inspects an installed official plugin and never initializes missing files', async () => {
  expect(await previewBlueprintMigration(profile)).toEqual({ installed: false, projects: [] });
  expect(await readdir(temp)).toEqual([]);
  await install('example/catalog');
  expect(await previewBlueprintMigration(profile)).toEqual({ installed: false, projects: [] });
  await install();
  expect(await previewBlueprintMigration(profile)).toEqual({ installed: true, projects: [] });
  expect(await readdir(profile)).toEqual(['market']);
});

it('separates repository bindings, conflicts, historical candidates and unrelated projects without writes', async () => {
  const a = join(temp, 'a'), b = join(temp, 'b'), history = join(temp, 'old'), empty = join(temp, 'empty');
  await install();
  for (const id of ['a-plan', 'b-plan']) await write(join(plans, id, 'project.md'), '# Plan');
  await write(join(a, '.omino.json'), { project: 'a-plan' });
  await write(join(b, '.omino.json'), { project: 'b-plan' });
  await write(join(plans, 'b-plan', '.paths.json'), { [history]: '2026-01-01' });
  await write(join(profile, 'config.json'), { projects: [
    project('first', a), project('shared', a), project('both', a, b), project('history', history), project('empty', empty),
  ] });
  const original = await Promise.all([store, join(profile,'config.json'), join(plans,'a-plan','project.md')].map(path => readFile(path)));
  const preview = await previewBlueprintMigration(profile);
  expect(preview.projects.map(({projectId,status,planId}) => [projectId,status,planId])).toEqual([
    ['first','bound','a-plan'], ['shared','bound','a-plan'], ['both','conflict',null], ['history','candidate',null], ['empty','unbound',null],
  ]);
  expect(preview.projects[2].evidence.map(row => row.planId).sort()).toEqual(['a-plan','b-plan']);
  expect(preview.projects[3].evidence[0]).toMatchObject({ planId:'b-plan', source:'path-history' });
  expect(await previewBlueprintMigration(profile)).toEqual(preview);
  expect(await Promise.all([store, join(profile,'config.json'), join(plans,'a-plan','project.md')].map(path => readFile(path)))).toEqual(original);
});

it('uses the common binding from a nested linked worktree and reports disagreement with the primary checkout', async () => {
  const repo=join(temp,'main'), linked=join(temp,'linked'), nested=join(linked,'src');
  await mkdir(repo); git(repo,'init','-q'); git(repo,'commit','--allow-empty','-qm','fixture'); git(repo,'worktree','add','-q','--detach',linked);
  await mkdir(nested); await install();
  for (const id of ['main-plan','branch-plan']) await write(join(plans,id,'project.md'),'# Plan');
  await write(join(repo,'.git','omino-project'),'main-plan\n');
  await write(join(profile,'config.json'),{projects:[project('linked',nested)]});
  expect((await previewBlueprintMigration(profile)).projects[0]).toMatchObject({status:'bound',planId:'main-plan'});
  await rm(join(repo,'.git','omino-project'));
  await write(join(linked,'.omino.json'),{project:'branch-plan'});
  expect((await previewBlueprintMigration(profile)).projects[0]).toMatchObject({status:'candidate',planId:null});
  await write(join(repo,'.omino.json'),{project:'main-plan'});
  expect((await previewBlueprintMigration(profile)).projects[0]).toMatchObject({status:'conflict',planId:null});
});

it('keeps dangling bindings pending and does not inspect remote workspaces as local directories', async () => {
  const repo=join(temp,'repo');
  await install(); await write(join(repo,'.omino.json'),{project:'missing-plan'});
  const remote=project('remote',repo);
  await write(join(profile,'config.json'),{projects:[project('dangling',repo),{...remote,workspaces:remote.workspaces.map(w=>({...w,machineId:'away'}))}]});
  const {projects}=await previewBlueprintMigration(profile);
  expect(projects[0]).toMatchObject({status:'candidate',planId:null});
  expect(projects[1]).toMatchObject({status:'unbound',planId:null});
});


it('requires review when a path-only workspace disagrees with a bound workspace', async () => {
  const repo = join(temp, 'repo'), other = join(temp, 'old');
  await install();
  await write(join(repo, '.omino.json'), { project: 'stable' });
  for (const id of ['stable', 'old']) await write(join(plans, id, 'project.md'), '# Plan');
  await write(join(plans, 'old', '.paths.json'), { [other]: '2026-01-01' });
  await write(join(profile, 'config.json'), { projects: [project('mixed', repo, other)] });
  const result = (await previewBlueprintMigration(profile)).projects[0];
  expect(result).toMatchObject({ status: 'conflict', planId: null });
  expect(result.evidence.map(row => row.source)).toEqual(['marker', 'path-history']);
});

it('does not promote a feature marker in the primary checkout over the known default branch', async () => {
  const repo = join(temp, 'source');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await write(join(repo, '.omino.json'), { project: 'default-plan' });
  git(repo, 'add', '.omino.json');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'switch', '-qc', 'feature');
  await write(join(repo, '.omino.json'), { project: 'feature-plan' });
  for (const id of ['default-plan', 'feature-plan']) await write(join(plans, id, 'project.md'), '# Plan');
  await install();
  await write(join(profile, 'config.json'), { projects: [project('repo', repo)] });
  const result = (await previewBlueprintMigration(profile)).projects[0];
  expect(result.status).toBe('conflict');
  expect(result.planId).toBeNull();
  expect(result.evidence.map(row => row.planId).sort()).toEqual(['default-plan', 'feature-plan']);
});

it('keeps a checkout marker as a candidate when Git has no known default branch', async () => {
  const repo = join(temp, 'repo');
  await mkdir(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'commit', '--allow-empty', '-qm', 'base');
  git(repo, 'switch', '-qc', 'feature');
  await write(join(repo, '.omino.json'), { project: 'feature' });
  await write(join(plans, 'feature', 'project.md'), '# Plan');
  await install();
  await write(join(profile, 'config.json'), { projects: [project('repo', repo)] });
  const result = (await previewBlueprintMigration(profile)).projects[0];
  expect(result).toMatchObject({ status: 'candidate', planId: null, evidence: [{ source: 'worktree-marker', planId: 'feature' }] });
});

it('retains known evidence when another checkout has unreadable Git metadata', async () => {
  const stable = join(temp, 'stable'), broken = join(temp, 'broken');
  await write(join(stable, '.omino.json'), { project: 'stable' });
  await write(join(broken, '.git'), 'gitdir: /unavailable/repository\n');
  await write(join(plans, 'stable', 'project.md'), '# Plan');
  await install();
  await write(join(profile, 'config.json'), { projects: [project('mixed', stable, broken), project('other', stable)] });
  const { projects } = await previewBlueprintMigration(profile);
  expect(projects[0]).toMatchObject({ status: 'candidate', planId: null });
  expect(projects[0].evidence.map(row => row.source)).toEqual(['marker', 'unverified-repository']);
  expect(projects[1]).toMatchObject({ status: 'bound', planId: 'stable' });
});

it('upgrades an installed profile once, adopts the existing plan and preserves every source byte',async()=>{
 const {readConfig,writeConfig}=await import('../server/config');
 const {migrateLegacyBlueprint}=await import('../server/blueprint-migration');
 const repo=join(temp,'existing'),id='original';
 const note='---\nid: project\nkind: intent\ntitle: Independent plan\n---\n## Purpose\nKeep the original.\n';
 await install();await write(join(repo,'.omino.json'),{project:id});await write(join(plans,id,'project.md'),note);
 const {config,revision}=await readConfig(profile);
 await mkdir(join(temp,'elsewhere'));config.projects=[project('mapped',repo),project('other',join(temp,'elsewhere'))];
 await writeConfig(profile,config,revision);
 await migrateLegacyBlueprint(profile);await migrateLegacyBlueprint(profile);
 const saved=(await readConfig(profile)).config;
 expect(saved.projects[0]).toMatchObject({blueprintEnabled:true,planId:id});
 expect(saved.projects[1].blueprintEnabled).toBeFalsy();
 expect((await previewBlueprintMigration(profile)).installed).toBe(false);
 expect(await readFile(join(plans,id,'project.md'),'utf8')).toBe(note);
 expect(await readdir(join(plans,id))).toEqual(['project.md']);
});

it('keeps the old reader for an ambiguous mapping until the human selects a plan',async()=>{
 const {readConfig,writeConfig}=await import('../server/config');
 const {migrateLegacyBlueprint}=await import('../server/blueprint-migration');
 const {createBlueprintService}=await import('../server/blueprint');
 const dirs=['one','two'].map(id=>join(temp,id));
 await install();
 for(const [i,id] of ['plan-one','plan-two'].entries()){
  await write(join(dirs[i],'.omino.json'),{project:id});
  await write(join(plans,id,'project.md'),'---\nid: project\nkind: intent\ntitle: Fixture\n---\n');
 }
 const {config,revision}=await readConfig(profile);config.projects=[project('mixed',...dirs)];await writeConfig(profile,config,revision);
 await migrateLegacyBlueprint(profile);
 expect((await previewBlueprintMigration(profile)).installed).toBe(true);
 const service=createBlueprintService(profile);expect((await service.state('mixed')).status).toBe('conflict');
 await service.disable('mixed');await migrateLegacyBlueprint(profile);
 expect((await service.state('mixed')).enabled).toBe(false);await service.enable('mixed');
 await service.bind('mixed','plan-two');await migrateLegacyBlueprint(profile);
 expect((await previewBlueprintMigration(profile)).installed).toBe(false);
 expect((await service.state('mixed')).planId).toBe('plan-two');
});
it('hides the retired official entry in an old catalog and rejects installation by its old ID',async()=>{
 const {createUiExtensions}=await import('../server/market-ui-extensions');
 const {retiredBlueprintPlugin}=await import('../shared/data-plugins');
 const ext=createUiExtensions(profile,async()=>new Response(JSON.stringify({format:'mandala-plugin-catalog',version:1,items:[{...planEntry,id:'omino'},planEntry]})));
 expect((await ext.pluginCatalog()).map(p=>p.catalogId)).toEqual(['plugin:maktub-ai/mandala-plugins:'+planEntry.id]);
 await expect(ext.install({catalogId:retiredBlueprintPlugin,version:planEntry.version,digest:planEntry.package.sha256,revision:(await ext.read()).revision})).rejects.toThrow('not found');
});
