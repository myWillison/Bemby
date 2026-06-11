import { TelegramClient, Api, Logger } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';

export type CheckinAttemptLog = {
  attempt: number;
  commandSent: string;
  hasMedia: boolean;
  commandResponseHtml: string;
  commandResponseImage?: string; // base64 data URL for photo messages
  availableButtons: string[][];  // button rows matching Telegram keyboard layout
  buttonClicked?: string;
  callbackAnswer?: string;
  error?: string;
};

export class CheckinError extends Error {
  constructor(message: string, public readonly log: CheckinAttemptLog) {
    super(message);
    this.name = 'CheckinError';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function messageToHtml(text: string, entities?: Api.TypeMessageEntity[]): string {
  if (!entities?.length) return escapeHtml(text).replace(/\n/g, '<br>');

  type Ins = { pos: number; html: string; isClose: boolean };
  const ins: Ins[] = [];

  for (const e of entities) {
    const end = e.offset + e.length;
    if (e instanceof Api.MessageEntityBold) {
      ins.push({ pos: e.offset, html: '<strong>', isClose: false });
      ins.push({ pos: end, html: '</strong>', isClose: true });
    } else if (e instanceof Api.MessageEntityItalic) {
      ins.push({ pos: e.offset, html: '<em>', isClose: false });
      ins.push({ pos: end, html: '</em>', isClose: true });
    } else if (e instanceof Api.MessageEntityCode) {
      ins.push({ pos: e.offset, html: '<code>', isClose: false });
      ins.push({ pos: end, html: '</code>', isClose: true });
    } else if (e instanceof Api.MessageEntityPre) {
      ins.push({ pos: e.offset, html: '<pre>', isClose: false });
      ins.push({ pos: end, html: '</pre>', isClose: true });
    } else if (e instanceof Api.MessageEntityUnderline) {
      ins.push({ pos: e.offset, html: '<u>', isClose: false });
      ins.push({ pos: end, html: '</u>', isClose: true });
    } else if (e instanceof Api.MessageEntityStrike) {
      ins.push({ pos: e.offset, html: '<s>', isClose: false });
      ins.push({ pos: end, html: '</s>', isClose: true });
    } else if (e instanceof Api.MessageEntityUrl) {
      const url = escapeHtml(text.slice(e.offset, end));
      ins.push({ pos: e.offset, html: `<a href="${url}" target="_blank" rel="noopener">`, isClose: false });
      ins.push({ pos: end, html: '</a>', isClose: true });
    } else if (e instanceof Api.MessageEntityTextUrl) {
      const url = escapeHtml((e as Api.MessageEntityTextUrl).url ?? '');
      ins.push({ pos: e.offset, html: `<a href="${url}" target="_blank" rel="noopener">`, isClose: false });
      ins.push({ pos: end, html: '</a>', isClose: true });
    }
  }

  // Sort: by position; close tags before open tags at the same position (correct nesting)
  ins.sort((a, b) => a.pos - b.pos || (a.isClose ? -1 : 1) - (b.isClose ? -1 : 1));

  let result = '';
  let pos = 0;
  for (const { pos: iPos, html } of ins) {
    if (iPos > pos) result += escapeHtml(text.slice(pos, iPos));
    result += html;
    pos = iPos;
  }
  result += escapeHtml(text.slice(pos));
  return result.replace(/\n/g, '<br>');
}

function waitForBotReply(
  client: TelegramClient,
  botUsername: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Api.Message> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Job cancelled')); return; }

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for bot reply`));
    }, timeoutMs);

    const onAbort = () => { cleanup(); reject(new Error('Job cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      if (!event.message.buttons) return;
      cleanup();
      resolve(event.message as Api.Message);
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [botUsername] }));
  });
}

export async function runCheckin(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  replyTimeoutMs = 40_000,
  startCommand = '/start',
  checkinButton = '签到',
  attempt = 1,
  signal?: AbortSignal,
): Promise<CheckinAttemptLog> {
  const log: CheckinAttemptLog = { attempt, commandSent: startCommand, hasMedia: false, commandResponseHtml: '', availableButtons: [] as string[][] };

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
  });

  await client.connect();

  try {
    if (signal?.aborted) throw new Error('Job cancelled');
    const replyPromise = waitForBotReply(client, botUsername, replyTimeoutMs, signal);
    await client.sendMessage(botUsername, { message: startCommand });
    const msg = await replyPromise;

    log.hasMedia = msg.media != null;
    log.commandResponseHtml = messageToHtml(msg.message, msg.entities as Api.TypeMessageEntity[] | undefined);

    // Collect button rows preserving Telegram keyboard layout
    for (const row of (msg as any).buttons ?? []) {
      const rowTexts = (row as any[]).map((btn: any) => btn.text as string);
      if (rowTexts.length) log.availableButtons.push(rowTexts);
    }

    // Download photo thumbnail for display (non-critical)
    if (msg.media instanceof Api.MessageMediaPhoto && !signal?.aborted) {
      try {
        const photo = msg.media.photo;
        if (photo instanceof Api.Photo) {
          const mSize = photo.sizes.find(
            (s): s is Api.PhotoSize => s instanceof Api.PhotoSize && s.type === 'm'
          ) ?? photo.sizes[1] ?? photo.sizes[0];
          if (mSize) {
            const bytes = await client.downloadMedia(msg, { thumb: mSize }) as Buffer | undefined;
            if (bytes) log.commandResponseImage = `data:image/jpeg;base64,${bytes.toString('base64')}`;
          }
        }
      } catch { /* skip image on error */ }
    }

    if (signal?.aborted) throw new Error('Job cancelled');
    const peer = await client.getInputEntity(botUsername);
    let clicked = false;

    for (const row of (msg as any).buttons ?? []) {
      for (const btn of row) {
        if (btn.text.includes(checkinButton)) {
          const callbackData = (btn.button as Api.KeyboardButtonCallback).data;
          const answer = await client.invoke(new Api.messages.GetBotCallbackAnswer({
            peer,
            msgId: msg.id,
            data: callbackData,
          })) as Api.messages.BotCallbackAnswer;
          log.buttonClicked = btn.text;
          if (answer.message) log.callbackAnswer = answer.message;
          clicked = true;
          break;
        }
      }
      if (clicked) break;
    }

    if (!clicked) throw new Error(`Button "${checkinButton}" not found in bot reply`);

    return log;
  } catch (err: any) {
    log.error = err?.message ?? String(err);
    throw new CheckinError(log.error!, log);
  } finally {
    // GramJS throws TIMEOUT when the update loop stops on disconnect; always swallow here
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}
