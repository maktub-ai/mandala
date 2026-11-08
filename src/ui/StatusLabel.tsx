import type { ReactNode } from 'react';
import { Badge } from '../components/ui/badge';
import Icon, { type IconName } from './Icon';
import StatusMark,{type StatusShape} from './StatusMark';
import './workspace.css';

/** The caller supplies a truthful domain label; tone never changes task/run state. */
export default function StatusLabel({ children, icon, tone = 'neutral', title, filled=false, shape }: {
  children: ReactNode; icon: IconName; tone?: 'neutral' | 'active' | 'success' | 'warning' | 'danger'; title?: string; filled?:boolean; shape?:StatusShape;
}) {
  return <Badge variant="ghost" className="workspace-status" data-tone={tone} data-filled={filled||undefined} title={title}>{filled?<StatusMark tone={tone} shape={shape}/>:<Icon name={icon} size={13}/>} {children}</Badge>;
}
