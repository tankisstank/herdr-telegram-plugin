import { describe, expect, it } from "vitest";
import { splitTelegramText } from "../src/telegram-text.js";

describe("splitTelegramText", () => {
  it("keeps short messages intact", () => {
    expect(splitTelegramText("a\n\nb")).toEqual(["a\n\nb"]);
  });

  it("splits long messages at paragraph boundaries without losing content", () => {
    const paragraphs = Array.from({ length: 8 }, (_, index) => `Paragraph ${index}: ${"x".repeat(40)}`);
    const source = paragraphs.join("\n\n");
    const chunks = splitTelegramText(source, 100);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(source.replace(/\s+/g, " ").trim());
  });
});
