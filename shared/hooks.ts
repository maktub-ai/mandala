import type { Cli } from "./types";

export type HookEventData = {
  id: string;
  name: string;
  event: string;
  status: "running" | "completed" | "failed" | "blocked" | "stopped";
  source: Cli;
  turnId?: string;
  durationMs?: number;
  output?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function normalizeHookEvent(source: Cli, method: string | undefined, params: unknown): HookEventData | null {
  const p = record(params);
  const turn = typeof p.turnId === "string" && p.turnId ? { turnId: p.turnId } : {};
  if (source === "omp" && method === "omp/extension_error") {
    if (typeof p.id !== "string" || !p.id || typeof p.extensionPath !== "string" || !p.extensionPath ||
        typeof p.event !== "string" || !p.event || typeof p.error !== "string") return null;
    return { id: p.id, name: p.extensionPath.split(/[\\/]/).at(-1) || p.extensionPath,
      event: p.event, status: "failed", source, ...turn, output: p.error };
  }
  if (source !== "codex" || method !== "hook/started" && method !== "hook/completed") return null;
  const run = record(p.run);
  if (typeof run.id !== "string" || !run.id || typeof run.sourcePath !== "string" || !run.sourcePath ||
      typeof run.eventName !== "string" || !run.eventName ||
      typeof run.status !== "string" || !["running", "completed", "failed", "blocked", "stopped"].includes(run.status)) return null;
  const output = (Array.isArray(run.entries) ? run.entries.map((entry) => record(entry).text)
    .filter((text): text is string => typeof text === "string") : []);
  if (typeof run.statusMessage === "string" && run.statusMessage) output.push(run.statusMessage);
  return { id: run.id, name: run.sourcePath.split(/[\\/]/).at(-1) || run.sourcePath,
    event: run.eventName, status: run.status as HookEventData["status"], source, ...turn,
    ...(typeof run.durationMs === "number" && Number.isFinite(run.durationMs) && run.durationMs >= 0
      ? { durationMs: run.durationMs } : {}),
    ...(output.length ? { output: output.join("\n") } : {}) };
}
