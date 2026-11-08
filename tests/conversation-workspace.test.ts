import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import * as fsPromises from "node:fs/promises";
import * as configModule from "../server/config";
import type { Server } from "node:http";
import { conversationEnvironment, listConversationWorkspace, readConversationWorkspaceFile } from "../server/conversation-workspace";
import { createHttpServer } from "../server/http";
import { createSessionManager, type SessionManager } from "../server/sessions";
import { openStore, type Store } from "../server/store";
import { readConfig } from "../server/config";
import { DomainError } from "../shared/workspace-contracts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

let home: string, cwd: string, store: Store | undefined, manager: SessionManager | undefined, server: Server | undefined;
beforeEach(async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fsPromises.realpath).mockImplementation(original.realpath);
  home = mkdtempSync(join(tmpdir(), "mana-workspace-")); cwd = join(home, "work"); mkdirSync(cwd);
});
afterEach(async () => {
  vi.restoreAllMocks();
  manager?.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  store?.close(); server = undefined; manager = undefined; store = undefined;
  rmSync(home, { recursive: true, force: true });
});
const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const file = (path: string, text: string | Buffer) => { mkdirSync(join(cwd, path, ".."), { recursive: true }); writeFileSync(join(cwd, path), text); };

it('shows committed branch changes against the merge base without unrelated working files', async () => {
  git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
  file('src/a.txt','before\n'); file('deleted.txt','deleted\n'); git('add','.'); git('commit','-m','base');
  git('checkout','-b','feature'); file('src/a.txt','committed\n'); git('rm','deleted.txt');
  file('added.txt','added\n'); file('.env','private'); git('add','.'); git('commit','-m','feature');
  git('checkout','main'); file('main-only.txt','not a branch change\n'); git('add','main-only.txt'); git('commit','-m','advance main'); git('checkout','feature');
  file('src/a.txt','uncommitted\n'); file('unrelated.txt','noise\n');
  const listing=await listConversationWorkspace(cwd,'branch');
  expect(listing.files).toEqual([
    {path:'added.txt',status:'A ',additions:1,deletions:0},
    {path:'deleted.txt',status:'D ',additions:0,deletions:1},
    {path:'src/a.txt',status:'M ',additions:1,deletions:1},
  ]);
  expect((await readConversationWorkspaceFile(cwd,'src/a.txt','branch')).text).toBe('committed\n');
  expect((await readConversationWorkspaceFile(cwd,'src/a.txt','branch')).diff).toContain('+committed');
  expect((await readConversationWorkspaceFile(cwd,'deleted.txt','branch')).diff).toContain('-deleted');
  expect((await listConversationWorkspace(join(cwd,'src'),'branch')).files).toEqual([{path:'a.txt',status:'M ',additions:1,deletions:1}]);
  await expect(readConversationWorkspaceFile(cwd,'.env','branch')).rejects.toMatchObject({status:403});
  expect((await listConversationWorkspace(cwd,'branch',undefined,'refs/heads/feature')).files).toEqual([]);
  await expect(listConversationWorkspace(cwd,'branch',undefined,'--output=/tmp/unwanted')).rejects.toMatchObject({status:409});
  git('checkout','--detach');
  expect((await listConversationWorkspace(cwd,'branch')).files).toEqual(listing.files);
});

it('keeps available refs recoverable when main has no default base or histories are unrelated', async()=>{
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  file('code.txt','before\n');git('add','.');git('commit','-m','base');git('branch','baseline');
  file('code.txt','committed\n');git('add','.');git('commit','-m','change');
  const unavailable=await listConversationWorkspace(cwd,'branch');
  expect(unavailable.comparison).toMatchObject({baseRef:'',baseRefs:['refs/heads/baseline','refs/heads/main'],error:'No comparison base is available for this branch'});
  expect((await listConversationWorkspace(cwd,'branch',undefined,'refs/heads/baseline')).files).toEqual([{path:'code.txt',status:'M ',additions:1,deletions:1}]);
  git('checkout','--orphan','unrelated');git('add','.');git('commit','-m','unrelated');git('checkout','main');
  const unrelated=await listConversationWorkspace(cwd,'branch',undefined,'refs/heads/unrelated');
  expect(unrelated.comparison).toMatchObject({baseRef:'refs/heads/unrelated',error:'No common ancestor is available for this branch'});
  expect(unrelated.comparison?.baseRefs).toContain('refs/heads/baseline');
  await expect(readConversationWorkspaceFile(cwd,'code.txt','branch','refs/heads/unrelated')).rejects.toMatchObject({status:409});
  expect((await listConversationWorkspace(cwd,'branch',undefined,'refs/heads/baseline')).files).toHaveLength(1);
});

it('reports missing branch history and handles committed binary changes', async()=>{
  git('init','-b','main');
  expect((await listConversationWorkspace(cwd,'branch')).comparison).toMatchObject({error:'No comparison base is available for this branch',baseRefs:[]});
  git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  file('image.bin',Buffer.from([0,1]));git('add','.');git('commit','-m','base');git('checkout','-b','feature');
  file('image.bin',Buffer.from([0,2]));git('add','.');git('commit','-m','binary');
  expect((await listConversationWorkspace(cwd,'branch')).files).toEqual([{path:'image.bin',status:'M ',additions:null,deletions:null,binary:true}]);
  expect(await readConversationWorkspaceFile(cwd,'image.bin','branch')).toMatchObject({binary:true,text:''});
});

it("lists safe nested files in ordinary directories and reads nested text without arbitrary host access", async () => {
  file("hello.ts", "const greeting = '你好';\n"); file("nested/readme.md", "# Notes");
  file(".env.local", "private"); file("auth.json", "private");
  file("nested/.ssh/secret.txt", "private"); file("node_modules/library/index.js", "dependency");
  writeFileSync(join(home, "outside.txt"), "private"); symlinkSync(home, join(cwd, "linked"));
  const listing = await listConversationWorkspace(cwd);
  expect(listing).toEqual({ cwd, git: false, files: [{ path: "hello.ts", status: "" }, { path: "nested/readme.md", status: "" }], directories: ["nested"], truncated: false });
  expect(await readConversationWorkspaceFile(cwd, "nested/readme.md")).toMatchObject({ name: "readme.md", path: "nested/readme.md", text: "# Notes", language: "markdown", diff: null });
  for (const path of ["../outside.txt", "/etc/passwd", "nested/../hello.ts", "nested\\readme.md", ".env.local", "auth.json", ".ssh/key", ".aws/config", ".codex/config.toml", ".git/config", "credentials.json", "secrets/token.txt"]) {
    await expect(readConversationWorkspaceFile(cwd, path)).rejects.toMatchObject({ status: expect.any(Number) });
  }
});

it("bounds discovery in large ordinary document folders", async () => {
  for (let index=0; index<1010; index++) file("notes/"+index+".md", "# Note");
  const listing=await listConversationWorkspace(cwd);
  expect(listing.truncated).toBe(true);
  expect(listing.files.length).toBeGreaterThan(0);
  expect(listing.files.length).toBeLessThanOrEqual(1000);
});

it("rejects symlink escapes, binary files, large files and missing files", async () => {
  writeFileSync(join(home, "outside.txt"), "private");
  symlinkSync(join(home, "outside.txt"), join(cwd, "link.txt"));
  symlinkSync(home, join(cwd, "linked"));
  file("binary.bin", Buffer.from([0, 1, 2])); file("large.txt", Buffer.alloc(1024 * 1024 + 1, 65));
  await expect(readConversationWorkspaceFile(cwd, "link.txt")).rejects.toMatchObject({ status: 403 });
  await expect(readConversationWorkspaceFile(cwd, "linked/outside.txt")).rejects.toMatchObject({ status: 403 });
  await expect(readConversationWorkspaceFile(cwd, "binary.bin")).rejects.toMatchObject({ status: 415 });
  await expect(readConversationWorkspaceFile(cwd, "large.txt")).rejects.toMatchObject({ status: 413 });
  await expect(readConversationWorkspaceFile(cwd, "missing.txt")).rejects.toMatchObject({ status: 404 });
  expect((await listConversationWorkspace(cwd)).files.map(f => f.path)).not.toContain("link.txt");
});

it("does not expose files when the working directory itself is a credentials directory", async () => {
  for (const name of [".aws", "credentials", "credentials.json", "secrets", "secret", "auth", "auth.json", ".env", ".env.local"]) {
    const credentials = join(home, name); mkdirSync(credentials); writeFileSync(join(credentials, "config"), "private configuration");
    await expect(listConversationWorkspace(credentials), name).rejects.toMatchObject({ status: 403 });
    await expect(readConversationWorkspaceFile(credentials, "config"), name).rejects.toMatchObject({ status: 403 });
  }
});

it("lists tracked, untracked and deleted files and shows net staged and unstaged changes without invoking configured diff programs", async () => {
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  file("src/code.ts", "const value = 1;\n"); file("deleted.md", "before deletion\n"); file(".env", "secret\n");
  git("add", "."); git("commit", "-m", "fixture");
  file("src/code.ts", "const value = 2;\n"); git("add", "src/code.ts"); file("src/code.ts", "const value = 3;\n");
  rmSync(join(cwd, "deleted.md")); file("new file.md", "new\n"); file(".env", "changed secret\n");
  git("config", "diff.external", "must-not-execute");
  const listing = await listConversationWorkspace(cwd);
  expect(listing.git).toBe(true);
  expect(listing.files).toEqual([{ path: "deleted.md", status: " D" }, { path: "new file.md", status: "??" }, { path: "src/code.ts", status: "MM" }]);
  const preview = await readConversationWorkspaceFile(cwd, "src/code.ts");
  expect(preview.text).toBe("const value = 3;\n");
  expect(preview.diff).toContain("-const value = 1;"); expect(preview.diff).not.toContain("+const value = 2;"); expect(preview.diff).toContain("+const value = 3;");
  expect(await readConversationWorkspaceFile(cwd, "deleted.md")).toMatchObject({ text: "", diff: expect.stringContaining("-before deletion") });
  expect((await readConversationWorkspaceFile(cwd, "new file.md")).diff).toContain("+new");
  expect((await listConversationWorkspace(join(cwd, "src"))).files).toEqual([{ path: "code.ts", status: "MM" }]);
});

it("keeps renamed filenames and Git subdirectory paths literal, including spaces and pathspec magic", async () => {
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  file(" original/old name.md", "rename fixture\n"); file(":(glob)*.md", "literal fixture\n");
  git("add", "."); git("commit", "-m", "fixture"); git("mv", " original/old name.md", " original/new name.md");
  expect((await listConversationWorkspace(join(cwd, " original"))).files).toEqual([{ path: "new name.md", status: "R " }]);
  expect((await readConversationWorkspaceFile(cwd, ":(glob)*.md")).diff).toBeNull();
});

it.each(["clean", "process"])("never executes the repository's %s filter during workspace listing or diff", async driver => {
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  file("code.txt", "old\n"); git("add", "."); git("commit", "-m", "fixture");
  const marker = join(home, "filter-executed"), script = join(home, "filter.cjs");
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); ${driver === "clean" ? "process.stdin.pipe(process.stdout);" : "process.exit(1);"}`);
  file(".gitattributes", "code.txt filter=probe\n"); file("code.txt", "new\n");
  git("config", `filter.probe.${driver}`, `${process.execPath} ${script}`); git("config", "filter.probe.required", "true");
  expect((await listConversationWorkspace(cwd)).git).toBe(true);
  const preview = await readConversationWorkspaceFile(cwd, "code.txt");
  expect(preview.diff).toContain("+new");
  await expect(fsPromises.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])("rejects a file that changes after text/diff loading, initially missing=%s", async missing => {
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  file("code.txt", "old\n"); git("add", "."); git("commit", "-m", "fixture");
  if (missing) rmSync(join(cwd, "code.txt")); else file("code.txt", "initial preview\n");
  const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).realpath;
  let checks = 0;
  vi.spyOn(fsPromises, "realpath").mockImplementation((async (path: Parameters<typeof original>[0], options?: any) => {
    if (String(path) === cwd && ++checks === 2) file("code.txt", "changed while loading\n");
    return original(path, options);
  }) as typeof original);
  await expect(readConversationWorkspaceFile(cwd, "code.txt")).rejects.toMatchObject({ status: 409 });
});

it("bounds ordinary directory listings", async () => {
  for (let i = 0; i < 1005; i++) file(`file-${i}.txt`, "ok");
  const listing = await listConversationWorkspace(cwd);
  expect(listing.files.length).toBeLessThanOrEqual(1000); expect(listing.truncated).toBe(true);
});

it("serves only the conversation's cwd, preserves origin protection and rechecks authorization before returning content", async () => {
  file("hello.ts", "export const value = 1;\n");
  store = openStore(home); manager = createSessionManager(store, async () => (await readConfig(home)).config);
  const chat = store.createConversation({ projectId: "", agentId: "", cli: "codex", model: null, cwd });
  server = createHttpServer({requireIdentity:false, home, store, manager }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/conversations/${chat.id}`;
  const auth = vi.spyOn(manager, "authorizeConversationRead");
  const listing = await fetch(url + "/workspace"); expect(listing.status).toBe(200); expect((await listing.json()).cwd).toBe(cwd); expect(auth).toHaveBeenCalledTimes(2);
  const preview = (path: string, origin?: string) => fetch(url + "/workspace-file", { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ path }) });
  expect((await preview("hello.ts", "https://evil.example")).status).toBe(403);
  expect((await preview("../outside.txt")).status).toBe(403);
  expect((await preview("hello.ts")).status).toBe(200);
  const originalConfigRead = configModule.readConfig;
  let configReads = 0;
  const configSpy = vi.spyOn(configModule, "readConfig").mockImplementation(async (...args) => {
    if (++configReads === 2) auth.mockImplementationOnce(() => { throw new DomainError("conversation_read", 403, "Read denied during config refresh"); });
    return originalConfigRead(...args);
  });
  const revoked = await preview("hello.ts"); expect(revoked.status).toBe(403); expect(await revoked.text()).not.toContain("export const value");
  configSpy.mockRestore(); auth.mockReset();
  auth.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new DomainError("conversation_read", 403, "Read denied"); });
  const denied = await preview("hello.ts"); expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("export const value");
});

it('reports scoped line counts and previews untracked files as additions', async () => {
  git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
  file('a.txt','before\nkeep\n'); git('add','.'); git('commit','-m','fixture');
  file('a.txt','staged\nkeep\n'); git('add','a.txt'); file('a.txt','working\nkeep\nextra\n');
  file('new file.txt','first\nsecond');
  const all=await listConversationWorkspace(cwd,'all');
  expect(all.files.find(f=>f.path==='a.txt')).toMatchObject({additions:2,deletions:1});
  expect(all.files.find(f=>f.path==='new file.txt')).toMatchObject({additions:2,deletions:0});
  const staged=await listConversationWorkspace(cwd,'staged');
  expect(staged.files.find(f=>f.path==='a.txt')).toMatchObject({additions:1,deletions:1});
  expect(staged.files.some(f=>f.path==='new file.txt')).toBe(false);
  expect((await readConversationWorkspaceFile(cwd,'a.txt','all')).diff).not.toContain('+staged');
  expect((await readConversationWorkspaceFile(cwd,'a.txt','staged')).diff).toContain('+staged');
  expect((await readConversationWorkspaceFile(cwd,'a.txt','unstaged')).diff).toContain('-staged');
  const added=await readConversationWorkspaceFile(cwd,'new file.txt','all');
  expect(added.diff).toContain('@@ -0,0 +1,2 @@');
  expect(added.diff).toContain('+first\n+second\n\\ No newline at end of file');
  await expect(listConversationWorkspace(cwd,'invalid')).rejects.toMatchObject({status:400});
});

it('supports unborn repositories and binary changes without presenting empty text as a diff', async () => {
  git('init'); file('first.txt','first\n'); git('add','.'); file('new.bin',Buffer.from([0,1,2]));
  expect((await listConversationWorkspace(cwd,'all')).files.find(f=>f.path==='first.txt')).toMatchObject({additions:1,deletions:0});
  expect((await readConversationWorkspaceFile(cwd,'first.txt','all')).diff).toContain('+first');
  expect(await readConversationWorkspaceFile(cwd,'new.bin','all')).toMatchObject({binary:true,diff:null});
});

it('compares a staged deletion recreated on disk against HEAD for the all scope',async()=>{
 git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
 file('restored.txt','original\n');file('image.bin',Buffer.from([0,1,2]));git('add','.');git('commit','-m','fixture');
 git('rm','restored.txt');file('restored.txt','replacement\n');
 const preview=await readConversationWorkspaceFile(cwd,'restored.txt','all');
 expect(preview.diff).toContain('-original');expect(preview.diff).toContain('+replacement');
 const listed=(await listConversationWorkspace(cwd,'all')).files.find(f=>f.path==='restored.txt');
 expect(listed).toMatchObject({additions:1,deletions:1});
 rmSync(join(cwd,'image.bin'));
 expect(await readConversationWorkspaceFile(cwd,'image.bin','all')).toMatchObject({binary:true});
});

it('reports empty directories without exposing sensitive or linked directories', async () => {
 mkdirSync(join(cwd, 'empty')); mkdirSync(join(cwd, '.ssh')); symlinkSync(home, join(cwd, 'linked'));
 expect((await listConversationWorkspace(cwd)).directories).toEqual(['empty']);
});

it('shows nested workspace output files even when Git ignores their directory', async () => {
 git('init');
 file('.gitignore', 'outputs/\nquality-dashboard/\n');
 file('outputs/reports/summary.md', '# Report');
 file('quality-dashboard/index.html', '<h1>Dashboard</h1>');
 file('outputs/.env', 'private');
 const listing = await listConversationWorkspace(cwd);
 expect(listing.files.map(item=>item.path)).toEqual(['.gitignore', 'outputs/reports/summary.md', 'quality-dashboard/index.html']);
 expect(listing.directories).toContain('outputs/reports');
 expect((await listConversationWorkspace(cwd, 'all')).files.map(item=>item.path)).toEqual(['.gitignore']);
});

it('loads a requested directory independently of the workspace listing limit', async () => {
 for (let i=0;i<1010;i++) file(`many/${i}.md`, 'note');
 file('outputs/deep/result.md', 'result');
 const listing = await listConversationWorkspace(cwd, undefined, 'outputs');
 expect(listing.files).toEqual([{path:'outputs/deep/result.md',status:''}]);
 expect(listing.directories).toEqual(['outputs/deep']);
 expect(listing.truncated).toBe(false);
 symlinkSync(home, join(cwd, 'linked'));
 for(const directory of ['../', '.git', 'linked', 'outputs/../many'])
  await expect(listConversationWorkspace(cwd, undefined, directory)).rejects.toMatchObject({status:403});
});

it('keeps tracked changes when unchanged and untracked files exceed the listing cap', async () => {
  git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
  for (let i=0;i<1100;i++) file(`a/clean-${i}.txt`,'x\n');
  file('z/changed.txt','before\n'); git('add','.'); git('commit','-qm','base');
  for (let i=0;i<1100;i++) file(`b/new-${i}.txt`,'y\n');
  file('z/changed.txt','after\n');
  const listing=await listConversationWorkspace(cwd,'all');
  expect(listing.truncated).toBe(true);
  expect(listing.untracked).toBe(1100);
  expect(listing.files.find(f=>f.path==='z/changed.txt')).toEqual({path:'z/changed.txt',status:' M',additions:1,deletions:1});
});

it('reports branch, tracked change totals and the other worktrees of a conversation directory', async () => {
  expect(await conversationEnvironment(cwd)).toEqual({cwd,git:false});
  git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
  file('a.txt','one\ntwo\n'); file('.env','A=1\n'); git('add','.'); git('commit','-qm','base');
  file('a.txt','one\nTWO\nthree\n'); file('.env','A=2\n'); file('new.txt','untracked\n');
  git('worktree','add','-q','-b','side',join(home,'side'));
  const environment=await conversationEnvironment(cwd);
  expect(environment).toMatchObject({git:true,branch:'main',changes:{files:1,additions:2,deletions:1}});
  expect(environment.git&&environment.worktrees.map(item=>item.branch)).toEqual(['side']);
});

it('attributes a worktree to the chat whose events named it around its creation, not to one that only listed it later', async () => {
  git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
  file('a.txt','one\n'); git('add','.'); git('commit','-qm','base');
  await readConfig(home); store = openStore(home); manager = createSessionManager(store, async () => (await readConfig(home)).config);
  const creator = store.createConversation({ projectId: "", agentId: "", cli: "codex", model: null, cwd });
  const bystander = store.createConversation({ projectId: "", agentId: "", cli: "codex", model: null, cwd });
  const quiet = store.createConversation({ projectId: "", agentId: "", cli: "codex", model: null, cwd });
  store.appendEvent(creator.id, "tool", { item: { type: "commandExecution", command: "git worktree add ../fix-notes -b fix-notes" } });
  git('worktree','add','-q','-b','fix-notes',join(home,'fix-notes'));
  git('worktree','add','-q','-b','other',join(home,'other'));
  // A later listing that names the worktree is outside the creation window.
  store.database.prepare("INSERT INTO events(conversationId,kind,data,createdAt) VALUES (?,?,?,?)").run(bystander.id, "tool", JSON.stringify({ output: "fix-notes other" }), new Date(Date.now() + 60 * 60 * 1000).toISOString());
  server = createHttpServer({requireIdentity:false, home, store, manager }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const environment = async (id: string) => (await (await fetch("http://127.0.0.1:" + (server!.address() as { port: number }).port + "/api/conversations/" + id + "/environment")).json()).worktrees.map((item: { branch: string; createdHere: boolean }) => [item.branch, item.createdHere]);
  expect(await environment(creator.id)).toEqual([['fix-notes', true], ['other', false]]);
  expect(await environment(bystander.id)).toEqual([['fix-notes', false], ['other', false]]);
  expect(await environment(quiet.id)).toEqual([['fix-notes', false], ['other', false]]);
});
