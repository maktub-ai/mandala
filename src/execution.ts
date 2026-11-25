import type { NativeItem } from '../shared/execution';
export * from '../shared/execution';

export function platformHookLabel(item: NativeItem) {
  if (item.hook?.source !== "platform") return undefined;
  switch (item.hook.task) {
    case "search": return "记忆检索";
    case "capture": return "记忆采集";
    case "title": return "生成标题";
    case "memory": return "提炼记忆";
    case "recall": return (item.result as { entries?: {kind: string}[] })?.entries?.some(entry => entry.kind === "document") ? "资料加载" : "记忆加载";
  }
}
