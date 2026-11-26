import { useEffect, useRef, useState } from 'react';
import type { Cli, Config, ModelChoice } from '../shared/types';
import { enabledRuntimes, runtimeLabel } from '../shared/runtimes';
import { api } from './api';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import Select from './ui/Select';
import LoadingState from './ui/LoadingState';
import RuntimeIcon from './ui/RuntimeIcon';
import Icon from './ui/Icon';
import { SettingsGroup, SettingRow, SettingSwitch } from './ui/SettingsLayout';
import ModelCatalogPicker, { type ModelCatalog } from './ModelCatalogPicker';
import AgentEffortPicker,{rebindAgentEffort,useAgentEffortCatalog} from './AgentEffortPicker';
import {effortModel,type AgentEffort} from '../shared/chat-input';
import { useLanguage } from './i18n';
import './mandala.css';

type Values = { name: string; soul: string; cli: Cli | ''; models: Config['agents'][number]['models']; defaultEffort?: AgentEffort; showExecutionDetails: boolean; maxParallel: string };
const sameValues = (a?: Values, b?: Values) => JSON.stringify(a) === JSON.stringify(b);

/** Settings page for the system Agent. Changes save on their own; text saves after a short pause. */
export default function MandalaSettings({ onSaved }: { onSaved: (config: Config, revision: string) => void }) {
  const { text: localize } = useLanguage(), say = (zh: string, en: string) => localize(zh, en);
  const [loaded, setLoaded] = useState<{ config: Config; revision: string }>();
  const [values, setValues] = useState<Values>(), [saved, setSaved] = useState<Values>();
  const [catalog, setCatalog] = useState<ModelCatalog>({ choices: [], loading: true, error: '' });
  const [catalogRefresh, refreshCatalog] = useState(0);
  const [effortReverted,setEffortReverted]=useState(false);
  const [error, setError] = useState(''), [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const revision = useRef(''), inFlight = useRef(false), onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const read = (result: { config: Config; revision: string }): Values => {
    const agent = result.config.agents.find(a => a.id === result.config.mandala?.agentId)!;
    return { name: agent.name, soul: result.config.mandala!.soul, cli: agent.defaultCli, models: agent.models, defaultEffort:agent.defaultEffort, showExecutionDetails: result.config.mandala?.showExecutionDetails === true, maxParallel: String(result.config.mandala!.maxParallel) };
  };
  const load = () => {
    setError(''); setSaveState('idle');
    void api<{ config: Config; revision: string }>('/config').then(result => { revision.current = result.revision; setLoaded(result); const next = read(result); setValues(next); setSaved(next); }).catch(reason => setError(reason.message));
  };
  useEffect(load, []);
  const cli = values?.cli ?? '';
  const effortCatalog=useAgentEffortCatalog(cli,loaded?.config.mandala?.agentId??'',cli&&values?values.models[cli]??'':'',catalog);
  useEffect(() => {
    if (!loaded || !cli) return;
    let active = true;
    setCatalog({ choices: [], loading: true, error: '' });
    void api<ModelChoice[]>('/models?' + new URLSearchParams({ cli, agentId: loaded.config.mandala!.agentId }))
      .then(choices => { if (active) setCatalog({ choices, loading: false, error: '' }); })
      .catch(reason => { if (active) setCatalog({ choices: [], loading: false, error: reason.message }); });
    return () => { active = false; };
  }, [loaded, cli, catalogRefresh]);
  const valid = !!values && !!values.name.trim() && !!values.cli && Number(values.maxParallel) >= 1 && Number.isInteger(Number(values.maxParallel));
  const save = async (next: Values) => {
    if (inFlight.current) return;
    inFlight.current = true; setSaveState('saving'); setError('');
    try {
      const result = await api<{ config: Config; revision: string }>('/mandala', 'PUT', { revision: revision.current, settings: { name: next.name.trim(), soul: next.soul, cli: next.cli, models: next.models, defaultEffort:next.defaultEffort??null, showExecutionDetails: next.showExecutionDetails, maxParallel: Number(next.maxParallel) } });
      revision.current = result.revision; setSaved(next); setSaveState('saved'); onSavedRef.current(result.config, result.revision);
    } catch (reason) { setError((reason as Error).message); setSaveState('error'); }
    finally { inFlight.current = false; }
  };
  // Selections save immediately; typing waits for a pause.
  const typing = useRef(false);
  useEffect(() => {
    if (!values || !valid || sameValues(values, saved) || saveState === 'error') return;
    const timer = setTimeout(() => { typing.current = false; void save(values); }, typing.current ? 600 : 0);
    return () => clearTimeout(timer);
  }, [values, saved, valid, saveState]);
  const patch = (change: Partial<Values>, typed = false) => { typing.current = typed; setValues(current => current && { ...current, ...change }); if (saveState === 'error') setSaveState('idle'); };

  if (error && !values) return <div className="settings-region-error" role="alert"><span>{error}</span><Button onClick={load}>{say('重新读取', 'Reload')}</Button></div>;
  if (!loaded || !values) return <LoadingState label={say('正在读取设置…', 'Loading settings…')} />;
  const status = saveState === 'saving' || (valid && !sameValues(values, saved)) ? <span className="settings-autosave" role="status"><Icon name="refresh" size={15} />{say('保存中…', 'Saving…')}</span>
    : saveState === 'error' ? <span className="settings-autosave is-error" role="alert"><Icon name="error" size={15} />{say('保存失败', 'Save failed')}{error && <> · {error}</>}<Button variant="ghost" onClick={() => error === 'configuration changed' ? load() : void save(values)}>{error === 'configuration changed' ? say('重新读取', 'Reload') : say('重试', 'Retry')}</Button></span>
    : saveState === 'saved' ? <span className="settings-autosave" role="status"><Icon name="circleCheck" size={15} />{say('已保存', 'Saved')}</span> : null;
  return <div className="mandala-settings-page">
    <SettingsGroup title={say('身份', 'Identity')} actions={status}>
      <SettingRow label={say('名字', 'Name')} htmlFor="mandala-name" hint={!values.name.trim() ? say('名字不能为空。', 'Name is required.') : undefined}>
        <Input id="mandala-name" value={values.name} maxLength={100} required aria-invalid={!values.name.trim() || undefined} onChange={event => patch({ name: event.target.value }, true)} />
      </SettingRow>
      <SettingRow stacked label="soul.md" htmlFor="mandala-soul" hint={say('性格、表达与协作偏好。系统规则和权限始终生效。', 'Personality, expression and collaboration preferences. System rules and permissions always apply.')}>
        <Textarea id="mandala-soul" rows={7} value={values.soul} maxLength={30000} onChange={event => patch({ soul: event.target.value }, true)} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={say('运行', 'Running')} scope={say('从下一轮对话生效', 'Applies from the next turn')} description={say('正在执行的工作保持当前设置。', 'Work already running keeps its current settings.')}>
      <SettingRow label={say('执行端', 'CLI')}>
        <Select ariaLabel={say('执行端', 'CLI')} searchable={false} value={values.cli} onChange={value=>{if(value===cli)return;setCatalog({choices:[],loading:true,error:''});setEffortReverted(!!values.defaultEffort);patch({cli:value as Cli,defaultEffort:undefined});}} options={enabledRuntimes(loaded.config).map(value => ({ value, label: runtimeLabel(value), icon: <RuntimeIcon cli={value} /> }))} />
      </SettingRow>
      <SettingRow label={say('模型', 'Model')}>
        <ModelCatalogPicker ariaLabel={say('模型', 'Model')} catalog={catalog} value={values.cli ? values.models[values.cli] ?? '' : ''} disabled={!values.cli}
          onChange={value=>{
            if(!cli||value===(values.models[cli]??''))return;
            const target=effortModel(catalog.choices,value);
            const defaultEffort=rebindAgentEffort(values.defaultEffort,cli,target?.id===effortCatalog.model?.id?effortCatalog.model:target);
            setEffortReverted(!!values.defaultEffort&&!defaultEffort);patch({models:{...values.models,[cli]:value},defaultEffort});
          }} onRefresh={() => refreshCatalog(value => value + 1)} />
      </SettingRow>
      <SettingRow label={say('默认思考强度','Default reasoning effort')}>
        <AgentEffortPicker cli={cli} model={effortCatalog.model} value={values.defaultEffort} pending={effortCatalog.pending} reverted={effortReverted} onChange={defaultEffort=>{setEffortReverted(false);patch({defaultEffort});}}/>
      </SettingRow>
      <SettingRow label={say('后台总并行上限', 'Background concurrency limit')} htmlFor="mandala-parallel" hint={say('主对话不占用后台名额。降低上限不会打断正在执行的工作。', 'The main chat does not use a background slot. Lowering the limit never interrupts running work.')}>
        <Input id="mandala-parallel" className="setting-row-field" type="number" min={1} step={1} required value={values.maxParallel} onChange={event => patch({ maxParallel: event.target.value }, true)} />
      </SettingRow>
      <SettingSwitch label={say('显示执行详情', 'Show execution details')} hint={say('在主对话中展示工具调用与执行过程。', 'Show tool calls and execution steps in the main chat.')} checked={values.showExecutionDetails} onChange={checked => patch({ showExecutionDetails: checked })} />
    </SettingsGroup>
    <p className="field-hint mandala-settings-footnote">{say('工作区、工具与规则由系统维护。', 'Workspace, tools and rules are managed by the system.')}</p>
  </div>;
}
