import { describe, it, expect } from "vitest";
import type { PaneInfo } from "../src/types.js";
import { syncTabs } from "../src/watcher.js";
import { ThinkingRelayTracker } from "../src/thinking-relay.js";

/**
 * Pure function extracted from watcher.ts: classify herdr panes against
 * known_tabs to determine what changed.  No API calls — just the detection
 * logic that the watcher loop runs.
 */
export function classifyTabChanges(
  panes: PaneInfo[],
  knownTabs: Record<string, { label: string; thread_id: number }>
) {
  const added: string[] = [];
  const renamed: string[] = [];
  const removed: string[] = [];
  const currentIds = new Set(panes.map((p) => p.tab_id));

  for (const pane of panes) {
    const existing = knownTabs[pane.tab_id];
    if (!existing) {
      added.push(pane.tab_id);
    } else if (existing.label !== pane.label) {
      renamed.push(pane.tab_id);
    }
  }

  // Detect removed (in knownTabs but not in current panes)
  for (const tabId of Object.keys(knownTabs)) {
    if (!currentIds.has(tabId)) {
      removed.push(tabId);
    }
  }

  return { added, renamed, removed };
}

const makePane = (overrides: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id: "w1:pX",
  tab_id: "w1:tX",
  label: "Test",
  agent: "pi",
  workspace_id: "w1",
  status: "idle",
  ...overrides,
});

describe("classifyTabChanges", () => {
  it("detects new tabs", () => {
    const panes = [makePane({ tab_id: "w1:tA", label: "Agent A" })];
    const result = classifyTabChanges(panes, {});
    expect(result.added).toEqual(["w1:tA"]);
    expect(result.renamed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("detects renamed tabs", () => {
    const panes = [makePane({ tab_id: "w1:tA", label: "New Name" })];
    const known = { "w1:tA": { label: "Old Name", thread_id: 10 } };
    const result = classifyTabChanges(panes, known);
    expect(result.renamed).toEqual(["w1:tA"]);
    expect(result.added).toEqual([]);
  });

  it("detects removed tabs", () => {
    const known = { "w1:tA": { label: "Agent A", thread_id: 10 } };
    const result = classifyTabChanges([], known);
    expect(result.removed).toEqual(["w1:tA"]);
    expect(result.added).toEqual([]);
  });

  it("no changes when tabs match", () => {
    const panes = [makePane({ tab_id: "w1:tA", label: "Agent A" })];
    const known = { "w1:tA": { label: "Agent A", thread_id: 10 } };
    const result = classifyTabChanges(panes, known);
    expect(result.added).toEqual([]);
    expect(result.renamed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("handles mixed new + renamed + removed", () => {
    const panes = [
      makePane({ tab_id: "w1:tA", label: "A" }),
      makePane({ tab_id: "w1:tB", label: "B Renamed" }),
    ];
    const known = {
      "w1:tB": { label: "B", thread_id: 10 },
      "w1:tC": { label: "C", thread_id: 11 },
    };
    const result = classifyTabChanges(panes, known);
    expect(result.added).toEqual(["w1:tA"]);
    expect(result.renamed).toEqual(["w1:tB"]);
    expect(result.removed).toEqual(["w1:tC"]);
  });
});
describe("syncTabs message ordering", () => {
  it("keeps a topic mapping when Herdr temporarily omits its tab", async () => {
    const pane = makePane({ tab_id: "w1:tA", pane_id: "w1:pA", label: "Test" });
    const state: any = {
      authorized_chat_id: 1,
      paired_at: "now",
      thread_mappings: {
        10: { pane_id: pane.pane_id, label: pane.label, agent: pane.agent, created_at: "now" },
      },
      known_topics: { 10: { name: "W1-Test", created_at: "now" } },
      known_tabs: { [pane.tab_id]: { label: "W1-Test", thread_id: 10, status: "idle" } },
    };
    const map = new Map([[10, state.thread_mappings[10]]]);
    const telegram = {
      deleteForumTopic: async () => { throw new Error("must not delete"); },
      sendMessage: async () => 1,
    };

    const result = await syncTabs(1, telegram as any, state, {
      map,
      getAgents: () => [],
      readPane: () => "",
    });

    expect(result.removed).toEqual([]);
    expect(state.known_tabs[pane.tab_id].thread_id).toBe(10);
    expect(state.thread_mappings[10].pane_id).toBe(pane.pane_id);
    expect(map.get(10)?.pane_id).toBe(pane.pane_id);
  });

  it("sends fresh thinking before the blocked approval prompt", async () => {
    let pane = makePane({
      tab_id: "w1:tA",
      pane_id: "w1:pA",
      label: "Test",
      workspace_label: "Video Review",
      status: "working",
    });
    let output = "prompt";
    const sent: Array<{ text: string; opts?: unknown }> = [];
    const telegram = {
      sendMessage: async (_chatId: number, _threadId: number, text: string, opts?: unknown) => {
        sent.push({ text, opts });
        return sent.length;
      },
    };
    const state: any = {
      authorized_chat_id: 1,
      paired_at: "now",
      thread_mappings: {
        10: { pane_id: pane.pane_id, label: pane.label, agent: pane.agent, created_at: "now" },
      },
      known_tabs: {
        [pane.tab_id]: { label: "VR-Test", thread_id: 10, status: "working" },
      },
    };
    const deps = {
      map: new Map([[10, state.thread_mappings[10]]]),
      thinkingTracker: new ThinkingRelayTracker(),
      getAgents: () => [pane],
      readPane: () => output,
    };

    await syncTabs(1, telegram as any, state, deps);
    pane = { ...pane, status: "blocked" };
    output = [
      "prompt",
      "• Validation completed",
      "Would you like to continue?",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
    ].join("\n");
    await syncTabs(1, telegram as any, state, deps);

    expect(sent.map((message) => message.text)).toEqual([
      "• Validation completed",
      expect.stringContaining("needs input (working -> blocked)"),
    ]);
  });

  it("sends a new approval prompt even when the pane remains blocked", async () => {
    const pane = makePane({
      tab_id: "w1:tA",
      pane_id: "w1:pA",
      label: "Test",
      status: "blocked",
    });
    let output = [
      "Would you like to run the following command?",
      "$ git merge --abort",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
    ].join("\n");
    const sent: string[] = [];
    const cleared: Array<{ chatId: number; messageId: number }> = [];
    const telegram = {
      sendMessage: async (_chatId: number, _threadId: number, text: string) => {
        sent.push(text);
        return sent.length;
      },
      clearMessageKeyboard: async (chatId: number, messageId: number) => {
        cleared.push({ chatId, messageId });
      },
    };
    const state: any = {
      authorized_chat_id: 1,
      paired_at: "now",
      thread_mappings: {},
      known_tabs: {
        [pane.tab_id]: { label: "W1-Test", thread_id: 10, status: "working" },
      },
    };
    const deps = {
      map: new Map(),
      getAgents: () => [pane],
      readPane: () => output,
    };

    await syncTabs(1, telegram as any, state, deps);
    output = [
      output,
      "Merge aborted.",
      "Would you like to run the following command?",
      "$ git merge --no-ff feature/audit",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again (p)",
      "  3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
    ].join("\n");
    await syncTabs(1, telegram as any, state, deps);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("git merge --abort");
    expect(sent[1]).toContain("has a new input request");
    expect(sent[1]).toContain("git merge --no-ff feature/audit");
    expect(sent[1]).not.toContain("git merge --abort");
    expect(cleared).toEqual([{ chatId: 1, messageId: 1 }]);
  });

  it("retries a blocked pane until its options have rendered", async () => {
    const pane = makePane({
      tab_id: "w1:tA",
      pane_id: "w1:pA",
      label: "Test",
      status: "blocked",
    });
    let output = "Would you like to run the following command?\n$ git merge --abort";
    const sent: string[] = [];
    const telegram = {
      sendMessage: async (_chatId: number, _threadId: number, text: string) => {
        sent.push(text);
        return sent.length;
      },
    };
    const state: any = {
      authorized_chat_id: 1,
      paired_at: "now",
      thread_mappings: {},
      known_tabs: {
        [pane.tab_id]: { label: "W1-Test", thread_id: 10, status: "working" },
      },
    };
    const deps = {
      map: new Map(),
      getAgents: () => [pane],
      readPane: () => output,
    };

    await syncTabs(1, telegram as any, state, deps);
    expect(sent).toEqual([]);
    expect(state.known_tabs[pane.tab_id].last_blocked_prompt_fingerprint).toBeUndefined();

    output = [
      output,
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
    ].join("\n");
    await syncTabs(1, telegram as any, state, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("git merge --abort");
    expect(state.known_tabs[pane.tab_id].last_blocked_prompt_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps all options when a long option wraps across terminal lines", async () => {
    const pane = makePane({
      tab_id: "w1:tA",
      pane_id: "w1:pA",
      label: "Test",
      status: "blocked",
    });
    const output = [
      "Would you like to run the following command?",
      "  Environment: local",
      "  Reason: Bạn có muốn cho phép đọc helper derive canary đã merge không?",
      "  $ $lines = Get-Content 'app\\scripts\\lib\\wingsSideTourEditorialProduction.ts'; $start = (Select-String -Path",
      "  'app\\scripts\\lib\\wingsSideTourEditorialProduction.ts' -Pattern '^export const deriveWingsSideTourEditorialCanaryPlan').LineNumber;",
      "  $lines[($start-1)..($start+120)]",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `$lines = Get-Content",
      "     'app\\scripts\\lib\\wingsSideTourEditorialProduction.ts'; $start = (Select-String -Path",
      "     'app\\scripts\\lib\\wingsSideTourEditorialProduction.ts' -Pattern '^export const",
      "     deriveWingsSideTourEditorialCanaryPlan').LineNumber; $lines[($start-1)..($start+120)]` (p)",
      "  3. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    const sent: Array<{ text: string; opts?: any }> = [];
    const telegram = {
      sendMessage: async (_chatId: number, _threadId: number, text: string, opts?: any) => {
        sent.push({ text, opts });
        return sent.length;
      },
    };
    const state: any = {
      authorized_chat_id: 1,
      paired_at: "now",
      thread_mappings: {},
      known_tabs: {
        [pane.tab_id]: { label: "W1-Test", thread_id: 10, status: "working" },
      },
    };

    await syncTabs(1, telegram as any, state, {
      map: new Map(),
      getAgents: () => [pane],
      readPane: () => output,
    });

    const buttons = sent[0].opts.reply_markup.inline_keyboard[0];
    expect(buttons.map((button: { text: string }) => button.text)).toEqual([
      "Yes",
      "All",
      "No + comment",
    ]);
    const callbackData = buttons.map((button: { callback_data: string }) => button.callback_data);
    expect(callbackData[0]).toMatch(/^resp\|[a-f0-9]{12}\|y$/);
    expect(callbackData[1]).toMatch(/^resp\|[a-f0-9]{12}\|p$/);
    expect(callbackData[2]).toMatch(/^respc\|[a-f0-9]{12}\|esc$/);
    expect(new Set(callbackData.map((value: string) => value.split("|")[1]))).toHaveLength(1);
  });
});
