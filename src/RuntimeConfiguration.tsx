import Button from './ui/Button';
import { useEffect, useRef, useState } from 'react';
import type { Cli, CliStatus, Config, ModelChoice, RuntimeConfig } from '../shared/types';
import { enabledRuntimes, isCli, runtimeCatalog, runtimeIds, runtimeLabel } from '../shared/runtimes';
import RuntimeSettingsEditor from './RuntimeSettingsEditor';
import RuntimeIcon from './ui/RuntimeIcon';
import Select from './ui/Select';
import Disclosure from './ui/Disclosure';
import Icon from './ui/Icon';
import { api } from './api';
import { useLanguage } from './i18n';
import { modelOptions, effortOptions, effortLabels, type ReasoningEffort } from '../shared/chat-input';

export default function RuntimeConfiguration({ config, savedConfig, onDraftChange, target, locked, onSave, onNavigate, onDirtyChange, onReload }: {
  onReload: () => void; config: Config; savedConfig: Config; target: string; locked: boolean;
  onDraftChange: (cli:Cli, value:RuntimeConfig, chatDefaults:Config['chatDefaults'])=>void;
  onSave: (cli: Cli, value: RuntimeConfig, enabled: boolean, chatDefaults: Config['chatDefaults']) => Promise<void>;
  onNavigate: (path: string) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const {text: localize,  t, errorText } = useLanguage();
  const enabled = enabledRuntimes(config), adding = target === 'new';
  const available = runtimeIds.filter(cli => !enabled.includes(cli));
  const [cli, setCli] = useState<Cli | undefined>(adding ? available.find(cli=>cli===new URLSearchParams(location.search).get('runtime')) : isCli(target) ? target : undefined);
  const [newValue, setNewValue] = useState<RuntimeConfig>(structuredClone(config.runtimeDefaults ?? {}));
  const [newChatDefaults, setNewChatDefaults] = useState(structuredClone(config.chatDefaults ?? {}));
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [status, setStatus] = useState<CliStatus>(), [models, setModels] = useState<ModelChoice[]>([]), [probeError, setProbeError] = useState(''), [refresh, setRefresh] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const value=adding?newValue:config.runtimeDefaults??{};
  const chatDefaults=adding?newChatDefaults:config.chatDefaults??{};
  const setValue=(next:RuntimeConfig)=>{setError('');if(adding)setNewValue(next);else if(cli)onDraftChange(cli,next,chatDefaults);};
  const setChatDefaults=(change:(current:NonNullable<Config['chatDefaults']>)=>NonNullable<Config['chatDefaults']>)=>{
    setError('');const next=change(chatDefaults);if(adding)setNewChatDefaults(next);else if(cli)onDraftChange(cli,value,next);
  };
  const dirty=adding&&!!cli;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!cli) return;
    let active = true; setStatus(undefined); setModels([]); setProbeError('');
    api<CliStatus>('/cli/status?scope=runtime&cli=' + cli).then(result => { if (active) setStatus(result); }).catch(e => { if (active) { setStatus({ status: 'unavailable', version: null }); setProbeError(e.message); } });
    api<ModelChoice[]>('/models?scope=runtime&cli=' + cli).then(result => { if (active) setModels(result); }).catch(e => { if (active) setProbeError(e.message); });
    return () => { active = false; };
  }, [cli, JSON.stringify(savedConfig.runtimeDefaults), refresh]);
  const save = async (enable: boolean) => {
    if (!cli || pending || locked) return;
    setPending(true); setError('');
    try { await onSave(cli, value, enable, chatDefaults); onNavigate('/settings/runtimes'); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };
  const invalidEnv = cli && Object.entries(value[cli]?.env ?? {}).some(([key, ref]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref));
  const defaults = cli ? chatDefaults[cli] : undefined;
  const selectedModel = models.find(model => model.id === (defaults?.model || models.find(item => item.isDefault)?.id));
  return <section className="runtime-configuration" aria-label={localize((adding?'新增 CLI':'配置 CLI'), (adding?'Add CLI':'Configure CLI'))}>
    <Button type="button" disabled={pending} onClick={() => onNavigate('/settings/runtimes')}><Icon name="arrowLeft" size={16}/>{localize('返回 CLI 接入', 'Back to CLI adapters')}</Button>
    <h2 ref={heading} tabIndex={-1}>{adding ? localize('新增 CLI', 'Add CLI') : cli ? <><RuntimeIcon cli={cli} size={20}/>{runtimeLabel(cli)}</> : localize('CLI 接入不可用', 'CLI adapter unavailable')}</h2>
    {adding && (available.length ? <label>{localize('选择 CLI', 'Choose CLI')}<Select ariaLabel={localize('选择 CLI', 'Choose CLI')} value={cli ?? ''} disabled={pending} searchable={false}
      options={available.map(item => ({value:item,label:runtimeLabel(item),icon:<RuntimeIcon cli={item}/>}))} onChange={item => setCli(item as Cli)}/></label> : <p>{localize('所有支持的 CLI 均已启用。', 'All supported CLI adapters are enabled.')}</p>)}
    {cli && <>
      <div role="status" className="runtime-connection-status">{!status ? t('正在检测…') : status.status === 'ready' ? (localize('CLI 可启动', 'CLI can launch')) : status.status === 'login-required' ? (localize('CLI 要求登录', 'CLI requires login')) : (localize('CLI 不可用', 'CLI unavailable'))}{status?.version && <code>{status.version}</code>}</div>
      {status && status.status !== 'ready' && <p className="field-hint">{localize('检查原生 CLI 安装和认证后重新检测。', 'Check the native CLI installation and authentication, then detect again.')}</p>}
      {probeError && <p role="status" className="form-error">{errorText(probeError)}</p>}
      {(cli==='cursor'||cli==='antigravity')&&<p className="field-hint">{localize('工具权限按整轮授权；不支持逐工具审批或会话级 MCP 绑定。', 'Tool permission applies to an entire turn. Per-tool approvals and isolated session MCP bindings are unavailable.')}</p>}
      {cli==='dsh'&&<p className="field-hint">{localize('DSH 工具权限按整轮授权；本轮内的单个工具不会再次请求审批。', 'DSH tool permission applies to an entire turn; individual tools do not prompt again.')}</p>}
      {(cli==='hermes'||cli==='openclaw')&&<p className="field-hint">{localize('原生 Gateway 执行任务；工具按整轮授权。Gateway、工作目录和 Mandala 业务 CLI 必须位于所选执行机器；远端机器请使用 SSH 执行。停用仅关闭适配连接，不停止原生 Gateway。不用于标题、记忆等受限系统任务。', 'Tasks run in the native Gateway with whole-turn tool approval. The Gateway, working directory and Mandala business CLI must share the selected execution machine; use SSH execution for another machine. Disabling closes the adapter only, preserving the native Gateway. Restricted system tasks are unavailable.')}</p>}
      {cli==='hermes'&&<p className="field-hint">{localize('会话级 MCP 绑定暂不可用：当前原生 Gateway 恢复时无法可靠清空旧绑定。请在原生 Gateway 管理 MCP。', 'Session MCP bindings are unavailable: the current native Gateway cannot reliably clear old bindings on resume. Manage MCP in the native Gateway.')}</p>}
      {cli==='openclaw'&&<p className="field-hint">{localize('不支持会话级 MCP 绑定；存在绑定时会在发送前拒绝。模型使用原生 Gateway 默认值，请在原生设置中更改后新建对话。', 'Session MCP bindings are unsupported and are rejected before dispatch. The model uses the native Gateway default; change it natively and start a new chat.')}</p>}
      {cli==='pi'&&<p className="field-hint">{localize('Pi 工具接入 Mandala 审批；原生 Pi 不支持 MCP 绑定。', 'Pi tools use Mandala approvals. Native Pi does not support MCP bindings.')}</p>}
      <fieldset disabled={pending}>
        <section className="runtime-chat-defaults"><h3>{t('新对话模型')}</h3>
          <div className="chat-defaults-row">
            <label>{t('模型')}<Select icon="sparkles" ariaLabel={`${runtimeLabel(cli)} ${t('模型')}`} value={defaults?.model ?? ''}
              options={[...modelOptions(models), ...(defaults?.model && !models.some(model => model.id === defaults.model) ? [{value:defaults.model,label:defaults.model}] : [])]}
              allowCustom={cli!=='openclaw'} onChange={model => {setError('');setChatDefaults(current => ({...current,[cli]:{model:model || undefined}}));}}/></label>
            <label>{t('思考强度')}<Select icon="settings" ariaLabel={`${runtimeLabel(cli)} ${t('思考强度')}`} searchable={false} value={defaults?.effort ?? ''} disabled={!effortOptions(selectedModel).length}
              options={[{value:'',label:t(selectedModel?.defaultReasoningEffort ? effortLabels[selectedModel.defaultReasoningEffort] : '沿用原生设置')},...effortOptions(selectedModel).map(effort=>({value:effort,label:t(effortLabels[effort])}))]}
              onChange={effort=>{setError('');setChatDefaults(current=>({...current,[cli]:{...current[cli],effort:effort as ReasoningEffort || undefined}}));}}/></label>
          </div>
        </section>
        <RuntimeSettingsEditor cli={cli} value={value} onChange={setValue} workspace/>
      </fieldset>
      <Disclosure title={t('连接诊断')}><p>{runtimeCatalog[cli].protocol === "acp" ? "ACP" : "Native"}</p><code>{[runtimeCatalog[cli].command,...runtimeCatalog[cli].args].join(' ')}</code>
        <p className="field-hint">{t('工作区默认值用于 Agent 对话和定时任务；Agent 可覆盖。系统标题、记忆和文件整理使用受限环境。')}</p>
        <p className="field-hint">{t('检测使用已保存的配置；保存后重新检测。')}</p>
        <p className="field-hint">{t('连接状态表示 CLI 可启动；模型权限与余额在实际请求时验证。')}</p>
        {!!models.length && <ul className="runtime-model-list">{models.map(model => <li key={model.id}>{model.label}<code>{model.id}</code></li>)}</ul>}
        <Button type="button" onClick={() => setRefresh(n => n + 1)}>{t('重新检测')}</Button></Disclosure>
      {error && <div role="alert" className="form-error">{errorText(error)}{error === 'configuration changed' && <><p>{t('重新读取最新配置后再保存；当前 Runtime 草稿保留。')}</p><Button type="button" onClick={onReload}>{t('重新读取配置')}</Button></>}</div>}
      <div className="runtime-actions">{adding&&<Button type="button" disabled={pending} onClick={()=>onNavigate('/settings/runtimes')}>{t('取消')}</Button>}
        {!adding && <span>{localize('修改自动保存', 'Changes save automatically')}</span>}
        {!adding && enabled.includes(cli) && <Button type="button" disabled={pending || locked} onClick={() => void save(false)}>{localize('停用 CLI', 'Disable CLI')}</Button>}
        {adding&&<Button type="button" className="primary" disabled={pending || locked || !!invalidEnv} onClick={() => void save(true)}>{pending?t('保存中…'):(localize('启用 CLI', 'Enable CLI'))}</Button>}
      </div>
      {!adding && <p className="field-hint">{localize('停用保留配置、原生认证和历史；从后续执行生效。', 'Disabling keeps configuration, native authentication and history. It affects future executions.')}</p>}
    </>}
  </section>;
}
