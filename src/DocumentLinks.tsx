import Input from './ui/Input';
import Button from './ui/Button';
import { useEffect, useState } from "react";
import type { KnowledgeEntry } from "../shared/types";
import { canUseKnowledge } from "../shared/knowledge-access";
import { api } from "./api";
import { useLanguage } from "./i18n";

export default function DocumentLinks({ ids, onChange, agentId = "", projectId = "", embedded = false }: {
  ids: string[]; onChange: (ids: string[]) => void; agentId?: string; projectId?: string; embedded?: boolean;
}) {
  const { t, errorText } = useLanguage();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [state, setState] = useState("loading");
  useEffect(() => { let active = true;
    api<KnowledgeEntry[]>("/knowledge").then(data => { if (active) { setEntries(data.filter(e => e.kind === "document")); setState(""); } })
      .catch(e => { if (active) setState(e.message); });
    return () => { active = false; };
  }, []);
  return <section className={embedded ? undefined : "settings-card"}>{!embedded && <h2>{t("参考文档")}</h2>}
    <p className="field-hint">{t("从资料库引用。执行时只加载已确认、允许使用且与任务相关的内容。")}</p>
    {state ? <p role={state === "loading" ? "status" : "alert"}>{state === "loading" ? t("正在读取资料…") : errorText(state)}</p> : <>
      <div className="check-list">{entries.map(entry => <label key={entry.id}>
        <Input type="checkbox" checked={ids.includes(entry.id)} onChange={event => onChange(event.target.checked ? [...ids, entry.id] : ids.filter(id => id !== entry.id))} />
        <span>{entry.title}<small>{entry.status === "candidate" ? t("候选") : t("已确认")}{!canUseKnowledge(entry, { agentId, projectId }) && ` · ${t("需在具体对话中校验使用范围")}`}</small></span>
      </label>)}</div>
      {!entries.length && <p className="field-hint">{t("资料库里还没有可引用的文档。")}</p>}
      {ids.filter(id => !entries.some(entry => entry.id === id)).map(id => <label className="missing-reference" key={id}>{t("引用已不可用")} · {id}<Button type="button" onClick={() => onChange(ids.filter(value => value !== id))}>{t("移除")}</Button></label>)}
    </>}
  </section>;
}
