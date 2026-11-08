import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, symlink, rename, truncate, readdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createAssetFiles } from "../server/asset-files";
let home: string, root: string;
const principal = { userId: "u", agentId: "a", runId: "r" };
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mana-assets-")); root = join(home, "output"); await mkdir(root); await writeFile(join(root, "a.txt"), "hello"); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const source = (manifestPath = "a.txt", relativePath = "a.txt") => ({ allowedRoot: root, relativePath, manifestPath });
it("streams exact hash size mode and persists principal-bound staging across reopen", async () => {
  await chmod(join(root, "a.txt"), 0o755);
  const files = createAssetFiles(home); const staged = await files.stageFiles(principal, "r", [source()]);
  expect(staged.files[0]).toEqual({ path: "a.txt", blobHash: createHash("sha256").update("hello").digest("hex"), size: 5, mediaType: "text/plain", executable: true });
  expect(await createAssetFiles(home).readStaging(principal, "r", staged.submissionId)).toEqual(staged);
  expect(() => files.readStaging({ userId: "other" }, "r", staged.submissionId)).toThrow();
  expect(() => files.readStaging(principal, "different", staged.submissionId)).toThrow();
  expect(JSON.stringify(staged)).not.toContain(home);
});
it("rejects traversal absolute paths duplicate normalized paths and mismatched run", async () => {
  const files = createAssetFiles(home);
  for (const path of ["../x", "/a", "a/../x", "a\\x"]) await expect(files.stageFiles(principal, "r", [source(path)])).rejects.toThrow();
  await expect(files.stageFiles(principal, "r", [source("x"), source("./x")])).rejects.toThrow();
  await expect(files.stageFiles(principal, "r", [source("x", "../a.txt")])).rejects.toThrow();
  await expect(files.stageFiles(principal, "other", [source()])).rejects.toThrow();
});
it("rejects symlink files and symlink directories", async () => {
  await symlink(join(root, "a.txt"), join(root, "link")); await symlink(root, join(root, "dir"));
  for (const path of ["link", "dir/a.txt"]) await expect(createAssetFiles(home).stageFiles(principal, "r", [source("x", path)])).rejects.toThrow();
});
it("rejects replacement after validation", async () => {
  const files = createAssetFiles(home, { afterSourceValidated: async () => { await rename(join(root, "a.txt"), join(root, "old")); await writeFile(join(root, "a.txt"), "changed"); } });
  await expect(files.stageFiles(principal, "r", [source()])).rejects.toThrow();
});
it("enforces exact file count individual and total byte limits", async () => {
  const files = createAssetFiles(home);
  await expect(files.stageFiles(principal, "r", Array.from({ length: 101 }, (_, i) => source(String(i))))).rejects.toThrow(/100/);
  await truncate(join(root, "a.txt"), 100 * 1024 * 1024 + 1);
  await expect(files.stageFiles(principal, "r", [source()])).rejects.toThrow(/100 MiB/);
  await truncate(join(root, "a.txt"), 100 * 1024 * 1024);
  await writeFile(join(root, "b"), ""); await truncate(join(root, "b"), 50 * 1024 * 1024 + 1);
  await expect(files.stageFiles(principal, "r", [source("1"), source("2"), source("3", "b")])).rejects.toThrow(/250 MiB/);
});
it("deduplicates bytes but creates distinct leases and rejects short writes or disk errors", async () => {
  const files = createAssetFiles(home); const a = await files.stageFiles(principal, "r", [source()]); const b = await files.stageFiles({ userId: "second" }, null, [source()]);
  expect(a.submissionId).not.toBe(b.submissionId); expect(a.files[0].blobHash).toBe(b.files[0].blobHash);
  expect(await readdir(join(home, "blobs", "sha256", a.files[0].blobHash.slice(0, 2)))).toEqual([a.files[0].blobHash]);
  for (const fault of [() => 1, () => { throw new Error("disk full"); }]) {
    await expect(createAssetFiles(home, { writeChunk: fault }).stageFiles(principal, "r", [source()])).rejects.toThrow();
  }
  expect((await readdir(join(home, "staging"))).length).toBe(2);
});
it("rejects a file changed in place after validation and an expired staging lease", async () => {
  const changing = createAssetFiles(home, { afterSourceValidated: async () => { await writeFile(join(root, "a.txt"), "changed in place"); } });
  await expect(changing.stageFiles(principal, "r", [source()])).rejects.toThrow(/changed/);
  const files = createAssetFiles(home); const manifest = await files.stageFiles(principal, "r", [source()]);
  const metadataPath = join(home, "staging", manifest.submissionId, "manifest.json");
  const { readFile } = await import("node:fs/promises");
  const record = JSON.parse(await readFile(metadataPath, "utf8")); record.manifest.expiresAt = "2000-01-01T00:00:00.000Z";
  await writeFile(metadataPath, JSON.stringify(record));
  expect(() => files.readStaging(principal, "r", manifest.submissionId)).toThrow(/expired/);
});
it("concurrent reuse establishes its own directory durability when the first writer fails", async () => {
  const hash = createHash("sha256").update("hello").digest("hex");
  const parent = join(home, "blobs", "sha256", hash.slice(0, 2)); await mkdir(parent, { recursive: true });
  const parentStat = await stat(parent), probe = await open(parent, "r");
  const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync;
  await probe.close();
  let entered!: () => void, release!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let parentSyncs = 0;
  const spy = vi.spyOn(prototype, "sync").mockImplementation(async function(this: import("node:fs/promises").FileHandle) {
    const current = await this.stat();
    if (current.dev === parentStat.dev && current.ino === parentStat.ino && ++parentSyncs === 1) {
      entered(); await gate; throw new Error("first parent fsync failure");
    }
    return originalSync.call(this);
  });
  const files = createAssetFiles(home);
  const first = files.stageFiles(principal, "r", [source()]).then(() => "ready", error => error.message);
  try {
    await blocked;
    const second = await files.stageFiles({ userId: "second" }, null, [source()]);
    release(); expect(await first).toBe("first parent fsync failure");
    expect(parentSyncs).toBe(2);
    expect(files.readStaging({ userId: "second" }, null, second.submissionId)).toEqual(second);
    expect((await readdir(join(home, "staging"))).length).toBe(1);
  } finally { release(); await first; spy.mockRestore(); }
});
it("failed parent sync retry cannot create a lease until its own sync succeeds", async () => {
  const hash = createHash("sha256").update("hello").digest("hex");
  const parent = join(home, "blobs", "sha256", hash.slice(0, 2)); await mkdir(parent, { recursive: true });
  const parentStat = await stat(parent), probe = await open(parent, "r");
  const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync; await probe.close();
  let failures = 2, parentSyncs = 0;
  const spy = vi.spyOn(prototype, "sync").mockImplementation(async function(this: import("node:fs/promises").FileHandle) {
    const current = await this.stat();
    if (current.dev === parentStat.dev && current.ino === parentStat.ino) {
      parentSyncs++; if (failures-- > 0) throw new Error("parent fsync failure");
    }
    return originalSync.call(this);
  });
  try {
    const files = createAssetFiles(home);
    await expect(files.stageFiles(principal, "r", [source()])).rejects.toThrow(/parent fsync/);
    await expect(files.stageFiles(principal, "r", [source()])).rejects.toThrow(/parent fsync/);
    expect(await readdir(join(home, "staging"))).toEqual([]);
    const recovered = await files.stageFiles(principal, "r", [source()]);
    expect(parentSyncs).toBe(3); expect(files.readStaging(principal, "r", recovered.submissionId)).toEqual(recovered);
  } finally { spy.mockRestore(); }
});
it("syncs every managed directory entry through the trusted existing home", async () => {
  const probe = await open(home, "r"), prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync; await probe.close();
  const synced = new Set<string>();
  const spy = vi.spyOn(prototype, "sync").mockImplementation(async function(this: import("node:fs/promises").FileHandle) {
    const current = await this.stat(); if (current.isDirectory()) synced.add(`${current.dev}:${current.ino}`);
    return originalSync.call(this);
  });
  try {
    const result = await createAssetFiles(home).stageFiles(principal, "r", [source()]);
    for (const directory of [home, join(home, "blobs"), join(home, "blobs", "sha256"), join(home, "blobs", "sha256", result.files[0].blobHash.slice(0, 2)), join(home, "staging"), join(home, "staging", result.submissionId)]) {
      const current = await stat(directory); expect(synced.has(`${current.dev}:${current.ino}`)).toBe(true);
    }
  } finally { spy.mockRestore(); }
});
