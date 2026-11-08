import type { ComponentPropsWithRef } from 'react';
import { Textarea as TextareaPrimitive } from '../components/ui/textarea';
import './controls.css';

export default function Textarea({ className = '', ...props }: ComponentPropsWithRef<'textarea'>) {
  return <TextareaPrimitive {...props} className={`ui-textarea ${className}`} />;
}
