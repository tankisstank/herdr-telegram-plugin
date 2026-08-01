import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TopicInfo } from "../src/types.js";
import { TelegramClient } from "../src/telegram-client.js";
import { MessageAuditLog } from "../src/message-audit-log.js";

describe("TopicInfo", () => {
  it("matches expected shape from Telegram API", () => {
    const info: TopicInfo = {
      message_thread_id: 140,
      name: "Echo",
    };
    expect(typeof info.message_thread_id).toBe("number");
    expect(typeof info.name).toBe("string");
    const errors: string[] = [];
    expect(Array.isArray(errors)).toBe(true);
  });
});

function fakeBot(start: () => Promise<void>) {
  return {
    init: async () => {},
    start,
    stop: async () => {},
    isRunning: () => false,
    api: {},
  };
}

describe("TelegramClient polling lifecycle", () => {
  it("audits messages sent through the grammy API transformer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-tg-client-audit-"));
    try {
      const audit = new MessageAuditLog(dir);
      const customFetch: typeof fetch = async () => new Response(JSON.stringify({
        ok: true,
        result: { message_id: 77, date: 0, chat: { id: -100123, type: "supergroup" }, text: "hello" },
      }), { status: 200, headers: { "content-type": "application/json" } });
      const client = new TelegramClient("123:test", undefined, undefined, customFetch, audit);

      await client.sendMessage(-100123, 42, "hello");

      const entries = readFileSync(audit.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toEqual([
        expect.objectContaining({ phase: "attempt", method: "sendMessage", thread_id: 42, text: "hello" }),
        expect.objectContaining({ phase: "sent", method: "sendMessage", message_id: 77 }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a permanent polling failure instead of retrying forever", async () => {
    const client = new TelegramClient("test", undefined, fakeBot(async () => {
      throw { error_code: 401, message: "Unauthorized" };
    }) as any);

    await client.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.getPollingStatus()).toMatchObject({ state: "failed", error: "Unauthorized" });
    await client.stop();
  });

  it("enters retrying on a polling conflict and can be stopped during backoff", async () => {
    const client = new TelegramClient("test", undefined, fakeBot(async () => {
      throw { error_code: 409, message: "Conflict" };
    }) as any);

    await client.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.getPollingStatus()).toMatchObject({ state: "retrying", attempt: 1, error: "Conflict" });
    await client.stop();
    expect(client.getPollingStatus().state).toBe("stopped");
  });
});
