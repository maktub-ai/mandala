import type { ComponentPropsWithoutRef } from 'react';
import Icon from './Icon';
import './controls.css';

export default function Notice({ tone = 'error', as: Tag = 'div', className = '', children, ...props }: ComponentPropsWithoutRef<'div'> & {
  tone?: 'error' | 'info' | 'success'; as?: 'div' | 'p' | 'span';
}) {
  return <Tag role={tone === 'error' ? 'alert' : 'status'} {...props} className={`ui-notice ${className}`} data-tone={tone}><Icon name={tone === 'error' ? 'error' : tone === 'success' ? 'circleCheck' : 'info'} size={15}/>{children}</Tag>;
}
