import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export interface MessageAuditEntry {
  timestamp: string;
  session_id: string;
  process_id: number;
  sequence: number;
  phase: "attempt" | "sent" | "failed";
  method: string;
  kind?: "approval" | "progress" | "final" | "status" | "message";
  chat_id?: number | string;
  thread_id?: number;
  text?: string;
  message_id?: number;
  disable_notification?: boolean;
  parse_mode?: string;
  reply_to_message_id?: number;
  buttons?: string[][];
  error?: string;
}

function buttonLabels(replyMarkup: unknown): string[][] | undefined {
  if (!replyMarkup || typeof replyMarkup !== "object") return undefined;
  const keyboard = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(keyboard)) return undefined;
  const labels = keyboard.map((row) =>
    Array.isArray(row)
      ? row.map((button) => {
          if (!button || typeof button !== "object") return "";
          const text = (button as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }).filter(Boolean)
      : []
  ).filter((row) => row.length > 0);
  return labels.length > 0 ? labels : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferKind(text: string | undefined, buttons: string[][] | undefined): MessageAuditEntry["kind"] {
  const flatButtons = (buttons ?? []).flat().map((button) => button.toLowerCase());
  if (flatButtons.some((button) => /^(yes|all|no|no \+ comment|always allow)$/.test(button))) return "approval";
  if (/^(✅|🟢|hoàn tất)/i.test(text ?? "")) return "final";
  if (/^status:/i.test(text ?? "")) return "status";
  if (/^(?:⏳|•)/.test(text ?? "")) return "progress";
  return "message";
}

/** Durable, append-only record of Telegram messages as they cross the API boundary. */
export class MessageAuditLog {
  readonly filePath: string;
  private readonly sessionId = randomUUID();
  private sequence = 0;

  constructor(
    stateDir: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly onError?: (error: Error) => void,
  ) {
    this.filePath = path.join(stateDir, "telegram-messages.jsonl");
  }

  begin(method: string, payload: Record<string, unknown>): number {
    const sequence = ++this.sequence;
    const text = typeof payload.text === "string"
      ? payload.text
      : typeof payload.caption === "string" ? payload.caption : undefined;
    const buttons = buttonLabels(payload.reply_markup);
    this.append({
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      process_id: process.pid,
      sequence,
      phase: "attempt",
      method,
      kind: inferKind(text, buttons),
      chat_id: payload.chat_id as number | string | undefined,
      thread_id: payload.message_thread_id as number | undefined,
      text,
      disable_notification: payload.disable_notification as boolean | undefined,
      parse_mode: payload.parse_mode as string | undefined,
      reply_to_message_id: typeof payload.reply_to_message_id === "number"
        ? payload.reply_to_message_id
        : typeof (payload.reply_parameters as { message_id?: unknown } | undefined)?.message_id === "number"
          ? (payload.reply_parameters as { message_id: number }).message_id
          : undefined,
      buttons,
    });
    return sequence;
  }

  sent(sequence: number, method: string, result: unknown): void {
    const messageId = result && typeof result === "object"
      ? (result as { message_id?: unknown }).message_id
      : undefined;
    this.append({
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      process_id: process.pid,
      sequence,
      phase: "sent",
      method,
      message_id: typeof messageId === "number" ? messageId : undefined,
    });
  }

  failed(sequence: number, method: string, error: unknown): void {
    this.append({
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      process_id: process.pid,
      sequence,
      phase: "failed",
      method,
      error: errorMessage(error),
    });
  }

  private append(entry: MessageAuditEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.filePath)) return;
    if (fs.statSync(this.filePath).size < this.maxBytes) return;
    const previousPath = `${this.filePath}.1`;
    if (fs.existsSync(previousPath)) fs.unlinkSync(previousPath);
    fs.renameSync(this.filePath, previousPath);
  }
}
