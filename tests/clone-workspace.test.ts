import { execFile } from "node:child_process";
import { createServer, type Server } from "node:https";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloneProjectWorkspace } from "../server/clone-workspace";

const run = promisify(execFile);
const gitShellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const gitShellPath = (path: string) => gitShellQuote(process.platform === "win32" ? path.replaceAll("\\", "/") : path);
// Public synthetic fixtures for a test HTTPS server bound only to 127.0.0.1.
const tlsFixture = (name: string) => fileURLToPath(new URL("fixtures/git-loopback-tls/" + name, import.meta.url));
let root: string, home: string, repository: string, url: string, server: Server;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mandala-clone-"));
  home = join(root, "home");
  repository = join(root, "source");
  await mkdir(home);
  await mkdir(repository);
  const config = join(root, "gitconfig");
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_SSL_NO_VERIFY", undefined);
  const ca = join(root, "fixture-ca.pem");
  await writeFile(ca, await readFile(tlsFixture("ca.pem")));
  vi.stubEnv("GIT_SSL_CAINFO", ca);
  // Git for Windows uses Schannel by default, which expects a revocation service.
  // Only this offline fixture selects Git's OpenSSL backend and its explicit CA.
  if (process.platform === "win32") await run("git", ["config", "--file", config, "http.sslBackend", "openssl"]);
  vi.stubEnv("NO_PROXY", "127.0.0.1");
  if (process.platform !== "win32") vi.stubEnv("no_proxy", "127.0.0.1");
  await run("git", ["init", "-b", "main", repository]);
  await writeFile(join(repository, "README.md"), "A personal reading list.\n");
  await run("git", ["-C", repository, "add", "README.md"]);
  await run("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
  await run("git", ["-C", repository, "update-server-info"]);
  const gitRoot = join(repository, ".git");
  server = createServer({ key: await readFile(tlsFixture("server-key.pem")), cert: await readFile(tlsFixture("server.pem")) }, async (req, res) => {
    const path = resolve(gitRoot, "." + new URL(req.url!, "https://localhost").pathname);
    if (!path.startsWith(gitRoot + sep)) { res.writeHead(404).end(); return; }
    try { res.end(await readFile(path)); } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  url = `https://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterEach(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("clones real Git content into an independent Workspace and records its remote source without saving config", async () => {
  const workspace = await cloneProjectWorkspace(home, { id: "reading", cwd: "" }, url);
  expect(workspace.cwd.startsWith(join(home, "workspaces", "reading") + sep)).toBe(true);
  expect(await readFile(join(workspace.cwd, "README.md"), "utf8")).toBe("A personal reading list.\n");
  expect((await run("git", ["-C", workspace.cwd, "remote", "get-url", "origin"])).stdout.trim()).toBe(url);
  expect(workspace.resources).toEqual([{ id: expect.any(String), label: expect.any(String), kind: "remote-git", location: url }]);
  expect(workspace.name).toBeTruthy();
  await expect(stat(join(home, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not trust the loopback fixture without its explicit CA", async () => {
  const env = { ...process.env };
  delete env.GIT_SSL_CAINFO;
  await expect(run("git", ["ls-remote", url], { env })).rejects.toMatchObject({
    code: 128, stderr: expect.stringMatching(/certificate|ssl/i),
  });
});

it("allocates distinct clones under an existing Project directory and preserves its files", async () => {
  const cwd = join(root, "existing");
  await mkdir(cwd);
  await writeFile(join(cwd, "keep.txt"), "preserve");
  const [first, second] = await Promise.all([
    cloneProjectWorkspace(home, { id: "reading", cwd }, url),
    cloneProjectWorkspace(home, { id: "reading", cwd }, url),
  ]);
  expect(first.id).not.toBe(second.id);
  expect(first.cwd).not.toBe(second.cwd);
  expect(first.cwd.startsWith(cwd + sep)).toBe(true);
  expect(second.cwd.startsWith(cwd + sep)).toBe(true);
  expect(await readFile(join(cwd, "keep.txt"), "utf8")).toBe("preserve");
});

it("cleans only its own failed clone and preserves an existing Workspace", async () => {
  const cwd = join(root, "existing");
  await mkdir(cwd);
  await writeFile(join(cwd, "keep.txt"), "preserve");
  await expect(cloneProjectWorkspace(home, { id: "reading", cwd }, url + "missing/")).rejects.toThrow(/clone/i);
  expect(await readdir(cwd)).toEqual(["keep.txt"]);
  expect(await readFile(join(cwd, "keep.txt"), "utf8")).toBe("preserve");
});

it.each(["ssh://git@example.test/reading.git", "git@example.test:reading.git"])("supports native SSH transport for %s", async remote => {
  const ssh = join(root, "fixture-ssh");
  await writeFile(ssh, `#!/bin/sh\nexec git-upload-pack ${gitShellPath(repository)}\n`, { mode: 0o755 });
  vi.stubEnv("GIT_SSH_COMMAND", `sh ${gitShellPath(ssh)}`);
  vi.stubEnv("GIT_SSH_VARIANT", "ssh");
  const workspace = await cloneProjectWorkspace(home, { id: "reading", cwd: "" }, remote);
  expect(await readFile(join(workspace.cwd, "README.md"), "utf8")).toBe("A personal reading list.\n");
  expect(workspace.resources[0].location).toBe(remote);
});

it.each([null, 42, "", "--upload-pack=evil", "file:///tmp/repository", "/tmp/repository", "git://example.test/repo",
  "http://example.test/repo", "ext::sh -c evil", "https://user:secret@example.test/repo", "https://example.test/repo?token=secret",
  "https://example.test/repo#token", "ssh://-oProxyCommand=evil/repo", "git@-oProxyCommand:repo", "git@example.test:-upload-pack=evil",
  "https://example.test/repo\n--upload-pack=evil", "https://example.test/repo;touch /tmp/evil"])("rejects unsafe remote URL %j before creating a directory", async value => {
  await expect(cloneProjectWorkspace(home, { id: "reading", cwd: "" }, value)).rejects.toThrow(/invalid.*url/i);
  expect(await readdir(home)).toEqual([]);
});

it("rejects unsafe project paths before creating directories", async () => {
  await expect(cloneProjectWorkspace(home, { id: "../escape", cwd: "" }, url)).rejects.toThrow(/invalid/i);
  await expect(cloneProjectWorkspace(home, { id: "reading", cwd: "relative" }, url)).rejects.toThrow(/invalid/i);
  expect(await readdir(home)).toEqual([]);
});

it.each(["?", "#"])("rejects even an empty query or fragment marker %s", async suffix => {
  await expect(cloneProjectWorkspace(home, { id: "reading", cwd: "" }, url + suffix)).rejects.toThrow(/invalid.*url/i);
  expect(await readdir(home)).toEqual([]);
});

it("rejects malformed HTTPS URLs that Git would interpret as SSH shorthand", async () => {
  const ssh = join(root, "fixture-ssh");
  await writeFile(ssh, `#!/bin/sh\nexec git-upload-pack ${gitShellPath(repository)}\n`, { mode: 0o755 });
  vi.stubEnv("GIT_SSH_COMMAND", `sh ${gitShellPath(ssh)}`);
  vi.stubEnv("GIT_SSH_VARIANT", "ssh");
  await expect(cloneProjectWorkspace(home, { id: "reading", cwd: "" }, "https:example.test/repo")).rejects.toThrow(/invalid.*url/i);
  expect(await readdir(home)).toEqual([]);
});

it("does not run native Git template hooks or configured checkout filters while cloning", async () => {
  const marker = join(root, "executed"), template = join(root, "template");
  await mkdir(join(template, "hooks"), { recursive: true });
  await writeFile(join(template, "hooks", "post-checkout"), `#!/bin/sh\nprintf unsafe > ${gitShellPath(marker)}\n`, { mode: 0o755 });
  await writeFile(join(repository, ".gitattributes"), "README.md filter=unsafe\n");
  await run("git", ["-C", repository, "add", ".gitattributes"]);
  await run("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "attributes"]);
  await run("git", ["-C", repository, "update-server-info"]);
  const cfg = join(root, "gitconfig");
  await run("git", ["config", "--file", cfg, "init.templateDir", template]);
  await run("git", ["config", "--file", cfg, "filter.unsafe.smudge", `sh -c ${gitShellQuote(`echo unsafe > ${gitShellPath(marker)}; cat`)}`]);
  await run("git", ["config", "--file", cfg, "filter.unsafe.required", "true"]);
  const workspace = await cloneProjectWorkspace(home, { id: "reading", cwd: "" }, url);
  expect(await readFile(join(workspace.cwd, "README.md"), "utf8")).toBe("A personal reading list.\n");
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
