const ESCAPED_LINE_BREAK_REGEX = /\\r\\n|\\n|\\r/g;
const MULTIPLE_BLANK_LINES_REGEX = /\n{3,}/g;

/**
 * Normalizes common markdown formatting defects seen in structured-output
 * string fields. Some providers occasionally return literal escaped line
 * breaks or collapse generated list items into a single paragraph.
 */
export function normalizeMarkdownDescription(description: string): string {
  return description
    .replace(ESCAPED_LINE_BREAK_REGEX, "\n")
    .replace(/([^\n]) {2,}([*-]) (?=\S)/g, "$1\n$2 ")
    .replace(/([.!?:;]) ([*-]) (?=\S)/g, "$1\n$2 ")
    .replace(MULTIPLE_BLANK_LINES_REGEX, "\n\n");
}
