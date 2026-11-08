import type { ComponentProps, ReactNode } from 'react';
import Icon from './Icon';
import './controls.css';

/** Optional context only. Keep required reading and primary actions visible. */
export default function Disclosure({ title, summaryLabel, children, className = '', ...props }: Omit<ComponentProps<'details'>, 'title'> & { title: ReactNode; summaryLabel?: string }) {
 return <details {...props} className={'ui-disclosure '+className}>
  <summary aria-label={summaryLabel}><span className="ui-disclosure-title">{title}</span><Icon name="chevronRight" size={16} className="ui-disclosure-chevron"/></summary>
  <div className="ui-disclosure-content">{children}</div>
 </details>;
}
