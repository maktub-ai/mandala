import Button from './ui/Button';
import Input from './ui/Input';
import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/types";
import Dialog from "./Dialog";
import Icon from "./ui/Icon";
import { useLanguage } from "./i18n";

export default function ProjectActions({ project, locked, onRename, onDelete }: {
  project: Project; locked: boolean; onRename: (name: string) => void; onDelete: () => void;
}) {
  const { t, errorText } = useLanguage();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const choose = (value: "rename" | "delete") => {
    setOpen(false); trigger.current?.focus(); setName(project.name); setError(""); setAction(value);
  };
  return <>
    <Button type="button" className="project-delete" disabled={locked} onClick={() => { setError(""); setAction("delete"); }}><Icon name="trash" size={16} />{t("删除项目")}</Button>
    <div className="project-actions" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
      if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (!open) { setOpen(true); return; }
        const items = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      <Button type="button" className="icon-button" ref={trigger} disabled={locked} title={t("项目操作")} aria-label={t("项目操作")} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}><Icon name="more" size={18} /></Button>
      {open && <div className="project-actions-menu" role="menu" aria-label={t("项目操作")}>
        <Button type="button" role="menuitem" disabled={locked} onClick={() => choose("rename")}><Icon name="edit" size={16} />{t("重命名项目")}</Button>
        <Button type="button" role="menuitem" disabled={locked} className="project-delete" onClick={() => choose("delete")}><Icon name="trash" size={16} />{t("删除项目")}</Button>
      </div>}
    </div>
    {action && <Dialog label={t(action === "rename" ? "重命名项目" : "确认删除项目")} className="project-action-dialog" locked={locked} onClose={() => setAction(null)}>
      <form onSubmit={event => {
        event.preventDefault();
        if (locked) return;
        if (action === "rename") {
          if (!name.trim()) { setError("项目名称不能为空"); return; }
          onRename(name.trim());
        } else onDelete();
        setAction(null);
      }}>
        <h2>{t(action === "rename" ? "重命名项目" : "确认删除项目")}</h2>
        {action === "rename" ? <label>{t("新项目名称")}<Input aria-label={t("新项目名称")} value={name} onChange={event => { setName(event.target.value); setError(""); }} disabled={locked} /></label> : <><p className="project-delete-name">{project.name}</p><p className="field-hint">{t("只移除项目配置。工作目录、历史对话、工作区资料和共享 Agent 均保留。")}</p></>}
        {error && <p className="form-error" role="alert">{errorText(error)}</p>}
        <p className="field-hint">{t("确认后自动保存。")}</p>
        <div className="project-form-actions"><Button type="button" disabled={locked} onClick={() => setAction(null)}>{t("取消")}</Button><Button type="submit" disabled={locked} className={action === "rename" ? "primary" : "project-delete"}>{t(action === "rename" ? "保存名称" : "删除项目")}</Button></div>
      </form>
    </Dialog>}
  </>;
}
