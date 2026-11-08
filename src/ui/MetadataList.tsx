import type { ReactNode } from 'react';
import Icon, { type IconName } from './Icon';
import './workspace.css';

export default function MetadataList({ items }: {items: {label: string; value: ReactNode; icon?: IconName}[]}) {
  return <dl className="workspace-metadata">{items.map(item => <div key={item.label}>
    <dt>{item.icon && <Icon name={item.icon} size={14}/>}<span>{item.label}</span></dt><dd>{item.value}</dd>
  </div>)}</dl>;
}
