/**
 * Language Code Conversion Utilities
 *
 * Provides bidirectional mapping between:
 * - ISO 639-1 (2-letter codes) - Used by browsers, BCP-47, most video players
 * - ISO 639-3 (3-letter codes) - Used by various APIs and language processing systems
 *
 * This is essential for interoperability between different systems:
 * - Mux uses ISO 639-1 for track language codes
 * - Browser players expect BCP-47 compliant codes (based on ISO 639-1)
 * - Some APIs require ISO 639-3 (3-letter) codes
 */

// ─────────────────────────────────────────────────────────────────────────────
// Language Code Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapping from ISO 639-1 (2-letter) to ISO 639-3 (3-letter) codes.
 * Covers the most common languages used in video translation.
 *
 * Reference: https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
 */
const ISO639_1_TO_3 = {
  // Major world languages
  en: "eng", // English
  es: "spa", // Spanish
  fr: "fra", // French
  de: "deu", // German
  it: "ita", // Italian
  pt: "por", // Portuguese
  ru: "rus", // Russian
  zh: "zho", // Chinese
  ja: "jpn", // Japanese
  ko: "kor", // Korean
  ar: "ara", // Arabic
  hi: "hin", // Hindi

  // European languages
  nl: "nld", // Dutch
  pl: "pol", // Polish
  sv: "swe", // Swedish
  da: "dan", // Danish
  no: "nor", // Norwegian
  fi: "fin", // Finnish
  el: "ell", // Greek
  cs: "ces", // Czech
  hu: "hun", // Hungarian
  ro: "ron", // Romanian
  bg: "bul", // Bulgarian
  hr: "hrv", // Croatian
  sk: "slk", // Slovak
  sl: "slv", // Slovenian
  uk: "ukr", // Ukrainian
  tr: "tur", // Turkish

  // Asian languages
  th: "tha", // Thai
  vi: "vie", // Vietnamese
  id: "ind", // Indonesian
  ms: "msa", // Malay
  tl: "tgl", // Tagalog/Filipino

  // Other languages
  he: "heb", // Hebrew
  fa: "fas", // Persian/Farsi
  bn: "ben", // Bengali
  ta: "tam", // Tamil
  te: "tel", // Telugu
  mr: "mar", // Marathi
  gu: "guj", // Gujarati
  kn: "kan", // Kannada
  ml: "mal", // Malayalam
  pa: "pan", // Punjabi
  ur: "urd", // Urdu
  sw: "swa", // Swahili
  af: "afr", // Afrikaans
  ca: "cat", // Catalan
  eu: "eus", // Basque
  gl: "glg", // Galician
  is: "isl", // Icelandic
  et: "est", // Estonian
  lv: "lav", // Latvian
  lt: "lit", // Lithuanian
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported ISO 639-1 two-letter language codes.
 * These are the language codes supported for translation workflows.
 */
export type SupportedISO639_1 = keyof typeof ISO639_1_TO_3;

/**
 * Supported ISO 639-3 three-letter language codes.
 * These are the language codes supported for translation workflows.
 */
export type SupportedISO639_3 = (typeof ISO639_1_TO_3)[SupportedISO639_1];

/** ISO 639-1 two-letter language code (e.g., "en", "fr", "es") */
export type ISO639_1 = SupportedISO639_1 | (string & {});

/** ISO 639-3 three-letter language code (e.g., "eng", "fra", "spa") */
export type ISO639_3 = SupportedISO639_3 | (string & {});

/** Structured language code result containing both formats */
export interface LanguageCodePair {
  /** ISO 639-1 two-letter code (BCP-47 compatible) */
  iso639_1: ISO639_1;
  /** ISO 639-3 three-letter code */
  iso639_3: ISO639_3;
}

/**
 * Reverse mapping from ISO 639-3 (3-letter) to ISO 639-1 (2-letter) codes.
 * Generated from ISO639_1_TO_3 for consistency.
 */
const ISO639_3_TO_1 = Object.fromEntries(
  Object.entries(ISO639_1_TO_3).map(([iso1, iso3]) => [iso3, iso1]),
) as Record<SupportedISO639_3, SupportedISO639_1>;

// ─────────────────────────────────────────────────────────────────────────────
// Conversion Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts an ISO 639-1 (2-letter) code to ISO 639-3 (3-letter) code.
 *
 * @param code - ISO 639-1 two-letter language code (e.g., "en", "fr")
 * @returns ISO 639-3 three-letter code, or the original if not found
 *
 * @example
 * ```typescript
 * toISO639_3("en") // "eng"
 * toISO639_3("fr") // "fra"
 * toISO639_3("ja") // "jpn"
 * ```
 */
export function toISO639_3(code: string): ISO639_3 {
  const normalized = code.toLowerCase().trim();

  // If it's already a 3-letter code, return as-is
  if (normalized.length === 3) {
    return normalized;
  }

  return (ISO639_1_TO_3 as Record<string, string>)[normalized] ?? normalized;
}

/**
 * Converts an ISO 639-3 (3-letter) code to ISO 639-1 (2-letter) code.
 *
 * @param code - ISO 639-3 three-letter language code (e.g., "eng", "fra")
 * @returns ISO 639-1 two-letter code, or the original if not found
 *
 * @example
 * ```typescript
 * toISO639_1("eng") // "en"
 * toISO639_1("fra") // "fr"
 * toISO639_1("jpn") // "ja"
 * ```
 */
export function toISO639_1(code: string): ISO639_1 {
  const normalized = code.toLowerCase().trim();

  // If it's already a 2-letter code, return as-is
  if (normalized.length === 2) {
    return normalized;
  }

  return (ISO639_3_TO_1 as Record<string, string>)[normalized] ?? normalized;
}

/**
 * Returns both ISO 639-1 and ISO 639-3 codes for a given language code.
 * Accepts either format as input and normalizes to both.
 *
 * @param code - Language code in either ISO 639-1 or ISO 639-3 format
 * @returns Object containing both code formats
 *
 * @example
 * ```typescript
 * getLanguageCodePair("en")  // { iso639_1: "en", iso639_3: "eng" }
 * getLanguageCodePair("fra") // { iso639_1: "fr", iso639_3: "fra" }
 * ```
 */
export function getLanguageCodePair(code: string): LanguageCodePair {
  const normalized = code.toLowerCase().trim();

  if (normalized.length === 2) {
    // Input is ISO 639-1
    return {
      iso639_1: normalized,
      iso639_3: toISO639_3(normalized),
    };
  } else if (normalized.length === 3) {
    // Input is ISO 639-3
    return {
      iso639_1: toISO639_1(normalized),
      iso639_3: normalized,
    };
  }

  // Unknown format, return as-is for both
  return {
    iso639_1: normalized,
    iso639_3: normalized,
  };
}

/**
 * Validates if a code is a known ISO 639-1 code.
 *
 * @param code - Code to validate
 * @returns true if the code is a known ISO 639-1 code
 */
export function isValidISO639_1(code: string): boolean {
  return code.length === 2 && code.toLowerCase() in ISO639_1_TO_3;
}

/**
 * Validates if a code is a known ISO 639-3 code.
 *
 * @param code - Code to validate
 * @returns true if the code is a known ISO 639-3 code
 */
export function isValidISO639_3(code: string): boolean {
  return code.length === 3 && code.toLowerCase() in ISO639_3_TO_1;
}

/**
 * Gets the human-readable language name for a given code.
 *
 * @param code - Language code in either ISO 639-1 or ISO 639-3 format
 * @returns Human-readable language name (e.g., "English", "French")
 */
export function getLanguageName(code: string): string {
  const iso639_1 = toISO639_1(code);
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(iso639_1) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
