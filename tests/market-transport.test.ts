import { beforeEach, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
const mock = vi.hoisted(() => ({ status: 200, headers: {} as Record<string, string>, request: vi.fn() }));
vi.mock("node:https", () => ({ get: mock.request }));
import { marketFetch } from "../server/market-transport";
beforeEach(() => {
 mock.status = 200; mock.headers = {}; mock.request.mockReset();
 mock.request.mockImplementation((_url, _options, callback) => {
  const request = new EventEmitter();
  queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from("source")]), { statusCode: mock.status, headers: mock.headers })));
  return request;
 });
});
it("uses a fresh bounded HTTPS connection without following redirects or forwarding credentials", async () => {
 const result = await marketFetch("https://api.github.com/repos/example/skills/git/trees/HEAD?recursive=1");
 expect(await result.text()).toBe("source");
 expect(mock.request.mock.calls[0][1]).toMatchObject({ agent: false, headers: { Accept: "application/json", "User-Agent": "Mandala-Market" } });
 expect(mock.request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
 mock.status=302; mock.headers={location:"http://127.0.0.1/secret"};
 expect((await marketFetch("https://raw.githubusercontent.com/example/skills/main/SKILL.md")).status).toBe(302);
 expect(mock.request).toHaveBeenCalledTimes(2);
});
it.each(["http://api.github.com/a", "https://user:password@api.github.com/a", "https://api.github.com:8443/a", "https://localhost/a", "https://api.github.com.evil.test/a", "https://api.github.com/a#fragment"])("rejects unsupported network destinations: %s", async url => {
 await expect(marketFetch(url)).rejects.toThrow("invalid market source URL");
 expect(mock.request).not.toHaveBeenCalled();
});
