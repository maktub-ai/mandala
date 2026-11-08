import type { MouseEvent } from "react";
import type { Project } from "../shared/types";
import { useLanguage, type Message } from "./i18n";

export default function ProjectNavigation({ project, active, disabled = false, onNavigate }: {
  project?: Project; active: "settings" | "overview" | "tasks" | "assets" | "memory" | "agents"; disabled?: boolean; onNavigate?: (path: string) => void;
}) {
  const { t,language } = useLanguage();
  if (!project) return null;
  const id = encodeURIComponent(project.id);
  const links: { id: typeof active; label: Message; path: string }[] = [
    { id: "overview", label: "概览", path: `/projects/${id}/overview` },
    { id: "assets", label: "资料库", path: `/projects/${id}/library` },
    { id: "settings", label: "设置", path: `/projects/${id}/settings` },
  ];
  const follow = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (disabled || onNavigate) { event.preventDefault(); if (!disabled) onNavigate?.(path); }
    else { event.preventDefault(); history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); }
  };
  return <nav className="project-content-navigation" aria-label={t("项目导航")}><span className="project-context" title={project.name}>{project.name}</span>
    <div>{links.map(link => <a key={link.id} href={link.path} aria-current={active === link.id ? "page" : undefined} aria-disabled={disabled || undefined} onClick={event => follow(event, link.path)}>{link.id==='assets'&&language !== 'zh-CN'?'Library':link.id==='agents'&&language !== 'zh-CN'?'Agents':t(link.label)}</a>)}</div>
  </nav>;
}
