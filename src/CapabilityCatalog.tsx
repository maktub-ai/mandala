import Button from './ui/Button';
import Input from './ui/Input';
import { useState } from "react";
import type { Config, McpConnection, SkillDefinition } from "../shared/types";
import CapabilityEditor from "./CapabilityEditor";
import { useLanguage } from "./i18n";
import Icon from "./ui/Icon";
import NativeMcpPanel from "./NativeMcpPanel";

export default function CapabilityCatalog({ config, savedConfig = config, mode, onChange }: {
  config: Config; savedConfig?: Config; mode: "mcp" | "skills"; onChange: (patch: Partial<Config>) => void;
}) {
  const {text: localize,  t } = useLanguage();
  const say = (zh: string, en: string) => localize(zh, en);
  const [preparation, setPreparation] = useState<McpConnection | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const items = mode === "mcp" ? config.connections ?? [] : config.skillLibrary ?? [];
  const selected = preparation ?? items.find(item => item.id === selectedId) ?? items[0];
  const linked = selected ? [...config.agents, ...config.projects].filter(owner => (mode === "mcp" ? owner.connectionIds : owner.skillIds)?.includes(selected.id)) : [];
  const patch = (values: (McpConnection | SkillDefinition)[]) => onChange(mode === "mcp" ? { connections: values as McpConnection[] } : { skillLibrary: values as SkillDefinition[] });
  const add = () => { const id = crypto.randomUUID(); setSearch(""); if (mode === "mcp") setPreparation({ id, name: "", transport: "stdio", command: "" }); else patch([...items, { id, name: "", path: "" }]); setSelectedId(id); };
  const validation = preparation ? mcpPreparationError(preparation, say) : "";
  const create = () => { if (!preparation || validation) return; const item = preparation.transport === "http" ? { ...preparation, url: new URL(preparation.url!).href } : preparation; patch([...items, item]); setSelectedId(preparation.id); setPreparation(null); };
  return <><div className="settings-columns catalog-columns"><div className="settings-items">
    <div className="settings-section-title"><h2>{t("能力目录")}</h2><Button type="button" disabled={!!preparation} onClick={add}><Icon name="plus" size={16} />{t(mode === "mcp" ? "添加 MCP" : "添加 Skill")}</Button></div>
    <Input type="search" aria-label={t("搜索能力")} placeholder={t("搜索能力")} value={search} onChange={e => setSearch(e.target.value)} />
    {preparation && <p className="field-hint">{say("新增 MCP · 尚未创建", "New MCP · Not created yet")}</p>}
    {items.filter(item => item.name.toLowerCase().includes(search.toLowerCase())).map(item => <Button type="button" className={`settings-object-item ${selected?.id === item.id ? "selected" : ""}`} key={item.id} title={item.name} onClick={() => { setPreparation(null); setSelectedId(item.id); }}>
      <Icon name={mode === "mcp" ? "tool" : "book"} size={16} /><span>{item.name || t("未命名对象")}</span></Button>)}
  </div><div className="settings-detail">{selected ? <section className="settings-card">
    <CapabilityEditor mode={mode} compact canRemove={!linked.length} mcp={mode === "mcp" ? [selected as McpConnection] : []} skills={mode === "skills" ? [selected as SkillDefinition] : []}
      onMcp={values => preparation ? setPreparation(values.length ? { ...values[0], id: preparation.id } : null) : patch(values.length ? items.map(item => item.id === selected.id ? { ...values[0], id: selected.id } : item) : items.filter(item => item.id !== selected.id))}
      onSkills={values => patch(values.length ? items.map(item => item.id === selected.id ? { ...values[0], id: selected.id } : item) : items.filter(item => item.id !== selected.id))} />
    {preparation && <><p className="field-hint" role="status">{validation || say("配置格式有效；创建后可供智能体引用。连接状态以会话实际加载为准。", "Configuration is valid. Create it to make it available to Agents; connection status is verified when a chat loads it.")}</p><div className="desktop-cli-actions"><Button onClick={() => setPreparation(null)}>{say("取消新增 MCP", "Cancel new MCP")}</Button><Button variant="primary" disabled={!!validation} onClick={create}>{say("创建 MCP", "Create MCP")}</Button></div></>}
    {!preparation && <div className="catalog-usage"><h3>{t("引用位置")}</h3><p>{linked.length ? linked.map(owner => owner.name).join(" · ") : t("尚未被引用")}</p>
      {linked.length > 0 && <p className="field-hint">{t("取消全部引用后才能删除定义。")}</p>}</div>}
  </section> : <p className="field-hint">{t("添加一次定义，供多个 Agent 与 Project 引用。")}</p>}</div></div>{mode === "mcp" && <NativeMcpPanel config={savedConfig}/>}</>;
}

function mcpPreparationError(item: McpConnection, say: (zh: string, en: string) => string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(item.name) || ["mandala_tasks", "openmana_tasks"].includes(item.name)) return say("名称仅支持字母、数字、下划线和连字符，不能使用系统保留名称。", "Use letters, numbers, underscores and hyphens; reserved names are unavailable.");
  if (item.transport === "stdio" && !item.command?.trim()) return say("请填写启动命令。", "Enter a startup command.");
  if (item.transport === "http") {
    try { const url = new URL(item.url ?? ""); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|secret|password|api.?key/i.test(key))) throw Error(); }
    catch { return say("请填写有效的 HTTP(S) URL；不要在 URL 中包含凭据。", "Enter a valid HTTP(S) URL without credentials."); }
  }
  if (Object.entries(item.env ?? {}).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) return say("环境变量请使用有效名称和值引用，例如 ${API_KEY}。", "Use valid environment names and references such as ${API_KEY}.");
  return "";
}
