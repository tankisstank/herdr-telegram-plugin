import { Bot } from "grammy";
import type { TopicInfo } from "./types.js";
import type { MessageAuditLog } from "./message-audit-log.js";

export type PollingState = "starting" | "running" | "retrying" | "failed" | "stopped";

export interface PollingStatus {
  state: PollingState;
  attempt: number;
  nextRetryAt?: number;
  error?: string;
}

type PollingObserver = (status: PollingStatus) => void;

const RETRYABLE_HTTP_CODES = new Set([409, 429, 500, 502, 503, 504]);
const MESSAGE_MUTATIONS = new Set([
  "sendMessage",
  "editMessageText",
  "editMessageCaption",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAudio",
  "sendVoice",
  "sendAnimation",
]);

function isMessageMutation(method: PropertyKey): boolean {
  return MESSAGE_MUTATIONS.has(String(method));
}

function errorCode(err: unknown): number | undefined {
  const e = err as { error_code?: unknown; error?: { error_code?: unknown } };
  const value = e?.error_code ?? e?.error?.error_code;
  return typeof value === "number" ? value : undefined;
}

function retryAfterMs(err: unknown, attempt: number): number {
  const e = err as { parameters?: { retry_after?: unknown }; error?: { parameters?: { retry_after?: unknown } } };
  const retryAfter = e?.parameters?.retry_after ?? e?.error?.parameters?.retry_after;
  if (typeof retryAfter === "number" && retryAfter > 0) return retryAfter * 1000;
  // Telegram can retain a previous getUpdates connection for about 30 seconds.
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  const minimum = errorCode(err) === 409 ? 30_000 : base;
  return minimum + Math.floor(Math.random() * Math.min(1_000, minimum / 10));
}

function isPermanent(err: unknown): boolean {
  return errorCode(err) === 401;
}

function isRetryable(err: unknown): boolean {
  const code = errorCode(err);
  // Network failures frequently have no HTTP response/code at all.
  return code === undefined || RETRYABLE_HTTP_CODES.has(code);
}

function describePollingError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

export class TelegramClient {
  public bot: Bot;
  private pollingTask?: Promise<void>;
  private readonly sendQueues = new Map<string, Promise<void>>();
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryWake?: () => void;
  private status: PollingStatus = { state: "stopped", attempt: 0 };

  constructor(
    token: string,
    private readonly observe?: PollingObserver,
    bot?: Bot,
    /** Custom fetch implementation. Test rigs pass a mocked fetch to keep
     *  grammy from hitting the real Telegram network. */
    customFetch?: typeof fetch,
    messageAudit?: MessageAuditLog,
  ) {
    this.bot = bot ?? (customFetch
      ? new Bot(token, { client: { fetch: customFetch as never } })
      : new Bot(token));
    if (messageAudit && this.bot.api?.config?.use) {
      this.bot.api.config.use(async (prev, method, payload, signal) => {
        if (!isMessageMutation(method)) return prev(method, payload, signal);
        const sequence = messageAudit.begin(method, payload as Record<string, unknown>);
        try {
          const result = await prev(method, payload, signal);
          if (result.ok) messageAudit.sent(sequence, method, result.result);
          else messageAudit.failed(sequence, method, new Error(`${result.error_code}: ${result.description}`));
          return result;
        } catch (error) {
          messageAudit.failed(sequence, method, error);
          throw error;
        }
      });
    }
  }

  getPollingStatus(): PollingStatus {
    return { ...this.status };
  }

  private setStatus(status: PollingStatus): void {
    this.status = status;
    this.observe?.(this.getPollingStatus());
  }

  /** Initialise credentials, then keep one long-poll loop alive in the background. */
  async start(): Promise<void> {
    if (this.pollingTask) return;
    this.stopped = false;
    this.setStatus({ state: "starting", attempt: 0 });
    // This makes invalid bot tokens fail during daemon startup, before a PID is published.
    await this.bot.init();
    this.pollingTask = this.runPollingLoop();
  }

  private async runPollingLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.setStatus({ state: "running", attempt });
        await this.bot.start({ onStart: () => this.setStatus({ state: "running", attempt }) });
        if (!this.stopped) throw new Error("Telegram polling stopped unexpectedly");
      } catch (err) {
        if (this.stopped) break;
        const message = describePollingError(err);
        if (isPermanent(err) || !isRetryable(err)) {
          this.setStatus({ state: "failed", attempt, error: message });
          return;
        }
        attempt += 1;
        const delay = retryAfterMs(err, attempt);
        this.setStatus({ state: "retrying", attempt, nextRetryAt: Date.now() + delay, error: message });
        await new Promise<void>((resolve) => {
          this.retryWake = resolve;
          this.retryTimer = setTimeout(resolve, delay);
        });
        this.retryTimer = undefined;
        this.retryWake = undefined;
      }
    }
    this.setStatus({ state: "stopped", attempt });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryWake?.();
    this.retryTimer = undefined;
    this.retryWake = undefined;
    if (this.bot.isRunning()) await this.bot.stop();
    await this.pollingTask;
    this.pollingTask = undefined;
  }

  async setCommands(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: "help", description: "Show available commands" },
      { command: "agents", description: "List Herdr agents with status" },
      { command: "status", description: "Show bridge status" },
      { command: "read", description: "Read output from an agent" },
      { command: "reply", description: "Read output then reply to an agent" },
      { command: "send", description: "Send text to an agent" },
      { command: "last", description: "Read this topic's pane output" },
      { command: "follow", description: "Follow updates in this topic" },
      { command: "unfollow", description: "Stop following this topic" },
      { command: "stop", description: "Soft stop this topic's agent" },
      { command: "interrupt", description: "Hard interrupt an agent" },
      { command: "trust", description: "Trust tools for an agent" },
      { command: "model", description: "Choose this agent's Codex model" },
      { command: "reasoning", description: "Choose Low, Medium, or High reasoning" },
      { command: "bind", description: "Bind this topic to a pane" },
      { command: "topics", description: "List bound topic ids" },
      { command: "reconcile", description: "Sync Herdr panes to topics" },
    ]);
  }
  async createForumTopic(chatId: number, name: string): Promise<number> {
    const result = await this.bot.api.createForumTopic(chatId, name);
    return result.message_thread_id;
  }

  async deleteForumTopic(chatId: number, messageThreadId: number): Promise<void> {
    await this.bot.api.deleteForumTopic(chatId, messageThreadId);
  }

  async editForumTopic(chatId: number, messageThreadId: number, name: string): Promise<void> {
    await this.bot.api.editForumTopic(chatId, messageThreadId, { name });
  }

  async getForumTopics(chatId: number): Promise<TopicInfo[]> {
    try {
      // grammy 1.x doesn't expose getForumTopics on typed API; use raw
      const result: any[] = await (this.bot.api as any).raw.getForumTopics({ chat_id: chatId });
      return result.map((t: any) => ({
        message_thread_id: t.message_thread_id,
        name: t.name,
      }));
    } catch {
      return [];
    }
  }

  async sendChatAction(chatId: number, threadId: number): Promise<void> {
    // Use 'typing' action; silent (no user-visible notification) and fails
    // with TOPIC_ID_INVALID if the thread was deleted.
    await this.bot.api.sendChatAction(chatId, "typing", { message_thread_id: threadId });
  }

  async sendMessage(
    chatId: number,
    threadId: number,
    text: string,
    opts?: { disable_notification?: boolean; reply_markup?: unknown; parse_mode?: "HTML" | "MarkdownV2" }
  ): Promise<number> {
    const queueKey = `${chatId}:${threadId}`;
    const previous = this.sendQueues.get(queueKey) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const msg = await this.bot.api.sendMessage(chatId, text, {
        message_thread_id: threadId,
        disable_notification: opts?.disable_notification ?? false,
        parse_mode: opts?.parse_mode,
        reply_markup: opts?.reply_markup as any,
      });
      return msg.message_id;
    });
    const tail = task.then(() => undefined, () => undefined);
    this.sendQueues.set(queueKey, tail);
    try {
      return await task;
    } finally {
      if (this.sendQueues.get(queueKey) === tail) this.sendQueues.delete(queueKey);
    }
  }

  async clearMessageKeyboard(chatId: number, messageId: number): Promise<void> {
    await this.bot.api.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: undefined,
    });
  }

  async editMessageText(
    chatId: number,
    threadId: number,
    messageId: number,
    text: string,
    opts?: { reply_markup?: unknown; parse_mode?: "HTML" | "MarkdownV2" },
  ): Promise<void> {
    const queueKey = `${chatId}:${threadId}`;
    const previous = this.sendQueues.get(queueKey) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      await this.bot.api.editMessageText(chatId, messageId, text, {
        parse_mode: opts?.parse_mode,
        reply_markup: opts?.reply_markup as any,
      });
    });
    const tail = task.then(() => undefined, () => undefined);
    this.sendQueues.set(queueKey, tail);
    try {
      await task;
    } finally {
      if (this.sendQueues.get(queueKey) === tail) this.sendQueues.delete(queueKey);
    }
  }

  async validatePermissions(chatId: number): Promise<string[]> {
    const errors: string[] = [];

    try {
      const chat = await this.bot.api.getChat(chatId);
      const chatType = chat.type;
      // Some Telegram API responses omit is_forum even for an existing
      // forum supergroup. Reject an explicit false value, but let the
      // subsequent topic reconciliation verify older/partial responses.
      if (chatType !== "supergroup" || (chat as { is_forum?: boolean }).is_forum === false) {
        errors.push("This bridge requires a Telegram Forum supergroup. Enable Topics in Group Settings, then pair again from that forum.");
      } else {
        try {
          const me = await this.bot.api.getMe();
          const member = await this.bot.api.getChatMember(chatId, me.id);
          if (!["creator", "administrator"].includes(member.status)) {
            errors.push(
              "Bot is not an administrator. Promote via Group Settings → Administrators → Add Administrator."
            );
            return errors;
          }
          if (member.status === "administrator" && !(member as any).can_manage_topics) {
            errors.push(
              "Bot lacks 'Manage Topics' permission. Enable in Group Settings → Administrators → @yourbot → Manage Topics."
            );
          }
        } catch (err: any) {
          errors.push(`Cannot check bot permissions. ${err.message}`);
        }
      }
    } catch (err: any) {
      errors.push(
        `Cannot access chat. Make sure the bot has been added. (${err.message})`
      );
    }

    return errors;
  }
}
