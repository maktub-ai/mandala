import { useId, type ReactNode } from 'react';
import {SidebarToggle} from '../AppSidebar';
import Icon, { type IconName } from './Icon';
import './workspace.css';

export function PageHeader({ title, icon, context, actions, children, onMobileNav }: {
  title: string; icon: IconName; context?: ReactNode; actions?: ReactNode; children?: ReactNode; onMobileNav?: () => void;
}) {
  return <header className="workspace-page-header">
    <div className="workspace-page-heading">{onMobileNav && <SidebarToggle onClick={onMobileNav}/>}<Icon name={icon} size={20}/><h1>{title}</h1>{context && <span className="workspace-page-context">{context}</span>}</div>
    {actions && <div className="workspace-page-actions">{actions}</div>}
    {children && <div className="workspace-page-toolbar">{children}</div>}
  </header>;
}

export function WorkspacePage({ children, className = '', width }: {children: ReactNode; className?: string; width?: 'compact' | 'standard' | 'fluid'}) {
  return <section data-page-width={width} data-page-canvas={width ? true : undefined} className={`workspace-page ${className}`}>{children}</section>;
}

/** Navigation stays with the route owner; mobile shows either list or selected detail. */
export function ListDetail({ list, detail, className = '' }: {list: ReactNode; detail?: ReactNode; className?: string}) {
  return <div className={`workspace-list-detail ${className}`} data-detail-open={!!detail}>
    <div className="workspace-list">{list}</div>
    {detail && <aside className="workspace-detail">{detail}</aside>}
  </div>;
}

export function DetailSection({ title, icon, actions, children }: {title: string; icon?: IconName; actions?: ReactNode; children: ReactNode}) {
  const id = useId();
  return <section className="workspace-detail-section" aria-labelledby={id}>
    <div className="workspace-section-heading">{icon && <Icon name={icon} size={15}/>}<h2 id={id}>{title}</h2>{actions}</div>
    {children}
  </section>;
}
