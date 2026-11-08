import type { ComponentPropsWithRef } from 'react';
import { Button as ButtonPrimitive } from '../components/ui/button';
import { LoaderCircle } from 'lucide-react';
import './controls.css';

type Props = ComponentPropsWithRef<'button'> & {
  variant?: 'secondary' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  busy?: boolean;
};

export default function Button({ type = 'button', variant, size, busy = false, disabled, className = '', children, ...props }: Props) {
  const primitiveVariant = variant === 'primary' ? 'default' : variant === 'danger' ? 'destructive' : variant ?? 'secondary';
  return <ButtonPrimitive {...props} type={type} variant={primitiveVariant} size={size === 'sm' ? 'sm' : 'default'}
    className={`ui-button ${variant === 'primary' ? 'primary ' : ''}${className}`}
    data-variant={variant} data-size={size} aria-busy={busy || undefined} disabled={disabled || busy}>
    {busy && <LoaderCircle size={14} className="ui-busy-icon" aria-hidden="true"/>}{children}
  </ButtonPrimitive>;
}
