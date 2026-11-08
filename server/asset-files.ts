import { constants, readFileSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileMediaType } from '../shared/file-types';
import type { ManifestFile, StagedManifest, UploadSource } from "../shared/assets";
import { DomainError, type Principal } from "../shared/workspace-contracts";
const FILE_LIMIT = 100 * 1024 * 1024, TOTAL_LIMIT = 250 * 1024 * 1024;
const invalid = (message: string) => new DomainError("invalid_upload", 422, message);
type StagingRecord = { principal: Principal; runId: string | null; manifest: StagedManifest };
type FaultHooks = {
  afterSourceValidated?: () => Promise<void>;
  writeChunk?: (file: FileHandle, chunk: Uint8Array) => Promise<number> | number;
};
function safePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) throw invalid("Unsafe relative path");
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized.endsWith("/")) throw invalid("Expected a file path");
  return normalized;
}
async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function validateSource(source: UploadSource) {
  const configuredRoot = resolve(source.allowedRoot);
  if (!(await lstat(configuredRoot)).isDirectory()) throw invalid("Output root must be a real directory");
  const root = await realpath(configuredRoot), path = join(root, safePath(source.relativePath));
  let current = root;
  for (const part of relative(root, path).split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw invalid("Symlinks are forbidden");
  }
  const stat = await lstat(path);
  if (!stat.isFile() || await realpath(path) !== path) throw invalid("Expected a regular file within output root");
  if (stat.size > FILE_LIMIT) throw invalid("Single file limit is 100 MiB");
  return { path, stat };
}
const samePrincipal = (a: Principal, b: Principal) => a.userId === b.userId && a.agentId === b.agentId && a.runId === b.runId;
export function createAssetFiles(home: string, hooks: FaultHooks = {}) {
  const blobRoot = join(resolve(home), "blobs", "sha256"), stagingRoot = join(resolve(home), "staging");
  const blobPath = (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw invalid("Invalid blob hash");
    return join(blobRoot, hash.slice(0, 2), hash);
  };
  return {
    // Internal location only; callers must authorize using a committed manifest or staging lease.
    blobPath,
    readStaging(principal: Principal, runId: string | null, submissionId: string): StagedManifest {
      if (!/^[a-f0-9-]{36}$/.test(submissionId)) throw invalid("Invalid submission ID");
      const record = JSON.parse(readFileSync(join(stagingRoot, submissionId, "manifest.json"), "utf8")) as StagingRecord;
      if (!samePrincipal(principal, record.principal) || runId !== record.runId) throw new DomainError("forbidden", 403, "Staging lease belongs to another principal or Run");
      if (Date.parse(record.manifest.expiresAt) <= Date.now()) throw new DomainError("staging_expired", 409, "Staging lease expired");
      return record.manifest;
    },
    async stageFiles(principal: Principal, runId: string | null, files: UploadSource[]): Promise<StagedManifest> {
      if (!principal.userId || (principal.runId !== undefined && principal.runId !== runId)) throw invalid("Principal Run mismatch");
      if (files.length > 100) throw invalid("Submission limit is 100 files");
      const names = files.map(file => safePath(file.manifestPath));
      if (new Set(names).size !== names.length) throw invalid("Duplicate normalized manifest path");
      const sources = [];
      let declaredTotal = 0;
      for (const source of files) {
        const checked = await validateSource(source); sources.push(checked); declaredTotal += checked.stat.size;
        if (declaredTotal > TOTAL_LIMIT) throw invalid("Submission limit is 250 MiB");
      }
      await mkdir(blobRoot, { recursive: true }); await mkdir(stagingRoot, { recursive: true });
      const manifestFiles: ManifestFile[] = [];
      let total = 0;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        await hooks.afterSourceValidated?.();
        const input = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const temporary = join(blobRoot, `.tmp-${randomUUID()}`);
        let output: FileHandle | undefined;
        try {
          const checked = await validateSource(files[i]), stat = await input.stat();
          if (!stat.isFile() || stat.dev !== source.stat.dev || stat.ino !== source.stat.ino || stat.size !== source.stat.size || stat.mtimeMs !== source.stat.mtimeMs || stat.ctimeMs !== source.stat.ctimeMs || checked.stat.ino !== stat.ino || checked.stat.dev !== stat.dev) throw invalid("Source changed after validation");
          output = await open(temporary, "wx", 0o600);
          const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
          let size = 0;
          while (true) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            size += bytesRead; total += bytesRead;
            if (size > FILE_LIMIT) throw invalid("Single file limit is 100 MiB");
            if (total > TOTAL_LIMIT) throw invalid("Submission limit is 250 MiB");
            const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
            const written = hooks.writeChunk ? await hooks.writeChunk(output, chunk) : (await output.write(chunk)).bytesWritten;
            if (written !== bytesRead) throw new Error("Short Blob write");
          }
          const after = await input.stat();
          const finalSource = await validateSource(files[i]);
          if (finalSource.stat.ino !== stat.ino || finalSource.stat.dev !== stat.dev) throw invalid("Source changed while reading");
          if (after.size !== stat.size || size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw invalid("Source changed while reading");
          await output.sync(); await output.close(); output = undefined;
          const blobHash = hash.digest("hex"), destination = blobPath(blobHash);
          await mkdir(dirname(destination), { recursive: true });
          try {
            const existing = await lstat(destination);
            if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== size) throw new Error("Existing Blob length mismatch");
            await rm(temporary);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await rename(temporary, destination);
          }
          // Every lease establishes durability, including reuse of another writer's renamed Blob.
          await syncDirectory(dirname(destination)); await syncDirectory(blobRoot);
          await syncDirectory(dirname(blobRoot)); await syncDirectory(resolve(home));
          const mediaType = fileMediaType(names[i]);
          manifestFiles.push({ path: names[i], blobHash, size, mediaType, executable: Boolean(stat.mode & 0o111) });
        } finally { await input.close(); await output?.close(); await rm(temporary, { force: true }); }
      }
      const manifest: StagedManifest = { submissionId: randomUUID(), files: manifestFiles, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
      const temporary = join(stagingRoot, `.tmp-${manifest.submissionId}`), destination = join(stagingRoot, manifest.submissionId);
      await mkdir(temporary);
      try {
        const metadata = await open(join(temporary, "manifest.json"), "wx", 0o600);
        try { await metadata.writeFile(JSON.stringify({ principal, runId, manifest } satisfies StagingRecord)); await metadata.sync(); } finally { await metadata.close(); }
        await syncDirectory(temporary); await rename(temporary, destination); await syncDirectory(stagingRoot);
        await syncDirectory(resolve(home));
      } catch (error) { await rm(temporary, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); throw error; }
      return manifest;
    },
  };
}
