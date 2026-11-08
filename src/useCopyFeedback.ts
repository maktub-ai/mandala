import { useCallback, useEffect, useRef, useState } from 'react';

// Errors stay with the caller; only a successful copy receives a deadline.
export function useCopyFeedback() {
  const [feedback, setFeedback] = useState<{ value: string | number; sequence: number } | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clear = useCallback(() => { clearTimeout(timer.current); setFeedback(null); }, []);
  const mark = useCallback((value: string | number) => {
    clearTimeout(timer.current);
    setFeedback({ value, sequence: ++sequence.current });
    timer.current = setTimeout(() => setFeedback(null), 2500);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [feedback?.value ?? null, mark, clear, feedback?.sequence] as const;
}
