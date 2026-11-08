import type { ReactNode } from 'react';
import Icon, { type IconName } from './Icon';
import './controls.css';

export default function EmptyState({ children, action, icon = 'inbox', as: Tag = 'div', className = '' }: { children: ReactNode; action?: ReactNode; icon?: IconName; as?: 'div' | 'p'; className?: string }) {
  const Copy = Tag === 'p' ? 'span' : 'div';
  return <Tag className={`ui-empty ${className}`}><Icon name={icon} size={20}/><Copy className="ui-empty-copy">{children}{action && <span className="ui-empty-action">{action}</span>}</Copy></Tag>;
}
