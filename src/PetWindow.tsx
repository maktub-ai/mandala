import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './i18n';
import { PetFigure, desktopPet, petStatusText, petTarget, usePetPack, usePetPreference, usePetStatus } from './MandalaPet';
import './mandala-pet.css';

/**
 * The desktop pet: a transparent always-on-top window where only the pet itself takes the mouse.
 * Drag it to move; click it to see its status and an Open action; double-click opens straight away.
 */
export default function PetWindow() {
  const { text } = useLanguage();
  const [preference] = usePetPreference();
  const pack = usePetPack(preference.figure);
  const status = usePetStatus(true);
  const desktop = desktopPet(), line = petStatusText(status, text);
  const [hover, setHover] = useState(false), [poke, setPoke] = useState(0), [shown, setShown] = useState(false);
  const drag = useRef<{ id: number; dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);
  const interactive = useRef(false);
  const setInteractive = (value: boolean) => { if (interactive.current === value) return; interactive.current = value; desktop?.interactive(value); };
  // Something that needs the person keeps the bubble up; otherwise it shows on hover or after a poke.
  const attention = status.pet === 'waiting' || status.pet === 'error' || status.pet === 'unknown';
  useEffect(() => { if (!poke) return; setShown(true); const timer = setTimeout(() => setShown(false), 6000); return () => clearTimeout(timer); }, [poke]);
  const enter = () => { setHover(true); setInteractive(true); };
  const leave = () => { setHover(false); if (!drag.current) setInteractive(false); };
  return <div className="pet-window-root">
    <div className="pet-window-pet" onMouseEnter={enter} onMouseLeave={leave}>
      <div className="pet-window-bubble" data-visible={hover || shown || attention || undefined} role="status">
        <span>{line}</span>
        <button type="button" className="pet-window-open" onClick={() => void desktop?.open(petTarget(status))}>{status.first ? text('处理', 'Review') : text('打开', 'Open')}</button>
        <button type="button" aria-label={text('收回到面板', 'Return to the panel')} title={text('收回到面板', 'Return to the panel')} onClick={() => void desktop?.hide()}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <button type="button" className="pet-window-figure" data-poke={poke ? poke % 2 : undefined} key={poke}
        title={text('拖动移动；单击查看状态；双击打开', 'Drag to move; click for status; double-click to open')}
        onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, dx: event.screenX - window.screenX, dy: event.screenY - window.screenY, x: event.screenX, y: event.screenY, moved: false }; }}
        onPointerMove={event => { const d = drag.current; if (!d || d.id !== event.pointerId) return; if (Math.abs(event.screenX - d.x) + Math.abs(event.screenY - d.y) > 3) d.moved = true; if (d.moved) desktop?.move(Math.round(event.screenX - d.dx), Math.round(event.screenY - d.dy)); }}
        onPointerUp={event => { const d = drag.current; drag.current = null; if (!d || d.id !== event.pointerId) return; if (d.moved) desktop?.settle(); else setPoke(value => value + 1); if (!event.currentTarget.matches(':hover')) setInteractive(false); }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => void desktop?.open(petTarget(status))}
        onKeyDown={event => { if (event.key === 'Enter') void desktop?.open(petTarget(status)); }}>
        <PetFigure state={status.pet} pack={pack} count={status.running} size={92} label={'Mandala · ' + line} />
      </button>
    </div>
  </div>;
}
