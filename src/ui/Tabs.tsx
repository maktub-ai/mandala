import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Tabs as TabsRoot, TabsList, TabsTrigger } from '../components/ui/tabs';
import { composingKey } from '../shortcuts';
import type { Choice } from './SegmentedControl';
import './controls.css';

/** The caller owns panel contents; public IDs retain the external TabPanel contract. */
export default function Tabs({ id, value, onChange, options, label, disabled = false, className = '' }: {
  id: string; value: string; onChange: (value: string) => void; options: Choice[]; label: string; disabled?: boolean; className?: string;
}) {
  const root = useRef<HTMLDivElement>(null), composing = useRef(false);
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
  useLayoutEffect(() => {
    const update = () => setOrientation(getComputedStyle(root.current!).flexDirection === 'column' ? 'vertical' : 'horizontal');
    update();
    const observer = new ResizeObserver(update); observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  return <TabsRoot className="ui-tabs-root" value={value} onValueChange={onChange} orientation={orientation}>
    <TabsList ref={root} className={`ui-tabs ${className}`} variant="line" aria-label={label} loop
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDownCapture={event => { if (composing.current || composingKey(event.nativeEvent)) event.stopPropagation(); }}>
      {options.map(option => <TabsTrigger key={option.value} value={option.value} id={`${id}-${option.value}`}
        aria-controls={`${id}-panel`} data-value={option.value} disabled={disabled || option.disabled}>{option.label}</TabsTrigger>)}
    </TabsList>
  </TabsRoot>;
}

export function TabPanel({ id, value, children, className }: { id: string; value: string; children: ReactNode; className?: string }) {
  return <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}`} className={className}>{children}</div>;
}
