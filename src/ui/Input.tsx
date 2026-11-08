import type { ComponentPropsWithRef } from 'react';
import { Input as InputPrimitive } from '../components/ui/input';
import './controls.css';

export default function Input({ className = '', type, ...props }: ComponentPropsWithRef<'input'>) {
  // These native controls have distinct geometry and change-event contracts.
  if (type && ['checkbox', 'radio', 'range', 'color'].includes(type))
    return <input {...props} type={type} className={`ui-input ${className}`} />;
  return <InputPrimitive {...props} type={type} className={`ui-input ${className}`} />;
}
