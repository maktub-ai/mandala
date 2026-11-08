import type { Message } from "./i18n";
import { useLanguage } from "./i18n";

const destinations = {
  assets: [["最近文件", "/assets"]],
  settings: [["通用设置", "/settings/general"], ["执行端接入", "/settings/runtimes"], ["MCP 连接", "/settings/mcp"], ["系统任务", "/settings/system"]],
  tasks: [["任务", "/tasks"], ["自动化", "/tasks?tab=automation"]],
} satisfies Record<string, [Message, string][]>;
const labels: Record<keyof typeof destinations, Message> = { assets: "文件", settings: "设置与连接", tasks: "任务" };

export default function ContentNavigation({ group, disabled = false, onNavigate }: {
  group: keyof typeof destinations; disabled?: boolean; onNavigate: (path: string) => void;
}) {
  const { t } = useLanguage();
  const query = new URLSearchParams(location.search);
  const tab = query.get("tab") ?? "memory";
  return <nav className="content-navigation" aria-label={t(labels[group])}>
    {destinations[group].map(([label, path]) => {
      const target = new URL(path, location.href);
      const current = target.pathname === location.pathname && (!["/mana", "/tasks"].includes(target.pathname) || (target.searchParams.get("tab") ?? "memory") === tab) ||
        group === "settings" && path === "/mana/skills" && location.pathname === "/settings/skills" ||
        group === "assets" && path === "/assets" && (location.pathname.startsWith("/assets/") || location.pathname === "/mana" && tab === "document") ||
        group === "tasks" && path.endsWith("automation") && location.pathname === "/mana" && tab === "automation";
      if (group === "assets" && query.has("project")) target.searchParams.set("project", query.get("project")!);
      const href = target.pathname + target.search;
      return <a key={path} href={href} aria-current={current ? "page" : undefined} aria-disabled={disabled || undefined} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); if (!disabled) onNavigate(href);
      }}>{t(label)}</a>;
    })}
  </nav>;
}
