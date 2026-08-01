export interface ParsedPromptOption {
  index: string;
  label: string;
  key: string;
  wantsComment: boolean;
  selected?: boolean;
}

export interface ParsedInteractivePrompt {
  adapter: "codex" | "agy" | "generic";
  text: string;
  options: ParsedPromptOption[];
  selectedIndex?: number;
  confidence: "high" | "low";
}

const HEADER = /^(?:[>?›]\s*)?(?:would you like|do you want|choose|select|which|how should|what should|bạn\s+(?:có\s+)?muốn|hãy chọn|chọn)\b|\?\s*\S|\S.*\?\s*$/i;
const OPTION = /^\s*([>›])?\s*(\d+)[.)]\s+(.+?)\s*$/;
const FOOTER = /^(?:press enter|enter to confirm|confirm|cancel|esc to cancel|[↑↓←→].*(?:navigate|amend)|.*ctrl[+ ]g.*(?:edit|expand)|.*esc to cancel)/i;

function cleanLine(line: string): string {
  return line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trimEnd();
}

function parseOption(line: string): ParsedInteractivePrompt["options"][number] | null {
  const match = cleanLine(line).match(OPTION);
  if (!match) return null;
  let label = match[3].trim();
  const keyMatch = label.match(/\(([^()]+)\)\s*$/);
  const candidateKey = keyMatch?.[1].trim().toLowerCase();
  const hasShortcut = Boolean(candidateKey && /^(?:[a-z]|esc|enter)$/i.test(candidateKey));
  const key = hasShortcut ? candidateKey! : `index:${match[2]}`;
  if (keyMatch && hasShortcut) label = label.slice(0, keyMatch.index).trim();
  const wantsComment = /tell .* differently|what to do differently|\bcomment\b|\bfeedback\b|ghi chú/i.test(label);
  return {
    index: match[2],
    label,
    key,
    wantsComment,
    selected: Boolean(match[1]),
  };
}

function adapterFor(lines: string[], headerIndex: number): ParsedInteractivePrompt["adapter"] {
  const header = lines[headerIndex] ?? "";
  const window = lines.slice(headerIndex, Math.min(lines.length, headerIndex + 24)).join(" ");
  if (/^\s*\?/.test(header) || /tab amend|always allow in this conversation|persist to settings/i.test(window)) return "agy";
  if (/\((?:y|p|n|esc)\)/i.test(window) || /tell codex what to do differently/i.test(window)) return "codex";
  return "generic";
}

export function parseInteractivePrompt(raw: string): ParsedInteractivePrompt {
  const lines = raw.split("\n").map(cleanLine);
  const candidates: Array<{ headerIndex: number; firstOption: number; options: Array<{ lineIndex: number; option: ParsedInteractivePrompt["options"][number] }> }> = [];

  for (let headerIndex = Math.max(0, lines.length - 100); headerIndex < lines.length; headerIndex++) {
    if (!HEADER.test(lines[headerIndex].trim())) continue;
    const options: Array<{ lineIndex: number; option: ParsedInteractivePrompt["options"][number] }> = [];
    let firstOption = -1;
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const parsed = parseOption(lines[i]);
      if (parsed) {
        if (firstOption < 0) firstOption = i;
        options.push({ lineIndex: i, option: parsed });
        continue;
      }
      if (firstOption >= 0 && FOOTER.test(lines[i].trim())) break;
    }
    if (firstOption >= 0 && options.length >= 2) candidates.push({ headerIndex, firstOption, options });
  }

  const candidate = candidates.at(-1);
  if (!candidate) return { adapter: "generic", text: "", options: [], confidence: "low" };

  const options = candidate.options.map(({ option, lineIndex }, index) => {
    const nextLine = candidate.options[index + 1]?.lineIndex ?? lines.length;
    const optionLines = lines.slice(lineIndex, nextLine).filter((line) => !FOOTER.test(line.trim()));
    const wrapped = optionLines.join(" ").replace(/^\s*[>›]?\s*\d+[.)]\s+/, "").trim();
    const reparsed = parseOption(`${option.index}. ${wrapped}`);
    return {
      ...option,
      label: reparsed?.label || wrapped || option.label,
      key: reparsed?.key || option.key,
      wantsComment: reparsed?.wantsComment ?? option.wantsComment,
    };
  });

  const validIndexes = options.every((option, index) => Number(option.index) === index + 1);
  const text = lines.slice(candidate.headerIndex, candidate.firstOption)
    .filter((line) => line.trim())
    .join("\n")
    .trim();
  const selected = options.find((option) => option.selected);
  return {
    adapter: adapterFor(lines, candidate.headerIndex),
    text,
    options,
    selectedIndex: selected ? Number(selected.index) : 1,
    confidence: validIndexes && text.length > 0 ? "high" : "low",
  };
}
