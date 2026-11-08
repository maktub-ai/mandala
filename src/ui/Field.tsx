import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';
import { Label } from '../components/ui/label';
import './controls.css';

type Control = { id?: string; ariaLabel?: string; 'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' };

/** Keep the native label layout; connect one control to its help and validation. */
export default function Field({ label, hint, error, children, className = '' }: {
  label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactElement<Control>; className?: string;
}) {
  const generated = useId();
  const id = children.props.id ?? generated;
  const describedBy = [children.props['aria-describedby'], hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return <Label className={`ui-field ${className}`} htmlFor={id}>
    <span id={`${id}-label`} className="ui-field-label">{label}</span>
    {cloneElement(children, { id, 'aria-labelledby': children.props['aria-labelledby'] ?? (children.props['aria-label'] || children.props.ariaLabel ? undefined : `${id}-label`), 'aria-describedby': describedBy || undefined, 'aria-invalid': error ? true : children.props['aria-invalid'] })}
    {hint && <span id={`${id}-hint`} className="field-hint ui-field-hint">{hint}</span>}
    {error && <span id={`${id}-error`} className="field-error ui-field-error" role="alert">{error}</span>}
  </Label>;
}
