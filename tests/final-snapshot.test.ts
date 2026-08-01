import { describe, expect, it } from "vitest";
import { extractFinalSnapshot } from "../src/final-snapshot.js";

describe("extractFinalSnapshot", () => {
  it("keeps headings, prose, Markdown and bullets while removing TUI chrome", () => {
    const result = extractFinalSnapshot([
      "Đã hoàn tất việc nâng cấp.",
      "",
      "### Chi tiết 5 file XML:",
      "",
      "1. **Hediffs_Bionic.xml**: Cập nhật mô tả.",
      "• Giữ nguyên đầy đủ thông tin.",
      "────────────────────────────────────",
      "▸ Thought for 2s",
      ">",
      "esc to cancel                                  Gemini · high",
    ].join("\n"));

    expect(result).toContain("### Chi tiết 5 file XML:");
    expect(result).toContain("**Hediffs_Bionic.xml**");
    expect(result).toContain("• Giữ nguyên đầy đủ thông tin.");
    expect(result).not.toContain("Thought for 2s");
    expect(result).not.toContain("esc to cancel");
  });
});
