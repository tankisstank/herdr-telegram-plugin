import { splitTelegramText } from "./telegram-text.js";

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Preserve the agent's prose/Markdown while removing terminal-only chrome. */
export function extractFinalSnapshot(raw: string): string {
  const lines = raw
    .replace(ANSI_ESCAPE, "")
    .replace(/<session_state[\s\S]*?<\/session_state>/g, "")
    .replace(/^[\s┃│▏▕]+/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^[─━═]{20,}$/.test(trimmed)) return false;
      if (/^(?:▸|●|○|⣻)\s/.test(trimmed)) return false;
      if (/^(?:esc to cancel|Model:|LSPs? are disabled)\b/i.test(trimmed)) return false;
      if (/^>\s*$/.test(trimmed)) return false;
      return true;
    });

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.join("\n").trim();
}
export function splitFinalSnapshot(text: string): string[] {
  return splitTelegramText(text);
}
