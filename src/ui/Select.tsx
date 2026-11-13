import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { composingKey } from '../shortcuts';
import { useEscapeScope } from './escape-scope';
import { useLanguage } from '../i18n';
import Icon, { type IconName } from './Icon';
import './controls.css';

export type SelectOption = { value: string; label: string; description?: string; group?: string; icon?: ReactNode; disabled?: boolean };

export default function Select({ value, onChange, options, ariaLabel, placeholder, disabled = false, searchable = true, className = '', icon, compactDescriptions = false, allowCustom = false, id: controlId, 'aria-describedby': describedBy, 'aria-labelledby': labelledBy, 'aria-invalid': invalid }: {
  id?: string; 'aria-describedby'?: string; 'aria-labelledby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  value: string; onChange: (value: string) => void; options: SelectOption[]; ariaLabel: string;
  placeholder?: string; disabled?: boolean; searchable?: boolean; className?: string; icon?: IconName; compactDescriptions?: boolean; allowCustom?: boolean;
}) {
  const { t } = useLanguage();
  const id = useId(), triggerId = controlId ?? `${id}-trigger`;
  const trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const composing = useRef(false), tabbing = useRef(false), restoreFocus = useRef(true);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const escapeScope = useEscapeScope<HTMLDivElement>(event => {
    if (composing.current || composingKey(event)) return;
    restoreFocus.current = true;
    setOpen(false);
  });
  const selected = options.find(option => option.value === value);
  const filtered = options.filter(option => `${option.value} ${option.label} ${option.description ?? ''} ${option.group ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  if (allowCustom && query.trim() && !options.some(option => option.value === query.trim()))
    filtered.push({ value: query.trim(), label: query.trim(), description: t('使用自定义模型 ID') });
  const groups: {label?: string; entries: {option: SelectOption; index: number}[]}[] = [];
  filtered.forEach((option,index)=>{
    if (!groups.length || groups.at(-1)!.label !== option.group) groups.push({label:option.group,entries:[]});
    groups.at(-1)!.entries.push({option,index});
  });
  const enabled = filtered.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const activeIndex = enabled.includes(active) ? active : enabled[0];
  const changeOpen = (next: boolean) => {
    if (next && disabled) return;
    if (next) {
      setQuery('');
      setActive(Math.max(0, options.findIndex(option => option.value === value && !option.disabled)));
      tabbing.current = false;
      restoreFocus.current = true;
    }
    setOpen(next);
  };
  const choose = (option: SelectOption) => { if (!option.disabled) { restoreFocus.current = true; onChange(option.value); setOpen(false); } };
  const handleKey = (event: KeyboardEvent) => {
    if (composing.current || composingKey(event.nativeEvent)) return;
    if (event.key === 'Tab' && open) {
      tabbing.current = true;
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) {
      event.preventDefault();
      if (!open) { changeOpen(true); return; }
      if (event.key === 'Enter') { if (filtered[activeIndex]) choose(filtered[activeIndex]); return; }
      const current = enabled.indexOf(activeIndex);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      setActive(enabled[next] ?? 0);
    }
  };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [open, activeIndex, id]);

  return <Popover open={open} onOpenChange={changeOpen}>
    <div className={`ui-select ${className}`}>
      <PopoverTrigger asChild>
        <button ref={trigger} id={triggerId} aria-describedby={describedBy} aria-labelledby={labelledBy} aria-invalid={invalid}
          type="button" className="ui-select-trigger" role="combobox" aria-label={ariaLabel}
          aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? `${id}-list` : undefined} disabled={disabled} data-value={value}
          title={selected?.label ?? (allowCustom ? value : undefined)} onKeyDown={handleKey}>
          {selected?.icon ?? (icon && <Icon name={icon} size={16}/>)}<span className="ui-select-value">{selected?.label ?? (allowCustom && value ? value : placeholder ?? ariaLabel)}</span><Icon name="chevronDown" size={16}/>
        </button>
      </PopoverTrigger>
    </div>
    {open && <PopoverContent ref={escapeScope.ref} className="ui-select-popup" align="start" sideOffset={6} collisionPadding={12}
      role="presentation" data-focus-return={triggerId} data-compact-descriptions={compactDescriptions || undefined}
      onOpenAutoFocus={event => { event.preventDefault(); (searchable ? search.current : list.current)?.focus(); }}
      onInteractOutside={() => { restoreFocus.current = false; }}
      onCloseAutoFocus={event => { event.preventDefault(); if (!tabbing.current && restoreFocus.current) trigger.current?.focus(); }}
      onEscapeKeyDown={escapeScope.onEscapeKeyDown}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={handleKey}>
      {searchable && <div className="ui-select-search"><Icon name="search" size={16}/><input ref={search} type="search"
        aria-label={`${ariaLabel} · ${t('搜索选项')}`} placeholder={t('搜索选项')} value={query}
        aria-controls={`${id}-list`} aria-activedescendant={activeIndex !== undefined ? `${id}-option-${activeIndex}` : undefined}
        onChange={event => { setQuery(event.target.value); setActive(0); }}/></div>}
      <div ref={list} id={`${id}-list`} tabIndex={searchable ? undefined : -1} role="listbox" aria-label={ariaLabel} className="ui-select-options"
        aria-activedescendant={!searchable && activeIndex !== undefined ? `${id}-option-${activeIndex}` : undefined}>
        {groups.map((group,groupIndex)=><div key={groupIndex} role={group.label?'group':undefined} aria-label={group.label}>
          {group.label&&<div className="ui-select-group-label">{group.label}</div>}
          {group.entries.map(({option,index}) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-label={option.label}
          aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-value={option.value}
          className={`ui-select-option ${index === activeIndex ? 'active' : ''}`} title={option.label}
          onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(option)}>
          {option.icon ?? (icon && <Icon name={icon} size={16}/>)}<span className="ui-select-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          {option.value === value && <Icon name="check" size={16}/>}
        </div>)}</div>)}
        {!filtered.length && <p className="ui-select-empty">{t('没有匹配选项')}</p>}
      </div>
    </PopoverContent>}
  </Popover>;
}
