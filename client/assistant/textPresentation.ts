import MarkdownIt from "markdown-it";

const parser = new MarkdownIt();
/** Keep lists, fences and tables intact; completed top-level blocks have stable text. */
export function markdownBlocks(text: string): string[] {
  // Reference definitions can affect earlier blocks, so render these together.
  if (/^ {0,3}\[[^\]]+\]:/m.test(text)) return [text];
  const lines = text.split("\n");
  const starts = parser.parse(text, {}).filter(token => token.level === 0 && token.map && token.nesting !== -1)
    .map(token => token.map![0]);
  const unique = [...new Set(starts)];
  return unique.length ? unique.map((start, index) => lines.slice(start, unique[index + 1] ?? lines.length).join("\n").trimEnd()) : [text];
}
