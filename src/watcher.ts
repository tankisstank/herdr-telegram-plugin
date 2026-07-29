import type { DaemonState, PaneInfo, ThreadMapping } from "./types.js";
import type { TelegramClient } from "./telegram-client.js";
import { getAgents, readPane } from "./herdr-client.js";
import { createLogger } from "./logger.js";
import { topicNameForPane } from "./topic-names.js";
import { ThinkingRelayTracker } from "./thinking-relay.js";

const log = createLogger("watcher");

interface WatcherDeps {
  map: Map<number, ThreadMapping>;
  thinkingTracker?: ThinkingRelayTracker;
  isPaneObserved?: (paneId: string) => boolean;
  getAgents?: () => PaneInfo[];
  readPane?: (paneId: string, lines: number) => string;
}

interface PromptOption {
  index: string;
  label: string;
  key: string;
  wantsComment: boolean;
}

interface InteractivePrompt {
  text: string;
  options: PromptOption[];
}

function optionButtonText(option: PromptOption): string {
  const normalized = option.label.toLowerCase();
  if (/yes|approve|proceed/.test(normalized) && !/again|always|don't ask/.test(normalized)) return "Yes";
  if (/always|don't ask|dont ask|all|trust/.test(normalized)) return "All";
  if (/no|cancel|different|esc/.test(normalized)) return option.wantsComment ? "No + comment" : "No";
  return option.label.length > 28 ? option.label.slice(0, 25) + "..." : option.label;
}

function promptKeyboard(options: PromptOption[]) {
  const buttons = options.slice(0, 6).map((option) => ({
    text: optionButtonText(option),
    callback_data: `${option.wantsComment ? "respc" : "resp"}|${option.key}`,
  }));
  return { inline_keyboard: buttons.length ? [buttons] : [[
    { text: "Yes", callback_data: "resp|yes" },
    { text: "All", callback_data: "resp|all" },
    { text: "No + comment", callback_data: "respc|esc" },
  ]] };
}

function parseOption(line: string): PromptOption | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^›?\s*(\d+)[.)]\s+(.+?)\s*$/);
  if (!match) return null;
  const index = match[1];
  let label = match[2].trim();
  const keyMatch = label.match(/\(([^()]+)\)\s*$/);
  const key = keyMatch ? keyMatch[1].trim().toLowerCase() : index;
  if (keyMatch) label = label.slice(0, keyMatch.index).trim();
  const wantsComment = /tell .* differently|what to do differently|comment|reason|edit/i.test(label);
  return { index, label, key, wantsComment };
}

function extractInteractivePrompt(raw: string): InteractivePrompt {
  const allLines = raw.split("\n").map((line) => line.trimEnd());
  const optionLines: Array<{ line: string; index: number; option: PromptOption }> = [];
  for (let i = 0; i < allLines.length; i++) {
    const option = parseOption(allLines[i]);
    if (option) optionLines.push({ line: allLines[i], index: i, option });
  }
  if (optionLines.length === 0) {
    const fallback = allLines.filter((line) => line.trim()).slice(-18).join("\n").trim();
    return { text: fallback.length > 1400 ? fallback.slice(-1400) : fallback, options: [] };
  }

  const firstOptionIndex = optionLines[0].index;
  let start = Math.max(0, firstOptionIndex - 12);
  for (let i = firstOptionIndex - 1; i >= 0; i--) {
    const line = allLines[i].trim();
    if (!line) continue;
    if (/^(Would you like|Do you want|Choose|Select|Which|How should|What should|Bạn có muốn|Hãy chọn|Chọn)/i.test(line)) {
      start = i;
      break;
    }
  }

  let end = optionLines.at(-1)!.index + 1;
  for (let i = end; i < Math.min(allLines.length, end + 4); i++) {
    if (/Press enter|confirm|cancel/i.test(allLines[i])) end = i + 1;
  }

  const text = allLines
    .slice(start, end)
    .filter((line) => line.trim())
    .join("\n")
    .trim();
  return {
    text: text.length > 1800 ? text.slice(-1800) : text,
    options: optionLines.map((entry) => entry.option),
  };
}

function blockedPrompt(
  pane: PaneInfo,
  paneReader: (paneId: string, lines: number) => string = readPane,
): InteractivePrompt {
  try {
    return extractInteractivePrompt(paneReader(pane.pane_id, 160));
  } catch {
    return { text: "", options: [] };
  }
}

function blockedMessage(
  pane: PaneInfo,
  previous: PaneInfo["status"],
  paneReader?: (paneId: string, lines: number) => string,
): { text: string; reply_markup: ReturnType<typeof promptKeyboard> } {
  const prompt = blockedPrompt(pane, paneReader);
  const body = prompt.text ? `\n\n${prompt.text}` : "";
  return {
    text: `${pane.label} needs input (${previous} -> blocked).${body}`,
    reply_markup: promptKeyboard(prompt.options),
  };
}

/**
 * Watch for herdr tab changes and sync topics in Telegram.
 * - New agent pane (tab_id not in known_tabs) → create topic
 * - Closed agent pane (tab_id in known_tabs but not in current list) → delete topic
 * - Renamed tab (label changed) → edit topic name
 *
 * Returns the updated known_tabs and a log of changes for the caller to persist.
 */
export async function syncTabs(
  chatId: number,
  tg: TelegramClient,
  state: DaemonState,
  deps?: WatcherDeps
): Promise<{ changed: boolean; added: string[]; removed: string[]; renamed: string[]; statusChanged: string[]; statusInitialized: number }> {
  const panes = deps?.getAgents?.() ?? getAgents();
  const knownTabs = state.known_tabs ?? {};

  const currentTabIds = new Set(panes.map((p) => p.tab_id));
  const knownTabIds = new Set(Object.keys(knownTabs));

  const added: string[] = [];
  const removed: string[] = [];
  const renamed: string[] = [];
  const statusChanged: string[] = [];
  let statusInitialized = 0;

  // Step 1: Detect removed tabs
  for (const tabId of knownTabIds) {
    if (!currentTabIds.has(tabId)) {
      const entry = knownTabs[tabId];
      try {
        await tg.deleteForumTopic(chatId, entry.thread_id);
        delete state.thread_mappings[entry.thread_id];
        deps?.map.delete(entry.thread_id);
        delete knownTabs[tabId];
        removed.push(`${entry.label} (tab ${tabId})`);
      } catch (err: any) {
        log.warn("watcher: failed to delete topic", {
          tabId,
          threadId: entry.thread_id,
          error: err.message,
        });
      }
    }
  }

  // Step 2: Detect new tabs + renames
  for (const pane of panes) {
    const existing = knownTabs[pane.tab_id];
    const topicName = topicNameForPane(pane);
    if (!existing) {
      // New tab — create topic
      try {
        const threadId = await tg.createForumTopic(chatId, topicName);
        knownTabs[pane.tab_id] = { label: topicName, thread_id: threadId, status: pane.status };
        const mapping = {
          pane_id: pane.pane_id,
          label: pane.label,
          agent: pane.agent,
          created_at: new Date().toISOString(),
        };
        state.thread_mappings[threadId] = mapping;
        deps?.map.set(threadId, mapping);
        // Seed with last 5 lines
        try {
          const seed = readPane(pane.pane_id, 5);
          const trimmed = seed
            .split("\n")
            .filter((l) =>
              !l.includes("context-mode active") &&
              !l.startsWith("<session_") &&
              !l.startsWith("</session_") &&
              !l.match(/^ctx_\w+ >/) &&
              !l.match(/^[─━═]{20,}/) &&
              l.length < 300
            )
            .join("\n")
            .trim();
          if (trimmed) {
            await tg.sendMessage(chatId, threadId, `📝 Last output:\n\n${trimmed}`);
          }
        } catch {
          // best-effort seeding
        }
        added.push(`${topicName} (tab ${pane.tab_id})`);
      } catch (err: any) {
        log.warn("watcher: failed to create topic", {
          pane: pane.label,
          error: err.message,
        });
      }
    } else if (existing.label !== topicName) {
      // Renamed tab — edit topic name
      try {
        await tg.editForumTopic(chatId, existing.thread_id, topicName);
        existing.label = topicName;
        const mapping = state.thread_mappings[existing.thread_id];
        if (mapping) {
          mapping.label = pane.label;
          // Explicitly re-set so deps.map always reflects the rename
          deps?.map.set(existing.thread_id, mapping);
        }
        renamed.push(`${topicName} (tab ${pane.tab_id})`);
      } catch (err: any) {
        // If topic was deleted (manually or otherwise), recreate it
        if (err.message?.includes("TOPIC_ID_INVALID")) {
          try {
        const newThreadId = await tg.createForumTopic(chatId, topicName);
        knownTabs[pane.tab_id] = { label: topicName, thread_id: newThreadId, status: pane.status };
        const newMapping = {
          pane_id: pane.pane_id,
          label: pane.label,
          agent: pane.agent,
          created_at: new Date().toISOString(),
        };
        state.thread_mappings[newThreadId] = newMapping;
        deps?.map.set(newThreadId, newMapping);
        // Drop the stale thread_id mapping
        delete state.thread_mappings[existing.thread_id];
        deps?.map.delete(existing.thread_id);
        added.push(`${topicName} (recreated, tab ${pane.tab_id})`);
          } catch (err2: any) {
            log.warn("watcher: failed to recreate topic", {
              pane: pane.label,
              error: err2.message,
            });
          }
        } else {
          log.warn("watcher: failed to rename topic", {
            pane: pane.label,
            error: err.message,
          });
        }
      }
    }
  }
  // Step 3: Relay newly rendered agent progress bullets before any blocked prompt.
  // Snapshot every pane, including panes already handled by a turn/follow loop, to avoid later replays.
  if (deps?.thinkingTracker) {
    deps.thinkingTracker.prune(new Set(panes.map((pane) => pane.pane_id)));
    for (const pane of panes) {
      const existing = knownTabs[pane.tab_id];
      if (!existing) continue;
      try {
        const raw = (deps.readPane ?? readPane)(pane.pane_id, 400);
        const blocks = deps.thinkingTracker.capture(
          pane.pane_id,
          raw,
          !deps.isPaneObserved?.(pane.pane_id),
        );
        for (const block of blocks) {
          await tg.sendMessage(chatId, existing.thread_id, block, {
            disable_notification: true,
          });
        }
      } catch (err: any) {
        log.warn("watcher: failed to relay thinking", {
          pane: pane.label,
          error: err.message,
        });
      }
    }
  }
  // Step 4: Detect agent status changes after progress has been delivered.
  for (const pane of panes) {
    const existing = knownTabs[pane.tab_id];
    if (!existing) continue;
    const previous = existing.status;
    if (previous === undefined) {
      existing.status = pane.status;
      statusInitialized++;
      continue;
    }
    if (previous !== pane.status) {
      existing.status = pane.status;
      statusChanged.push(`${pane.label}: ${previous} -> ${pane.status}`);
      try {
        if (pane.status === "blocked") {
          const message = blockedMessage(pane, previous, deps?.readPane);
          await tg.sendMessage(
            chatId,
            existing.thread_id,
            message.text,
            { reply_markup: message.reply_markup }
          );
        } else {
          await tg.sendMessage(
            chatId,
            existing.thread_id,
            `Status: ${previous} -> ${pane.status}`,
            { disable_notification: true }
          );
        }
      } catch (err: any) {
        log.warn("watcher: failed to send status update", {
          pane: pane.label,
          status: pane.status,
          error: err.message,
        });
      }
    }
  }

  state.known_tabs = knownTabs;
  const changed = added.length + removed.length + renamed.length + statusChanged.length + statusInitialized > 0;

  if (changed) {
    log.info("watcher: tab sync", { added, removed, renamed, statusChanged, statusInitialized });
  }

  return { changed, added, removed, renamed, statusChanged, statusInitialized };
}

/**
 * Health check: try to ping every known topic by editing it with its current
 * label. If the topic was deleted in Telegram, editForumTopic returns
 * TOPIC_ID_INVALID — we recreate it.
 *
 * Called less frequently than the main sync (e.g. every N ticks) to avoid
 * hammering Telegram's API.
 */
export async function healthCheckTopics(
  chatId: number,
  tg: TelegramClient,
  state: DaemonState,
  deps?: WatcherDeps
): Promise<{ recreated: string[] }> {
  const knownTabs = state.known_tabs ?? {};
  const recreated: string[] = [];

  for (const [tabId, entry] of Object.entries(knownTabs)) {
    try {
      // Silent ping — no user-visible notification, but fails if thread was deleted.
      await tg.sendChatAction(chatId, entry.thread_id);
      // Topic exists — make sure deps.map is in sync (it may have been recreated
      // by a previous watcher run that updated state but not in-memory map).
      if (deps && !deps.map.has(entry.thread_id)) {
        const panes = deps?.getAgents?.() ?? getAgents();
        const pane = panes.find((p) => p.tab_id === tabId);
        if (pane) {
          const mapping = {
            pane_id: pane.pane_id,
            label: entry.label,
            agent: pane.agent,
            created_at: new Date().toISOString(),
          };
          state.thread_mappings[entry.thread_id] = mapping;
          deps.map.set(entry.thread_id, mapping);
          log.info("watcher: re-bound existing topic to deps.map", {
            tabId,
            threadId: entry.thread_id,
            label: entry.label,
          });
        } else {
          log.warn("watcher: pane not found for known tab", { tabId });
        }
      }
    } catch (err: any) {
      if (err.message?.includes("TOPIC_ID_INVALID")) {
        // Topic was deleted — recreate it. We need the pane info to seed.
        const panes = deps?.getAgents?.() ?? getAgents();
        const pane = panes.find((p) => p.tab_id === tabId);
        const label = pane ? topicNameForPane(pane) : entry.label;
        try {
          const newThreadId = await tg.createForumTopic(chatId, label);
          knownTabs[tabId] = { label, thread_id: newThreadId };
          if (pane) {
            const newMapping = {
              pane_id: pane.pane_id,
              label,
              agent: pane.agent,
              created_at: new Date().toISOString(),
            };
            state.thread_mappings[newThreadId] = newMapping;
            deps?.map.set(newThreadId, newMapping);
          }
          delete state.thread_mappings[entry.thread_id];
          deps?.map.delete(entry.thread_id);
          recreated.push(`${label} (tab ${tabId})`);
        } catch (err2: any) {
          log.warn("watcher: healthCheck recreate failed", {
            tabId,
            error: err2.message,
          });
        }
      } else {
        log.warn("watcher: healthCheck edit failed", {
          tabId,
          error: err.message,
        });
      }
    }
  }

  if (recreated.length > 0) {
    log.info("watcher: healthCheck recreated", { recreated });
  }
  return { recreated };
}

/**
 * Start the watcher loop. Polls every `intervalMs` and calls syncTabs.
 * Stops when the abort signal fires.
 */
export function startWatcher(
  chatId: number,
  tg: TelegramClient,
  state: DaemonState,
  saveState: () => void,
  intervalMs: number = 30_000,
  abortSignal?: AbortSignal,
  deps?: WatcherDeps
): void {
  let tickCount = 0;
  const thinkingTracker = deps?.thinkingTracker ?? new ThinkingRelayTracker();
  const watcherDeps = deps ? { ...deps, thinkingTracker } : undefined;
  const HEALTH_CHECK_EVERY = 2; // every 2 ticks (2 * 30s = 1min)
  const tick = async () => {
    try {
      tickCount++;
      const result = await syncTabs(chatId, tg, state, watcherDeps);
      if (result.changed) saveState();
      // Health check less frequently: pings every known topic to detect deleted ones
      let recreated: string[] = [];
      let healthCheckRan = false;
      if (tickCount % HEALTH_CHECK_EVERY === 0) {
        healthCheckRan = true;
        const hc = await healthCheckTopics(chatId, tg, state, deps);
        recreated = hc.recreated;
        if (recreated.length > 0) saveState();
      }
      // Log every tick at debug level so we can verify it's actually running
      log.debug("watcher: tick", {
        added: result.added.length,
        removed: result.removed.length,
        renamed: result.renamed.length,
        statusChanged: result.statusChanged.length,
        statusInitialized: result.statusInitialized,
        recreated: recreated.length,
        healthCheckRan,
        knownTabs: Object.keys(state.known_tabs ?? {}).length,
      });
    } catch (err: any) {
      log.error("watcher: sync error", { error: err.message });
    }
  };

  // Run an initial sync immediately
  tick();

  const handle = setInterval(tick, intervalMs);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => clearInterval(handle));
  }
  log.info("watcher: started", { intervalMs });
}