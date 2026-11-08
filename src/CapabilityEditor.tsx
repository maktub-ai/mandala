import Button from './ui/Button';
import Input from './ui/Input';
import Disclosure from './ui/Disclosure';
import { useState } from "react";
import FolderPicker from "./FolderPicker";
import Select from "./ui/Select";
import Icon from "./ui/Icon";
import type { McpServer, Skill } from "../shared/types";
import { useLanguage } from "./i18n";

export default function CapabilityEditor({ mcp, skills, onMcp, onSkills, mode, compact = false, canRemove = true }: {
  mcp: McpServer[];
  skills: Skill[];
  onMcp: (items: McpServer[]) => void;
  onSkills: (items: Skill[]) => void;
  mode?: "mcp" | "skills";
  compact?: boolean; canRemove?: boolean;
}) {
  const { t } = useLanguage();
  const [folderIndex, setFolderIndex] = useState<number | null>(null);
  return <div className="capability-editor">
    {mode !== "skills" && <>
    <div className="settings-section-title">
      <h4>MCP</h4>
      {!compact && <Button type="button" onClick={() => onMcp([...mcp, { name: "", transport: "stdio", command: "" }])}><Icon name="plus" size={16} />{t("添加 MCP")}</Button>}
    </div>
    {mcp.map((item, index) => <div className="capability-row mcp-capability-row" key={index}>
      <label><span>{t("MCP 名称")}</span><Input aria-label={t("MCP 名称")} placeholder={t("MCP 名称")} value={item.name}
        onChange={(e) => onMcp(mcp.map((m, i) => i === index ? { ...m, name: e.target.value } : m))} /></label>
      <label><span>{t("连接类型")}</span><Select icon="tool" ariaLabel={t("连接类型")} value={item.transport} searchable={false}
        onChange={(value) => onMcp(mcp.map((m, i) => i === index ? { name: m.name, transport: value as "stdio" | "http", ...(value === "stdio" ? { command: "" } : { url: "" }) } : m))}
        options={[{value:"stdio",label:"stdio",icon:<Icon name="terminal" size={16} />},{value:"http",label:"HTTP",icon:<Icon name="globe" size={16} />}]} /></label>
      <label><span>{item.transport === "stdio" ? t("启动命令") : "URL"}</span><Input aria-label={item.transport === "stdio" ? t("启动命令") : "URL"}
        placeholder={item.transport === "stdio" ? t("启动命令") : "URL"}
        value={item.transport === "stdio" ? item.command ?? "" : item.url ?? ""}
        onChange={(e) => onMcp(mcp.map((m, i) => i === index ? {
          ...m, [item.transport === "stdio" ? "command" : "url"]: e.target.value,
        } : m))} /></label>
      <Button type="button" disabled={!canRemove} aria-label={t("移除 MCP")} onClick={() => onMcp(mcp.filter((_, i) => i !== index))}><Icon name="close" size={16} /></Button>
      {item.transport === "stdio" && <Disclosure className="capability-advanced" title={<> {t("启动参数与环境变量")} </>}>

        <div className="settings-section-title"><strong>{t("启动参数")}</strong>
          <Button type="button" aria-label={t("添加参数")} onClick={() => onMcp(mcp.map((m, i) => i === index ? { ...m, args: [...(m.args ?? []), ""] } : m))}><Icon name="plus" size={16} /></Button></div>
        {(item.args ?? []).map((arg, argIndex) => <div className="capability-row" key={argIndex}>
          <Input aria-label={t("启动参数")} value={arg} onChange={(e) => onMcp(mcp.map((m, i) => i === index ?
            { ...m, args: m.args?.map((a, n) => n === argIndex ? e.target.value : a) } : m))} />
          <Button type="button" aria-label={t("移除参数")} onClick={() => onMcp(mcp.map((m, i) => i === index ?
            { ...m, args: m.args?.filter((_, n) => n !== argIndex) } : m))}><Icon name="close" size={16} /></Button>
        </div>)}
        <div className="settings-section-title"><strong>{t("环境变量引用")}</strong>
          <Button type="button" aria-label={t("添加环境变量引用")} onClick={() => onMcp(mcp.map((m, i) => i === index ?
            { ...m, env: { ...m.env, "": "${}" } } : m))}><Icon name="plus" size={16} /></Button></div>
        {Object.entries(item.env ?? {}).map(([key, ref], envIndex) => <div className="capability-row" key={envIndex}>
          <Input aria-label={t("变量名称")} placeholder="API_KEY" value={key} onChange={(e) => onMcp(mcp.map((m, i) => {
            if (i !== index) return m;
            const entries = Object.entries(m.env ?? {});
            entries[envIndex] = [e.target.value, ref];
            return { ...m, env: Object.fromEntries(entries) };
          }))} />
          <Input aria-label={t("变量来源")} placeholder="${MY_API_KEY}" value={ref}
            onChange={(e) => onMcp(mcp.map((m, i) => i === index ?
              { ...m, env: { ...m.env, [key]: e.target.value } } : m))} />
          <Button type="button" aria-label={t("移除变量")} onClick={() => onMcp(mcp.map((m, i) => {
            if (i !== index) return m;
            const entries = Object.entries(m.env ?? {});
            entries.splice(envIndex, 1);
            return { ...m, env: Object.fromEntries(entries) };
          }))}><Icon name="close" size={16} /></Button>
        </div>)}
      </Disclosure>}
    </div>)}
    <p className="field-hint">{t("MCP 凭据保留在原生配置或环境变量中；这里不保存密钥。")}</p>
    </>}
    {mode !== "mcp" && <>
    <div className="settings-section-title">
      <h4>Skills</h4>
      {!compact && <Button type="button" onClick={() => onSkills([...skills, { name: "", path: "" }])}><Icon name="plus" size={16} />{t("添加 Skill")}</Button>}
    </div>
    {skills.map((item, index) => <div className="capability-row skill-capability-row" key={index}>
      <label><span>{t("Skill 名称")}</span><Input aria-label={t("Skill 名称")} placeholder={t("Skill 名称")} value={item.name}
        onChange={(e) => onSkills(skills.map((s, i) => i === index ? { ...s, name: e.target.value } : s))} /></label>
      <label><span>{t("Skill 目录")}</span><Input aria-label={t("Skill 目录")} placeholder={t("Skill 目录")} value={item.path}
        onChange={(e) => onSkills(skills.map((s, i) => i === index ? { ...s, path: e.target.value } : s))} /></label>
      <Button type="button" aria-label={t("浏览 Skill 目录")} onClick={() => setFolderIndex(index)}><Icon name="folder" size={16} /></Button>
      <Button type="button" disabled={!canRemove} aria-label={t("移除 Skill")} onClick={() => onSkills(skills.filter((_, i) => i !== index))}><Icon name="close" size={16} /></Button>
    </div>)}
    </>}
    {folderIndex !== null && <FolderPicker initialPath={skills[folderIndex]?.path ?? ""} onClose={() => setFolderIndex(null)} onSelect={path => { onSkills(skills.map((item, index) => index === folderIndex ? { ...item, path } : item)); setFolderIndex(null); }} />}
  </div>;
}
