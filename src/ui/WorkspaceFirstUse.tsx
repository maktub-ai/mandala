import type { ReactNode } from 'react';
import Icon, { type IconName } from './Icon';
import './workspace-first-use.css';

export default function WorkspaceFirstUse({ icon, title, children, action }: {
  icon: IconName; title: string; children: ReactNode; action: ReactNode;
}) {
  return <div className="workspace-first-use"><div className="workspace-first-use-content">
    <div className="workspace-first-use-art" aria-hidden="true"><span><Icon name={icon} size={24}/></span></div>
    <h2>{title}</h2>
    <p>{children}</p>
    {action}
  </div></div>;
}
