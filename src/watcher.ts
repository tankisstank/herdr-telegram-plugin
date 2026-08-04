import { createHash } from "node:crypto";
import type { DaemonState, PaneInfo, ThreadMapping } from "./types.js";
import type { TelegramClient } from "./telegram-client.js";
import { getAgents, readPane } from "./herdr-client.js";
import { createLogger } from "./logger.js";
import { topicNameForPane } from "./topic-names.js";
import { ThinkingRelayTracker } from "./thinking-relay.js";
import { parseInteractivePrompt, type ParsedInteractivePrompt as InteractivePrompt } from "./prompt-parser.js";
import { formatApprovalMessage } from "./telegram-format.js";
import { extractFinalSnapshot, splitFinalSnapshot } from "./final-snapshot.js";

const log = createLogger("watcher");

interface WatcherDeps {
  map: Map<number, ThreadMapping>;
  thinkingTracker?: ThinkingRelayTracker;
  isPaneObserved?: (paneId: string) => boolean;
  getAgents?: () => PaneInfo[];
  readPane?: (paneId: string, lines: number) => string;
}

function optionButtonText(option: InteractivePrompt["options"][number]): string {
  const normalized = option.label.toLowerCase();
  if (/yes|approve|proceed/.test(normalized) && !/again|always|don't ask/.test(normalized)) return "Yes";
  if (/always allow in this conversation/.test(normalized)) return "Allow here";
  if (/persist to settings|always allow for commands/.test(normalized)) return "Always allow";
  if (/always|don't ask|dont ask|all|trust/.test(normalized)) return "All";
  if (/no|cancel|different|esc/.test(normalized)) return option.wantsComment ? "No + comment" : "No";
  return option.label.length > 28 ? option.label.slice(0, 25) + "..." : option.label;
}

function promptKeyboard(prompt: InteractivePrompt, promptId: string) {
  const options = prompt.options;
  const selectedIndex = prompt.selectedIndex ?? 1;
  const buttons = options.slice(0, 6).map((option) => ({
    text: optionButtonText(option),
    callback_data: `${option.wantsComment ? "respc" : "resp"}|${promptId}|${option.key.startsWith("index:") ? `${option.key}:${selectedIndex}` : option.key}`,
  }));
  return { inline_keyboard: buttons.length ? [buttons] : [[
    { text: "Yes", callback_data: `resp|${promptId}|yes` },
    { text: "All", callback_data: `resp|${promptId}|all` },
    { text: "No + comment", callback_data: `respc|${promptId}|esc` },
  ]] };
}

function promptFingerprint(prompt: InteractivePrompt): string | undefined {
  if (prompt.confidence !== "high" || !prompt.text || prompt.options.length === 0) return undefined;
  const normalized = JSON.stringify({
    text: prompt.text.replace(/\s+/g, " ").trim(),
    options: prompt.options.map(({ index, label, key, wantsComment }) => ({
      index,
      label: label.replace(/\s+/g, " ").trim(),
      key,
      wantsComment,
    })),
  });
  return createHash("sha256").update(normalized).digest("hex");
}

function blockedPrompt(
  pane: PaneInfo,
  paneReader: (paneId: string, lines: number) => string = readPane,
): InteractivePrompt {
  try {
    const compact = parseInteractivePrompt(paneReader(pane.pane_id, 160));
    if (compact.confidence === "high") return compact;
    return parseInteractivePrompt(paneReader(pane.pane_id, 600));
  } catch {
    return { adapter: "generic", text: "", options: [], confidence: "low" };
  }
}

function blockedMessage(
  pane: PaneInfo,
  previous: PaneInfo["status"],
  prompt: InteractivePrompt,
  fingerprint: string,
): { text: string; reply_markup: ReturnType<typeof promptKeyboard> } {
  const body = prompt.text ? `\n\n${prompt.text}` : "";
  const heading = previous === "blocked"
    ? `${pane.label} has a new input request.`
    : `${pane.label} needs input.`;
  return {
    text: formatApprovalMessage(heading, prompt.text),
    reply_markup: promptKeyboard(prompt, fingerprint.slice(0, 12)),
  };
}

function clearBlockedPromptCandidate(tab: NonNullable<DaemonState["known_tabs"]>[string]): void {
  delete tab.blocked_prompt_candidate_fingerprint;
  delete tab.blocked_prompt_candidate_count;
}

function acceptBlockedPromptReplacement(
  tab: NonNullable<DaemonState["known_tabs"]>[string],
  fingerprint: string,
): boolean {
  if (!tab.last_blocked_prompt_fingerprint) return true;
  if (tab.last_blocked_prompt_fingerprint === fingerprint) {
    clearBlockedPromptCandidate(tab);
    return false;
  }
  if (tab.blocked_prompt_candidate_fingerprint === fingerprint) {
    tab.blocked_prompt_candidate_count = (tab.blocked_prompt_candidate_count ?? 1) + 1;
  } else {
    tab.blocked_prompt_candidate_fingerprint = fingerprint;
    tab.blocked_prompt_candidate_count = 1;
  }
  if (tab.blocked_prompt_candidate_count < 2) return false;
  clearBlockedPromptCandidate(tab);
  return true;
}

/**
 * Watch for herdr tab changes and sync topics in Telegram.
 * - New agent pane (tab_id not in known_tabs) → create topic
 * - Missing agent pane (tab_id in known_tabs but not in current list) → retain topic/mapping
 * - Renamed tab (label changed) → edit topic name
 *
 * Returns the updated known_tabs and a log of changes for the caller to persist.
 */
export async function syncTabs(
  chatId: number,
  tg: TelegramClient,
  state: DaemonState,
  deps?: WatcherDeps
): Promise<{ changed: boolean; added: string[]; removed: string[]; renamed: string[]; statusChanged: string[]; promptsSent: string[]; statusInitialized: number }> {
  const panes = deps?.getAgents?.() ?? getAgents();
  const knownTabs = state.known_tabs ?? {};

  const currentTabIds = new Set(panes.map((p) => p.tab_id));
  const knownTabIds = new Set(Object.keys(knownTabs));

  const added: string[] = [];
  const removed: string[] = [];
  const renamed: string[] = [];
  const statusChanged: string[] = [];
  const promptsSent: string[] = [];
  let statusInitialized = 0;

  // Step 1: Retain topics for tabs that are temporarily absent. Herdr can
  // return a partial pane list while a workspace changes focus or restarts.
  // Deleting on one missing sample loses the user's topic and makes messages
  // sent to the old topic silently unbound. Retained topics act as history for
  // permanently closed tabs and are re-used if the same tab returns.
  for (const tabId of knownTabIds) {
    if (!currentTabIds.has(tabId)) {
      const entry = knownTabs[tabId];
      log.info("watcher: pane temporarily absent; retaining topic mapping", {
        tabId,
        threadId: entry.thread_id,
        label: entry.label,
      });
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
        state.known_topics ??= {};
        state.known_topics[threadId] = { name: topicName, created_at: new Date().toISOString() };
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
        if (state.known_topics?.[existing.thread_id]) state.known_topics[existing.thread_id].name = topicName;
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
        const previousStatus = existing.status;
        const raw = (deps.readPane ?? readPane)(pane.pane_id, 400);
        const blocks = deps.thinkingTracker.capture(
          pane.pane_id,
          raw,
          !deps.isPaneObserved?.(pane.pane_id),
        );
        const observed = Boolean(deps.isPaneObserved?.(pane.pane_id));
        const fullSnapshot = extractFinalSnapshot(raw);
        const completed = !observed &&
          (pane.status === "idle" || pane.status === "done") &&
          (previousStatus === "working" || previousStatus === "blocked") &&
          fullSnapshot.length > 0;
        if (completed) {
          const summary = blocks.length > 0
            ? `✅ Hoàn tất\n\n${blocks.join("\n\n")}`
            : "✅ Hoàn tất";
          const messageId = await tg.sendMessage(chatId, existing.thread_id, summary);
          const fullChunks = splitFinalSnapshot(fullSnapshot || summary);
          if (fullChunks.length > 0 && "editMessageText" in tg) {
            await tg.editMessageText(
              chatId,
              existing.thread_id,
              messageId,
              `✅ Hoàn tất\n\n${fullChunks[0]}`,
            );
            for (const chunk of fullChunks.slice(1)) {
              await tg.sendMessage(chatId, existing.thread_id, chunk);
            }
          } else {
            for (const chunk of fullChunks.slice(1)) {
              await tg.sendMessage(chatId, existing.thread_id, chunk);
            }
          }
        } else if (!observed && (pane.status === "working" || pane.status === "blocked")) {
          for (const block of blocks) {
            await tg.sendMessage(chatId, existing.thread_id, block, {
              disable_notification: true,
            });
          }
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
    let statusTransition = false;
    if (previous === undefined) {
      existing.status = pane.status;
      statusInitialized++;
    } else if (previous !== pane.status) {
      existing.status = pane.status;
      statusTransition = true;
      statusChanged.push(`${pane.label}: ${previous} -> ${pane.status}`);
    }

    try {
      if (pane.status === "blocked") {
        if (statusTransition && previous !== "blocked") {
          delete existing.last_blocked_prompt_fingerprint;
          delete existing.last_blocked_prompt_message_id;
          clearBlockedPromptCandidate(existing);
        }
        const prompt = blockedPrompt(pane, deps?.readPane);
        const fingerprint = promptFingerprint(prompt);
        if (fingerprint && acceptBlockedPromptReplacement(existing, fingerprint)) {
          if (existing.last_blocked_prompt_message_id && "clearMessageKeyboard" in tg) {
            try {
              await tg.clearMessageKeyboard(chatId, existing.last_blocked_prompt_message_id);
            } catch {
              // Callback fingerprint validation still rejects an old keyboard.
            }
          }
          const message = blockedMessage(pane, previous ?? "unknown", prompt, fingerprint);
          const messageId = await tg.sendMessage(
            chatId,
            existing.thread_id,
            message.text,
            { reply_markup: message.reply_markup, parse_mode: "HTML" }
          );
          existing.last_blocked_prompt_fingerprint = fingerprint;
          existing.last_blocked_prompt_message_id = messageId;
          promptsSent.push(pane.label);
        }
      } else {
        delete existing.last_blocked_prompt_fingerprint;
        delete existing.last_blocked_prompt_message_id;
        clearBlockedPromptCandidate(existing);
        // Normal working/idle/done transitions are represented by progress or
        // the final message. Keep status messages for blocked and errors only.
      }
    } catch (err: any) {
      log.warn("watcher: failed to send status update", {
        pane: pane.label,
        status: pane.status,
        error: err.message,
      });
    }
  }

  state.known_tabs = knownTabs;
  const changed = added.length + removed.length + renamed.length + statusChanged.length + promptsSent.length + statusInitialized > 0;

  if (changed) {
    log.info("watcher: tab sync", { added, removed, renamed, statusChanged, promptsSent, statusInitialized });
  }

  return { changed, added, removed, renamed, statusChanged, promptsSent, statusInitialized };
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
          state.known_topics ??= {};
          state.known_topics[newThreadId] = { name: label, created_at: new Date().toISOString() };
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
          delete state.known_topics?.[entry.thread_id];
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
  let tickRunning = false;
  let tickRequested = false;
  let stopped = false;
  const thinkingTracker = deps?.thinkingTracker ?? new ThinkingRelayTracker();
  const watcherDeps = deps ? { ...deps, thinkingTracker } : undefined;
  const HEALTH_CHECK_EVERY = 2; // every 2 ticks (2 * 30s = 1min)
  const tick = async () => {
    if (tickRunning) {
      tickRequested = true;
      return;
    }
    tickRunning = true;
    try {
      do {
      tickRequested = false;
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
        promptsSent: result.promptsSent.length,
        statusInitialized: result.statusInitialized,
        recreated: recreated.length,
        healthCheckRan,
        knownTabs: Object.keys(state.known_tabs ?? {}).length,
      });
      } while (tickRequested && !stopped);
    } catch (err: any) {
      log.error("watcher: sync error", { error: err.message });
    } finally {
      tickRunning = false;
    }
  };

  // Run an initial sync immediately
  tick();

  const handle = setInterval(tick, intervalMs);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      stopped = true;
      clearInterval(handle);
    });
  }
  log.info("watcher: started", { intervalMs });
}
