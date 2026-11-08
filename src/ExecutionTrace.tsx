import { runtimeLabel } from "../shared/runtimes";
import Disclosure from './ui/Disclosure';
import type { Approval, DisplayEvent } from "../shared/types";
import { isMcpToolApproval } from "../shared/approvals";
import {describeOperation} from './activity-presentation';
import { useState, type ReactNode } from "react";
import { summarizeOperations, type Operation } from "./execution";
import { useLanguage, type Message } from "./i18n";
import Icon, { type IconName } from "./ui/Icon";
import "./execution.css";
export const statusLabels: Record<string, Message> = {
  inProgress: "执行中",
  running: "执行中",
  pending: "待处理",
  completed: "完成",
  failed: "失败",
  declined: "已拒绝",
  interrupted: "已中断",
  blocked: "已阻止",
  stopped: "已停止",
  updated: "已更新",
};
const operationKinds: Record<string, { label: Message; icon: IconName }> = {
  commandExecution: { label: "执行命令", icon: "terminal" },
  read: {label:"读取文件",icon:"file"},
  search: {label:"搜索",icon:"search"},
  fileChange: { label: "修改文件", icon: "file" },
  mcpToolCall: { label: "工具操作", icon: "tool" },
  dynamicToolCall: { label: "工具操作", icon: "tool" },
  webSearch: { label: "网页搜索", icon: "search" },
  plan: { label: "工作计划", icon: "plan" },
  contextCompaction: { label: "整理上下文", icon: "activity" },
  collabAgentToolCall: { label: "Agent 协作", icon: "users" },
  hook: { label: "Hook", icon: "hook" },
};
function OperationContent({
  operation: { item, output },
}: {
  operation: Operation;
}) {
  const { t } = useLanguage();
  const result = item.result as
    | {
        content?: { type?: string; text?: string }[];
        structuredContent?: unknown;
        toolCall?: {rawInput?: unknown; content?: unknown; locations?: unknown};
    title?: string; applied?: boolean; entries?: { title: string; kind: string; assetId?: string; versionId?: string }[];
      }
    | undefined;
  const resultText = result?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  const displayResult = resultText || result?.structuredContent || item.result;
  const presentation=describeOperation(item);
  return (
    <div className="operation-content">
      {presentation.target&&(presentation.category==='command'?<pre className="operation-command">{presentation.target}</pre>:presentation.category==='read'||presentation.category==='search'?<p className="operation-meta">{presentation.target}</p>:null)}
      {(item.server||item.tool)&&<dl className="operation-facts"><div><dt>{t('来源')}</dt><dd>{[item.server,item.tool].filter(Boolean).join(' / ')}</dd></div></dl>}
      {item.hook && (
        <dl className="operation-facts">
          <div><dt>{t("触发事件")}</dt><dd>{item.hook.event}</dd></div>
          <div><dt>{t("来源")}</dt><dd>{item.hook.source === "platform" ? "Mandala" : runtimeLabel(item.hook.source)}</dd></div>
        </dl>
      )}
      {item.hook?.source === "platform" && result?.title && (
        <dl className="operation-facts">
          <div><dt>{t("生成的标题")}</dt><dd>{result.title}</dd></div>
          <div><dt>{t("写回结果")}</dt><dd>{t(result.applied ? "已更新对话标题" : "保留已有标题")}</dd></div>
        </dl>
      )}
      {item.cwd && (
        <p className="operation-meta">
          {t("工作目录")} · {item.cwd}
        </p>
      )}
      {output && (
        <section className="operation-section">
          <h4>{t("工具输出")}</h4>
          <pre className="operation-output">{output}</pre>
        </section>
      )}
      {(item.exitCode != null || item.durationMs != null) && (
        <p className="operation-meta">
          {item.exitCode != null && t("退出码 {code}", { code: item.exitCode })}{" "}
          {item.durationMs != null && t("耗时 {duration} ms", { duration: item.durationMs })}
        </p>
      )}
      {item.changes?.map((change, i) => (
        <div className="file-change" key={i}>
          <p>
            {t(
              (
                { add: "新增", delete: "删除", update: "修改" } as Record<
                  string,
                  Message
                >
              )[change.kind.type] ?? "变更",
            )}{" "}
            · {change.path}
          </p>
          <pre>{change.diff}</pre>
        </div>
      ))}
      {item.text && <p>{item.text}</p>}
      {item.explanation&&<p>{item.explanation}</p>}
      {item.plan&&<ol className="explicit-progress-steps">{item.plan.map((step,index)=><li key={index}><Icon name={step.status==='completed'?'check':step.status==='in_progress'?'play':'clock'} size={13}/><span>{step.step}</span><small>{t(step.status==='completed'?'完成':step.status==='in_progress'?'执行中':'待处理')}</small></li>)}</ol>}
      {item.query && <p>{item.query}</p>}
      {item.arguments != null && (
        <Disclosure  title={<> {t("调用参数")} </>}>

          <pre>{JSON.stringify(item.arguments, null, 2)}</pre>
        </Disclosure>
      )}
      <Disclosure title={t('原始操作')}><pre>{JSON.stringify(item,null,2)}</pre></Disclosure>
      {item.hook?.source === "platform" && item.hook.task === "recall" && result?.entries && <ul className="recalled-records">{result.entries.map((entry, index) => <li key={index}><small>{t(entry.kind === "document" ? "文档" : "记忆")}</small><span>{entry.title}</span>{entry.assetId && <code>{entry.assetId} · {entry.versionId}</code>}</li>)}</ul>}
      {displayResult != null && !(item.hook?.source === "platform" && item.hook.task === "recall" && result?.entries) && (
        <section className="operation-section">
          <h4>{t("返回结果")}</h4>
          <pre className="operation-output">
            {typeof displayResult === "string"
              ? displayResult
              : JSON.stringify(displayResult, null, 2)}
          </pre>
        </section>
      )}
      {item.error != null && (
        <section className="operation-section">
          <h4>{t("错误详情")}</h4>
          <pre className="operation-error">
            {typeof item.error === "string"
              ? item.error
              : JSON.stringify(item.error, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
function OperationDetails({ operation, lazy, children }: { operation: Operation; lazy: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="operation-card" open={open} onToggle={event => {if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}>
    {children}
    {(!lazy || open) && <OperationContent operation={operation} />}
  </details>;
}
export default function ExecutionTrace({ events, lazy = false, label }: { events: DisplayEvent[]; lazy?: boolean; label?: string }) {
  const { t } = useLanguage();
  const operations = summarizeOperations(events).filter(operation => operation.item.type !== "modelCall");
  if (!operations.length) return null;
  const running = operations.filter((operation) => ["inProgress", "running"].includes(operation.status)).length;
  const failed = operations.filter((operation) => operation.status === "failed").length;
  return (
    <section className={`trace execution-trace${operations.length === 1 ? " single-operation" : ""}`} aria-label={label ?? t("执行过程")}>
      {(label !== "Hooks" || running > 0 || failed > 0) && <header className="execution-overview">
        {label !== "Hooks" && <><h3><Icon name="activity" size={16} />{label ?? t("执行过程")}</h3>
        <span className="execution-count">
          {operations.length === 1
            ? t("1 次操作")
            : t("{count} 次操作", { count: operations.length })}
        </span></>}
        {running > 0 && (
          <span className="operation-state inProgress"><Icon name="play" size={12} />{t("{count} 次进行中", { count: running })}</span>
        )}
        {failed > 0 && (
          <span className="operation-state failed"><Icon name="error" size={12} />{t("{count} 次失败", { count: failed })}</span>
        )}
      </header>}
      {operations.map((operation) => {
        const { item } = operation;
        const presentation=describeOperation(item);
        const kind=operationKinds[presentation.category==='change'?'fileChange':presentation.category==='command'?'commandExecution':presentation.category==='collaboration'?'collabAgentToolCall':presentation.category==='context'?'contextCompaction':presentation.category]??operationKinds.dynamicToolCall;
        const platformHook = item.hook?.source === "platform" ? item.hook : undefined;
        const title =
          item.hook
            ? platformHook ? t(platformHook.task === "title" ? "生成标题" : platformHook.task === "recall" ? ((item.result as { entries?: {kind: string}[] })?.entries?.some(entry => entry.kind === "document") ? "资料加载" : "记忆加载") : "提炼记忆") : item.hook.name
            : presentation.category==='tool'?item.tool||t("工具操作"):t(kind.label);
        const result = item.result as { content?: { type?: string; text?: string }[] } | undefined;
        const resultText = typeof item.result === "string" ? item.result :
          result?.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
        const outputPreview=operation.output||(typeof item.error==='string'?item.error:'')||resultText;
        const preferTarget=['read','search'].includes(presentation.category)||presentation.category==='command'&&operation.status==='completed';
        const preview = ((preferTarget?presentation.target||outputPreview:outputPreview||presentation.target)||"")
          .split(/[\r\n]/).filter((line) => line.trim()).at(-1) ?? "";
        const kindLabel = t(platformHook?.event === "systemTask" ? "平台后台 Hook" : platformHook ? "平台 Hook" : kind.label);
        const stateIcon: IconName = ["inProgress", "running"].includes(operation.status)
          ? "play" : ["failed", "blocked", "declined"].includes(operation.status)
            ? "error" : ["completed","updated"].includes(operation.status) ? "check" : "stop";
        return (
          <OperationDetails operation={operation} lazy={lazy} key={operation.key}>
            <summary aria-label={`${title} · ${kindLabel} · ${t(statusLabels[operation.status] ?? "状态未提供")}`}>
              <Icon name={kind.icon} size={16} className="operation-icon" />
              <span className="operation-title" title={title}><strong>{title}</strong></span>
              {item.hook && <span className="operation-trigger" title={item.hook.event}>{platformHook ? t(platformHook.task === "recall" ? "回复前" : platformHook.task === "memory" ? "回复后" : "后台") : item.hook.event}</span>}
              {preview && preview.trim()!==title.trim() && (!platformHook || !["completed","updated"].includes(operation.status)) && <span className="operation-preview" title={preview} aria-label={t("最新输出")}>{preview}</span>}
              <span className={"operation-state " + operation.status}>
                <Icon name={stateIcon} size={13} />
                {t(statusLabels[operation.status] ?? "状态未提供")}
              </span>
              <Icon name="chevronRight" size={14} className="operation-chevron" />
            </summary>
          </OperationDetails>
        );
      })}
    </section>
  );
}
export function ApprovalContent({
  approval,
  events,
}: {
  approval: Approval;
  events: DisplayEvent[];
}) {
  const { t } = useLanguage();
  const p = approval.params as {
    itemId?: string;
    turnId?: string;
    command?: string;
    cwd?: string;
    reason?: string;
    grantRoot?: string;
    kind?: string;
    networkApprovalContext?: { host: string; protocol: string };
    toolCall?: {rawInput?: unknown; content?: unknown; locations?: unknown};
    title?: string;
    message?: string;
  };
  const operation = summarizeOperations(events).find(
    (o) => o.key === `${p.turnId ?? ""}:${p.itemId}`,
  );
  return (
    <div className="approval-context">
      <p className="approval-context-title">
        <Icon name="approval" size={18} />
        {t(
          approval.method === "acp/permission" ? "ACP 请求确认" :
          approval.method === "omp/confirm" ? "OMP 请求确认" :
          isMcpToolApproval(approval) ? "Codex 请求调用 MCP 工具" :
          approval.method === "item/commandExecution/requestApproval"
            ? p.kind === "writeStdin"
              ? "Codex 请求向已运行命令发送输入"
              : "Codex 请求执行命令"
            : approval.method === "item/fileChange/requestApproval"
              ? "Codex 请求修改文件"
              : "暂不支持此类原生交互，请停止后使用 CLI",
        )}
      </p>
      {p.title && <strong>{p.title}</strong>}
      {approval.method === "acp/permission" && p.toolCall && <pre className="approval-command">{JSON.stringify({input:p.toolCall.rawInput,changes:p.toolCall.content,locations:p.toolCall.locations},null,2)}</pre>}
      {p.message && <p>{p.message}</p>}
      {p.reason && <p>{p.reason}</p>}
      {(p.command || operation?.item.command) && (
        <pre className="approval-command">
          {p.command || operation?.item.command}
        </pre>
      )}
      {(p.cwd || operation?.item.cwd) && (
        <p className="operation-meta">
          {t("工作目录")} · {p.cwd || operation?.item.cwd}
        </p>
      )}
      {p.grantRoot && (
        <p>
          {t("申请扩大写入范围")} · {p.grantRoot}
        </p>
      )}
      {p.networkApprovalContext && (
        <p>
          {t("申请网络访问")} · {p.networkApprovalContext.protocol} ·{" "}
          {p.networkApprovalContext.host}
        </p>
      )}
      {approval.method === "item/fileChange/requestApproval" &&
        (operation?.item.changes?.length ? (
          <OperationContent operation={operation} />
        ) : (
          <p>{t("CLI 尚未提供文件变更明细。")}</p>
        ))}
      <Disclosure className="native-details" title={<> {t("原生请求详情")} </>}>

        <pre>{JSON.stringify(approval.params, null, 2)}</pre>
      </Disclosure>
    </div>
  );
}
