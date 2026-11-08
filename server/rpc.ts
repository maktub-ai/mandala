import type { ChildProcessWithoutNullStreams } from "node:child_process";
export type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};
export type RpcCallbacks = {
  jsonRpc?: boolean;
  onRequest?: (message: RpcMessage) => void;
  onNotification?: (message: RpcMessage) => void;
  onExit?: (reason: string) => void;
};
export interface RpcClient {
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  reply(id: string | number, result: unknown): void;
  close(): void | Promise<void>;
}
export function createRpcClient(
  child: ChildProcessWithoutNullStreams,
  callbacks: RpcCallbacks,
): RpcClient {
  const stopped = new Promise<void>(resolve => { child.once("close", () => resolve()); });
  let counter = 0,
    buffer = "",
    ended = false;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const fail = (reason: string) => {
    if (ended) return;
    ended = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
    callbacks.onExit?.(reason);
  };
  child.on("error", (e) =>
    fail(
      `Cannot start Codex: ${e.message}. Install Codex and run codex login.`,
    ),
  );
  child.on("exit", (code, signal) => fail(`CLI exited (${code ?? signal})`));
  child.stdin.on("error", (e) => fail(`CLI input failed: ${e.message}`));
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (message.method) {
          if (message.id !== undefined) callbacks.onRequest?.(message);
          else callbacks.onNotification?.(message);
        } else if (typeof message.id === "number") {
          const p = pending.get(message.id);
          if (!p) continue;
          pending.delete(message.id);
          clearTimeout(p.timer);
          if (message.error) p.reject(new Error(message.error.message));
          else p.resolve(message.result);
        }
      } catch (e) {
        fail(`Invalid CLI event: ${(e as Error).message}`);
        child.kill();
      }
    }
  });
  const send = (value: unknown) => {
    if (ended) throw new Error("CLI exited");
    child.stdin.write(JSON.stringify(callbacks.jsonRpc ? { jsonrpc: "2.0", ...value as object } : value) + "\n");
  };
  return {
    request(method, params) {
      if (ended) return Promise.reject(new Error("CLI exited"));
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            Object.assign(new Error(`CLI request timed out: ${method}`), {
              name: "RpcTimeoutError",
            }),
          );
        }, 45000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, method, params });
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
    },
    notify(method, params) {
      send({ method, ...(params === undefined ? {} : { params }) });
    },
    reply(id, result) {
      send({ id, result });
    },
    close() {
      fail("CLI exited (closed)");
      child.stdin.end();
      child.kill();
      const t = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000);
      t.unref();
      return stopped;
    },
  };
}
