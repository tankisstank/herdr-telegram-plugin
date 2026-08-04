export interface ApprovalKeyResponse {
  kind: "keys" | "invalid";
  values: string[];
}

/** Translate a Telegram approval choice into keys supported by Herdr. */
export function approvalResponseForKey(key: string): ApprovalKeyResponse {
  const normalized = key.trim().toLowerCase();
  if (["yes", "y"].includes(normalized)) return { kind: "keys", values: ["y", "Enter"] };
  if (["all", "p", "trust"].includes(normalized)) return { kind: "keys", values: ["p", "Enter"] };
  if (["no", "n"].includes(normalized)) return { kind: "keys", values: ["n", "Enter"] };
  if (["esc", "escape"].includes(normalized)) return { kind: "keys", values: ["Escape"] };

  // Agy uses a cursor menu without shortcut letters. The optional second
  // index is the item selected when the keyboard was rendered. Older
  // keyboards omit it and assume the first item is selected.
  const index = normalized.match(/^index:(\d+)(?::(\d+))?$/);
  if (!index) return { kind: "invalid", values: [] };
  const target = Number(index[1]);
  const selected = Number(index[2] ?? "1");
  if (target < 1 || target > 12 || selected < 1 || selected > 12) {
    return { kind: "invalid", values: [] };
  }
  const direction = target > selected ? "Down" : "Up";
  return {
    kind: "keys",
    values: [...Array.from({ length: Math.abs(target - selected) }, () => direction), "Enter"],
  };
}
