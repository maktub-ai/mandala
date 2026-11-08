import { productEnv, productHome } from "../cli/product-env.mjs";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { backupWorkspace } from "../server/workspace-backup";

type Deployment = { pid: number; directory: string; sha: string; home: string; port: number };
export function assertReleaseSource(branch: string, status: string): void {
  if (branch !== "main") throw new Error("Release from main only.");
  if (status.trim()) throw new Error("Uncommitted changes: commit or move them before releasing.");
}
export function assertManagedListener(pid: number | null, previous: Pick<Deployment, "pid" | "directory"> | null, cwd?: string): void {
  if (pid !== null && (!previous || previous.pid !== pid || previous.directory !== cwd))
    throw new Error("Refusing to replace an unmanaged service. Consolidate and migrate the existing runtime first.");
}
export function assertIdle(conversations: { status: string }[], runs: { state: string }[]): void {
  if (conversations.some(item => ["running", "approval"].includes(item.status)) ||
      runs.some(item => ["queued", "starting", "running", "approval", "unknown"].includes(item.state)))
    throw new Error("Service has active work. Stop or finish it before releasing.");
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const command = (file: string, args: string[], cwd = process.cwd()) =>
  execFileSync(file, args, { cwd, encoding: "utf8" }).trim();
const git = (...args: string[]) => command("git", args);
export async function readApi(port: number, path: string, home?: string): Promise<any> {
  const keyPath = home && join(home, "local-access.key");
  const key = keyPath && existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : undefined;
  if (key !== undefined && !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid local owner credential");
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: key ? {"X-Mandala-Local-Key":key,"X-OpenMana-Local-Key":key} : {}, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Readiness check failed: ${path} (${response.status})`);
  return response.json();
}
export function releaseOptions(args: string[]) {
  if (args.some(arg => !["--check", "--local-only"].includes(arg))) throw new Error("Usage: npm run release:local -- [--check] [--local-only]");
  return { check: args.includes("--check"), localOnly: args.includes("--local-only") };
}
function assertUnprovisionedIdle(home: string) {
  const db = new DatabaseSync(join(home, "state.sqlite"), {readOnly:true});
  try {
    const has = (table: string) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const conversations = db.prepare("SELECT json_extract(data,'$.status') AS status FROM conversations").all() as {status:string}[];
    const runs = has('task_runs') ? db.prepare('SELECT state FROM task_runs').all() as {state:string}[] : [];
    const inputs = has('task_user_inputs') ? db.prepare('SELECT state FROM task_user_inputs').all() as {state:string}[] : [];
    assertIdle(conversations, [...runs,...inputs]);
  } finally { db.close(); }
}
function listener(port: number): number | null {
  try {
    const ids = command("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n");
    if (ids.length !== 1) throw new Error("Multiple listeners on the release port.");
    return Number(ids[0]);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function preflight(port: number, previous: Deployment | null, home: string): Promise<number | null> {
  const pid = listener(port);
  const cwd = pid === null ? undefined : command("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n").find(line => line.startsWith("n"))?.slice(1);
  assertManagedListener(pid, previous, cwd);
  if (pid !== null) {
    const session = await fetch(`http://127.0.0.1:${port}/auth/session`, {signal:AbortSignal.timeout(3000)}).then(async response => response.ok && response.headers.get('content-type')?.includes('application/json') ? response.json() : null);
    if (session?.mode === 'local' && !session.provisioned) assertUnprovisionedIdle(home);
    else {
      const tasks = await readApi(port, "/api/v2/tasks", home) as { id: string }[];
      const controls = await Promise.all(tasks.map(task => readApi(port, `/api/v2/tasks/${encodeURIComponent(task.id)}/control`, home)));
      assertIdle(await readApi(port, "/api/conversations", home), controls.flatMap(item => item.runs));
    }
  }
  return pid;
}

async function release(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Local service releases currently support macOS only.");
  const options = releaseOptions(process.argv.slice(2));
  assertReleaseSource(git("branch", "--show-current"), git("status", "--porcelain"));
  command(process.execPath, [fileURLToPath(new URL("./check-release-source.mjs", import.meta.url))]);
  const home = resolve(productEnv('HOME') ?? "");
  const root = productHome('releases');
  if (!productEnv('HOME') || home === homedir() || home === "/" ||
      home === root || home.startsWith(root + "/") || root.startsWith(home + "/"))
    throw new Error("Set MANDALA_HOME (or OPEN_MANA_HOME) to the intended application data directory, outside the release directory.");
  const port = Number(productEnv('PORT') ?? 4332);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid release port.");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "release.lock");
  mkdirSync(lock); // One publisher per Mac. An existing lock requires investigation.
  try {
    const manifest = join(root, "current.json");
    const previous: Deployment | null = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : null;
    if (previous && (previous.home !== home || previous.port !== port)) throw new Error("Release HOME/port differ from the managed service.");
    await preflight(port, previous, home);
    const sha = git("rev-parse", "HEAD");
    if (options.check) {
      console.log(`Preflight passed: main@${sha}, HOME=${home}, port=${port}. No push or service restart.`);
      return;
    }
    const directory = mkdtempSync(join(root, `${sha.slice(0, 12)}-`));
    const archive = join(directory, "source.tar");
    git("archive", "--format=tar", `--output=${archive}`, sha);
    command("tar", ["-xf", archive, "-C", directory]);
    rmSync(archive);
    const npm = join(resolve(process.execPath, ".."), "npm");
    for (const args of [["ci"], ["test"], ["run", "typecheck"], ["run", "build"], ["run", "test:e2e"]])
      execFileSync(npm, args, { cwd: directory, stdio: "inherit" });
    assertReleaseSource(git("branch", "--show-current"), git("status", "--porcelain"));
    if (git("rev-parse", "HEAD") !== sha) throw new Error("main changed during verification; release again.");
    const pid = await preflight(port, previous, home);
    if (!options.localOnly) {
      execFileSync("git", ["push", "origin", "HEAD:refs/heads/main"], { stdio: "inherit" });
      if (!git("ls-remote", "origin", "refs/heads/main").startsWith(sha + "\t")) throw new Error("Remote main differs from the verified release.");
    }
    if (pid !== null) {
      process.kill(pid, "SIGTERM");
      for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await pause(100);
      if (alive(pid) || listener(port) !== null) throw new Error("Service did not stop gracefully. No replacement started.");
    }
    // Copy only after SQLite has closed. Runtime data never enters the Git archive.
    if (existsSync(home)) cpSync(home, join(directory, "data-backup"), { recursive: true });
    await backupWorkspace(home, join(directory, "workspace-snapshot"));
    const logPath = join(directory, "service.log");
    const log = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
      cwd: directory, env: { ...process.env, MANDALA_HOME: home, MANDALA_PORT: String(port), MANDALA_DEV: "0" },
      detached: true, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    const deployment: Deployment = { pid: child.pid!, directory, sha, home, port };
    const pending = join(directory, "deployment.json");
    writeFileSync(pending, JSON.stringify(deployment, null, 2), { mode: 0o600 });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const session = await readApi(port, "/auth/session", home);
          if (session.mode !== 'local') throw new Error('Expected personal authentication gate');
          if (session.provisioned) await readApi(port, "/api/config", home);
          else if ((await fetch(`http://127.0.0.1:${port}/api/config`)).status !== 401) throw new Error('Unprovisioned service must protect business data');
          ready = true; break;
        } catch { await pause(200); }
      }
      if (!ready || listener(port) !== child.pid) throw new Error("New service did not become ready.");
      const served = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (!served.ok || await served.text() !== readFileSync(join(directory, "dist/index.html"), "utf8"))
        throw new Error("Served UI differs from the verified build.");
      writeFileSync(manifest, JSON.stringify(deployment, null, 2), { mode: 0o600 });
      console.log(`Published main@${sha}: http://127.0.0.1:${port}, PID=${child.pid}, HOME=${home}, source=${directory}`);
    } catch (error) {
      try { process.kill(child.pid!, "SIGTERM"); } catch (stopError) {
        if ((stopError as NodeJS.ErrnoException).code !== "ESRCH") throw stopError;
      }
      throw new Error(`${options.localOnly ? 'Local-only' : 'GitHub main was pushed, but local'} deployment failed: ${String(error)}. Inspect ${logPath}. Backup: ${join(directory, "data-backup")}. No automatic data rollback.`);
    }
  } finally {
    rmSync(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  release().catch(error => { console.error(error.message); process.exitCode = 1; });
