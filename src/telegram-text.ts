const TELEGRAM_TEXT_LIMIT = 4096;

/** Split without cutting a line or paragraph whenever Telegram's limit is hit. */
export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT - 96): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < Math.floor(limit * 0.55)) cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.55)) cut = remaining.lastIndexOf(" ", limit);
    if (cut < 1) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
