import type { ReactNode } from 'react';
import { useLanguage } from './i18n';
import Tabs from './ui/Tabs';
import Button from './ui/Button';
import Icon from './ui/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';

export function LibraryTabs({ value, disabled, plugins, onChange }: {
  value: string; disabled: boolean; plugins: { value: string; label: ReactNode }[]; onChange: (value: string) => void;
}) {
  const { t } = useLanguage();
  const overflow = plugins.slice(2);
  const selected = overflow.find(item => item.value === value);
  const options = [
    { value: 'recent', label: <><Icon name="clock" size={15}/>{t('最近')}</> },
    { value: 'wiki', label: <><Icon name="book" size={15}/>{t('知识库')}</> },
    ...plugins.slice(0, 2),
  ];
  return <div className="library-tabs">
    <Tabs id="library-tab" value={value} onChange={onChange} options={options} disabled={disabled} label={t('资料库视图')}/>
    {overflow.length > 0 && <DropdownMenu><DropdownMenuTrigger asChild>
      <Button variant="ghost" id="library-tab-:overflow" disabled={disabled} data-selected={!!selected} aria-label={t('更多')}>
        {selected?.label ?? t('更多')}<Icon name="chevronDown" size={13}/>
      </Button>
    </DropdownMenuTrigger><DropdownMenuContent align="end">{overflow.map(item =>
      <DropdownMenuItem key={item.value} onSelect={() => onChange(item.value)}>{item.label}{item.value === value && <Icon name="check" size={14}/>}</DropdownMenuItem>
    )}</DropdownMenuContent></DropdownMenu>}
  </div>;
}
