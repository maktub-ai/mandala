export type TelegramBot = {id: number; username: string; name: string};
export type TelegramIdentity = {userId: number; chatId: number; name: string; username?: string};
export type TelegramStatus = {
  configured: boolean;
  state: 'unconfigured' | 'connecting' | 'connected' | 'disconnected' | 'conflict' | 'error';
  bot?: TelegramBot;
  binding?: TelegramIdentity;
  candidate?: TelegramIdentity;
  pairing?: {url: string; expiresAt: string};
  attention: boolean;
  lastConnectedAt?: string;
  error?: string;
  deliveries?: {id: string; state: 'failed' | 'uncertain'; summary: string}[];
};
