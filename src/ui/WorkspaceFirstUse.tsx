import { Fragment, type ReactNode } from 'react';
import BrandMark from './BrandMark';
import Icon from './Icon';
import './workspace-first-use.css';

/**
 * A dashed blueprint of the first item, drawn where that item will appear.
 * `fields` name what the real row or card will carry; the first slot is the sample,
 * the rest are fading outlines that hint at a list.
 */
export type FirstUseSlot = {
  shape?: 'row' | 'card' | 'task';
  fields: string[];
  /** A sample value shown before the fields, e.g. a schedule time. */
  lead?: string;
  /** Task shape: label of the nested chat row. */
  child?: string;
  /** Visible label inside the sample; shown only when the sample is clickable. */
  createLabel?: string;
  onCreate?: () => void;
  disabled?: boolean;
};

export default function WorkspaceFirstUse({ title, children, action, slot, size = 'page' }: {
  title: string; children: ReactNode; action?: ReactNode; slot: FirstUseSlot; size?: 'page' | 'panel';
}) {
  const shape = slot.shape ?? 'row';
  const ghosts = size === 'panel' || shape === 'task' ? 1 : 3;
  const clickable = !!slot.onCreate && !slot.disabled;
  const body = <>
    <span className="workspace-first-use-slot-lead" data-kind={shape === 'task' ? 'status' : 'identity'}/>
    {slot.lead && <span className="workspace-first-use-slot-sample">{slot.lead}</span>}
    <span className="workspace-first-use-slot-fields">{slot.fields.map((field, index) => <Fragment key={field}>
      {index > 0 && <span className="workspace-first-use-slot-rule"/>}
      <span>{field}</span>
    </Fragment>)}</span>
    {clickable && slot.createLabel && <span className="workspace-first-use-slot-create"><Icon name="plus" size={14}/>{slot.createLabel}</span>}
  </>;
  return <div className="workspace-first-use" data-size={size} data-shape={shape}><div className="workspace-first-use-content">
    <div className="workspace-first-use-copy">
      <h2><BrandMark className="workspace-first-use-mark"/>{title}</h2>
      <p>{children}</p>
    </div>
    {/* The sample repeats the primary action for pointer users; assistive technology uses the action below. */}
    <div className="workspace-first-use-slots" aria-hidden="true">
      {clickable
        ? <button type="button" tabIndex={-1} className="workspace-first-use-slot is-sample" onClick={slot.onCreate}>{body}</button>
        : <div className="workspace-first-use-slot is-sample">{body}</div>}
      {shape === 'task' && slot.child && <div className="workspace-first-use-slot is-child"><span className="workspace-first-use-slot-fields"><span>{slot.child}</span></span></div>}
      {Array.from({ length: ghosts }, (_, index) => <div key={index} className="workspace-first-use-slot is-ghost" data-step={index + 1}/>)}
    </div>
    {action && <div className="workspace-first-use-actions">{action}</div>}
  </div></div>;
}
