import { TelegramClient, Api, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { EditedMessage } from "telegram/events/EditedMessage";
import type { TgProxy, AutoregConfig, CustomStepLog } from "../types";
import type { TgDeviceParams } from "../auth/tgAuth";
import { expandCommand, parseMessages } from "./checkin";

// Reuses the custom-job step log shape so LogsView renders the same timeline.
export type AutoregJobLog = {
  steps: CustomStepLog[];
};

export class AutoregJobError extends Error {
  constructor(
    message: string,
    public readonly log: AutoregJobLog,
  ) {
    super(message);
    this.name = "AutoregJobError";
  }
}

const DEFAULT_LISTEN_MINUTES = 30;
// Bots drop the code-entry state after a short window (often only a minute or two),
// so a previously armed prompt is refreshed before sending another code
const ARM_STALE_MS = 100_000;

// Characters a registration code may contain after the prefix
const CODE_CHAR = /[A-Za-z0-9_*\-]/;
// Block/mask characters used when a bot announces a used code (e.g. ABC-30-Register_85D▓▓▓)
const MASK_CHAR = /[▀-▟■-◿]/;

export type ExtractedCodes = {
  /** Complete, usable codes (prefix included) */
  codes: string[];
  /** Partial codes from used-code announcements; queued codes starting with one of these are burned */
  usedPartials: string[];
};

/** Builds a matcher for the code prefix; `*` matches any non-whitespace run,
 *  e.g. ABC-*-Register_ matches ABC-30-Register_ and ABC-7-Register_ */
function prefixToRegex(prefix: string): RegExp {
  const pattern = prefix
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^\\s]*?");
  return new RegExp(pattern, "g");
}

/** Pulls registration codes out of a message. A mask character straight after the
 *  code run marks a used-code announcement rather than a fresh code. */
export function extractCodes(text: string, prefix: string): ExtractedCodes {
  const codes: string[] = [];
  const usedPartials: string[] = [];
  const wanted = prefix?.trim();
  if (!wanted) return { codes, usedPartials };
  const re = prefixToRegex(wanted);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    let end = start + m[0].length;
    while (end < text.length && CODE_CHAR.test(text[end])) end++;
    const token = text.slice(start, end);
    if (end < text.length && MASK_CHAR.test(text[end])) {
      usedPartials.push(token);
    } else if (token.length > m[0].length) {
      codes.push(token);
    }
    // Skip past the whole code run and never stall on a zero-length match
    re.lastIndex = Math.max(end, re.lastIndex, start + 1);
  }
  return { codes, usedPartials };
}

/** Text to scan for codes: visible message text plus any URLs hidden in
 *  text-link entities or URL buttons (codes often arrive as ?start= deep links) */
function messageSearchText(msg: Api.Message): string {
  const parts = [msg.message ?? ""];
  for (const e of (msg.entities ?? []) as Array<{ url?: string }>) {
    if (e?.url) parts.push(e.url);
  }
  const markup = (msg as any).replyMarkup as Api.ReplyInlineMarkup | undefined;
  if (markup?.rows) {
    for (const row of markup.rows) {
      for (const b of row.buttons) {
        const url = (b as { url?: string }).url;
        if (url) parts.push(url);
      }
    }
  }
  return parts.join("\n");
}

// FIFO of codes with a single async consumer. Live listener pushes, the register
// loop pulls; used-code announcements prune both queued and future codes.
class CodeQueue {
  private queue: string[] = [];
  private seen = new Set<string>();
  private burnedPartials: string[] = [];
  private waiter: ((code: string | null) => void) | null = null;

  add(code: string): boolean {
    if (this.seen.has(code)) return false;
    this.seen.add(code);
    if (this.burnedPartials.some((p) => code.startsWith(p))) return false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(code);
    } else {
      this.queue.push(code);
    }
    return true;
  }

  /** Puts a code back at the front (e.g. bot never replied and we re-arm) */
  requeueFront(code: string): void {
    this.queue.unshift(code);
  }

  markUsed(partial: string): number {
    this.burnedPartials.push(partial);
    const before = this.queue.length;
    this.queue = this.queue.filter((c) => !c.startsWith(partial));
    return before - this.queue.length;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Next code, waiting up to maxMs for one to arrive. Resolves null on timeout/abort. */
  next(maxMs: number, signal?: AbortSignal): Promise<string | null> {
    if (this.queue.length > 0)
      return Promise.resolve(this.queue.shift() ?? null);
    return new Promise((resolve) => {
      if (signal?.aborted || maxMs <= 0) {
        resolve(null);
        return;
      }
      const finish = (code: string | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiter = null;
        resolve(code);
      };
      const timer = setTimeout(() => finish(null), maxMs);
      const onAbort = () => finish(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = finish;
    });
  }
}

type ReplyVerdict = {
  verdict: "success" | "fail" | "timeout";
  messages: Api.Message[];
};

// Collects bot messages until success/fail text is matched or the timeout fires.
// With no successContains, the first non-fail message counts as success.
// Listens for both new messages and edits: some bots respond by editing
// their previous message rather than replying.
function waitForVerdict(
  client: TelegramClient,
  botUsername: string,
  botPeerId: string,
  maxMs: number,
  successContains?: string,
  failContains?: string,
  signal?: AbortSignal,
): Promise<ReplyVerdict> {
  return new Promise((resolve) => {
    const collected: Api.Message[] = [];
    const finish = (verdict: ReplyVerdict["verdict"]) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(handler, new EditedMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve({ verdict, messages: collected });
    };
    const timer = setTimeout(
      () => finish(collected.length ? "fail" : "timeout"),
      maxMs,
    );
    const onAbort = () => finish("timeout");
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      const text = msg.message ?? "";
      if (failContains && text.includes(failContains)) {
        finish("fail");
        return;
      }
      if (successContains) {
        if (text.includes(successContains)) finish("success");
        return;
      }
      finish("success");
    };
    // Scoped to the direct chat so group posts by the same bot are ignored.
    // Pre-resolved numeric IDs only: gramjs stringifies chats/fromUsers and
    // resolves them during update dispatch, where a failed lookup crashes.
    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    client.addEventHandler(
      handler,
      new EditedMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
  });
}

function hasInlineButtons(msg: Api.Message): boolean {
  return (msg as any).replyMarkup instanceof Api.ReplyInlineMarkup;
}

// Fallback poll cadence while waiting for the button prompt
const BUTTON_POLL_MS = 3_000;

export type ButtonWaitResult = {
  message: Api.Message;
  /** How the prompt arrived: a fresh reply, an edit of an existing message,
   *  or an unchanged existing message (bot ignored the repeated /start) */
  via: "reply" | "edit" | "existing";
};

/** Arms a wait for the bot to present inline buttons. Handles bots that reply
 *  with a new message AND bots that edit an existing one. Must be called
 *  BEFORE sending the trigger command so the chat baseline predates the reply.
 *  A polling fallback covers missed updates, and on timeout an unchanged
 *  existing prompt is accepted as a last resort. */
async function beginButtonWait(
  client: TelegramClient,
  botUsername: string,
  botPeerId: string,
  maxMs: number,
  signal?: AbortSignal,
): Promise<{ result: Promise<ButtonWaitResult | null> }> {
  // Snapshot recent messages so edits and new arrivals can be told apart
  // from what was already in the chat
  const baseline = new Map<number, number>();
  try {
    const recent = (await client.getMessages(botUsername, {
      limit: 10,
    })) as Api.Message[];
    for (const m of recent) baseline.set(m.id, m.editDate ?? 0);
  } catch {
    /* chat may not exist yet; everything counts as new */
  }

  const result = new Promise<ButtonWaitResult | null>((resolve) => {
    let done = false;
    let poll: NodeJS.Timeout | null = null;
    const finish = (found: ButtonWaitResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      client.removeEventHandler(onNew, new NewMessage({}));
      client.removeEventHandler(onEdit, new EditedMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(found);
    };
    const onTimeout = async () => {
      // Last resort: the bot may have ignored a repeated /start because its
      // prompt (with buttons) is already the latest state of the chat
      try {
        const recent = (await client.getMessages(botUsername, {
          limit: 5,
        })) as Api.Message[];
        const existing = recent.find(hasInlineButtons);
        if (existing) {
          finish({ message: existing, via: "existing" });
          return;
        }
      } catch {
        /* fall through to null */
      }
      finish(null);
    };
    const timer = setTimeout(onTimeout, maxMs);
    const onAbort = () => finish(null);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const onNew = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      if (hasInlineButtons(msg)) finish({ message: msg, via: "reply" });
    };
    const onEdit = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      if (hasInlineButtons(msg)) finish({ message: msg, via: "edit" });
    };
    // Scoped to the direct chat (pre-resolved ID; see waitForVerdict note)
    client.addEventHandler(
      onNew,
      new NewMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    client.addEventHandler(
      onEdit,
      new EditedMessage({ fromUsers: [botPeerId], chats: [botPeerId] }),
    );
    // Poll as a safety net in case an update never reaches the event loop
    let polling = false;
    poll = setInterval(async () => {
      if (polling || done) return;
      polling = true;
      try {
        const recent = (await client.getMessages(botUsername, {
          limit: 5,
        })) as Api.Message[];
        for (const m of recent) {
          if (!hasInlineButtons(m)) continue;
          const seenEdit = baseline.get(m.id);
          if (seenEdit === undefined) {
            finish({ message: m, via: "reply" });
            return;
          }
          if ((m.editDate ?? 0) > seenEdit) {
            finish({ message: m, via: "edit" });
            return;
          }
        }
      } catch {
        /* transient; next tick retries */
      } finally {
        polling = false;
      }
    }, BUTTON_POLL_MS);
  });
  return { result };
}

function findButton(
  msg: Api.Message,
  match: string,
): Api.KeyboardButtonCallback | null {
  const markup = (msg as any).replyMarkup as Api.ReplyInlineMarkup | undefined;
  if (!markup) return null;
  const flat = markup.rows.flatMap((r) => r.buttons);
  const clickable = flat.filter(
    (b): b is Api.KeyboardButtonCallback =>
      b instanceof Api.KeyboardButtonCallback,
  );
  const wanted = match.trim();
  if (wanted) {
    return clickable.find((b) => (b.text ?? "").includes(wanted)) ?? null;
  }
  // No text configured: the sole button, otherwise the first clickable one
  return clickable[0] ?? null;
}

export async function runAutoreg(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  startCommand: string,
  config: AutoregConfig,
  signal?: AbortSignal,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
  replyTimeoutMs = 40_000,
): Promise<AutoregJobLog> {
  const log: AutoregJobLog = { steps: [] };
  let stepNum = 0;

  const beginStep = (actionType: string, label: string): CustomStepLog => {
    const step: CustomStepLog = { step: ++stepNum, actionType, label };
    log.steps.push(step);
    return step;
  };

  const groupId = config.groupId?.trim();
  const codePrefix = config.codePrefix?.trim();
  const signupUsername = config.signupUsername?.trim();
  if (!groupId) throw new AutoregJobError("Group is required", log);
  if (!codePrefix) throw new AutoregJobError("Code prefix is required", log);
  if (!signupUsername)
    throw new AutoregJobError("Signup username is required", log);

  const listenMs =
    Math.max(1, config.listenMinutes ?? DEFAULT_LISTEN_MINUTES) * 60_000;
  const entryMode = config.entryMode === "command" ? "command" : "button";

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      autoReconnect: false,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );

  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("Job cancelled");
  };

  try {
    await client.connect();
    checkCancelled();

    // 1. Resolve the group and make sure we are a member
    {
      const step = beginStep("join_group", `Join group: ${groupId}`);
      const t0 = Date.now();
      try {
        const inviteMatch = groupId.match(
          /(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/,
        );
        if (inviteMatch) {
          try {
            await client.invoke(
              new Api.messages.ImportChatInvite({ hash: inviteMatch[1] }),
            );
            step.result = "Joined via invite link";
          } catch (err: any) {
            if (err?.message?.includes("ALREADY_PARTICIPANT")) {
              step.result = "Already a member";
            } else {
              throw err;
            }
          }
        } else {
          const entity = await client.getEntity(groupId.replace(/^@/, ""));
          try {
            await client.invoke(
              new Api.channels.JoinChannel({ channel: entity as any }),
            );
            step.result = "Joined";
          } catch (err: any) {
            if (err?.message?.includes("ALREADY_PARTICIPANT")) {
              step.result = "Already a member";
            } else {
              throw err;
            }
          }
        }
      } finally {
        step.durationMs = Date.now() - t0;
      }
    }

    const groupEntity = await client.getEntity(
      groupId.match(/t\.me/) ? groupId : groupId.replace(/^@/, ""),
    );
    // Event filters need pre-resolved numeric IDs: gramjs stringifies whatever
    // is passed (an entity object becomes "[object Object]") and resolves it
    // during update dispatch, where a failed lookup crashes the update loop
    const groupPeerId = String(await client.getPeerId(groupEntity));
    const botPeerId = String(await client.getPeerId(botUsername));

    // 2. Start listening for codes immediately, before anything slower
    const queue = new CodeQueue();
    const listenStep = beginStep(
      "wait_reply",
      `Listen for codes with prefix "${codePrefix}"`,
    );
    const listenStart = Date.now();
    let codesSeen = 0;
    const onGroupMessage = async (event: NewMessageEvent) => {
      const text = messageSearchText(event.message as Api.Message);
      const { codes, usedPartials } = extractCodes(text, codePrefix);
      for (const p of usedPartials) queue.markUsed(p);
      for (const c of codes) if (queue.add(c)) codesSeen++;
      listenStep.result = `${codesSeen} code(s) seen`;
    };
    client.addEventHandler(
      onGroupMessage,
      new NewMessage({ chats: [groupPeerId] }),
    );

    try {
      // 3. Optionally seed the queue from recent group history (oldest first so
      // later used-code announcements prune correctly)
      const scanCount = config.scanHistoryCount ?? 0;
      if (scanCount > 0) {
        const recent = (await client.getMessages(groupEntity, {
          limit: scanCount,
        })) as Api.Message[];
        for (const m of [...recent].reverse()) {
          const { codes, usedPartials } = extractCodes(
            messageSearchText(m),
            codePrefix,
          );
          for (const c of codes) if (queue.add(c)) codesSeen++;
          for (const p of usedPartials) queue.markUsed(p);
        }
        listenStep.result = `${codesSeen} code(s) seen`;
      }

      // Arms the bot conversation for button mode: start command, then the
      // register button, leaving the bot waiting for a code.
      let armed = false;
      let armedAt = 0;
      const arm = async (refresh = false) => {
        checkCancelled();
        armed = false;
        const sendStep = beginStep(
          "send_command",
          `${refresh ? "Refresh prompt, send" : "Send"}: "${startCommand}"`,
        );
        let t0 = Date.now();
        // Armed before /start so the baseline predates the bot's reply/edit
        const buttonWait = await beginButtonWait(
          client,
          botUsername,
          botPeerId,
          replyTimeoutMs,
          signal,
        );
        await client.sendMessage(botUsername, { message: startCommand });
        sendStep.result = "Sent";
        sendStep.durationMs = Date.now() - t0;

        const clickStep = beginStep(
          "click_button",
          `Click register button${config.registerButton ? ` "${config.registerButton}"` : ""}`,
        );
        t0 = Date.now();
        try {
          const found = await buttonWait.result;
          checkCancelled();
          if (!found)
            throw new Error(
              `No new, edited, or existing message with buttons found within ${replyTimeoutMs}ms`,
            );
          const buttonsMsg = found.message;
          const parsed = await parseMessages([buttonsMsg], client, signal);
          if (parsed.html) clickStep.preClickHtml = parsed.html;
          if (parsed.buttons.length) clickStep.preClickButtons = parsed.buttons;
          const target = findButton(buttonsMsg, config.registerButton ?? "");
          if (!target)
            throw new Error(
              `Register button ${config.registerButton ? `"${config.registerButton}" ` : ""}not found`,
            );
          const peer = await client.getInputEntity(botUsername);
          try {
            const answer = (await client.invoke(
              new Api.messages.GetBotCallbackAnswer({
                peer,
                msgId: buttonsMsg.id,
                data: target.data,
              }),
            )) as Api.messages.BotCallbackAnswer;
            if (answer.message) clickStep.callbackAnswer = answer.message;
          } catch (err: any) {
            // Click was delivered even if the bot never answered the callback
            if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) throw err;
          }
          clickStep.clickedButton = target.text;
          const viaNote =
            found.via === "edit"
              ? " (bot edited its message)"
              : found.via === "existing"
                ? " (existing prompt)"
                : "";
          clickStep.result = `Clicked "${target.text}"${viaNote}`;
          armed = true;
          armedAt = Date.now();
        } finally {
          clickStep.durationMs = Date.now() - t0;
        }
      };

      // 4. Race: try each code as soon as it is available
      const deadline = listenStart + listenMs;
      const retriedCodes = new Set<string>();

      while (true) {
        checkCancelled();

        const remaining = deadline - Date.now();
        const code = remaining > 0 ? await queue.next(remaining, signal) : null;
        checkCancelled();
        if (!code) {
          listenStep.durationMs = Date.now() - listenStart;
          throw new Error(
            codesSeen === 0
              ? `No registration codes appeared within ${Math.round(listenMs / 60_000)} minute(s)`
              : "All captured registration codes were used or rejected",
          );
        }

        // Button mode arms the prompt only once a code is in hand; a prompt
        // left over from a previous attempt is refreshed once stale
        if (
          entryMode === "button" &&
          (!armed || Date.now() - armedAt > ARM_STALE_MS)
        ) {
          await arm(armed);
        }

        // Command mode skips the button entirely: the code rides along with
        // the start command, e.g. /start ABC-30-Register_XYZ
        const payload =
          entryMode === "command" ? `${startCommand} ${code}` : code;
        const codeStep = beginStep("send_command", `Send code: "${payload}"`);
        const t0 = Date.now();
        const verdictPromise = waitForVerdict(
          client,
          botUsername,
          botPeerId,
          replyTimeoutMs,
          config.successContains,
          config.failContains,
          signal,
        );
        await client.sendMessage(botUsername, { message: payload });
        const { verdict, messages } = await verdictPromise;
        codeStep.durationMs = Date.now() - t0;
        if (messages.length) {
          const parsed = await parseMessages(messages, client, signal);
          codeStep.responseHtml = parsed.html || undefined;
          codeStep.responseImage = parsed.images[0];
        }

        if (verdict === "timeout") {
          // Bot went quiet: re-arm and give this code one more go
          codeStep.error = `No reply within ${replyTimeoutMs}ms`;
          armed = false;
          if (!retriedCodes.has(code)) {
            retriedCodes.add(code);
            queue.requeueFront(code);
          }
          continue;
        }
        if (verdict === "fail") {
          codeStep.error = "Code rejected (likely already used)";
          // The bot re-prompts after a bad code, so stay armed and fire the next one
          armedAt = Date.now();
          continue;
        }
        codeStep.result = "Code accepted";

        // 5. Finish signup with the username
        const username = expandCommand(signupUsername);
        const userStep = beginStep(
          "send_command",
          `Send username: "${username}"`,
        );
        const u0 = Date.now();
        const finalPromise = waitForVerdict(
          client,
          botUsername,
          botPeerId,
          replyTimeoutMs,
          undefined,
          config.failContains,
          signal,
        );
        await client.sendMessage(botUsername, { message: username });
        const final = await finalPromise;
        userStep.durationMs = Date.now() - u0;
        if (final.messages.length) {
          const parsed = await parseMessages(final.messages, client, signal);
          userStep.responseHtml = parsed.html || undefined;
          userStep.responseImage = parsed.images[0];
        }
        if (final.verdict === "fail") {
          userStep.error = "Signup rejected after username";
          armed = false;
          continue;
        }
        userStep.result =
          final.verdict === "timeout"
            ? "Username sent (no confirmation received)"
            : "Registration completed";
        listenStep.durationMs = Date.now() - listenStart;
        return log;
      }
    } finally {
      client.removeEventHandler(onGroupMessage, new NewMessage({}));
    }
  } catch (err: any) {
    if (err?.message === "Job cancelled") throw err;
    if (err instanceof AutoregJobError) throw err;
    throw new AutoregJobError(err?.message ?? String(err), log);
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}
