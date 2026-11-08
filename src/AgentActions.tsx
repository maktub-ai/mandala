import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './components/ui/dropdown-menu';
import Button from './ui/Button';
import { useState } from 'react';
import type { Agent } from '../shared/types';
import Dialog from './Dialog';
import Icon from './ui/Icon';
import { useLanguage } from './i18n';

export default function AgentActions({ agent, locked, onDelete }: {
  agent: Agent; locked: boolean; onDelete: () => void;
}) {
  const {text: localize,  t } = useLanguage();
  const [confirm, setConfirm] = useState(false);
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" className="icon-button" disabled={locked} aria-label={localize('智能体操作', 'Agent actions')}><Icon name="more" size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" disabled={locked} onSelect={()=>setConfirm(true)}><Icon name="trash" size={16}/>{t('删除智能体')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    {confirm && <Dialog label={t('确认删除智能体')} className="project-action-dialog" locked={locked} onClose={() => setConfirm(false)}>
      <h2>{t('确认删除智能体')}</h2>
      <p className="project-delete-name">{agent.name || t('未命名 Agent')}</p>
      <p className="field-hint">{t('删除此智能体的配置，并从所有关联项目中移除。历史对话、任务记录、资料和工作目录保留。')}</p>
      <p className="field-hint">{t('确认后自动保存。')}</p>
      <div className="project-form-actions"><Button type="button" disabled={locked} onClick={() => setConfirm(false)}>{t('取消')}</Button>
        <Button type="button" className="project-delete" disabled={locked} onClick={() => { onDelete(); setConfirm(false); }}>{t('删除智能体')}</Button></div>
    </Dialog>}
  </>;
}
