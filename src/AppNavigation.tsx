import { AccountAvatar } from './AccountAvatar';
import BrandMark from "./ui/BrandMark";
import {TaskNotificationInbox} from './TaskNotifications';
import Button from './ui/Button';
import { progressReturnPath } from './progress-navigation';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { orderedSidebarItems, modulePinned, type ModulePins } from './sidebar-modules';
import { useLanguage, type Message } from './i18n';
import Icon from './ui/Icon';
import { shortcutLabel, shortcutAria } from './shortcuts';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './components/ui/dropdown-menu';
import { useDesktopUpdate } from './desktopUpdates';

export type SidebarAccount = { username: string; status: string; avatar?: string; onOpen: () => void };
type Area = 'usage' | 'chat' | 'tasks' | 'projects' | 'agents' | 'assets' | 'settings' | 'mana' | 'memory' | 'market' | 'library' | 'schedules';
export function navigationGroup(active: Area): Exclude<Area, 'mana'> {
  const tab = new URLSearchParams(location.search).get('tab');
  if(location.pathname==='/mana/skills'||location.pathname==='/settings/skills')return 'settings';
  if (location.pathname === '/mana' && tab === 'organization') return 'agents';
  if (location.pathname === '/mana' && tab === 'skill') return 'settings';
  if (location.pathname === '/mana' && tab === 'automation') return 'schedules';
  if (location.pathname === '/mana' && (!tab || tab === 'memory')) return 'memory';
  return active === 'assets' || active === 'mana' ? 'library' : active;
}
export default function AppNavigation({ active, disabled = false, library, modulePins, moduleOrder, onStartChat, onOpenPath, account, mandala }: {
  mandala?: {name:string;active:boolean};
  active: Area; disabled?: boolean; library: ReactNode; account?: SidebarAccount;
  modulePins: ModulePins; moduleOrder: string[];
  onStartChat: () => void; onOpenPath: (path: string) => void;
}) {
  const { t, text } = useLanguage();
  const label = (item: {id: string; label: Message}) => {
    const names: Record<string, [string, string]> = { projects: ['项目', 'Projects'], agents: ['智能体', 'Agents'], library: ['资料库', 'Library'], schedules: ['自动化', 'Schedules'] };
    const pair = names[item.id];
    return pair ? text(pair[0], pair[1]) : t(item.label);
  };
  const accountDescription = useId();
  const current = navigationGroup(active);
  const [accountOpen, setAccountOpen] = useState(false);
  const [updateState] = useDesktopUpdate();
  const update = updateState?.status === 'available' || updateState?.status === 'ready' ? updateState.update : null;
  const items = orderedSidebarItems(moduleOrder);
  const pinned = items.filter(item => modulePinned(item, modulePins));
  const unpinned = items.filter(item => item.id !== 'settings' && !modulePinned(item, modulePins));
  const hiddenCurrent = unpinned.some(item => item.id === current);
  const link = (item: typeof items[number]) => <a className="sidebar-destination" key={item.id} href={item.href} data-area={item.id} aria-disabled={disabled || undefined}
    aria-current={current === item.id ? 'page' : undefined} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); if (!disabled) { setAccountOpen(false); onOpenPath(item.id === 'tasks' ? progressReturnPath() : item.href); }
    }}><Icon name={item.icon} size={16}/><span>{label(item)}</span></a>;
  useEffect(() => { if (disabled) setAccountOpen(false); }, [disabled]);
  return <>
    <div className="sidebar-start"><Button className="new-chat" type="button" disabled={disabled} aria-keyshortcuts={shortcutAria('new-chat')} title={t('开始对话') + ' · ' + shortcutLabel('new-chat')} onClick={onStartChat}><Icon name="plus" size={16}/>{t('开始对话')}<kbd aria-hidden="true">{shortcutLabel('new-chat')}</kbd></Button></div>
    <nav className="workspace-navigation" aria-label={t('主导航')} data-active-area={active}>
      <div className="sidebar-primary-navigation"><a className="sidebar-destination sidebar-mandala" href="/mandala" aria-current={mandala?.active?'page':undefined} aria-disabled={disabled||undefined} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();if(!disabled)onOpenPath('/mandala');}}><BrandMark/><span>{mandala?.name??'Mandala'}</span></a>{pinned.map(link)}</div>
      <div id="navigation-chat" className="permanent-conversations"><div className="conversation-heading"><h2>{t('对话')}</h2></div>{library}</div>
      <div className="sidebar-bottom-navigation"><div className="sidebar-account-row"><DropdownMenu open={accountOpen} onOpenChange={setAccountOpen}><DropdownMenuTrigger asChild>
        <Button type="button" className="sidebar-account" aria-label={t('用户菜单') + (update ? ' · ' + text(`有新版本 ${update.version}`, `Update ${update.version} available`) : '')} aria-describedby={accountDescription} disabled={disabled} title={[account?.username, account?.status ?? t('本机')].filter(Boolean).join(' · ')} aria-current={hiddenCurrent ? 'page' : undefined}><AccountAvatar className="sidebar-account-avatar" name={account?.username ?? 'Mandala'} source={account?.avatar} />{update && <i className="sidebar-update-dot" aria-hidden="true"/>}<span id={accountDescription}><strong title={account?.username ?? 'Mandala'}>{account?.username ?? 'Mandala'}</strong><small title={account?.status ?? t('本机')}>{account?.status ?? t('本机')}</small></span></Button>
      </DropdownMenuTrigger><DropdownMenuContent className="sidebar-account-menu" side="top" align="start" aria-label={t('用户菜单')}>
        {/* Who you are, then where you can go: the one separator divides identity from destinations. */}
        {account && <><DropdownMenuItem className="sidebar-account-identity" onSelect={() => account.onOpen()} aria-label={t('账号') + ' · ' + account.username}><AccountAvatar className="sidebar-account-avatar" name={account.username} source={account.avatar} /><span><strong>{account.username}</strong><small>{account.status}</small></span></DropdownMenuItem><DropdownMenuSeparator/></>}
        {unpinned.map(item => <DropdownMenuItem key={item.id} asChild disabled={disabled}>{link(item)}</DropdownMenuItem>)}
        <DropdownMenuItem asChild>{link(items.find(item => item.id === 'settings')!)}</DropdownMenuItem>
        {update && <><DropdownMenuSeparator/><DropdownMenuItem className="sidebar-update-item" disabled={disabled} onSelect={() => onOpenPath('/settings/general')}><Icon name="download" size={16}/><span>{text(`更新到 ${update.version}`, `Update to ${update.version}`)}</span></DropdownMenuItem></>}
      </DropdownMenuContent></DropdownMenu><TaskNotificationInbox disabled={disabled}/></div></div>
    </nav>
  </>;
}
