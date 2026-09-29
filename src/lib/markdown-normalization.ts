const ESCAPED_LINE_BREAK_REGEX = /\\r\\n|\\n|\\r/g;
const MULTIPLE_BLANK_LINES_REGEX = /\n{3,}/g;
const HAS_ESCAPED_LINE_BREAK_REGEX = /\\[rn]/;

/**
 * Undoes one extra layer of JSON string escaping that some providers apply,
 * so literal `\n` and `\"` become real line breaks and quotes. Only text with
 * escaped line breaks and no real ones is treated as double-escaped.
 */
export function unescapeDoubleEscapedText(text: string): string {
  if (text.includes("\n") || !HAS_ESCAPED_LINE_BREAK_REGEX.test(text)) {
    return text;
  }
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

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
