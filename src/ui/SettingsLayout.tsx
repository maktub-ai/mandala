import { useId, type ReactNode } from 'react';
import Input from './Input';
import './settings-layout.css';

/**
 * Shared anatomy for every settings page (DESIGN.md § Settings):
 * a group is an unboxed section with a 16px heading, optional scope tag and
 * heading action; rows put the name and hint on the left and the control on
 * the right, or stack a full-width control below the name.
 */
export function SettingsGroup({ title, scope, description, actions, children, className = '', label }: {
  title: ReactNode; scope?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; label?: string;
}) {
  const id = useId();
  return <section className={`settings-group ${className}`.trim()} aria-labelledby={label ? undefined : id} aria-label={label}>
    <header className="settings-group-heading">
      <div className="settings-group-title"><h2 id={id}>{title}</h2>{scope && <span className="settings-scope">{scope}</span>}</div>
      {actions && <div className="settings-group-actions">{actions}</div>}
    </header>
    {description && <p className="settings-group-description">{description}</p>}
    {children && <div className="settings-rows">{children}</div>}
  </section>;
}

export function SettingRow({ label, hint, children, htmlFor, stacked = false, className = '' }: {
  label: ReactNode; hint?: ReactNode; children?: ReactNode; htmlFor?: string; stacked?: boolean; className?: string;
}) {
  return <div className={`setting-row${stacked ? ' is-stacked' : ''} ${className}`.trim()}>
    <div className="setting-row-text">
      {htmlFor ? <label className="setting-row-label" htmlFor={htmlFor}>{label}</label> : <span className="setting-row-label">{label}</span>}
      {hint && <p className="setting-row-hint">{hint}</p>}
    </div>
    {children !== undefined && <div className="setting-row-control">{children}</div>}
  </div>;
}

/** Every on/off setting is a right-aligned switch; checkboxes are reserved for multi-select lists. */
export function SettingSwitch({ label, hint, checked, onChange, disabled, ariaLabel }: {
  label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; ariaLabel?: string;
}) {
  const id = useId();
  return <SettingRow label={label} hint={hint} htmlFor={id}>
    <Input id={id} type="checkbox" role="switch" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
  </SettingRow>;
}
