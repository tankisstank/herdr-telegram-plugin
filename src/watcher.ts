import { createHash } from "node:crypto";
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

function promptKeyboard(options: PromptOption[], promptId: string) {
  const buttons = options.slice(0, 6).map((option) => ({
    text: optionButtonText(option),
    callback_data: `${option.wantsComment ? "respc" : "resp"}|${promptId}|${option.key}`,
  }));
  return { inline_keyboard: buttons.length ? [buttons] : [[
    { text: "Yes", callback_data: `resp|${promptId}|yes` },
    { text: "All", callback_data: `resp|${promptId}|all` },
    { text: "No + comment", callback_data: `respc|${promptId}|esc` },
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
  const wantsComment = /tell .* differently|what to do differently|\bcomment\b|\breason\b|\bedit\b/i.test(label);
  return { index, label, key, wantsComment };
}

function extractInteractivePrompt(raw: string): InteractivePrompt {
  const allLines = raw.split("\n").map((line) => line.trimEnd());
  const optionLines: Array<{ line: string; index: number; option: PromptOption }> = [];
  const promptHeaderPattern = /^(Would you like|Do you want|Choose|Select|Which|How should|What should|Bạn có muốn|Hãy chọn|Chọn)/i;
  for (let i = 0; i < allLines.length; i++) {
    const option = parseOption(allLines[i]);
    if (option) optionLines.push({ line: allLines[i], index: i, option });
  }
  if (optionLines.length === 0) {
    const fallback = allLines.filter((line) => line.trim()).slice(-18).join("\n").trim();
    return { text: fallback.length > 1400 ? fallback.slice(-1400) : fallback, options: [] };
  }

  // Anchor to the newest question header. Long commands and option labels wrap
  // over several terminal lines, so physical line adjacency cannot delimit an
  // option group reliably.
  let start = -1;
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (promptHeaderPattern.test(allLines[i].trim())) {
      start = i;
      break;
    }
  }
  const currentOptions = start >= 0
    ? optionLines.filter((entry) => entry.index > start)
    : optionLines;
  if (currentOptions.length === 0) {
    const fallbackLines = start >= 0 ? allLines.slice(start) : allLines;
    const fallback = fallbackLines.filter((line) => line.trim()).slice(-18).join("\n").trim();
    return { text: fallback.length > 1400 ? fallback.slice(-1400) : fallback, options: [] };
  }

  const lastOptionIndex = currentOptions.at(-1)!.index;
  let end = lastOptionIndex + 1;
  let optionBlockEnd = end;
  for (let i = end; i < allLines.length; i++) {
    if (/Press enter|confirm|cancel/i.test(allLines[i])) {
      optionBlockEnd = i;
      end = i + 1;
      break;
    }
  }
  const trailingLines = allLines.slice(end).filter((line) => line.trim());
  if (trailingLines.some((line) => !/Press enter|confirm|cancel/i.test(line))) {
    const fallback = allLines.filter((line) => line.trim()).slice(-18).join("\n").trim();
    return { text: fallback.length > 1400 ? fallback.slice(-1400) : fallback, options: [] };
  }

  const firstOptionIndex = currentOptions[0].index;
  if (start < 0) {
    start = Math.max(0, firstOptionIndex - 12);
  }
  const parsedOptions = currentOptions.map((entry, index) => {
    const nextOptionIndex = currentOptions[index + 1]?.index ?? optionBlockEnd;
    const wrapped = allLines
      .slice(entry.index, nextOptionIndex)
      .filter((line) => line.trim())
      .map((line) => line.trim())
      .join(" ");
    return parseOption(wrapped) ?? entry.option;
  });

  const text = allLines
    .slice(start, end)
    .filter((line) => line.trim())
    .join("\n")
    .trim();
  return {
    text: text.length > 1800 ? text.slice(-1800) : text,
    options: parsedOptions,
  };
}

function promptFingerprint(prompt: InteractivePrompt): string | undefined {
  if (!prompt.text || prompt.options.length === 0) return undefined;
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
    return extractInteractivePrompt(paneReader(pane.pane_id, 160));
  } catch {
    return { text: "", options: [] };
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
    : `${pane.label} needs input (${previous} -> blocked).`;
  return {
    text: `${heading}${body}`,
    reply_markup: promptKeyboard(prompt.options, fingerprint.slice(0, 12)),
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

  // Step 1: Detect removed tabs
  for (const tabId of knownTabIds) {
    if (!currentTabIds.has(tabId)) {
      const entry = knownTabs[tabId];
      try {
        await tg.deleteForumTopic(chatId, entry.thread_id);
        delete state.thread_mappings[entry.thread_id];
        delete state.known_topics?.[entry.thread_id];
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
        }
        const prompt = blockedPrompt(pane, deps?.readPane);
        const fingerprint = promptFingerprint(prompt);
        if (fingerprint && fingerprint !== existing.last_blocked_prompt_fingerprint) {
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
            { reply_markup: message.reply_markup }
          );
          existing.last_blocked_prompt_fingerprint = fingerprint;
          existing.last_blocked_prompt_message_id = messageId;
          promptsSent.push(pane.label);
        }
      } else {
        delete existing.last_blocked_prompt_fingerprint;
        delete existing.last_blocked_prompt_message_id;
        if (statusTransition) {
          await tg.sendMessage(
            chatId,
            existing.thread_id,
            `Status: ${previous} -> ${pane.status}`,
            { disable_notification: true }
          );
        }
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
