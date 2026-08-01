export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function formatApprovalMessage(heading: string, body: string): string {
  return `<b>${escapeTelegramHtml(heading)}</b>${body ? `\n\n${escapeTelegramHtml(body)}` : ""}`;
}
