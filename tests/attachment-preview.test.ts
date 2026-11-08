import { expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { openStore } from "../server/store";
import { createSessionManager } from "../server/sessions";
import { createHttpServer } from "../server/http";
import { saveAttachment, loadAttachments } from "../server/attachments";

it("serves stored images only to their chat or a chat with an inherited reference", async () => {
  const home = await mkdtemp(join(tmpdir(), "mana-preview-"));
  const store = openStore(home);
  const manager = createSessionManager(store, async () => ({runtimes:['codex','omp'], version: 2, projects: [], agents: [] }));
  const server = createHttpServer({requireIdentity:false, home, store, manager });
  const get = (path: string, origin = "http://127.0.0.1") => new Promise<{ status: number; headers: Record<string, string>; data: Buffer }>(resolve => {
    let status = 0, headers: Record<string, string> = {};
    const req = Object.assign(Readable.from([]), { url: path, method: "GET", headers: { host: "127.0.0.1", origin } });
    server.emit("request", req, {
      writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
      end(data: string | Buffer) { resolve({ status, headers, data: Buffer.from(data) }); },
    });
  });
  try {
    const chat = await manager.create("", "");
    const other = await manager.create("", "");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGD8AAAAASUVORK5CYII=", "base64");
    const saved = await saveAttachment(home, chat.id, "sample.png", image);
    const endpoint = (id: string, attachmentId = saved.id) => `/api/conversations/${id}/attachments/${attachmentId}`;
    const response = await get(endpoint(chat.id));
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toBe("image/png");
    expect(response.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(response.data).toEqual(image);
    expect((await get(endpoint(other.id))).status).toBe(400);
    expect((await get(endpoint(chat.id), "https://foreign.example")).status).toBe(403);
    const fake = await saveAttachment(home, chat.id, "fake.png", Buffer.from("<html>not an image</html>"));
    expect((await get(endpoint(chat.id, fake.id))).status).toBe(415);
    const downloaded=await get(endpoint(chat.id,fake.id)+'?download=1');
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['Content-Type']).toBe('application/octet-stream');
    expect(downloaded.headers['Content-Disposition']).toContain('attachment;');
    expect(downloaded.data.toString()).toBe('<html>not an image</html>');
    expect((await get(endpoint(other.id,fake.id)+'?download=1')).status).toBe(400);
    const [fakeFile]=await loadAttachments(home,chat.id,[fake.id]);
    await writeFile(join(home,'outside.txt'),'private');await rm(fakeFile.path);await symlink(join(home,'outside.txt'),fakeFile.path);
    expect((await get(endpoint(chat.id,fake.id)+'?download=1')).status).toBe(403);
    const [reference] = await loadAttachments(home, chat.id, [saved.id]);
    store.appendEvent(other.id, "user", { text: "Inherited image", attachments: [reference] });
    expect((await get(endpoint(other.id))).status).toBe(200);
    const bad = await manager.create("", "");
    store.appendEvent(bad.id, "user", { text: "Invalid reference", attachments: [{ ...reference, path: join(home, "private.png") }] });
    expect((await get(endpoint(bad.id))).status).toBe(400);
    expect((await get(endpoint(chat.id, "invalid"))).status).toBe(400);
  } finally {
    manager.close();
    server.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
