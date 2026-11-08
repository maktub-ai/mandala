import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRpcClient, type RpcMessage } from "../server/rpc";
const fixture = () =>
  spawn(process.execPath, ["tests/fixtures/fake-cli.mjs"], { stdio: "pipe" });
it("routes_fragmented_response", async () => {
  const rpc = createRpcClient(fixture(), {});
  try {
    expect(await rpc.request("probe", { value: 7 })).toEqual({ value: 7 });
  } finally {
    rpc.close();
  }
});
it("preserves_server_request_id_and_routes_approval_reply", async () => {
  let resolve!: (m: RpcMessage) => void;
  const received = new Promise<RpcMessage>((r) => {
    resolve = r;
  });
  let result!: (m: RpcMessage) => void;
  const reply = new Promise<RpcMessage>((r) => {
    result = r;
  });
  const rpc = createRpcClient(fixture(), {
    onRequest: resolve,
    onNotification: result,
  });
  try {
    await rpc.request("approval", {});
    const request = await received;
    expect(request.id).toBe(42);
    rpc.reply(request.id!, { decision: "accept" });
    expect((await reply).params).toEqual({
      id: 42,
      result: { decision: "accept" },
    });
  } finally {
    rpc.close();
  }
});
it("rejects_pending_requests_on_exit", async () => {
  const rpc = createRpcClient(fixture(), {});
  try {
    await expect(rpc.request("exit", {})).rejects.toThrow("CLI exited");
  } finally {
    rpc.close();
  }
});
