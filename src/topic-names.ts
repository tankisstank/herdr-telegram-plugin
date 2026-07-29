import type { PaneInfo } from "./types.js";

export function workspaceAbbrev(label: string): string {
  const words = label
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (words.length === 0) return "WS";
  if (words.length === 1) {
    const capitals = words[0].match(/[A-Z0-9]/g)?.join("") ?? "";
    if (capitals.length >= 2) return capitals.slice(0, 4).toUpperCase();
    return words[0].slice(0, 2).toUpperCase();
  }
  return words.map((w) => w[0]).join("").slice(0, 4).toUpperCase();
}

export function topicNameForPane(pane: PaneInfo): string {
  const workspace = pane.workspace_label || pane.workspace_id || "workspace";
  return `${workspaceAbbrev(workspace)}-${pane.label}`;
}