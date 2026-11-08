import Button from './ui/Button';
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import DOMPurify from "dompurify";
import Dialog from "./Dialog";
import { useLanguage } from "./i18n";
import "./mermaid.css";

let sequence = 0;
let renders: Promise<unknown> = Promise.resolve();

function renderDiagram(source: string, theme: string) {
  // Mermaid's configuration is global; configure and render each diagram together.
  const result = renders.then(async () => {
    const { default: mermaid } = await import("mermaid");
    const style = getComputedStyle(document.documentElement);
    const color = (name: string) => style.getPropertyValue(name).trim();
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      theme: "base", fontFamily: style.fontFamily, htmlLabels: false,
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "theme", "themeVariables", "themeCSS", "htmlLabels", "flowchart", "dompurifyConfig"],
      themeVariables: {
        darkMode: theme === "dark", background: color("--panel"),
        primaryColor: color("--accent-bg"), primaryTextColor: color("--text"), primaryBorderColor: color("--accent"),
        secondaryColor: color("--surface"), secondaryTextColor: color("--text"), secondaryBorderColor: color("--border"),
        tertiaryColor: color("--raised"), tertiaryTextColor: color("--text"), tertiaryBorderColor: color("--border"),
        lineColor: color("--muted"), textColor: color("--text"), mainBkg: color("--accent-bg"),
        nodeBorder: color("--accent"), clusterBkg: color("--surface"), clusterBorder: color("--border"),
        edgeLabelBackground: color("--panel"), actorTextColor: color("--text"), actorBkg: color("--accent-bg"),
        actorBorder: color("--accent"), actorLineColor: color("--muted"), signalColor: color("--muted"),
        signalTextColor: color("--text"), labelBoxBkgColor: color("--panel"), labelTextColor: color("--text"),
      },
    });
    const container = document.createElement("div");
    container.style.cssText = "position:absolute;left:-10000px;visibility:hidden;";
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`mana-mermaid-${++sequence}`, source, container);
      const sanitized = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject"] });
      const image = new DOMParser().parseFromString(sanitized, "image/svg+xml").documentElement;
      const bounds = image.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
      const width = bounds?.[2] || 300;
      const height = bounds?.[3] || 150;
      image.setAttribute("width", String(width));
      image.setAttribute("height", String(height));
      return { svg: image.outerHTML, width, height };
    } finally { container.remove(); }
  });
  renders = result.catch(() => {});
  return result;
}

function DiagramViewport({ svg, width, height, expanded = false, suspended = false, onExpand }: {
  svg: string; width: number; height: number; expanded?: boolean; suspended?: boolean; onExpand?: () => void;
}) {
  const { t } = useLanguage();
  const canvas = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [view, setView] = useState<{ scale: number; x: number; y: number }>();
  const drag = useRef<{ id: number; x: number; y: number; view: { scale: number; x: number; y: number } }>(undefined);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setAvailable(entry.contentRect.width);
      setAvailableHeight(entry.contentRect.height);
      setView(undefined);
    });
    observer.observe(canvas.current!);
    return () => observer.disconnect();
  }, []);
  const viewportHeight = expanded ? availableHeight : Math.min(420, Math.max(160, height * Math.min(1, Math.max(1, available - 32) / width) + 32));
  const fitScale = Math.min(1, Math.max(1, available - 32) / width, Math.max(1, viewportHeight - 32) / height);
  const fitted = { scale: fitScale, x: (available - width * fitScale) / 2, y: (viewportHeight - height * fitScale) / 2 };
  const position = view ?? fitted;
  function zoom(factor: number) {
    setView(previous => {
      const current = previous ?? fitted;
      const scale = Math.max(fitScale / 4, Math.min(4, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: available / 2 - (available / 2 - current.x) * ratio,
        y: viewportHeight / 2 - (viewportHeight / 2 - current.y) * ratio };
    });
  }
  return <>
    <div ref={canvas} className="mermaid-canvas" tabIndex={0} role="group" aria-label={t("Mermaid 图表")}
      title={t("拖动平移，使用按钮缩放")} style={expanded ? undefined : { height: viewportHeight }}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view: position };
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        setView({ ...start.view, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y });
      }}
      onPointerUp={event => {
        if (drag.current?.id === event.pointerId) {
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = undefined;
        }
      }}
      onLostPointerCapture={() => { drag.current = undefined; }}
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') zoom(1.25);
        else if (event.key === '-') zoom(0.8);
        else if (event.key === '0') setView(undefined);
        else if (event.key.startsWith('Arrow')) setView(previous => ({ ...(previous ?? fitted),
          x: (previous ?? fitted).x + (event.key === 'ArrowLeft' ? -32 : event.key === 'ArrowRight' ? 32 : 0),
          y: (previous ?? fitted).y + (event.key === 'ArrowUp' ? -32 : event.key === 'ArrowDown' ? 32 : 0) }));
        else return;
        event.preventDefault();
      }}>
      <div className="mermaid-stage" role="img" aria-label={t("Mermaid 图表")}
        style={{ width, height, transform: `translate(${position.x}px, ${position.y}px) scale(${position.scale})` }}
        dangerouslySetInnerHTML={{ __html: suspended ? "" : svg }} />
    </div>
    <div className="mermaid-controls">
      <Button type="button" className="mermaid-scale" aria-label={t("原始大小")}
        title={t("原始大小")} onClick={() => zoom(1 / position.scale)}>{Math.round(position.scale * 100)}%</Button>
      <Button type="button" aria-label={t("缩小图表")} title={t("缩小图表")} onClick={() => zoom(0.8)}><ZoomOut size={16} aria-hidden="true" /></Button>
      <Button type="button" aria-label={t("放大图表")} title={t("放大图表")} onClick={() => zoom(1.25)}><ZoomIn size={16} aria-hidden="true" /></Button>
      <Button type="button" aria-label={t("适应图表")} title={t("适应图表")} onClick={() => setView(undefined)}><RotateCcw size={16} aria-hidden="true" /></Button>
      {onExpand && <Button type="button" aria-label={t("全屏查看图表")} title={t("全屏查看图表")} onClick={onExpand}><Maximize2 size={16} aria-hidden="true" /></Button>}
    </div>
  </>;
}

export default function MermaidDiagram({ source }: { source: string }) {
  const { t } = useLanguage();
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  const [expanded, setExpanded] = useState(false);
  const [paletteVersion, setPaletteVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setPaletteVersion(value => value + 1);
    window.addEventListener("mandala-theme-change", refresh);
    return () => window.removeEventListener("mandala-theme-change", refresh);
  }, []);
  const [result, setResult] = useState<{ source: string; theme: string; diagram?: { svg: string; width: number; height: number }; failed?: boolean }>();
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void renderDiagram(source, theme).then(diagram => {
        if (active) setResult({ source, theme, diagram });
      }).catch(() => { if (active) setResult({ source, theme, failed: true }); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [source, theme, paletteVersion]);
  const current = result?.source === source && result.theme === theme ? result : undefined;
  const diagram = current?.diagram ?? (result?.source === source ? result.diagram : undefined);
  return <div className="mermaid-diagram" data-theme={theme}>
    {diagram ? <>
      <DiagramViewport key={source} {...diagram} suspended={expanded} onExpand={() => setExpanded(true)} />
      {expanded && createPortal(<Dialog label={t("Mermaid 图表")} className="mermaid-fullscreen" onClose={() => setExpanded(false)}>
        <div className="mermaid-viewer-header">
          <span>{t("Mermaid 图表")}</span>
          <Button type="button" aria-label={t("关闭图表")} title={t("关闭图表")} onClick={() => setExpanded(false)}><X size={20} aria-hidden="true" /></Button>
        </div>
        <div className="mermaid-viewer-body"><DiagramViewport {...diagram} expanded /></div>
      </Dialog>, document.body)}
    </> : current?.failed ? <>
      <p className="mermaid-error" role="status">{t("图表暂时无法渲染，源码已保留。")}</p>
      <pre><code>{source}</code></pre>
    </> : <p className="mermaid-loading" role="status">{t("正在绘制图表…")}</p>}
  </div>;
}
