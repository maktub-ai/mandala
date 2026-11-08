import { MAX_ATTACHMENT_SIZE } from './attachments';

export type TelegramUser = {id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string};
export type TelegramChat = {id: number; type: string};
export type TelegramMedia = {file_id: string; file_size?: number; file_name?: string; mime_type?: string};
export type TelegramMessage = {
  message_id: number; from?: TelegramUser; chat: TelegramChat; date: number;
  text?: string; caption?: string; reply_to_message?: {message_id: number};
  photo?: TelegramMedia[]; document?: TelegramMedia; video?: unknown; voice?: unknown;
  video_note?: unknown; audio?: unknown; animation?: unknown; sticker?: unknown;
};
export type TelegramCallback = {id: string; from: TelegramUser; data?: string; message?: TelegramMessage};
export type TelegramUpdate = {update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback};
export type TelegramDocument = {name: string; bytes: Uint8Array; photo?: boolean};
export const telegramToken = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}:[A-Za-z0-9_-]{20,128}$/.test(value);
export const telegramId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export class TelegramApiError extends Error {
  constructor(readonly code: number, readonly retryAfter?: number) {
    super('Telegram Bot API request failed');
  }
}

// Telegram's error descriptions and network exceptions may contain the token URL. Never propagate them.
export function telegramApi(token: string, fetcher: typeof fetch, active: AbortSignal) {
  const root = 'https://api.telegram.org';
  const call = async <T>(method: string, body: Record<string, unknown> | FormData = {}, timeout = 15_000): Promise<T> => {
    const multipart = body instanceof FormData;
    let response: Response;
    try {
      response = await fetcher(root + '/bot' + token + '/' + method, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([active, AbortSignal.timeout(timeout)]),
        ...(multipart ? {body} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
      });
    } catch { throw new TelegramApiError(0); }
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok === true && Object.hasOwn(payload,'result')) return payload.result as T;
    const status = payload?.ok === false && Number.isInteger(payload.error_code) ? payload.error_code : response.status;
    const retryAfter=payload?.parameters?.retry_after;
    throw new TelegramApiError(status >= 400 && status < 500 ? status : 0,
      Number.isFinite(retryAfter)&&retryAfter>0 ? retryAfter * 1000 : undefined);
  };
  return {
    call,
    async download(media: TelegramMedia): Promise<Buffer> {
      if (!media.file_id || (media.file_size ?? 0) > MAX_ATTACHMENT_SIZE) throw new TelegramApiError(413);
      const file = await call<{file_path?: string; file_size?: number}>('getFile', {file_id:media.file_id});
      if ((file?.file_size ?? 0)>MAX_ATTACHMENT_SIZE) throw new TelegramApiError(413);
      const path = file?.file_path?.split('/');
      if (!path?.length || path.some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..')) throw new TelegramApiError(422);
      const signal = AbortSignal.any([active, AbortSignal.timeout(45_000)]);
      try {
        const response = await fetcher(root + '/file/bot' + token + '/' + path.join('/'), {signal,redirect:'error'});
        if (!response.ok || !response.body) throw new TelegramApiError(422);
        if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_SIZE) {
          await response.body.cancel();
          throw new TelegramApiError(413);
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const {value,done}=await reader.read();
            if (done) break;
            size+=value.length;
            if (size>MAX_ATTACHMENT_SIZE) throw new TelegramApiError(413);
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel().catch(()=>{});
          throw error;
        } finally { reader.releaseLock(); }
        if (!size) throw new TelegramApiError(422);
        return Buffer.concat(chunks,size);
      } catch (error) { throw error instanceof TelegramApiError ? error : new TelegramApiError(0); }
    },
    sendDocument(chatId: number, file: TelegramDocument) {
      if (file.bytes.length > MAX_ATTACHMENT_SIZE) throw new TelegramApiError(413);
      const photo = file.photo && file.bytes.length <= 10 * 1024 * 1024;
      const form = new FormData();
      form.set('chat_id',String(chatId));
      form.set(photo?'photo':'document',new Blob([new Uint8Array(file.bytes)]),file.name);
      return call<TelegramMessage>(photo?'sendPhoto':'sendDocument',form,60_000);
    },
  };
}
