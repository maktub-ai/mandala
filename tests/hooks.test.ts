import { expect, it } from "vitest";
import { normalizeHookEvent } from "../shared/hooks";

const run = { id: "native-hook", eventName: "preToolUse", sourcePath: "/tmp/hooks/audit.sh",
  handlerType: "command", status: "running", entries: [], durationMs: null };

it.each(["running", "completed", "failed", "blocked", "stopped"])("preserves the native Codex hook result %s", (status) => {
  expect(normalizeHookEvent("codex", status === "running" ? "hook/started" : "hook/completed", { run: { ...run, status } }))
    .toEqual({ id: "native-hook", name: "audit.sh", event: "preToolUse", status, source: "codex" });
});

it("keeps native duration, turn correlation and text output including the status message", () => {
  expect(normalizeHookEvent("codex", "hook/completed", { turnId: "turn-1", run: {
    ...run, status: "completed", durationMs: 0,
    entries: [{ kind: "context", text: "<script>untrusted</script>" }, { kind: "feedback", text: "Checked" }],
    statusMessage: "Done",
  } })).toMatchObject({ turnId: "turn-1", durationMs: 0, output: "<script>untrusted</script>\nChecked\nDone" });
});

it("recognizes OMP extension errors only as failures without adding unreported duration", () => {
  expect(normalizeHookEvent("omp", "omp/extension_error", { id: "failure-1", extensionPath: "/tmp/audit.ts",
    event: "tool_call", error: "Policy rejected" }))
    .toEqual({ id: "failure-1", name: "audit.ts", event: "tool_call", status: "failed", source: "omp", output: "Policy rejected" });
  expect(normalizeHookEvent("omp", "hook/started", { run })).toBeNull();
  expect(normalizeHookEvent("codex", "omp/extension_error", { id: "failure-1" })).toBeNull();
});

it("does not reinterpret tools or malformed notifications as hooks", () => {
  expect(normalizeHookEvent("codex", "item/started", { run })).toBeNull();
  for (const value of [null, {}, { run: null }, { run: { ...run, id: "" } }, { run: { ...run, status: "unknown" } },
      { run: { ...run, status: { toString: "running" } } }])
    expect(normalizeHookEvent("codex", "hook/started", value)).toBeNull();
  expect(normalizeHookEvent("omp", "omp/extension_error", { extensionPath: "/tmp/audit.ts", event: "tool_call" })).toBeNull();
});
