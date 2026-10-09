export interface TextLengthLimit {
  unit: "characters" | "words";
  value: number;
}

interface WordSegmenter {
  segment: (input: string) => Iterable<{ isWordLike?: boolean }>;
}

function createWordSegmenter(): WordSegmenter | undefined {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: "word" }) => WordSegmenter;
  }).Segmenter;
  return Segmenter ? new Segmenter("und", { granularity: "word" }) : undefined;
}

/**
 * Measures text in the unit of a length limit. Characters are code points.
 * Words use locale-aware segmentation so Markdown syntax is not counted and
 * scripts without spaces are counted properly, falling back to whitespace
 * splitting where `Intl.Segmenter` is unavailable.
 */
export function measureGenerateTextLength(content: string, unit: TextLengthLimit["unit"]): number {
  if (unit === "characters") {
    return [...content].length;
  }
  const normalized = content.trim();
  if (!normalized) {
    return 0;
  }
  const segmenter = createWordSegmenter();
  if (!segmenter) {
    return normalized.split(/\s+/u).length;
  }
  let words = 0;
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike) {
      words += 1;
    }
  }
  return words;
}

/** The first limit a piece of text violates, if any. */
export function findGenerateTextLengthViolation(
  content: string,
  limits: readonly TextLengthLimit[],
): { limit: TextLengthLimit; actual: number } | undefined {
  for (const limit of limits) {
    const actual = measureGenerateTextLength(content, limit.unit);
    if (actual > limit.value) {
      return { limit, actual };
    }
  }
  return undefined;
}
