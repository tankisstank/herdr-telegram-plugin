import { describe, expect, it } from "vitest";
import {
  extractThinkingBlocks,
  ThinkingRelayTracker,
} from "../src/thinking-relay.js";

describe("extractThinkingBlocks", () => {
  it("keeps progress bullets and their wrapped continuation lines", () => {
    const raw = [
      "old transcript",
      "• Tests pass. Tôi restart daemon để parser mới có hiệu lực.",
      "  Chi tiết tiếp tục ở dòng bị wrap.",
      "• Daemon mới đã start. Tôi đọc status và log khởi động.",
      "› 1. Yes, proceed (y)",
    ].join("\n");

    expect(extractThinkingBlocks(raw)).toEqual([
      "• Tests pass. Tôi restart daemon để parser mới có hiệu lực.\n  Chi tiết tiếp tục ở dòng bị wrap.",
      "• Daemon mới đã start. Tôi đọc status và log khởi động.",
    ]);
  });

  it("ignores terminal tool activity and working ticker bullets", () => {
    const raw = [
      "• Ran rg -n renderQueue backend\\app\\web\\app.js",
      "  └ 487:function renderQueue(q)",
      "• Working (4m 30s • esc to interrupt)",
      "• Added backend\\\\app\\\\telegram\\\\bot.py (+103 lines)",
      "• Updated Plan",
      "• Music state và API contract đã được bổ sung; code đã compile.",
    ].join("\n");

    expect(extractThinkingBlocks(raw)).toEqual([
      "• Music state và API contract đã được bổ sung; code đã compile.",
    ]);
  });
});

  it("keeps the complete final narrative after a bullet heading", () => {
    const raw = [
      "• Đã thêm nút trong topic Quản trị:",
      "Các nút mới hỗ trợ pause và resume.",
      "- Đã cập nhật API và kiểm thử.",
      "Status: working -> done",
    ].join("\n");

    expect(extractThinkingBlocks(raw)).toEqual([
      "• Đã thêm nút trong topic Quản trị:\nCác nút mới hỗ trợ pause và resume.\n- Đã cập nhật API và kiểm thử.",
    ]);
  });

  it("keeps numbered Markdown lists in the final narrative", () => {
    const raw = [
      "• Đã kiểm tra 3 ảnh. Bước Research đang có lỗi UI nghiêm trọng về tương phản:",
      "",
      "1. Banner READY ở đầu trang",
      "",
      "- Chữ xanh lime đặt trên nền gần trắng.",
      "- Độ tương phản rất thấp, khó đọc.",
      "",
      "2. Evidence review",
      "Status: working -> done",
    ].join("\n");

    expect(extractThinkingBlocks(raw)).toEqual([
      "• Đã kiểm tra 3 ảnh. Bước Research đang có lỗi UI nghiêm trọng về tương phản:\n\n1. Banner READY ở đầu trang\n\n- Chữ xanh lime đặt trên nền gần trắng.\n- Độ tương phản rất thấp, khó đọc.\n\n2. Evidence review",
    ]);
  });

describe("ThinkingRelayTracker", () => {
  it("uses the first pane read as a baseline and emits only appended bullets", () => {
    const tracker = new ThinkingRelayTracker();
    expect(tracker.capture("1-1", "prompt\n• Existing update")).toEqual([]);
    expect(tracker.capture("1-1", "prompt\n• Existing update\n• New update")).toEqual([
      "• New update",
    ]);
  });

  it("deduplicates bullets when a terminal redraw loses the common prefix", () => {
    const tracker = new ThinkingRelayTracker();
    tracker.capture("1-1", "prompt\n• Existing before startup");
    expect(tracker.capture("1-1", "redrawn\n• Existing before startup")).toEqual([]);
    expect(tracker.capture("1-1", "redrawn\n• Existing before startup\n• Sent once")).toEqual(["• Sent once"]);
    expect(tracker.capture("1-1", "another redraw\n• Sent once")).toEqual([]);
  });

  it("advances the snapshot while another observer owns the pane", () => {
    const tracker = new ThinkingRelayTracker();
    tracker.capture("1-1", "prompt");
    expect(tracker.capture("1-1", "prompt\n• Sent by follow loop", false)).toEqual([]);
    expect(tracker.capture("1-1", "prompt\n• Sent by follow loop\n• Watcher resumes")).toEqual([
      "• Watcher resumes",
    ]);
  });
});
