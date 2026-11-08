import { useRef, type ReactNode } from 'react';
import { RadioGroup } from 'radix-ui';
import { composingKey } from '../shortcuts';
import './controls.css';

export type Choice = { value: string; label: ReactNode; disabled?: boolean };

export default function SegmentedControl({ value, onChange, options, label, disabled = false, className = '', role = 'radiogroup' }: {
  value: string; onChange: (value: string) => void; options: Choice[]; label: string; disabled?: boolean; className?: string; role?: 'radiogroup' | 'group';
}) {
  const composing = useRef(false), keyboardSelection = useRef(false);
  return <RadioGroup.Root className={`ui-segmented ${className}`} role={role} aria-label={label} value={value} onValueChange={onChange} disabled={disabled} loop
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDownCapture={event => {
      if (composing.current || composingKey(event.nativeEvent)) { event.stopPropagation(); return; }
      keyboardSelection.current = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
    }}
    onKeyDown={() => {
      // Radix moves focus asynchronously; a quick keyup must not cancel selection.
      if (keyboardSelection.current) setTimeout(() => { keyboardSelection.current = false; }, 0);
    }}
    onPointerDownCapture={() => { keyboardSelection.current = false; }}>
    {options.map(option => <RadioGroup.Item key={option.value} value={option.value} data-value={option.value} disabled={disabled || option.disabled}
      onFocus={event => {
        if (!keyboardSelection.current) return;
        keyboardSelection.current = false;
        event.preventDefault();
        if (!disabled && !option.disabled && option.value !== value) onChange(option.value);
      }}
      role={role === 'radiogroup' ? 'radio' : 'button'} aria-checked={role === 'radiogroup' ? value === option.value : undefined}
      aria-pressed={role === 'group' ? value === option.value : undefined}>{option.label}</RadioGroup.Item>)}
  </RadioGroup.Root>;
}
