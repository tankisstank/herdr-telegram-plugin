import { Bot, type Context, InlineKeyboard } from "grammy";
import type { PaneInfo, ThreadMapping } from "./types.js";
import { getAgents, readPane, sendText, submitText, sendEscape, sendInterrupt, sendKeys } from "./herdr-client.js";
import { findMapping } from "./mapping.js";
import { isPaired } from "./pairing.js";
import type { DaemonState } from "./types.js";
import { loadState, saveState } from "./state.js";
import { cleanPaneOutput, stripStatusBar } from "./wait-loop.js";
import type { FollowManager } from "./follow-manager.js";

export function formatAgentList(panes: PaneInfo[], map: Map<number, ThreadMapping>): string {
  if (panes.length === 0) return "No agents active.";
  const lines = ["Agents:"];
  for (const p of panes) {
    let threadId = "?";
    for (const [tid, m] of map.entries()) {
      if (m.pane_id === p.pane_id) { threadId = String(tid); break; }
    }
    lines.push(`  ${p.label} (${p.agent}, ${p.status}) — topic ${threadId}`);
  }
  return lines.join("\n");
}

export function formatStatus(opts: {
  uptime: string;
  paired: boolean;
  panesCount: number;
  follows?: Array<{
    threadId: number;
    mapping: ThreadMapping;
    expiresAt: number;
    timeoutMs: number;
    now: number;
  }>;
}): string {
  const lines = [
    `Bridge uptime: ${opts.uptime}`,
    `Paired: ${opts.paired ? "yes" : "no"}`,
    `Active panes: ${opts.panesCount}`,
  ];
  if (opts.follows && opts.follows.length > 0) {
    lines.push("");
    lines.push("Active follows:");
    for (const f of opts.follows) {
      const label =
        f.timeoutMs === 0
          ? "manual (no timeout)"
          : `${Math.max(0, Math.ceil((f.expiresAt - f.now) / 60_000))} min left`;
      lines.push(`  thread ${f.threadId} (${f.mapping.label}) — ${label}`);
    }
  }
  return lines.join("\n");
}

export interface CommandDeps {
  map: Map<number, ThreadMapping>;
  stateDir: string;
  chatId: number;
  startTime: number;
  saveMappings: () => void;
  /** Bot-created topic registry (for dedup). Mutated in-place by reconcile. */
  knownTopics?: Record<number, { name: string; created_at: string }>;
  /** Stops the tab watcher (called on /unpair). */
  stopWatcher?: () => void;
  /** Optional dispatcher, used to hint when a pane is mid-turn and to
   *  abort the currently running turn when /stop is invoked. */
  turns?: { isBusy(paneId: string): boolean; abort(paneId: string): boolean };
  /** Optional subscription registry. /follow registers, /unfollow removes. */
  follows?: FollowManager;
  /** Default minutes when /follow is invoked without an explicit argument. */
  follows_default_minutes?: number;
  /** Optional hook called by /follow after registering a subscription, so
   *  the daemon can spawn the background poll loop. */
  onFollowStart?: (threadId: number) => void;
  /** Optional hook called by /unfollow after dropping a subscription, so
   *  the daemon can stop the background poll loop. */
  onFollowStop?: (threadId: number) => void;
  /** Start a full observed turn, used by /reply and picker-driven free text. */
  startAgentTurn?: (mapping: ThreadMapping, threadId: number, text: string) => void;
}

/** Format the body of a /last readback. Pure function: easy to unit-test. */
export function formatLastReadback(opts: {
  mapping: ThreadMapping;
  rawPane: string;
  busy: boolean;
  now: () => string;
  truncateAt: number;
}): string {
  const cleaned = cleanPaneOutput(stripStatusBar(opts.rawPane));
  const truncated =
    cleaned.length > opts.truncateAt
      ? `(... ${cleaned.length - opts.truncateAt} chars omitted)\n${cleaned.slice(-opts.truncateAt)}`
      : cleaned;
  const ts = opts.now();
  const busyHint = opts.busy
    ? "\n\n_(painel imprimindo — pode estar parcial)_"
    : "";
  return `[${ts}] ${opts.mapping.label}\n\n${truncated}${busyHint}`;
}

function findPaneByQuery(panes: PaneInfo[], query: string): PaneInfo | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return panes.find((p) =>
    p.pane_id.toLowerCase() === q ||
    p.label.toLowerCase() === q ||
    p.label.toLowerCase().includes(q) ||
    p.agent.toLowerCase().includes(q)
  );
}

function mappingForPane(map: Map<number, ThreadMapping>, paneId: string): { threadId: number; mapping: ThreadMapping } | undefined {
  for (const [threadId, mapping] of map.entries()) {
    if (mapping.pane_id === paneId) return { threadId, mapping };
  }
  return undefined;
}

function agentPicker(action: "read" | "send" | "reply" | "trust" | "interrupt", panes: PaneInfo[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const pane of panes.slice(0, 12)) {
    keyboard.text(`${pane.label} (${pane.agent}, ${pane.status})`, `agent|${action}|${pane.pane_id}`).row();
  }
  return keyboard;
}

function nativeModelPickerKeyboard(paneId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Up", `tui|up|${paneId}`)
    .text("Down", `tui|down|${paneId}`)
    .row()
    .text("Choose", `tui|enter|${paneId}`)
    .text("Cancel", `tui|escape|${paneId}`);
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `(... ${text.length - maxChars} chars omitted)\n${text.slice(-maxChars)}`;
}
export function registerCommands(bot: Bot<Context>, deps: CommandDeps): void {
  const pendingTargets = new Map<number, { paneId: string; mode: "send" | "reply" }>();

  async function readPaneForReply(ctx: Context, paneId: string): Promise<void> {
    const selected = mappingForPane(deps.map, paneId);
    if (!selected) {
      await ctx.reply("No bound topic for this agent. Use /reconcile or /bind first.");
      return;
    }
    let raw: string;
    try {
      raw = readPane(paneId, 4_000);
    } catch (err: any) {
      await ctx.reply(`Failed to read pane: ${err.message}`);
      return;
    }
    const cleaned = cleanPaneOutput(stripStatusBar(raw));
    const body = truncateMiddle(cleaned || "(empty)", 3000);
    const msg = await ctx.reply(`${selected.mapping.label}:\n\n${body}\n\nReply to this message, or type your next message here, to send it to this agent.`);
    pendingTargets.set(ctx.chat!.id, { paneId, mode: "reply" });
    pendingTargets.set(msg.message_id, { paneId, mode: "reply" });
  }

  async function sendToPaneFromText(ctx: Context, paneId: string, text: string, mode: "send" | "reply"): Promise<void> {
    const selected = mappingForPane(deps.map, paneId);
    if (!selected) {
      await ctx.reply("No bound topic for this agent. Use /reconcile or /bind first.");
      return;
    }
    if (mode === "reply" && deps.startAgentTurn) {
      deps.startAgentTurn(selected.mapping, selected.threadId, text);
      await ctx.reply(`Sent to ${selected.mapping.label}. Watching the bound topic for the response.`);
      return;
    }
    sendText(paneId, text, selected.mapping.agent);
    await ctx.reply(`Sent to ${selected.mapping.label}.`);
  }

  async function handleAgentPicker(ctx: Context, action: string, paneId: string): Promise<void> {
    const selected = mappingForPane(deps.map, paneId);
    if (!selected) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "No bound topic." });
      else await ctx.reply("No bound topic for this agent. Use /reconcile or /bind first.");
      return;
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    if (action === "read") {
      let raw: string;
      try {
        raw = readPane(paneId, 4_000);
      } catch (err: any) {
        await ctx.reply(`Failed to read pane: ${err.message}`);
        return;
      }
      const cleaned = cleanPaneOutput(stripStatusBar(raw));
      const msg = await ctx.reply(`${selected.mapping.label}:\n\n${truncateMiddle(cleaned || "(empty)", 3500)}`);
      pendingTargets.set(msg.message_id, { paneId, mode: "reply" });
      return;
    }
    if (action === "reply") {
      await readPaneForReply(ctx, paneId);
      return;
    }
    if (action === "send") {
      pendingTargets.set(ctx.chat!.id, { paneId, mode: "send" });
      await ctx.reply(`Ready. Type your message to send to ${selected.mapping.label}.`);
      return;
    }
    if (action === "trust") {
      sendText(paneId, "trust, always allow", selected.mapping.agent);
      await ctx.reply(`Trusted ${selected.mapping.label}.`);
      return;
    }
    if (action === "interrupt") {
      sendInterrupt(paneId);
      deps.turns?.abort(paneId);
      await ctx.reply(`Interrupted ${selected.mapping.label}.`);
    }
  }

  if (typeof (bot as any).on === "function") {
    bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("agent|")) {
      const [, action, paneId] = data.split("|");
      await handleAgentPicker(ctx, action, paneId);
      return;
    }
    if (!data.startsWith("tui|")) return next();
    const [, action, paneId] = data.split("|");
    const key = { up: "Up", down: "Down", enter: "Enter", escape: "Escape" }[action];
    if (!key || !mappingForPane(deps.map, paneId)) {
      await ctx.answerCallbackQuery({ text: "Model picker is no longer available." });
      return;
    }
    sendKeys(paneId, key);
    await ctx.answerCallbackQuery();
  });

  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return next();
    const byReply = ctx.message.reply_to_message?.message_id !== undefined
      ? pendingTargets.get(ctx.message.reply_to_message.message_id)
      : undefined;
    const target = byReply ?? pendingTargets.get(ctx.chat.id);
    if (!target) return next();
    pendingTargets.delete(ctx.chat.id);
    await sendToPaneFromText(ctx, target.paneId, text, target.mode);
    });
  }

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/help — this message",
        "/agents — list agents with status and bound threads",
        "/read [agent] — read last output and allow reply",
        "/reply [agent] — read output, then type a response",
        "/send [agent] [text] — send text to an agent",
        "/bind <pane-label> — bind this thread to a pane (use in a new thread)",
        "/unbind — unbind this thread",
        "/topics — list bound topic ids (use /delete <id> to remove)",
        "/delete <id> — delete a forum topic by its thread id",
        "/unpair — reset pairing (re-authorize with /pair)",
        "/status — bridge uptime and connection info (incl. active follows)",
        "/interrupt — send Ctrl+C to this thread's agent (hard interrupt)",
        "/stop — send ESC to this thread's agent (soft cancel of current operation)",
        "/submit — submit text already present in this topic's agent composer",
        "/trust — send 'trust, always allow' to this thread's agent",
        "/model — open Codex's model picker for this idle agent",
        "/reasoning — open Codex's reasoning picker for this idle agent",
        "/digest — today's activity (coming soon)",
        "/last — show current pane output (read-only, no turn)",
        "/follow [minutes] — keep listening after the agent responds; expires N min after your last message (default 30, 0 = manual)",
        "/unfollow — stop listening on this thread",
        "",
        "Plain text in any thread is sent to that thread's pane.",
      ].join("\n")
    );
  });

  bot.command("agents", async (ctx) => {
    const panes = getAgents();
    await ctx.reply(formatAgentList(panes, deps.map));
  });

  bot.command("read", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const panes = getAgents();
    if (!arg) {
      if (panes.length === 0) { await ctx.reply("No agents active."); return; }
      await ctx.reply("Read which agent?", { reply_markup: agentPicker("read", panes) });
      return;
    }
    const pane = findPaneByQuery(panes, arg);
    if (!pane) { await ctx.reply(`No agent matching "${arg}". Use /agents to see list.`); return; }
    await handleAgentPicker(ctx, "read", pane.pane_id);
  });

  bot.command("reply", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const panes = getAgents();
    if (!arg) {
      if (panes.length === 0) { await ctx.reply("No agents active."); return; }
      await ctx.reply("Reply to which agent?", { reply_markup: agentPicker("reply", panes) });
      return;
    }
    const pane = findPaneByQuery(panes, arg);
    if (!pane) { await ctx.reply(`No agent matching "${arg}". Use /agents to see list.`); return; }
    await readPaneForReply(ctx, pane.pane_id);
  });

  bot.command("send", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const panes = getAgents();
    if (!arg) {
      if (panes.length === 0) { await ctx.reply("No agents active."); return; }
      await ctx.reply("Send to which agent?", { reply_markup: agentPicker("send", panes) });
      return;
    }
    const parts = arg.split(/\s+/);
    const pane = findPaneByQuery(panes, parts[0]);
    if (!pane) { await ctx.reply(`No agent matching "${parts[0]}". Use /agents to see list.`); return; }
    const text = parts.slice(1).join(" ").trim();
    if (!text) {
      pendingTargets.set(ctx.chat.id, { paneId: pane.pane_id, mode: "send" });
      await ctx.reply(`Ready. Type your message to send to ${pane.label}.`);
      return;
    }
    await sendToPaneFromText(ctx, pane.pane_id, text, "send");
  });
  bot.command("status", async (ctx) => {
    const state = loadState(deps.stateDir);
    const uptime = Math.floor((Date.now() - deps.startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    const now = Date.now();
    const followsSnapshot = deps.follows
      ? deps.follows.listAll().map((f) => ({
          threadId: f.threadId,
          mapping: f.mapping,
          expiresAt: f.expiresAt,
          timeoutMs: f.timeoutMs,
          now,
        }))
      : undefined;
    await ctx.reply(formatStatus({
      uptime: `${h}h ${m}m ${s}s`,
      paired: isPaired(state),
      panesCount: deps.map.size,
      follows: followsSnapshot,
    }));
  });

  bot.command("interrupt", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    if (arg) {
      const pane = findPaneByQuery(getAgents(), arg);
      if (!pane) { await ctx.reply(`No agent matching "${arg}". Use /agents to see list.`); return; }
      await handleAgentPicker(ctx, "interrupt", pane.pane_id);
      return;
    }
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      const panes = getAgents().filter((p) => ["working", "blocked"].includes(p.status));
      if (panes.length === 0) { await ctx.reply("No active agents to interrupt."); return; }
      await ctx.reply("Interrupt which agent?", { reply_markup: agentPicker("interrupt", panes) });
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendInterrupt(mapping.pane_id);
    deps.turns?.abort(mapping.pane_id);
    await ctx.reply(`Interrupted ${mapping.label}`);
  });

  bot.command("stop", async (ctx) => {
    // Send ESC to the pane — same as pressing ESC in the agent's TUI.
    // Soft-cancels the current operation (tool call, generation) without
    // killing the agent process. For a hard interrupt, use /interrupt.
    //
    // Uses herdr agent send-keys with the named 'Escape' key. Raw ESC
    // bytes sent as terminal text are interpreted as the start of an ANSI CSI
    // sequence and silently swallowed; agent send-keys routes the named key
    // through the terminal input pipeline and triggers the real handler.
    //
    // Also aborts the in-flight turn so queued user messages can proceed.
    // Without this, a stuck turn (e.g. agent outputting in a way that
    // never stabilises for the coordinator's stability window) blocks
    // every subsequent message for up to max_total_wait_s.
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendEscape(mapping.pane_id);
    const wasBusy = deps.turns?.abort(mapping.pane_id) ?? false;
    await ctx.reply(
      wasBusy
        ? `Stopped ${mapping.label} and released the in-progress turn. The queue will now process your pending messages.`
        : `Stopped ${mapping.label}.`
    );
  });

  bot.command("trust", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    if (arg) {
      const pane = findPaneByQuery(getAgents(), arg);
      if (!pane) { await ctx.reply(`No agent matching "${arg}". Use /agents to see list.`); return; }
      await handleAgentPicker(ctx, "trust", pane.pane_id);
      return;
    }
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      const panes = getAgents().filter((p) => p.status === "blocked");
      if (panes.length === 0) { await ctx.reply("No blocked agents."); return; }
      await ctx.reply("Trust which blocked agent?", { reply_markup: agentPicker("trust", panes) });
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) { await ctx.reply("No pane for this topic."); return; }
    sendText(mapping.pane_id, "trust, always allow", mapping.agent);
    await ctx.reply(`Trusted ${mapping.label}`);
  });

  bot.command("submit", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Use /submit inside an agent topic.");
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    submitText(mapping.pane_id, mapping.agent);
    await ctx.reply(`Submitted the current composer for ${mapping.label}.`);
  });

  async function openNativeModelPicker(ctx: Context, label: "model" | "reasoning"): Promise<void> {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply(`Send /${label} inside an agent topic.`);
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    const pane = getAgents().find((candidate) => candidate.pane_id === mapping.pane_id);
    if (deps.turns?.isBusy(mapping.pane_id) || (pane && pane.status !== "idle")) {
      await ctx.reply(`Wait for ${mapping.label} to become idle before changing its ${label}.`);
      return;
    }
    // Codex exposes model and reasoning selection through its native /model
    // picker. Keep the catalog in Codex so it matches the signed-in account.
    sendText(mapping.pane_id, "/model", mapping.agent);
    // The TUI is the source of truth for account-specific model availability.
    // Relay its rendered picker so Telegram users can see names and the
    // current highlight instead of navigating blind with Up/Down.
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    let pickerView = "";
    try {
      pickerView = cleanPaneOutput(stripStatusBar(readPane(mapping.pane_id, 80)));
    } catch {
      // Keep the native controls available even if Herdr cannot read a redraw.
    }
    await ctx.reply(
      [
        label === "model"
          ? "Codex model picker is open."
          : "Codex model and reasoning picker is open. Reasoning choices are Low, Medium, or High.",
        pickerView
          ? `\nAvailable choices (› is selected):\n\n${truncateMiddle(pickerView, 3000)}`
          : "\nThe picker is redrawing. Use /last to inspect the current choices.",
      ].join(""),
      { reply_markup: nativeModelPickerKeyboard(mapping.pane_id) }
    );
  }

  bot.command("model", async (ctx) => {
    await openNativeModelPicker(ctx, "model");
  });

  bot.command("reasoning", async (ctx) => {
    await openNativeModelPicker(ctx, "reasoning");
  });

  bot.command("last", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /last inside a thread.");
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    let raw: string;
    try {
      // Match wait-loop's max scan lines (ScreenScrapeWrapper expands up to 4000)
      // so /last can show recent output that scrolled off a 500-line buffer.
      raw = readPane(mapping.pane_id, 4_000);
    } catch (err: any) {
      await ctx.reply(`Failed to read pane: ${err.message}`);
      return;
    }
    const body = formatLastReadback({
      mapping,
      rawPane: raw,
      busy: deps.turns?.isBusy(mapping.pane_id) ?? false,
      now: () => new Date().toISOString(),
      truncateAt: 3000,
    });
    await ctx.reply(body);
  });

  bot.command("bind", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply(
        "Send /bind inside a thread (tap + or New Thread in the chat first)."
      );
      return;
    }
    const arg = (ctx.match ?? "").trim();
    const panes = getAgents();

    if (!arg) {
      const available = panes
        .map((p) => `- ${p.label} (${p.agent}, ${p.status})`)
        .join("\n");
      await ctx.reply(
        `Usage: /bind <pane-label>\n\nAvailable panes:\n${available}\n\nExample: /bind analisedefiis`
      );
      return;
    }

    const pane = panes.find(
      (p) =>
        p.label.toLowerCase() === arg.toLowerCase() ||
        p.pane_id.toLowerCase() === arg.toLowerCase()
    );
    if (!pane) {
      await ctx.reply(
        `Pane "${arg}" not found. Use /bind with no args to see available panes.`
      );
      return;
    }

    deps.map.set(threadId, {
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
      created_at: new Date().toISOString(),
    });
    deps.saveMappings();
    await ctx.reply(
      `Bound this thread to ${pane.label} (${pane.agent}). Send a message to start.`
    );
  });

  bot.command("unbind", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /unbind inside a thread.");
      return;
    }
    const mapping = deps.map.get(threadId);
    if (!mapping) {
      await ctx.reply("This thread is not bound.");
      return;
    }
    deps.map.delete(threadId);
    deps.saveMappings();
    await ctx.reply(`Unbound thread from ${mapping.label}.`);
  });

  bot.command("topics", async (ctx) => {
    if (deps.map.size === 0) {
      await ctx.reply("No bound topics.");
      return;
    }
    const lines: string[] = ["Bound topics:"];
    for (const [tid, m] of deps.map.entries()) {
      lines.push(`  #${tid} → ${m.label} (${m.agent})`);
    }
    await ctx.reply(lines.join("\n") + "\n\nUse /delete <id> to remove a topic by id.");
  });

  bot.command("delete", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const threadId = parseInt(arg, 10);
    if (!threadId || isNaN(threadId)) {
      await ctx.reply("Usage: /delete <thread_id>\n\nGet thread ids from /topics or Telegram UI (long-press a topic to see its id).");
      return;
    }
    const wasBound = deps.map.has(threadId);
    try {
      await ctx.api.deleteForumTopic(ctx.chat.id, threadId);
      deps.map.delete(threadId);
      if (deps.knownTopics) delete deps.knownTopics[threadId];
      deps.saveMappings();
      await ctx.reply(`Deleted topic #${threadId}.${wasBound ? " (was bound)" : ""}`);
    } catch (err: any) {
      await ctx.reply(`Failed to delete #${threadId}: ${err.message}`);
    }
  });

  bot.command("follow", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /follow inside a thread.");
      return;
    }
    if (!deps.follows) {
      await ctx.reply("Subscriptions not available.");
      return;
    }
    const mapping = findMapping(threadId, deps.map);
    if (!mapping) {
      await ctx.reply("No pane for this topic.");
      return;
    }
    const arg = (ctx.match ?? "").trim();
    let minutes: number;
    if (arg === "") {
      minutes = deps.follows_default_minutes ?? 30;
    } else {
      const parsed = parseInt(arg, 10);
      if (isNaN(parsed) || parsed < 0) {
        await ctx.reply("Usage: /follow [minutes] — minutes must be a non-negative integer (0 = no timeout).");
        return;
      }
      minutes = parsed;
    }
    const sub = deps.follows.subscribe(threadId, mapping, minutes);
    deps.onFollowStart?.(threadId);
    // React to the user's /follow message so they see confirmation inline.
    try {
      await ctx.api.setMessageReaction(ctx.chat!.id, ctx.message!.message_id, [{ type: "emoji", emoji: "👀" }]);
    } catch {
      // reactions may be unavailable in some chats; ignore.
    }
    const hint =
      minutes === 0
        ? "no timeout — /unfollow to stop"
        : `expires in ${minutes} min from your last message`;
    await ctx.reply(`Following ${mapping.label}. ${hint}.`);
  });

  bot.command("unfollow", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Send /unfollow inside a thread.");
      return;
    }
    if (!deps.follows) {
      await ctx.reply("Subscriptions not available.");
      return;
    }
    const had = deps.follows.remove(threadId);
    deps.onFollowStop?.(threadId);
    // Clear the 👀 reaction if we had set one.
    if (had) {
      try {
        await ctx.api.setMessageReaction(ctx.chat!.id, ctx.message!.message_id, []);
      } catch {
        // ignore
      }
    }
    await ctx.reply(had ? "Unfollowed." : "Was not following this thread.");
  });
}
