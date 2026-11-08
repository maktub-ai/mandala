import Button from './ui/Button';
import Textarea from './ui/Textarea';
import Input from './ui/Input';
import { runtimeLabel, runtimeIds, effectiveRuntime } from "../shared/runtimes";
import Disclosure from './ui/Disclosure';
import Select from "./ui/Select";
import Icon from "./ui/Icon";
import { useEffect, useRef, useState } from "react";
import type { ApprovalMode, Cli, RuntimeConfig } from "../shared/types";
import { useLanguage } from "./i18n";
import type { ApprovalPreference } from '../shared/chat-preferences';
import { api } from './api';
import './agent-approval-settings.css';

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ApprovalSettingsProps = { value?: RuntimeConfig; defaults?: RuntimeConfig; cli: Cli; onChange: (value: RuntimeConfig) => void };
function ApprovalModeSelect({ value, defaults, cli, onChange, workspace = false, label }: ApprovalSettingsProps & { workspace?: boolean; label?: string }) {
  const { t } = useLanguage();
  const inherit = defaults && !workspace ? '沿用 Runtime 默认' : '沿用原生设置';
  const select = <Select icon="approval" ariaLabel={label ?? t('审批模式')} searchable={false}
    value={value?.[cli]?.approvalMode ?? ''}
    onChange={mode => onChange({ ...value, [cli]: { ...value?.[cli], approvalMode: mode ? mode as ApprovalMode : undefined } })}
    options={[
      { value: '', label: t(inherit), icon: <Icon name="terminal" size={16}/> },
      { value: 'default', label: t('按需审批'), icon: <Icon name="approval" size={16}/>, description: t('日常读写减少审批；命令和额外权限按执行端规则确认。') },
      { value: 'strict', label: t('严格审批'), icon: <Icon name="approval" size={16}/>, description: t('使用更严格的原生规则，暂停平台对话授权。') },
      { value: 'auto', label: t('自动批准'), icon: <Icon name="sparkles" size={16}/>, description: t('自动批准工具操作，不扩大文件和网络访问范围。') },
    ]}/>;
  return label ? <div className="settings-form-row"><span>{label}</span>{select}</div> : <label>{t('审批模式')}{select}</label>;
}

export function AgentApprovalSettings({ agentId, available, savedValue, ...props }: ApprovalSettingsProps & { agentId: string; available: boolean; savedValue?: RuntimeConfig }) {
  const {text: localize,  t, errorText } = useLanguage();
  const say = (zh: string, en: string) => localize(zh, en);
  const [preference, setPreference] = useState<ApprovalMode | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    setPreference(null); setError(''); setLoading(available);
    if (available) api<ApprovalPreference>(`/chat-preferences/approval?${new URLSearchParams({ agentId, cli: props.cli })}`)
      .then(result => { if (!cancelled) setPreference(result.approvalMode); })
      .catch(err => { if (!cancelled) setError(String(err.message ?? err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; active.current = false; };
  }, [agentId, props.cli, available]);
  const reset = async () => {
    setResetting(true); setError('');
    try {
      const result = await api<ApprovalPreference>('/chat-preferences/approval', 'PATCH', { agentId, cli: props.cli, approvalMode: null });
      if (active.current) setPreference(result.approvalMode);
    } catch (err) {
      if (active.current) setError(String((err as Error).message ?? err));
    } finally { if (active.current) setResetting(false); }
  };
  const defaultMode = effectiveRuntime(props.cli, savedValue, props.defaults).approvalMode ?? 'default';
  const modeLabel = (mode: ApprovalMode) => t(mode === 'auto' ? '自动批准' : mode === 'strict' ? '严格审批' : '按需审批');
  return <section className="agent-approval-settings" aria-label={say('审批规则', 'Approval policy')}>
    <h3>{say('审批规则', 'Approval policy')}</h3>
    <ApprovalModeSelect {...props} label={say('默认审批模式', 'Default approval mode')}/>
    <p className="field-hint">{say('Agent 默认随此执行端配置保存。聊天中的选择可覆盖默认值，并为当前用户记住。', 'The Agent default is saved for this runtime. A choice made in chat can override it and be remembered for you.')}</p>
    <div className="agent-approval-effective" aria-live="polite">
      {loading ? <p role="status">{say('正在读取聊天偏好…', 'Loading chat preference…')}</p> : error ? <p role="alert" className="runtime-env-error">{say('无法确认聊天偏好：', 'Chat preference could not be confirmed: ')}{errorText(error)}</p> : available ? <>
        <div><span>{say('新对话使用', 'New chats use')}</span><strong>{modeLabel(preference ?? defaultMode)}</strong></div>
        <p>{preference !== null ? say('已为你记住 · 仅此 Agent 和执行端', 'Remembered for you · only this Agent and CLI') : say('当前使用 Agent 默认', 'Using Agent default')}</p>
      </> : <p>{say('保存 Agent 并启用此执行端后，可读取聊天偏好。', 'Save the Agent and enable this runtime to read chat preferences.')}</p>}
      {preference !== null && <Button type="button" disabled={!available || resetting} onClick={() => void reset()}>{resetting ? say('正在重置…', 'Resetting…') : say('使用 Agent 默认', 'Use Agent default')}</Button>}
    </div>
    {preference !== null && <p className="field-hint">{say('重置仅清除你为此 Agent 和执行端记住的选择，立即生效。', 'Reset immediately clears only your remembered choice for this Agent and runtime.')}</p>}
    <p className="field-hint">{t('自动批准工具操作，不扩大文件和网络访问范围。')}</p>
  </section>;
}

export default function RuntimeSettingsEditor({ value, onChange, cli: selectedCli, defaults, workspace = false, hideApproval = false }: {
  value?: RuntimeConfig;
  defaults?: RuntimeConfig; workspace?: boolean;
  onChange: (value: RuntimeConfig) => void;
  cli?: Cli;
  hideApproval?: boolean;
}) {
  const { t } = useLanguage();
  const [duplicateNames, setDuplicateNames] = useState<Partial<Record<Cli, string>>>({});
  useEffect(() => { setDuplicateNames({}); }, [value]);
  const patch = (cli: Cli, changes: NonNullable<RuntimeConfig[Cli]>) =>
    onChange({ ...value, [cli]: { ...value?.[cli], ...changes } });
  return <div className="runtime-settings-editor">
    <p className="field-hint">{t(workspace ? "运行中的对话保持不变；变更在下一次发送时载入。" : "参数与环境变量随此 Agent 使用，按所选 CLI 分别加载。")}</p>
    <Disclosure className="settings-help" title={<> {t("运行说明")} </>}>
      {!workspace && <p className="field-hint">{t("运行中的对话保持不变；变更在下一次发送时载入。")}</p>}
      <p className="field-hint">{t("外部记忆服务的身份可通过其支持的环境变量或 CLI 参数传入。")}</p>
    </Disclosure>
    {(selectedCli ? [selectedCli] : runtimeIds).map((cli) => {
      const current = value?.[cli];
      const effective = effectiveRuntime(cli, value, defaults);
      const inherit = defaults && !workspace ? "沿用 Runtime 默认" : "沿用原生设置";
      const entries = Object.entries(current?.env ?? {});
      return <fieldset className="runtime-cli-card" key={cli} aria-label={`${runtimeLabel(cli)} ${t("运行参数")}`}>
        <legend>{runtimeLabel(cli)}</legend>
        <div className="settings-section-title"><span className="field-hint">{t(current ? "已配置" : defaults && !workspace ? "沿用 Runtime 默认" : cli === "codex" ? "平台默认：完整访问" : "沿用原生设置")}</span>
          {current && <Button type="button" onClick={() => {
            const next = { ...value };
            delete next[cli];
            onChange(next);
          }}>{t(defaults && !workspace ? "沿用 Runtime 默认" : "清除此 CLI 配置")}</Button>}</div>
        {!hideApproval && <ApprovalModeSelect cli={cli} value={value} defaults={defaults} onChange={onChange} workspace={workspace}/>}
        {effective.gateway==='unavailable'&&<div role="alert"><span className="field-hint">{t('旧版模型接入已停用，请确认使用 CLI 原生设置。')}</span>
          <Button type="button" onClick={()=>patch(cli,{gateway:'native'})}>{t('使用 CLI 原生设置')}</Button>
        </div>}
        {cli === "codex" && <label>{t("文件和网络权限")}<Select icon="approval" ariaLabel={t("文件和网络权限")} searchable={false}
          value={defaults && !workspace && current?.fullAccess === undefined ? "" : effective.fullAccess !== false ? "full" : "native"} onChange={(mode) => patch(cli, { fullAccess: mode === "" ? undefined : mode === "full" })}
          options={[
            ...(defaults && !workspace ? [{value: "", label: t(inherit)}] : []),
            { value: "native", label: t("沿用原生设置"), icon: <Icon name="terminal" size={16}/> },
            { value: "full", label: t("完整访问"), icon: <Icon name="globe" size={16}/>, description: t(workspace ? "允许读写本机文件和访问网络，Agent 可覆盖。" : "允许读写本机文件和访问网络，仅对该 Agent 生效。") },
          ]} /></label>}
        {(cli === "codex" || cli === "omp") && <><label>{t("启动参数（每行一个）")}<Textarea disabled={cli !== "codex" && cli !== "omp"} aria-label={t("启动参数（每行一个）")}
          value={(current?.args ?? defaults?.[cli]?.args)?.join("\n") ?? ""} placeholder={t("每行作为独立参数传给 CLI")}
          onChange={(e) => patch(cli, { args: e.target.value === "" ? [] : e.target.value.split(/\r?\n/) })} /></label>
        <p className="field-hint">{t("参数逐项传给 CLI，不经过 shell。")}</p>
        {current?.args !== undefined && <Button type="button" onClick={() => {
          const next = { ...current };
          delete next.args;
          onChange({ ...value, [cli]: next });
        }}>{t(defaults && !workspace ? "沿用 Runtime 默认" : "恢复原生参数")}</Button>}
        </>}
        {defaults && !workspace && <p className="field-hint">{t("当前生效：审批 {mode}；启动参数 {args}", {mode: effective.approvalMode ?? "default", args: effective.args.join(" ") || "—"})}{cli === "codex" && " · " + t(effective.fullAccess ? "完整访问" : "沿用原生设置")}</p>}
        <div className="settings-section-title"><h3>{t("环境变量引用")}</h3>
          <Button type="button" aria-label={t("添加环境变量引用")} onClick={() => patch(cli, { env: { ...current?.env, "": "${}" } })}><Icon name="plus" size={16} /> {t("添加环境变量引用")}</Button></div>
        {defaults && !workspace && Object.keys(defaults[cli]?.env ?? {}).length > 0 && <p className="field-hint">{t("继承的环境变量：{names}；同名 Agent 引用覆盖默认值。", {names: Object.keys(defaults[cli]?.env ?? {}).join(", ")})}</p>}
        {entries.map(([name, reference], index) => {
          const source = reference.startsWith("${") && reference.endsWith("}") ? reference.slice(2, -1) : "";
          const valid = envName.test(name) && envName.test(source);
          const changeEntry = (entry: [string, string]) => {
            if (entries.some(([existing], i) => i !== index && existing === entry[0])) {
              setDuplicateNames((names) => ({ ...names, [cli]: entry[0] }));
              return;
            }
            setDuplicateNames((names) => ({ ...names, [cli]: undefined }));
            const next = [...entries];
            next[index] = entry;
            patch(cli, { env: Object.fromEntries(next) });
          };
          return <div className="runtime-env-entry" key={index}>
            <label>{t("变量名称")}<Input aria-label={t("变量名称")} value={name} placeholder="SERVICE_API_KEY"
              aria-invalid={!envName.test(name)} onChange={(e) => changeEntry([e.target.value, reference])} /></label>
            <label>{t("环境变量来源名称")}<span className="runtime-env-source"><span>{"${"}</span><Input
              aria-label={t("环境变量来源名称")} value={source} placeholder="MY_API_KEY" aria-invalid={!envName.test(source)}
              onChange={(e) => changeEntry([name, "${" + e.target.value + "}"])} /><span>{"}"}</span></span></label>
            <Button type="button" aria-label={t("移除变量")} onClick={() => patch(cli, { env: Object.fromEntries(entries.filter((_, i) => i !== index)) })}><Icon name="close" size={16} /></Button>
            {!valid && <p className="field-hint runtime-env-error">{t("变量名称与来源必须是有效的环境变量名。")}</p>}
          </div>;
        })}
        {duplicateNames[cli] !== undefined && <p role="alert" className="field-hint runtime-env-error">
          {t("变量名 {name} 已存在；修改未应用，原引用已保留。", { name: duplicateNames[cli]! })}
        </p>}
        <p className="field-hint">{t("这里只保存环境变量名引用，密钥留在启动服务的环境中。")}</p>
      </fieldset>;
    })}
  </div>;
}
