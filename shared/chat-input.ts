import type { Cli, ModelChoice } from "./types";
export const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const effortLabels = { none: "关闭思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超高" } as const;
export type ReasoningEffort = typeof efforts[number];
export type ChatDefaults = Partial<Record<Cli, { model?: string; effort?: ReasoningEffort }>>;
export type Attachment = { id: string; name: string; size: number; mimeType: string };
export type NativeAttachment = Attachment & { path: string };
export type TurnOptions = { model?: string; effort?: ReasoningEffort; images?: { path: string; mimeType: string }[] };
export function validateEffort(value: unknown): asserts value is ReasoningEffort {
  if (!efforts.includes(value as ReasoningEffort)) throw new Error("invalid reasoning effort");
}
export function modelOptions(models: ModelChoice[], inherited?: string) {
  const id = inherited || models.find(model => model.isDefault)?.id;
  return [{ value: "", label: models.find(model => model.id === id)?.label ?? id ?? "—" },
    ...models.map(model => ({ value: model.id, label: model.label }))];
}
export function effortOptions(model?: ModelChoice) {
  return model?.supportedReasoningEfforts ?? [];
}
