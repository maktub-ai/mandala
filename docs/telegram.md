# Mandala × Telegram

Telegram is an additional entrance to this computer's continuous Mandala main chat. It shares the existing history and work; it does not create a separate assistant. Ordinary Agent chats, independent Project entrances, groups, WhatsApp, voice transcription and video interpretation are outside this release.

## Connect your phone

1. In Telegram, open [BotFather](https://t.me/BotFather), send `/newbot`, and create a dedicated bot. Do not reuse a bot consumed by another application or computer.
2. On the computer, open **Mandala settings → Phone connection · Telegram** and enter its Bot Token. Mandala checks the identity and existing webhook without deleting another application's webhook.
3. Generate a pairing QR code/link. Open it on your phone and press **Start**. Pairing expires after ten minutes.
4. Check the candidate's name, username and numeric user ID on the computer, then confirm. Merely being the first person to message the bot never grants access.
5. Send a test message. Keep this computer running and able to reach Telegram.

The bot connects directly through outbound HTTPS long polling. No Mandala hosted service, public incoming port, or browser remote-access service is required. Configure access to Telegram on the computer as needed; the app does not install a VPN or change your network.

If Telegram reports a competing receiver, Mandala pauses polling and preserves that conflict across restarts. Stop the other receiver, then unlink and configure the dedicated bot again on this computer. Telegram does not provide a passive check for another long-poll receiver, so a dedicated bot is required even when token validation succeeds.

The token is a private local credential, separate from ordinary configuration. It is not returned in status responses or printed in logs. Messages and requested files pass through Telegram and are subject to its storage and privacy model; this channel does not use the separate browser connection's encrypted transport.

**Unlink** revokes this account and all old buttons and removes the local token. It does not delete messages already sent to Telegram. Rotate the token through BotFather if it has been exposed. Rebinding does not replay old history.

## Messages and results

- Telegram messages are recorded in the main chat with a Telegram source label. Only after a request is durably accepted locally does the bot acknowledge it.
- A busy main chat queues the input instead of interrupting work. Changing desktop pages does not change the phone's target conversation.
- Telegram requests receive their final replies there. Ordinary desktop messages and replies are not forwarded. You can ask about earlier desktop work because both entrances share context.
- Editing or deleting a Telegram message does not change a previously accepted request or undo its effects. Send a new correction instead.
- **Current progress**, **Needs my attention**, and **Help** are available in the bot menu. Routine tool logs and internal Agent exchanges stay on the computer.
- Long replies offer the complete result separately; a summary never substitutes for the original answer.

## Cards and decisions

Cards use text and Telegram buttons. They preserve the task name, actor, operation, scope and current status, rather than reproducing desktop layout.

Questions accept an option or a reply to their message. Multiple questions are collected and reviewed before submission. Secret/password inputs must be answered on the computer.

Codex asynchronous questions in the Mandala main chat remain answerable after the native turn finishes or the app restarts. Submitting on either device consumes the same form; a phone submission queues its continuation and returns the resulting reply to Telegram. Asynchronous questions inside delegated execution chats currently require the desktop; their Telegram cards do not offer a submit action. Native synchronous task questions retain their existing phone support.

On first upgrade, old plain-text question forms preceding the latest ordinary human request in each chat are not revived. This is a one-time compatibility cutoff, not proof those historical questions were answered. New forms retain independent pending state across subsequent messages.

Only current, fully presented single-operation approvals and concrete configuration proposals can be approved on the phone. Session-wide, permanent, whole-turn, directory/access grants and unsupported or oversized approvals direct you to the computer. A bare “agree” does not approve an unidentified item. Phone decisions reuse existing permission checks and cannot broaden the native runtime's grant.

An item already processed on the computer cannot execute again from an old phone button. Changed content, cancellation, authorization changes, and unlinking invalidate the old action.

## Pictures and files

Pictures and documents first form a draft. Add a description, then choose **Send to Mandala** or cancel. A submission accepts at most eight attachments, each up to 20 MiB, subject to Telegram's download limit. Download failure, unsupported media or an oversized file is reported without silently dropping the attachment. Successful submission exposes the same attachments in the desktop conversation; content understanding depends on the selected execution runtime.

Results list available output filenames and sizes. Only choosing **Send file** uploads a result file to Telegram. This channel caps outgoing files at 20 MiB as well; large pictures are sent as documents. Larger outputs stay on the computer. A local filesystem path is never presented as a phone-accessible download link.

## Notifications

| Event | Default |
| --- | --- |
| Reply to a phone request; final result of phone-origin work | Return to Telegram |
| Mandala or its explicitly owned tasks need input or approval | Notify when **Notify my phone when I need to act** is enabled (default on) |
| A failure needs user intervention | Same attention setting |
| A desktop-origin task completes | Only when **Notify my phone on completion** is enabled for that task |
| Normal progress, internal delegation replies, automatic retries | No unsolicited notification |
| An item already resolved on the computer | No stale attention alert |

Task completion preference is available on eligible task cards/details. Other Agents' unrelated tasks are not exposed through this channel. A final reply and task completion must not generate duplicate notifications for the same result. Desktop activity does not silently suppress notifications. Sound and lock-screen appearance remain Telegram/OS preferences.

## Offline and uncertain delivery

The bot cannot answer while the computer is offline. A Telegram sent marker is not proof that Mandala accepted or executed an instruction.

On startup/reconnect, newly recovered instructions not already accepted locally show their original time and content. Choose **Continue processing** or **Discard** for each. Previously accepted work is reconciled against its existing durable submission, never started again because an acknowledgement was lost. Approval clicks received across an outage do not execute later automatically; a current approval must be presented and confirmed again.

Telegram retains unreceived updates for at most 24 hours, so complete offline history cannot be guaranteed. On recovery, resolved alerts are suppressed and remaining attention is summarized. Results that were not delivered remain queryable.

Known rejected sends can be retried without running the task again. A send whose outcome is uncertain is labelled **Delivery unconfirmed**, not blindly resent. Verify in Telegram first.

Sources: [Bot FAQ / polling](https://core.telegram.org/bots/faq#how-do-i-get-updates), [update retention](https://core.telegram.org/bots/api#getting-updates), [file limits](https://core.telegram.org/bots/api#file).

## Acceptance checklist

Automated checks use isolated homes, synthetic identities, a fake Telegram transport and fake CLI execution. No personal token, conversation, file or runtime screenshot belongs in Git.

- Pairing: invalid token, webhook conflict, numeric account confirmation, expiry, unauthorized private user, groups, revoke/rebind.
- Routing: same Mandala history, source label, ordinary desktop silence, queued concurrent input, no repeated execution after duplicate update/restart.
- Decisions: choice/free text/multiple questions, secret-input exclusion, single approval, desktop-only grants, stale/changed/revoked callbacks, simultaneous desktop decision.
- Attachments: draft/description/send/cancel, count and size bounds, download errors, desktop visibility, explicit output download, missing/oversized output.
- Notifications: attention settings, task opt-in, phone task results, unrelated task exclusion, suppression of stale/duplicate alerts.
- Recovery: offline quarantine, confirm/discard, existing request reconciliation, stale click rejection, known failure vs uncertain delivery.
- UI: initial/error/paired/expired states, Chinese labels, keyboard access, light/dark and narrow screens.

**Real-phone release gate:** With a user-owned dedicated bot, verify computer-origin task → completion notification enabled → leave computer → answer a question and approve a single operation on phone → receive result/file → confirm identical history on desktop. Also test sleep/restart/reconnect and revocation. Automated or local-browser fixtures do not establish this external acceptance. No real-phone acceptance is asserted by this document.

The feature is opt-in. Existing installations have no Telegram connection until configured. Disable/unlink to stop the channel; conversations, tasks and outputs remain normal Mandala data. App installation and real-phone setup are separate from source delivery.
