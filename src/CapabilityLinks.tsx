import Button from './ui/Button';
import Input from './ui/Input';
import type { Agent, Config, Project } from "../shared/types";
import Icon from "./ui/Icon";
import { useLanguage } from "./i18n";

export default function CapabilityLinks({ config, owner, onChange, onManage }: {
  config: Config; owner: Agent | Project;
  onChange: (patch: Pick<Agent, "connectionIds" | "skillIds" | "disabledConnectionIds" | "disabledSkillIds">) => void;
  onManage: (section: "mcp" | "skills") => void;
}) {
  const { t } = useLanguage();
  return <div className="capability-links">{(["mcp", "skills"] as const).map(kind => {
    const key = kind === "mcp" ? "connectionIds" : "skillIds";
    const disabledKey = kind === "mcp" ? "disabledConnectionIds" : "disabledSkillIds";
    const items = kind === "mcp" ? config.connections ?? [] : config.skillLibrary ?? [];
    const selected = owner[key] ?? [];
    return <section key={kind} className="settings-card">
      <div className="settings-section-title"><h2>{kind === "mcp" ? "MCP" : "Skills"}</h2>
        <Button type="button" onClick={() => onManage(kind)}><Icon name="link" size={15} />{t("管理目录")}</Button></div>
      <div className="check-list">{items.map(item => <label key={item.id}>
        <Input type="checkbox" aria-label={item.name || item.id} checked={selected.includes(item.id)} onChange={event => onChange({ [key]: event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id), [disabledKey]: owner[disabledKey]?.filter(id => id !== item.id) })} />
        <span>{item.name || t("未命名对象")}<small>{"path" in item ? item.path : item.command ?? item.url}</small></span>
      </label>)}</div>
      {!items.length && <p className="field-hint">{t("目录中暂无能力，先添加定义，再在这里关联。")}</p>}
      <p className="field-hint">{t("这里只保存引用；修改目录中的定义会影响所有引用对象。")}</p>
    </section>;
  })}</div>;
}
