import {useEffect,useState} from 'react';
import {effortLabels,effortModel,effortOptions,matchingAgentEffort,supportedAgentEffort,type AgentEffort,type ReasoningEffort} from '../shared/chat-input';
import type {Cli,ModelChoice} from '../shared/types';
import {api} from './api';
import {useLanguage} from './i18n';
import type {ModelCatalog} from './ModelCatalogPicker';
import Select from './ui/Select';

/** Pi and DSH expose thinking levels only for the active model in an isolated probe. */
export function useAgentEffortCatalog(cli:Cli|'', agentId:string, model:string, catalog:ModelCatalog) {
 const key=JSON.stringify([cli,agentId,model]);
 const needsProbe=!!model&&!catalog.loading&&!catalog.error&&(cli==='pi'||cli==='dsh')&&
   !catalog.choices.find(choice=>choice.id===model)?.isDefault;
 const [probe,setProbe]=useState<{key:string;catalog:ModelCatalog;choices:ModelChoice[]} >();
 const fresh=probe?.key===key&&probe.catalog===catalog;
 useEffect(()=>{
  if(!needsProbe)return;
  const controller=new AbortController();
  void api<ModelChoice[]>('/models?'+new URLSearchParams({cli,agentId,model}),'GET',undefined,controller.signal)
   .then(choices=>{if(!controller.signal.aborted)setProbe({key,catalog,choices});})
   .catch(()=>{if(!controller.signal.aborted)setProbe({key,catalog,choices:[]});});
  return ()=>controller.abort();
 },[needsProbe,key,catalog]);
 const models=needsProbe?(fresh?probe.choices:[]):catalog.choices;
 return {model:effortModel(models,model), pending:catalog.loading||needsProbe&&!fresh};
}

export function rebindAgentEffort(value:AgentEffort|undefined, cli:Cli, model?:ModelChoice) {
 return value?.cli===cli&&model&&effortOptions(model).includes(value.effort)?{...value,model:model.id}:undefined;
}

export default function AgentEffortPicker({cli,model,value,onChange,disabled,pending,reverted}: {
 cli:Cli|'';model?:ModelChoice;value?:AgentEffort;onChange:(value?:AgentEffort)=>void;disabled?:boolean;pending:boolean;reverted:boolean;
}) {
 const {text:say,t}=useLanguage();
 const label=say('默认思考强度','Default reasoning effort');
 const allowed=effortOptions(model);
 const selected=cli?supportedAgentEffort(matchingAgentEffort(value,cli,model?.id),model):undefined;
 return <div>
  <Select ariaLabel={label} value={pending&&value?value.effort:selected??''} disabled={disabled||pending||!cli||!allowed.length&&!value} searchable={false}
   options={[{value:'',label:say('跟随执行端默认','Use runtime default')},...allowed.map(effort=>({value:effort,label:t(effortLabels[effort])})),
    ...(pending&&value&&!allowed.includes(value.effort)?[{value:value.effort,label:t(effortLabels[value.effort])}]:[])]}
   onChange={next=>onChange(next&&cli&&model?{cli,model:model.id,effort:next as ReasoningEffort}:undefined)}/>
  {(reverted||!pending&&value&&!selected)?<p className="field-hint" role="status">{say('当前模型的原档位不受支持或无法确认，执行时跟随执行端默认。','The previous effort is unsupported or unverified for this model. Execution uses the runtime default.')}</p>
   : !pending&&!allowed.length?<p className="field-hint">{say('执行端未报告此模型的可选档位。','The runtime reports no effort options for this model.')}</p>:null}
 </div>;
}
