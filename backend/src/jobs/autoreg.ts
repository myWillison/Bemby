import { TelegramClient, Api, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
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
// so a pre-armed prompt is refreshed before it can expire
const PRE_ARM_REFRESH_MS = 100_000;

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
function waitForVerdict(
  client: TelegramClient,
  botUsername: string,
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
    client.addEventHandler(handler, new NewMessage({ fromUsers: [botUsername] }));
  });
}

// Waits for a bot message carrying inline buttons.
function waitForButtons(
  client: TelegramClient,
  botUsername: string,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message | null> {
  return new Promise((resolve) => {
    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(msg);
    };
    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      if ((msg as any).replyMarkup instanceof Api.ReplyInlineMarkup) finish(msg);
    };
    client.addEventHandler(handler, new NewMessage({ fromUsers: [botUsername] }));
  });
}

function findButton(
  msg: Api.Message,
  match: string,
): Api.KeyboardButtonCallback | null {
  const markup = (msg as any).replyMarkup as Api.ReplyInlineMarkup | undefined;
  if (!markup) return null;
  const flat = markup.rows.flatMap((r) => r.buttons);
  const clickable = flat.filter(
    (b): b is Api.KeyboardButtonCallback => b instanceof Api.KeyboardButtonCallback,
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
  const preArm = config.preArm !== false;

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
      new NewMessage({ chats: [groupEntity] }),
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

      // Pre-arms the bot conversation: start command, then the register button,
      // leaving the bot waiting for a code so only the code send remains.
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
        const buttonsPromise = waitForButtons(
          client,
          botUsername,
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
          const buttonsMsg = await buttonsPromise;
          checkCancelled();
          if (!buttonsMsg)
            throw new Error(
              `No message with buttons received within ${replyTimeoutMs}ms`,
            );
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
          clickStep.result = `Clicked "${target.text}"`;
          armed = true;
          armedAt = Date.now();
        } finally {
          clickStep.durationMs = Date.now() - t0;
        }
      };

      if (preArm) await arm();

      // 4. Race: try each code as soon as it is available
      const deadline = listenStart + listenMs;
      const retriedCodes = new Set<string>();

      while (true) {
        checkCancelled();

        // Wait for a code, refreshing the pre-armed prompt before it expires
        let code: string | null = null;
        while (!code) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const slice =
            preArm && armed
              ? Math.min(
                  remaining,
                  Math.max(1_000, armedAt + PRE_ARM_REFRESH_MS - Date.now()),
                )
              : remaining;
          code = await queue.next(slice, signal);
          checkCancelled();
          if (!code && preArm && Date.now() < deadline) {
            // A failed refresh is not fatal while idle; arm again on demand
            await arm(true).catch(() => {
              armed = false;
            });
          }
        }
        if (!code) {
          listenStep.durationMs = Date.now() - listenStart;
          throw new Error(
            codesSeen === 0
              ? `No registration codes appeared within ${Math.round(listenMs / 60_000)} minute(s)`
              : "All captured registration codes were used or rejected",
          );
        }

        if (!armed) await arm();

        const codeStep = beginStep("send_command", `Send code: "${code}"`);
        const t0 = Date.now();
        const verdictPromise = waitForVerdict(
          client,
          botUsername,
          replyTimeoutMs,
          config.successContains,
          config.failContains,
          signal,
        );
        await client.sendMessage(botUsername, { message: code });
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
