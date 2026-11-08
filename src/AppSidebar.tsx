import { devicePreferences } from './devicePreferences';
import BrandMark from './ui/BrandMark';
import Button from './ui/Button';
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLanguage } from "./i18n";
import Icon from "./ui/Icon";
import "./sidebar.css";

export type SidebarNavigation = () => ReactNode;

export default function AppSidebar({ navigation, open, onClose, chat = false }: {
  navigation?: SidebarNavigation; open: boolean; onClose: () => void; chat?: boolean;
}) {
  const { t } = useLanguage();
  const [layout, setLayout] = useState(() => {
    try {
      const value = JSON.parse(devicePreferences.getItem("mana-sidebar-layout") || "null");
      if (value && typeof value.collapsed === "boolean" && Number.isFinite(value.width))
        return { collapsed: value.collapsed, width: Math.max(220, Math.min(400, value.width)) };
    } catch { /* Use the default for unreadable preferences. */ }
    return { collapsed: false, width: 220 };
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    try { devicePreferences.setItem("mana-sidebar-layout", JSON.stringify(layout)); } catch { /* Storage may be unavailable. */ }
  }, [layout]);
  const sidebar = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const close = () => { onClose(); requestAnimationFrame(() => {
    const opener = trigger.current;
    const target = opener?.isConnected && opener !== document.body && !sidebar.current?.contains(opener)
      ? opener : sidebar.current?.parentElement?.querySelector<HTMLButtonElement>("main .mobile-menu");
    target?.focus();
  }); };
  useEffect(() => {
    if (!open) return;
    if (!matchMedia("(max-width: 600px)").matches) {
      setLayout(value => ({ ...value, collapsed: false }));
      onClose();
      requestAnimationFrame(() => sidebar.current?.querySelector<HTMLButtonElement>(".sidebar-collapse")?.focus());
      return;
    }
    trigger.current = document.activeElement as HTMLElement;
    const main = sidebar.current?.parentElement?.querySelector("main");
    if (main) main.inert = true;
    sidebar.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const narrow = matchMedia("(max-width: 600px)");
    const resize = () => { if (!narrow.matches) onClose(); };
    narrow.addEventListener("change", resize);
    return () => { if (main) main.inert = false; narrow.removeEventListener("change", resize); };
  }, [open]);
  return <>
    {open && <Button type="button" className="sidebar-backdrop" aria-hidden="true" onClick={close} tabIndex={-1} />}
    <aside ref={sidebar} data-collapsed={layout.collapsed} style={{ "--sidebar-width": `${layout.width}px` } as CSSProperties} className={`sidebar area-sidebar${open ? " mobile-open" : ""}`} onKeyDown={event => {
      if (!open || event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const items = Array.from(sidebar.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]')).filter(item => item.offsetParent !== null && (item.tagName === "SUMMARY" || !item.closest("details:not([open])")));
        const target = event.shiftKey && document.activeElement === items[0] ? items.at(-1) : !event.shiftKey && document.activeElement === items.at(-1) ? items[0] : null;
        if (target) { event.preventDefault(); target.focus(); }
      }
    }}>
      <div className="sidebar-heading"><div className="workspace-brand"><BrandMark/><span>Mandala</span></div><Button type="button" className="sidebar-close icon-button" aria-label={t(chat ? "关闭会话列表" : "关闭侧栏")} onClick={close}><Icon name="close" size={18}/></Button></div>
      {(() => { const slot=document.getElementById('desktop-titlebar-left');const button=<Button type="button" className="sidebar-collapse icon-button" aria-label={t(layout.collapsed ? "展开侧栏" : "收起侧栏")} title={t(layout.collapsed ? "展开侧栏" : "收起侧栏")} aria-expanded={!layout.collapsed} onClick={() => {
        setLayout(value => ({ ...value, collapsed: !value.collapsed }));
        if (!slot && !layout.collapsed) requestAnimationFrame(() => sidebar.current?.parentElement?.querySelector<HTMLButtonElement>("main .sidebar-expand")?.focus());
      }}><Icon name="panelLeft" size={18}/></Button>;return slot?createPortal(button,slot):button; })()}
      <div className="area-sidebar-content">{navigation?.()}</div>
      <div className="sidebar-resize" role="separator" aria-label={t("调整侧栏宽度")} aria-orientation="vertical" aria-valuemin={220} aria-valuemax={400} aria-valuenow={layout.width} tabIndex={layout.collapsed ? -1 : 0}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, width: layout.width }; }}
        onPointerMove={event => { if (drag.current) setLayout(value => ({ ...value, width: Math.max(220, Math.min(400, drag.current!.width + event.clientX - drag.current!.x)) })); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => setLayout(value => ({ ...value, width: 220 }))}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          setLayout(value => ({ ...value, width: event.key === "Home" ? 220 : event.key === "End" ? 400 : Math.max(220, Math.min(400, value.width + (event.key === "ArrowRight" ? 16 : -16))) }));
        }} />
    </aside>
  </>;
}

export function SidebarToggle({ onClick, chat = false }: { onClick: () => void; chat?: boolean }) {
  const { t } = useLanguage();
  return <><Button type="button" className="sidebar-expand icon-button" aria-label={t("展开侧栏")} title={t("展开侧栏")} aria-expanded={false} onClick={onClick}><Icon name="panelLeft" size={18}/></Button><Button type="button" className="mobile-menu icon-button" aria-label={t(chat ? "会话列表" : "打开侧栏")} onClick={onClick}><Icon name="menu" size={20} /></Button></>;
}
