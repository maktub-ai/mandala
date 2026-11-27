import type { Cli, ModelChoice } from "./types";
export const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const effortLabels = { none: "关闭思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超高" } as const;
export type ReasoningEffort = typeof efforts[number];
export type AgentEffort = { cli: Cli; model: string; effort: ReasoningEffort };
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
    ...models.map(model => ({ value: model.id, label: model.label, ...(providerGroups(models) && model.provider ? { group: model.provider } : {}) }))];
}
/** Providers only matter when one runtime offers models from more than one of them. */
export function providerGroups(models: ModelChoice[]) {
  return new Set(models.map(model => model.provider).filter(Boolean)).size > 1;
}
/** The pill shows a short name; a runtime may prefix labels with its provider. */
export function modelShortLabel(model: ModelChoice) {
  if (model.shortLabel) return model.shortLabel;
  const prefix = model.provider ? `${model.provider} / ` : "";
  return prefix && model.label.startsWith(prefix) ? model.label.slice(prefix.length) : model.label;
}
export function effortOptions(model?: ModelChoice) {
  return [...new Set(model?.supportedReasoningEfforts?.filter(value => efforts.includes(value)))];
}

export function effortModel(models: ModelChoice[], model?: string | null) {
  return model ? models.find(item => item.id === model) : models.find(item => item.isDefault);
}

export function matchingAgentEffort(value: AgentEffort | undefined, cli: Cli, model?: string | null) {
  return value?.cli === cli && (!model || model === value.model) ? value : undefined;
}

export function supportedAgentEffort(value: AgentEffort | undefined, model?: ModelChoice) {
  return value && value.model === model?.id && effortOptions(model).includes(value.effort) ? value.effort : undefined;
}
