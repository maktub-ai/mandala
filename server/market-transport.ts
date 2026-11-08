import { get } from "node:https";
import { Readable } from "node:stream";

const hosts = new Set(["api.github.com", "raw.githubusercontent.com", "registry.modelcontextprotocol.io", "clawhub.ai"]);
/** Market packages only come from fixed public adapter hosts, with no redirects or shared idle sockets. */
export async function marketFetch(value: string, signal?: AbortSignal): Promise<Response> {
  const url = new URL(value);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.port || url.username || url.password || url.hash) throw new Error("invalid market source URL");
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { Accept: "application/json", "User-Agent": "Mandala-Market" } }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const status = response.statusCode ?? 502;
      try {
        const empty = [204, 205, 304].includes(status);
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream, { status, headers }));
      } catch { response.destroy(); reject(new Error("invalid market source response")); }
    });
    request.once("error", reject);
  });
}
