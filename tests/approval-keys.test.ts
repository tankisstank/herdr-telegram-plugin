import { describe, expect, it } from "vitest";
import { approvalResponseForKey } from "../src/approval-keys.js";

describe("approvalResponseForKey", () => {
  it("uses native shortcut keys where an agent provides them", () => {
    expect(approvalResponseForKey("y")).toEqual({ kind: "keys", values: ["y", "Enter"] });
    expect(approvalResponseForKey("esc")).toEqual({ kind: "keys", values: ["Escape"] });
  });

  it("uses only Herdr-supported cursor keys for indexed options", () => {
    expect(approvalResponseForKey("index:1:1")).toEqual({ kind: "keys", values: ["Enter"] });
    expect(approvalResponseForKey("index:3:1")).toEqual({ kind: "keys", values: ["Down", "Down", "Enter"] });
    expect(approvalResponseForKey("index:2:4")).toEqual({ kind: "keys", values: ["Up", "Up", "Enter"] });
    expect(approvalResponseForKey("index:3")).toEqual({ kind: "keys", values: ["Down", "Down", "Enter"] });
  });
});
