import { useEffect, useRef, useState } from 'react';
import type { CodexWriterRecovery as Recovery, CodexWriterRecoveryAction } from '../shared/codex-writer-recovery';
import { api } from './api';
import Dialog from './Dialog';
import { useLanguage } from './i18n';
import Button from './ui/Button';
import Disclosure from './ui/Disclosure';
import './codex-writer-recovery.css';

export default function CodexWriterRecovery({ id, eventId, showNotice, disabled, onBusy, flushDraft }: {
  id: string;
  eventId: number | undefined;
  showNotice: boolean;
  disabled: boolean;
  onBusy: (id: string) => void;
  flushDraft: () => Promise<void>;
}) {
  const { text: localize } = useLanguage();
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const readGeneration = useRef(0);
  const cancel = useRef<HTMLButtonElement>(null);
  const route = '/conversations/' + id + '/codex-writer-recovery';

  useEffect(() => {
    const generation = ++readGeneration.current;
    const controller = new AbortController();
    void api<{ recovery: Recovery | null }>(route, 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted && readGeneration.current === generation) setRecovery(value.recovery);
    }).catch(() => {});
    return () => controller.abort();
  }, [route, eventId]);

  async function recover(action: CodexWriterRecoveryAction) {
    if (!recovery || disabled || submitting.current) return;
    submitting.current = true;
    readGeneration.current++;
    setWorking(true);
    onBusy(id);
    setError('');
    try {
      if (action === 'isolate') await flushDraft();
      const value = await api<{ recovery: Recovery }>(route, 'POST', { conflictId: recovery.conflictId, action });
      setRecovery(value.recovery);
      setConfirming(false);
    } catch (error) {
      setError((error as Error).message);
      // A lost HTTP reply is reconciled by reading the durable operation before retrying.
      try {
        const value = await api<{ recovery: Recovery | null }>(route);
        setRecovery(value.recovery);
        if (value.recovery?.operationId) setConfirming(false);
      } catch { /* Keep the original conflict and the error visible. */ }
    } finally {
      onBusy('');
      setWorking(false);
      submitting.current = false;
    }
  }

  if (!recovery || !showNotice && recovery.state !== 'linked') return null;
  const stateText = {
    held: localize('另一个 Codex 客户端占用原生会话。可以等它正常释放后重试。', 'Another Codex client is holding the native session. You can retry after it releases the session.'),
    released: localize('已确认原 Codex 会话释放。草稿准备好后，可在这里手动发送。', 'The original Codex session is available again. Send your draft here when you are ready.'),
    creating: localize('正在核对新的 Codex 会话关联。', 'Checking the new Codex session link.'),
    unknown: localize('新会话关联结果待核对。原会话仍保留，确认记录不会重复创建会话。', 'The new session link is unconfirmed. The original session is preserved, and the recorded confirmation cannot create another session.'),
    linked: localize('已关联新的隔离 Codex 会话。可在这里检查草稿、附件和引用，再手动发送。', 'A fresh isolated Codex session is linked. Review your draft, attachments and references, then send here when ready.'),
  };
  const title = localize('在此对话关联新的 Codex 会话', 'Link a new Codex session here');
  const canRetry = ['held', 'unknown', 'released'].includes(recovery.state);
  return <section className="codex-writer-recovery" aria-label={localize('Codex 会话恢复', 'Codex session recovery')}>
    {showNotice && <p role="status">{stateText[recovery.state]}</p>}
    {showNotice && (canRetry || recovery.state === 'creating') && <div className="codex-writer-actions">
      {canRetry && <Button size="sm" disabled={disabled || working} onClick={() => void recover('retry-original')}>
        {localize('重试原会话', 'Retry original session')}
      </Button>}
      {recovery.state === 'held' && <Button size="sm" disabled={disabled || working} onClick={() => { setError(''); setConfirming(true); }}>{title}</Button>}
      {(recovery.state === 'unknown' || recovery.state === 'creating') && <Button size="sm" disabled={disabled || working} onClick={() => void (recovery.state === 'creating'
        ? api<{ recovery: Recovery | null }>(route).then(value => setRecovery(value.recovery)).catch(error => setError(error.message))
        : recover('check'))}>{localize('核对关联结果', 'Check link result')}</Button>}
    </div>}
    {recovery.operationId && <Disclosure className="codex-writer-record" title={localize('原生会话关联记录', 'Native session link record')}>
      <p>{localize('原会话', 'Original session')} <code>{recovery.previousNativeId}</code></p>
      {recovery.nativeId && <p>{localize('新会话', 'New session')} <code>{recovery.nativeId}</code></p>}
      <p>{localize('确认记录', 'Confirmation record')} <code>{recovery.operationId}</code></p>
    </Disclosure>}
    {showNotice && error && !confirming && <p role="alert">{error}</p>}
    {confirming && <Dialog label={title} className="codex-writer-dialog" initialFocus={cancel} locked={working} onClose={() => setConfirming(false)}>
      <h2>{title}</h2>
      <p>{localize('先检查原会话。如果它已释放，就继续使用原生会话。仍被占用时，将在这里关联一个空的 Codex 会话。', 'Mandala will check the original session first and keep using it if available. If it is still held, an empty Codex session will be linked here.')}</p>
      <p>{localize('历史、草稿、附件和引用保留在这个对话。关联时不会发送内容。下一条消息由你手动发送，你可以先检查或删除草稿中的附件和引用。', 'The history, draft, attachments and references stay in this chat. Linking sends no content. Review or remove draft attachments and references before you send the next message yourself.')}</p>
      <p>{localize('新的执行按当前工作区、Agent 和 Codex 设置授权。原生会话内批准和本对话的工具授权需要重新确认。', 'New execution uses the current workspace, Agent and Codex permissions. Native session approvals and tool approvals granted to this chat require fresh confirmation.')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="codex-writer-actions">
        <Button ref={cancel} disabled={working} onClick={() => setConfirming(false)}>{localize('取消', 'Cancel')}</Button>
        <Button variant="primary" busy={working} disabled={disabled} onClick={() => void recover('isolate')}>{localize('确认关联新会话', 'Confirm new session link')}</Button>
      </div>
    </Dialog>}
  </section>;
}
