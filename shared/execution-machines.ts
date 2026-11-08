import type { Config, ExecutionLocation, Workspace } from "./types";

export function isValidSshHost(host: unknown): host is string {
  return typeof host === "string" && host.length <= 300 &&
    /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:]+\]|[A-Fa-f0-9]*:[A-Fa-f0-9:]+)$/.test(host);
}

export function isRemoteAbsolutePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(path);
}

export function workspaceExecutionLocation(config: Pick<Config, "executionMachines">, workspace?: Workspace, cwd = workspace?.cwd): ExecutionLocation | undefined {
  if (workspace?.machineId === undefined) return undefined;
  const machine = config.executionMachines?.find(item => item.id === workspace.machineId);
  if (!machine || !isValidSshHost(machine.host) || !isRemoteAbsolutePath(cwd)) throw new Error("invalid execution location");
  return { machineId: machine.id, machineName: machine.name, host: machine.host, cwd };
}
