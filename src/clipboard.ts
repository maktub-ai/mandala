export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* HTTP origins and embedded browsers may deny the modern API. */ }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({length:selection.rangeCount}, (_, i)=>selection.getRangeAt(i).cloneRange()) : [];
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:16px;';
  // Keep the fallback inside a modal's focus boundary when one is open.
  (active?.closest('[role="dialog"],dialog') ?? document.body).appendChild(field);
  try {
    field.focus({preventScroll:true});
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard copy failed');
  } finally {
    field.remove();
    active?.focus({preventScroll:true});
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
