const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BULLET_START = /^\s*•\s+\S/;
const MAX_RECENT_FINGERPRINTS = 200;
const NON_THINKING_PREFIX = /^(?:working\b|ran\b|running\b|edited\b|added\b|removed\b|created\b|updated plan\b|read\b|wrote\b|opened\b|searched\b|tested\b|checked\b|built\b|fixed\b|applied\b|moved\b|deleted\b|started\b|stopped\b)/i;

function normalizeSnapshot(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function appendedContent(previous: string, current: string): string {
  if (!previous || previous === current) return previous === current ? "" : current;
  if (current.startsWith(previous)) return current.slice(previous.length).replace(/^\n+/, "");

  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const maxOverlap = Math.min(previousLines.length, currentLines.length, 200);
  for (let size = maxOverlap; size > 0; size--) {
    const oldTail = previousLines.slice(-size).join("\n");
    const newHead = currentLines.slice(0, size).join("\n");
    if (oldTail === newHead) return currentLines.slice(size).join("\n");
  }

  // A terminal redraw can destroy the common prefix. Treat the visible
  // snapshot as new and let fingerprint deduplication suppress old bullets.
  return current;
}

function isContinuation(line: string): boolean {
  if (!line.trim()) return false;
  if (BULLET_START.test(line)) return false;
  if (/^\s*[›>]\s/.test(line)) return false;
  if (/^\s*\d+[.)]\s/.test(line)) return false;
  if (/^[─━═]{10,}/.test(line.trim())) return false;
  return /^\s{2,}\S/.test(line);
}

function isThinkingBlock(block: string): boolean {
  const firstLine = block.replace(/^\s*•\s+/, "").trim();
  return Boolean(firstLine) && !NON_THINKING_PREFIX.test(firstLine) && !firstLine.startsWith("$");
}

/** Extract progress/thinking blocks rendered by agent TUIs as `• ...`. */
export function extractThinkingBlocks(raw: string): string[] {
  const lines = normalizeSnapshot(raw).split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    if (!BULLET_START.test(lines[index])) continue;
    const block = [lines[index].trimStart()];
    while (index + 1 < lines.length && isContinuation(lines[index + 1])) {
      block.push(lines[++index].trimEnd());
    }
    const rendered = block.join("\n");
    if (isThinkingBlock(rendered)) blocks.push(rendered);
  }

  return blocks;
}

function fingerprint(block: string): string {
  return block.replace(/\s+/g, " ").trim();
}

/**
 * Keeps a per-pane terminal snapshot and returns only newly observed bullet
 * blocks. The first snapshot is a baseline so daemon restarts do not replay
 * old terminal history.
 */
export class ThinkingRelayTracker {
  private readonly snapshots = new Map<string, string>();
  private readonly recent = new Map<string, string[]>();

  capture(paneId: string, raw: string, emit: boolean = true): string[] {
    const current = normalizeSnapshot(raw);
    const previous = this.snapshots.get(paneId);
    this.snapshots.set(paneId, current);

    const seen = this.recent.get(paneId) ?? [];
    const seenSet = new Set(seen);
    const source = previous === undefined ? current : appendedContent(previous, current);
    const fresh: string[] = [];
    for (const block of extractThinkingBlocks(source)) {
      const key = fingerprint(block);
      if (!key || seenSet.has(key)) continue;
      seen.push(key);
      seenSet.add(key);
      if (previous !== undefined && emit) fresh.push(block);
    }
    if (seen.length > MAX_RECENT_FINGERPRINTS) {
      seen.splice(0, seen.length - MAX_RECENT_FINGERPRINTS);
    }
    this.recent.set(paneId, seen);
    return fresh;
  }

  prune(activePaneIds: Set<string>): void {
    for (const paneId of this.snapshots.keys()) {
      if (!activePaneIds.has(paneId)) {
        this.snapshots.delete(paneId);
        this.recent.delete(paneId);
      }
    }
  }
}
