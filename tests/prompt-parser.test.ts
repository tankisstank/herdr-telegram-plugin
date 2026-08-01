import { describe, expect, it } from "vitest";
import { parseInteractivePrompt } from "../src/prompt-parser.js";

describe("interactive prompt parser", () => {
  it("parses Codex prompts with the ASCII selection marker", () => {
    const parsed = parseInteractivePrompt([
      "Do you want to proceed?",
      "> 1. Yes",
      "  2. Yes, and always allow in this conversation for commands that start with 'python'",
      "  3. Yes, and always allow for commands that start with 'python' (Persist to settings.json)",
      "  4. No",
      "↑/↓ Navigate · tab Amend · ctrl+g edit/expand command · esc to cancel",
    ].join("\n"));

    expect(parsed.confidence).toBe("high");
    expect(parsed.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, and always allow in this conversation for commands that start with 'python'",
      "Yes, and always allow for commands that start with 'python' (Persist to settings.json)",
      "No",
    ]);
    expect(parsed.options.map((option) => option.key)).toEqual(["index:1", "index:2", "index:3", "index:4"]);
    expect(parsed.options[3].wantsComment).toBe(false);
  });

  it("does not use numbered historical content when the latest prompt is not anchored", () => {
    const parsed = parseInteractivePrompt([
      "1. Old report section",
      "2. Old report recommendation",
      "The agent is still working.",
    ].join("\n"));

    expect(parsed.confidence).toBe("low");
    expect(parsed.options).toEqual([]);
  });

  it("recognizes Agy's question marker and keeps its four choices", () => {
    const parsed = parseInteractivePrompt([
      "? Bạn muốn cài đặt theo phương thức nào?",
      "> 1. Cài đặt trực tiếp thành thư mục ngôn ngữ",
      "  2. Chỉ cài đặt bản Core",
      "  3. Cài đặt toàn bộ DLC",
      "  4. Không, hãy hướng dẫn tôi",
      "tab Amend · esc to cancel",
    ].join("\n"));

    expect(parsed.adapter).toBe("agy");
    expect(parsed.confidence).toBe("high");
    expect(parsed.selectedIndex).toBe(1);
    expect(parsed.options).toHaveLength(4);
    expect(parsed.options.map((option) => option.label)).toEqual([
      "Cài đặt trực tiếp thành thư mục ngôn ngữ",
      "Chỉ cài đặt bản Core",
      "Cài đặt toàn bộ DLC",
      "Không, hãy hướng dẫn tôi",
    ]);
  });
});
