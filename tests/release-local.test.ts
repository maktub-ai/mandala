import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { assertReleaseSource, assertManagedListener, assertIdle, readApi, releaseOptions } from "../scripts/release-local";

describe("local release safety", () => {
  it("accepts a local-only release without implicitly authorizing remote push", () => {
    expect(releaseOptions(['--local-only'])).toEqual({check:false,localOnly:true});
    expect(releaseOptions(['--check','--local-only'])).toEqual({check:true,localOnly:true});
    expect(()=>releaseOptions(['--skip-checks'])).toThrow('Usage');
  });
  it("reads the authenticated owner API with the private local credential", async () => {
    const {createServer}=await import('node:http');
    const home=mkdtempSync(join(tmpdir(),'mana-release-auth-')),key='a'.repeat(64);
    writeFileSync(join(home,'local-access.key'),key,{mode:0o600});
    const server=createServer((req,res)=>{res.writeHead(req.headers['x-openmana-local-key']===key?200:401,{'Content-Type':'application/json'});res.end(JSON.stringify({verified:true}));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {expect(await readApi((server.address() as {port:number}).port,'/api/config',home)).toEqual({verified:true});}
    finally {await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});}
  });
  it("only releases a clean main checkout", () => {
    expect(() => assertReleaseSource("main", "")).not.toThrow();
    expect(() => assertReleaseSource("feature/work", "")).toThrow("main");
    expect(() => assertReleaseSource("main", " M src/App.tsx")).toThrow("Uncommitted");
    expect(() => assertReleaseSource("main", "?? private.txt")).toThrow("Uncommitted");
  });
  it("never stops a listener outside the recorded release", () => {
    expect(() => assertManagedListener(null, null)).not.toThrow();
    expect(() => assertManagedListener(42, null)).toThrow("unmanaged");
    expect(() => assertManagedListener(42, { pid: 43, directory: "/release" }, "/release")).toThrow("unmanaged");
    expect(() => assertManagedListener(42, { pid: 42, directory: "/release" }, "/other")).toThrow("unmanaged");
    expect(() => assertManagedListener(42, { pid: 42, directory: "/release" }, "/release")).not.toThrow();
  });
  it("waits for approvals and all active or queued task runs", () => {
    expect(() => assertIdle([{ status: "idle" }], [{ state: "succeeded" }])).not.toThrow();
    for (const status of ["running", "approval"])
      expect(() => assertIdle([{ status }], [])).toThrow("active");
    for (const state of ["queued", "starting", "running", "approval", "unknown"])
      expect(() => assertIdle([], [{ state }])).toThrow("active");
  });
  it.skipIf(process.platform !== "darwin")("preflight refuses an actual unmanaged listener without stopping it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mana-release-"));
    const server = createServer();
    try {
      execFileSync("git", ["init", "-b", "main", directory]);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      let failure: any;
      try {
        execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/release-local.ts"), "--check"], {
          cwd: directory, env: { ...process.env, HOME: directory, OPEN_MANA_HOME: join(directory, "data"), OPEN_MANA_PORT: String(port) },
          stdio: "pipe",
        });
      } catch (error) { failure = error; }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr.toString()).toContain("unmanaged");
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
