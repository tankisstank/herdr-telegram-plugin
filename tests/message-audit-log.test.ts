import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageAuditLog } from "../src/message-audit-log.js";

function readEntries(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("MessageAuditLog", () => {
  it("persists the full outbound body before its Telegram result", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-tg-audit-"));
    try {
      const audit = new MessageAuditLog(dir);
      const sequence = audit.begin("sendMessage", {
        chat_id: -100123,
        message_thread_id: 42,
        text: "Agent result\n\nFull body",
        disable_notification: true,
        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "secret-action" }]] },
      });
      audit.sent(sequence, "sendMessage", { message_id: 99 });

      expect(readEntries(audit.filePath)).toEqual([
        expect.objectContaining({
          sequence: 1,
          phase: "attempt",
          method: "sendMessage",
          chat_id: -100123,
          thread_id: 42,
          text: "Agent result\n\nFull body",
          disable_notification: true,
          buttons: [["Approve"]],
        }),
        expect.objectContaining({
          sequence: 1,
          phase: "sent",
          method: "sendMessage",
          message_id: 99,
        }),
      ]);
      expect(readFileSync(audit.filePath, "utf8")).not.toContain("secret-action");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records failures and rotates an oversized log", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-tg-audit-"));
    try {
      const audit = new MessageAuditLog(dir, 1);
      const first = audit.begin("sendMessage", { text: "first" });
      audit.failed(first, "sendMessage", new Error("network down"));
      audit.begin("sendMessage", { text: "second" });

      expect(readEntries(audit.filePath)).toEqual([
        expect.objectContaining({ sequence: 2, phase: "attempt", text: "second" }),
      ]);
      expect(readFileSync(`${audit.filePath}.1`, "utf8")).toContain("network down");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
