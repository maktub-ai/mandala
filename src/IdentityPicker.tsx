import { useMemo, useState } from 'react';
import { identityIcons, isIdentityEmoji, type IdentityAppearance, type IdentityIcon, type IdentityKind } from '../shared/identity';
import IdentityAvatar from './IdentityAvatar';
import { IdentityGlyph, identityEmojiGroups, identityIconLabels } from './identity-icons';
import { useLanguage } from './i18n';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import Input from './ui/Input';
import './identity-picker.css';

type Patch = { icon?: IdentityIcon; emoji?: string; avatarSeed?: string };
/** Linear-style chooser: icons or emoji for both kinds; Agents also keep the generated avatar as default. */
export default function IdentityPicker({ kind, identity, onChange }: { kind: IdentityKind; identity: IdentityAppearance & { name: string }; onChange: (patch: Patch) => void }) {
 const { text: say } = useLanguage(), [open, setOpen] = useState(false), [tab, setTab] = useState<'icons' | 'emoji'>(identity.emoji ? 'emoji' : 'icons'), [query, setQuery] = useState('');
 const label = kind === 'project' ? say('项目图标', 'Project icon') : say('Agent 图标', 'Agent icon');
 const q = query.trim().toLowerCase();
 const icons = useMemo(() => identityIcons.filter(icon => !q || [icon, ...identityIconLabels[icon]].some(word => word.toLowerCase().includes(q))), [q]);
 const groups = useMemo(() => identityEmojiGroups.map(group => ({ ...group, items: group.items.filter(([emoji, words]) => !q || emoji === query.trim() || words.toLowerCase().includes(q)) })).filter(group => group.items.length), [q, query]);
 const typed = isIdentityEmoji(query.trim()) && !identityEmojiGroups.some(group => group.items.some(([emoji]) => emoji === query.trim())) ? query.trim() : null;
 const choose = (patch: Patch) => { onChange(patch); setOpen(false); setQuery(''); };
 const autoAvatar = kind === 'agent' && !identity.icon && !identity.emoji;
 const iconSelected = (icon: IdentityIcon) => !identity.emoji && (identity.icon ?? (kind === 'project' ? 'project' : undefined)) === icon;
 return <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery(''); }}>
  <PopoverTrigger asChild><button type="button" className="identity-picker-trigger" aria-label={label} aria-haspopup="dialog">
   <IdentityAvatar identity={identity} kind={kind} size={40} /><span>{say('更换图标', 'Change icon')}</span>
  </button></PopoverTrigger>
  <PopoverContent className="identity-picker" align="start" aria-label={label}>
   <div className="identity-picker-tabs" role="tablist" aria-label={label}>
    {(['icons', 'emoji'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value === 'icons' ? say('图标', 'Icons') : 'Emoji'}</button>)}
   </div>
   <Input type="search" aria-label={label + ' · ' + say('搜索', 'Search')} placeholder={tab === 'icons' ? say('搜索图标…', 'Search icons…') : say('搜索或粘贴 emoji…', 'Search or paste an emoji…')} value={query} onChange={event => setQuery(event.target.value)} />
   <div className="identity-picker-body" role="tabpanel">
    {tab === 'icons' ? <div className="identity-picker-grid">
     {kind === 'agent' && !q && <button type="button" className="identity-picker-auto" aria-pressed={autoAvatar} aria-label={say('自动头像', 'Generated avatar')} title={say('自动头像', 'Generated avatar')} onClick={() => choose({ icon: undefined, emoji: undefined })}>
      <IdentityAvatar identity={{ ...identity, icon: undefined, emoji: undefined }} kind="agent" size={22} /></button>}
     {icons.map(icon => { const [zh, en] = identityIconLabels[icon]; return <button key={icon} type="button" aria-pressed={iconSelected(icon)} aria-label={say(zh, en)} title={say(zh, en)} onClick={() => choose({ icon, emoji: undefined })}><IdentityGlyph name={icon} size={18} /></button>; })}
     {!icons.length && <p className="identity-picker-empty">{say('没有匹配的图标', 'No matching icons')}</p>}
    </div> : <>
     {typed && <div className="identity-picker-grid"><button type="button" className="identity-emoji" aria-label={typed} onClick={() => choose({ emoji: typed, icon: undefined })}>{typed}</button></div>}
     {groups.map(group => <section key={group.en}><h3>{say(group.zh, group.en)}</h3><div className="identity-picker-grid">
      {group.items.map(([emoji]) => <button key={emoji} type="button" className="identity-emoji" aria-pressed={identity.emoji === emoji} aria-label={emoji} onClick={() => choose({ emoji, icon: undefined })}>{emoji}</button>)}
     </div></section>)}
     {!groups.length && !typed && <p className="identity-picker-empty">{say('没有匹配的 emoji，可以直接粘贴一个', 'No match. You can paste any emoji')}</p>}
    </>}
   </div>
   {autoAvatar && <button type="button" className="identity-picker-regenerate" onClick={() => onChange({ avatarSeed: crypto.randomUUID() })}>{say('重新生成头像', 'Regenerate avatar')}</button>}
  </PopoverContent>
 </Popover>;
}
