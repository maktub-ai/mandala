import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linkedLocalFiles, localFilePath, readLocalFilePreview } from "../server/local-files";
import { Readable } from "node:stream";
import { openStore } from "../server/store";
import { createSessionManager } from "../server/sessions";
import { createHttpServer } from "../server/http";
import { DomainError } from "../shared/workspace-contracts";

it("opens linked text files within declared roots and rejects unrelated paths, secrets, binaries and escaping symlinks", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mana-file-preview-")));
  try {
    const root = join(home, "workspace");
    await mkdir(root);
    const path = join(root, "notes.md");
    await writeFile(path, "# Synthetic notes\n\nOpen this file.");
    expect(await readLocalFilePreview(path, [root])).toMatchObject({ name: "notes.md", path, text: "# Synthetic notes\n\nOpen this file." });
    expect(await readLocalFilePreview(`file://${path}:2`, [root])).toMatchObject({ path });
    const outside = join(home, "outside.txt");
    await writeFile(outside, "unrelated");
    await expect(readLocalFilePreview(outside, [root])).rejects.toMatchObject({ status: 403 });
    await symlink(outside, join(root, "shortcut.txt"));
    await expect(readLocalFilePreview(join(root, "shortcut.txt"), [root])).rejects.toMatchObject({ status: 403 });
    await writeFile(join(root, ".env"), "synthetic secret");
    await expect(readLocalFilePreview(join(root, ".env"), [root])).rejects.toMatchObject({ status: 403 });
    for (const name of [".ssh", ".SSH", ".aws", ".codex", ".CoDeX", ".config"]) {
      const protectedRoot = join(home, name, "nested");
      await mkdir(protectedRoot, { recursive: true });
      const config = join(protectedRoot, "config.toml");
      await writeFile(config, "synthetic private config");
      await expect(readLocalFilePreview(config, [protectedRoot])).rejects.toMatchObject({ status: 403 });
    }
    const worktree = join(home, ".codex", "worktrees", "synthetic", "repo");
    await mkdir(worktree, { recursive: true });
    const source = join(worktree, "example.ts");
    await writeFile(source, "export const synthetic = true;");
    expect(await readLocalFilePreview(source, [worktree])).toMatchObject({ text: "export const synthetic = true;" });
    const nestedNative = join(worktree, ".codex");
    await mkdir(nestedNative);
    await writeFile(join(nestedNative, "config.toml"), "synthetic native config");
    await expect(readLocalFilePreview(join(nestedNative, "config.toml"), [nestedNative])).rejects.toMatchObject({ status: 403 });
    await expect(readLocalFilePreview(join(root, "missing.txt"), [root])).rejects.toMatchObject({ status: 404 });
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    await expect(readLocalFilePreview(join(root, "binary.dat"), [root])).rejects.toMatchObject({ status: 415 });
    await writeFile(join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));
    await expect(readLocalFilePreview(join(root, "large.txt"), [root])).rejects.toMatchObject({ status: 413 });
    await expect(readLocalFilePreview("https://foreign.example/path", [root])).rejects.toMatchObject({ status: 400 });
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("previews only a file linked in the authorized chat and rechecks access after reading", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mana-file-http-")));
  const sibling = home + '-outside.md';
  const artifacts = await realpath(await mkdtemp(join(process.cwd(), ".file-preview-")));
  const store = openStore(home);
  const manager = createSessionManager(store, async () => ({runtimes:['codex','omp'], version: 2, projects: [], agents: [] }), undefined, undefined, home);
  const server = createHttpServer({requireIdentity:false, home, store, manager });
  const call = (id: string, href: string | string[], origin = "http://127.0.0.1") => new Promise<{ status: number; data: any }>(resolve => {
    let status = 0;
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(Array.isArray(href) ? { hrefs: href } : { href }))]), {
      url: `/api/conversations/${id}/${Array.isArray(href) ? "local-files/resolve" : "local-file"}`, method: "POST", headers: { host: "127.0.0.1", origin, "content-type": "application/json" },
    });
    server.emit("request", req, { writeHead(code: number) { status = code; }, end(data: string) { resolve({ status, data: JSON.parse(data) }); } });
  });
  try {
    const chat = await manager.create("", "", undefined, "codex", { cwd: home });
    const other = await manager.create("", "");
    const path = join(home, "report.md");
    await writeFile(path, "# Synthetic report\n\nExpected file content.");
    expect((await call(chat.id, path)).status).toBe(403);
    expect(await call(chat.id, [path])).toMatchObject({status:200,data:{hrefs:[]}});
    store.appendEvent(chat.id, "text", { itemId: "report", text: `[说明](${path})` });
    expect(await call(chat.id, path)).toMatchObject({ status: 200, data: { name: "report.md", text: "# Synthetic report\n\nExpected file content." } });
    expect(await call(chat.id, [path, join(home,"missing.md"), "data/*.parquet"])).toMatchObject({status:200,data:{hrefs:[path]}});
    const delta={runId:'link-check',method:'item/reasoning/textDelta',params:{itemId:'reasoning',delta:'Unrelated reasoning'}},serialized=JSON.stringify(delta);
    store.transaction(()=>{for(let i=0;i<500;i++)store.appendEvent(chat.id,'tool',delta);store.appendEvent(chat.id,'tool',{runId:'link-check',method:'item/completed',params:{item:{id:'reasoning',type:'reasoning',content:['Completed reasoning']}}});});
    const parse=vi.spyOn(JSON,'parse');
    try{expect(await call(chat.id,[path])).toMatchObject({status:200,data:{hrefs:[path]}});expect(parse.mock.calls.filter(([value])=>value===serialized).length).toBeLessThanOrEqual(1);}finally{parse.mockRestore();}
    expect(await call(other.id, [path])).toMatchObject({status:200,data:{hrefs:[]}});
    expect((await call(chat.id, [path], "https://foreign.example")).status).toBe(403);
    for (const [name, link] of [["report(1).md", (path: string) => `[括号](${path})`], ["referenced.md", (path: string) => `[引用][file]\n\n[file]: ${path}`]] as const) {
      const target = join(home, name); await writeFile(target, "Synthetic linked content");
      store.appendEvent(chat.id, "text", { itemId: name, text: link(target) });
      expect(await call(chat.id, target)).toMatchObject({ status: 200, data: { name, text: "Synthetic linked content" } });
    }
    const secondReference = join(home, "second-reference.md");
    await writeFile(secondReference, "Independent reference");
    store.appendEvent(chat.id, "text", { itemId: "second-reference", text: `[另一引用][file]\n\n[file]: ${secondReference}` });
    expect((await call(chat.id, secondReference)).status).toBe(200);
    const streamed = join(home, "streamed.md");
    await writeFile(streamed, "Streamed link");
    store.appendEvent(chat.id, "text", { itemId: "streamed", text: "[分段](" });
    store.appendEvent(chat.id, "text", { itemId: "streamed", text: `${streamed})` });
    expect((await call(chat.id, streamed)).status).toBe(200);
    const completed = join(home, "completed.md");
    await writeFile(completed, "Completed message link");
    store.appendEvent(chat.id, "tool", { method: "item/completed", params: { item: { type: "agentMessage", id: "completed", text: `[完成](${completed})` } } });
    expect((await call(chat.id, completed)).status).toBe(200);
    const delivered = join(home, 'outputs', 'delivered one.md');
    await mkdir(join(home, 'outputs'));
    await writeFile(delivered, 'Delivered relative file');
    store.appendEvent(chat.id, 'text', { itemId: 'relative-delivery', text: 'Delivered `outputs/delivered one.md`.' });
    expect(await call(chat.id, 'outputs/delivered one.md')).toMatchObject({ status: 200, data: { path: delivered, text: 'Delivered relative file' } });
    expect((await call(other.id, 'outputs/delivered one.md')).status).toBe(403);
    const literalPercent = join(home, 'outputs', 'report%20one.md');
    await writeFile(literalPercent, 'Literal percent filename');
    store.appendEvent(chat.id, 'text', { itemId: 'percent-delivery', text: 'Delivered `outputs/report%2520one.md`.' });
    expect(await call(chat.id, 'outputs/report%2520one.md')).toMatchObject({ status: 200, data: { path: literalPercent, text: 'Literal percent filename' } });
    const inline = join(home, 'inline one.md');
    await writeFile(inline, 'Delivered absolute file');
    store.appendEvent(chat.id, 'text', { itemId: 'absolute-delivery', text: `Delivered \`${inline}\`.` });
    expect(await call(chat.id, inline)).toMatchObject({ status: 200, data: { path: inline, text: 'Delivered absolute file' } });
    const commandOnly = join(home, 'command-only.md');
    await writeFile(commandOnly, 'Not a delivery link');
    store.appendEvent(chat.id, 'text', { itemId: 'command-example', text: `Run \`cat ${commandOnly}\`\n\n\`\`\`\n${commandOnly}\n\`\`\`` });
    expect((await call(chat.id, commandOnly)).status).toBe(403);
    expect((await call(other.id, path)).status).toBe(403);
    expect((await call(chat.id, path, "https://foreign.example")).status).toBe(403);
    const missing = join(home, "missing.txt");
    store.appendEvent(chat.id, "text", { itemId: "missing", text: `[缺失](${missing})` });
    expect((await call(chat.id, missing)).status).toBe(404);
    expect((await call(chat.id, "/Users/example/private.txt")).status).toBe(403);
    const report = join(artifacts, "release-status.json");
    await writeFile(report, '{"status":"published"}');
    expect((await call(chat.id, report)).status).toBe(403);
    store.appendEvent(chat.id, "text", { itemId: "release", text: `[发布状态](${report})` });
    expect(await call(chat.id, report)).toMatchObject({ status: 200, data: { name: "release-status.json", text: '{"status":"published"}' } });
    expect((await call(other.id, report)).status).toBe(403);
    const unrelated = join(artifacts, "unrelated.txt");
    await writeFile(unrelated, "Unlinked file");
    expect((await call(chat.id, unrelated)).status).toBe(403);
    await writeFile(sibling, 'Outside cwd but inside the legacy temporary-file roots');
    await symlink(sibling, join(home, 'outputs', 'escape.md'));
    store.appendEvent(chat.id, 'text', { itemId: 'relative-escape', text: 'Delivered `outputs/escape.md`.' });
    expect((await call(chat.id, 'outputs/escape.md')).status).toBe(403);
    expect((await call(chat.id, join(home, 'outputs', 'escape.md'))).status).toBe(403);
    const secret = join(artifacts, ".env");
    await writeFile(secret, "synthetic secret");
    store.appendEvent(chat.id, "text", { itemId: "secret", text: `[环境](${secret})` });
    expect((await call(chat.id, secret)).status).toBe(403);
    const shortcut = join(artifacts, "shortcut.txt");
    await symlink(unrelated, shortcut);
    store.appendEvent(chat.id, "text", { itemId: "shortcut", text: `[快捷方式](${shortcut})` });
    expect((await call(chat.id, shortcut)).status).toBe(403);
    let checked = 0;
    const original = manager.authorizeConversationRead.bind(manager);
    const check = vi.spyOn(manager, "authorizeConversationRead").mockImplementation(id => {
      original(id);
      if (++checked === 2) throw new DomainError("forbidden", 403, "Access revoked");
    });
    try {
      const denied = await call(chat.id, path);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.data)).not.toContain("Expected file content");
    } finally { check.mockRestore(); }
  } finally { manager.close(); store.close(); server.close(); await rm(home, { recursive: true, force: true }); await rm(sibling, { force: true }); await rm(artifacts, { recursive: true, force: true }); }
});

it('authorizes the same local link targets that Markdown renders, including parentheses and references', async () => {
 const {linkedLocalFiles}=await import('../server/local-files');
 expect(linkedLocalFiles('[Report](/tmp/report(1).md)')).toEqual(['/tmp/report(1).md']);
 expect(linkedLocalFiles('[Report][file]\n\n[file]: /tmp/report.md')).toEqual(['/tmp/report.md']);
 expect(linkedLocalFiles('> [Report][file]\n>\n> [file]: /tmp/nested.md')).toEqual(['/tmp/nested.md']);
 expect(linkedLocalFiles('`[Hidden](/tmp/hidden.md)`\n\n[unused]: /tmp/unlinked.md\n\n![Image](/tmp/image.png)')).toEqual([]);
});

it('resolves delivered inline paths against an explicit chat cwd while rejecting traversal and commands', () => {
 const cwd='/tmp/authorized-chat';
 expect(localFilePath('outputs/report one.md',cwd)).toBe('/tmp/authorized-chat/outputs/report one.md');
 expect(localFilePath('./report one.md',cwd)).toBe('/tmp/authorized-chat/report one.md');
 expect(linkedLocalFiles('`outputs/report one.md` `/tmp/absolute.md` `cat /tmp/no.md`\n\n```\n/tmp/code.md\n```',cwd)).toEqual(['/tmp/authorized-chat/outputs/report one.md','/tmp/absolute.md']);
 expect(linkedLocalFiles('`outputs/report.md`')).toEqual([]);
 for(const href of ['../private.md','outputs/../private.md','outputs/%2e%2e/private.md','outputs/report.md;cat','//private/report.md','outputs/%00.md'])expect(()=>localFilePath(href,cwd)).toThrow();
});
