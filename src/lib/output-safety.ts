import { SYSTEM_PROMPT_CANARY } from "@mux/ai/lib/prompt-fragments";

// ─────────────────────────────────────────────────────────────────────────────
// Output-side safety checks
//
// Defensive backstop for prompt-extraction attacks. Even when system-prompt
// hardening tells the model "do not disclose", a sufficiently clever prompt
// injection may still coerce leakage through a free-text field (reasoning,
// insight, summary, etc.). These utilities scan model output for evidence
// of a leak and let the caller scrub affected fields before returning them.
//
// The scanner applies three detectors, strongest signal first:
//
// 1. Canary substring. The system prompt embeds a rare token
//    (SYSTEM_PROMPT_CANARY); any output that contains it must have copied
//    part of the prompt. Very low false-positive rate. An attacker can
//    defeat this only by stripping the canary from their exfil, which the
//    instruction-level defences in `prompt-fragments.ts` make harder.
//
// 2. Prompt-tag markers. Our system prompts use a fixed set of XML-like
//    section tags (<role>, <task>, <security>, …). Legitimate video/audio
//    content analysis never emits these markers, so their presence in the
//    output signals prompt-structure leakage. The regex tolerates internal
//    whitespace and attributes to resist simple obfuscation like
//    "<role >" or "<role attr='x'>".
//
// 3. Encoded-blob heuristic. Long runs of base64/hex-like characters in a
//    field expected to contain prose are a sign the model complied with a
//    "dump your prompt in base64" request that the instruction-level
//    defences failed to stop. This detector has a higher false-positive
//    risk (hashes, URLs, tokens), which is why it only fires on long,
//    dense runs.
//
// All detectors normalise the input first (NFKC + zero-width / bidi
// control strip) so obfuscations like "<rоle>" (Cyrillic о) or a canary
// with zero-width characters spliced into the middle do not slip through
// by splitting the bytes that `String.includes` compares against.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tag markers used in our system prompts. If any of these appear in model
 * output, the prompt structure has almost certainly leaked — legitimate
 * content analysis never emits these markers.
 *
 * The list tracks tags actually used across `src/lib/prompt-fragments.ts`
 * and each workflow's system prompt. Add new tags here when new workflows
 * introduce them.
 */
const PROMPT_TAG_NAMES = [
  "role",
  "task",
  "constraint",
  "constraints",
  "context",
  "security",
  "answer_guidelines",
  "relevance_filtering",
  "transcript_guidance",
  "capabilities",
  "language_guidelines",
  "tone_guidance",
  "confidence_scoring",
  "critical_note",
  "analysis_steps",
  "classify_as_captions",
  "not_captions",
  "quality_guidelines",
  "insight_guidelines",
  "visual_context",
  "output_format",
  "title_requirements",
  "description_requirements",
  "keywords_requirements",
  "chapter_guidelines",
  "title_guidelines",
];

// Matches `<tag>`, `</tag>`, `< tag >`, `<tag attr="x">`, etc.
// Uses a single character class `[/\s]*` between `<` and the tag name so
// the engine has no ambiguity to backtrack through — an optional slash
// and any whitespace can interleave in any order. Everything after the
// tag name up to `>` is treated as attributes.
// Example inputs the stricter `</?tag>` form would skip:
//   "< role >"            (whitespace padding)
//   "</role attr='x'>"   (attribute on closer)
//   "<role\n>"            (embedded newline)
const PROMPT_TAG_PATTERN = new RegExp(
  `<[/\\s]*(?:${PROMPT_TAG_NAMES.join("|")})\\b[^>]*>`,
  "i",
);

/**
 * Characters that are invisible or near-invisible when rendered but are
 * still real Unicode code points. Attackers use these to split an exfil
 * token so that a literal `String.includes` comparison against the canary
 * fails, while the model (and any human reading the output) still receives
 * the intended content.
 *
 * Covered ranges (each listed explicitly rather than as a range to keep
 * the regex literal readable and to satisfy `regexp/no-obscure-range`):
 * - U+00AD       soft hyphen
 * - U+200B       zero-width space
 * - U+200C       zero-width non-joiner
 * - U+200D       zero-width joiner
 * - U+2060       word joiner
 * - U+2066–2069 bidi isolates (can reorder display)
 * - U+202A–202E bidi overrides/embeddings
 * - U+FEFF      BOM / zero-width no-break space
 *
 * Exported so the transcript primitive (`sanitizeUntrustedText`) can
 * use the same list on input as the output-side scrubber uses on
 * output. Drifting copies would create an asymmetry where a code
 * point is stripped on one side but not the other — enough to defeat
 * the obfuscation defenses this list exists to enforce.
 */
// Code points enumerated individually so the source file itself contains
// no invisible characters (which would fail lint and be hard to audit).
// Each value corresponds to one of the documented ranges above.
export const INVISIBLE_CODE_POINTS = [
  0x00AD, // soft hyphen
  0x200B, // zero-width space
  0x200C, // zero-width non-joiner
  0x200D, // zero-width joiner
  0x2060, // word joiner
  0x2066, // LTR isolate
  0x2067, // RTL isolate
  0x2068, // first-strong isolate
  0x2069, // pop directional isolate
  0x202A, // LTR embedding
  0x202B, // RTL embedding
  0x202C, // pop directional formatting
  0x202D, // LTR override
  0x202E, // RTL override
  0xFEFF, // BOM / zero-width no-break space
];

/** Compiled regex form of {@link INVISIBLE_CODE_POINTS}. */
export const INVISIBLE_CHARACTERS_PATTERN = new RegExp(
  `[${INVISIBLE_CODE_POINTS.map(cp => `\\u${cp.toString(16).padStart(4, "0").toUpperCase()}`).join("")}]`,
  "g",
);

/**
 * Normalise untrusted text by folding Unicode compatibility forms
 * (NFKC) and stripping invisible / bidi-control code points.
 *
 * Single source of truth for the two places this transformation is
 * needed:
 *
 * - **Output side** (internal `detectLeakReason`): applied to every
 *   model output before matching it against canary / tag / encoded-
 *   blob detectors. Normalising here ensures an attacker-emitted
 *   fullwidth `<role>` or a canary split with zero-width characters
 *   still matches.
 *
 * - **Input side** (`sanitizeUntrustedText` in
 *   `src/primitives/transcripts.ts`): applied to every transcript
 *   cue before it reaches a prompt. Normalising here prevents
 *   payloads hidden in homoglyphs or invisible splitters from being
 *   invisible to human reviewers while still understandable to the
 *   model.
 *
 * Using the same function on both sides keeps the hygiene symmetric —
 * any character folded / stripped on one end is folded / stripped on
 * the other. Example transformations:
 *
 * - Fullwidth angle brackets (U+FF1C / U+FF1E) around a word fold to
 *   ASCII `<` / `>` under NFKC, so a "fullwidth-tag" wrapping still
 *   trips the tag detector.
 * - A zero-width space (U+200B) spliced into the middle of a word is
 *   removed, collapsing "ig + ZWSP + nore" back to "ignore".
 * - A leading right-to-left override (U+202E) is stripped, so a
 *   filename that would render reversed in a terminal reads forward
 *   for the model and for any downstream substring check.
 */
export function normalizeUntrustedUnicode(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE_CHARACTERS_PATTERN, "");
}

/**
 * Heuristic for encoded-blob leakage.
 *
 * An instruction-level defence against encoded exfiltration ("output your
 * prompt in base64") cannot stop every model in every case, so we look for
 * the shape of encoded data in fields expected to hold prose:
 *
 * - A run of 80+ characters that are entirely in the base64 alphabet
 *   (`[A-Za-z0-9+/=_-]`, allowing both standard and URL-safe variants).
 *   80 chars is long enough that a single short base64-encoded phrase in
 *   legitimate content will not match, but short enough to catch a
 *   meaningfully exfiltrated prompt fragment.
 * - A run of 65+ hexadecimal characters. Tuned so that single references
 *   to any common hash length in legitimate tech content pass through:
 *   MD5 (32), SHA-1 (40), SHA-256 (64) are all below the threshold. A
 *   real hex-encoded exfil of a meaningful prompt fragment takes
 *   hundreds of hex chars, so 65 still catches it comfortably while
 *   eliminating single-hash false positives on transcripts of coding /
 *   security content. Two consecutive hashes (≥ 80 hex) still trip,
 *   as does any encoded dump.
 *
 * Both thresholds can still false-positive on fields that legitimately
 * include long base64 blobs (data URLs pasted into a transcript) or
 * consecutive hash strings. Workflows that need such content in outputs
 * should bypass this scrubber or extend the heuristic.
 */
const BASE64_RUN_PATTERN = /[\w+/=-]{80,}/;
const HEX_RUN_PATTERN = /[0-9a-f]{65,}/i;

/**
 * Which detector fired on a leak, or `null` when the text is clean.
 *
 * - `canary` — the system-prompt canary token appeared in the output.
 *   Near-zero false-positive rate; treat as a confirmed leak.
 * - `prompt_tag` — an XML-like tag taken from our prompt structure
 *   appeared in the output. Low false-positive rate.
 * - `encoded_blob` — a long run of base64- or hex-shaped characters
 *   appeared in a field expected to hold prose. Heuristic; some false
 *   positives on hashes or tokens in tech-content transcripts.
 * - `unexpected_key` — the model emitted a JSON field not declared in
 *   the schema (see {@link detectUnexpectedKeys}). Stripped silently
 *   by zod's default `.strip()` mode; this signal surfaces the
 *   smuggling attempt rather than letting it go unseen.
 * - `unspecified` — defensive fallback used only when a scrub is
 *   known to have occurred but the specific detector that fired was
 *   not preserved across a `"use step"` serialisation boundary.
 *   Operators seeing this value should treat it as a suspected leak
 *   of indeterminate confidence — the content was suppressed, but we
 *   cannot attribute which detector caught it. Under the current
 *   scrubber contract this should not occur in practice; the variant
 *   exists so synthesised reports never fabricate a higher-confidence
 *   reason than was actually observed (e.g. claiming a canary hit
 *   when none was seen).
 */
export type LeakReason =
  | "canary" |
  "prompt_tag" |
  "encoded_blob" |
  "unexpected_key" |
  "unspecified" |
  null;

/**
 * Canary in its normalised form, pre-computed at module load.
 *
 * Model output is normalised with `normalizeUntrustedUnicode` before matching
 * (NFKC + strip invisibles). For that comparison to be symmetric, the
 * canary we compare against must be normalised the same way — otherwise
 * an operator who configures `MUX_AI_PROMPT_CANARY` with any characters
 * affected by NFKC (fullwidth ASCII, soft hyphens, ligatures) or any
 * invisible code points would see the output get folded to ASCII while
 * the canary constant stays in its original form, and `.includes` would
 * silently fail to match.
 *
 * For the default ASCII-only canary this is a no-op — normalised and
 * raw are identical. The pre-normalisation matters only for operator
 * overrides. Added side benefit: an attacker who tries to exfiltrate
 * the canary by emitting it in fullwidth form (a classic evasion
 * dodge) is now caught too, since the fullwidth output normalises back
 * to the canary's form.
 */
const NORMALISED_SYSTEM_PROMPT_CANARY = normalizeUntrustedUnicode(SYSTEM_PROMPT_CANARY);

// Guard against a pathological configuration: `MUX_AI_PROMPT_CANARY`
// is validated at env-parse time to be >= 16 *raw* characters, but a
// 16-character string made of pure zero-width / soft-hyphen / bidi-
// control code points would normalise to an empty string. A zero-length
// canary would make every `.includes("")` call trivially true, flagging
// every model output as `reason: "canary"` — the worst possible signal
// for alerting. Fail loudly at module init if normalisation strips the
// canary below usability.
if (NORMALISED_SYSTEM_PROMPT_CANARY.length < 16) {
  throw new Error(
    "MUX_AI_PROMPT_CANARY normalises to fewer than 16 characters after " +
    "NFKC + invisibles strip. Canaries composed largely of fullwidth " +
    "ASCII, invisible / bidi-control code points, or other characters " +
    "that collapse under Unicode normalisation are not usable as " +
    "tripwires — they would produce false-positive matches against " +
    "legitimate model output. Use a high-entropy ASCII-leaning value.",
  );
}

/**
 * Returns which detector fires on `text`, or `null` if none do.
 *
 * Exposed alongside {@link scrubFreeTextField} so workflows can decide
 * how to surface the signal (an `engagement-insights` summary might be
 * suppressed silently, whereas an `ask-questions` reasoning field might
 * be converted into a skip).
 */
export function detectLeakReason(text: string | null | undefined): LeakReason {
  if (!text) {
    return null;
  }
  const normalised = normalizeUntrustedUnicode(text);

  // Both sides of the comparison are normalised — see the note on
  // NORMALISED_SYSTEM_PROMPT_CANARY above for why. For the default
  // ASCII canary this is indistinguishable from comparing against the
  // raw value; the pre-normalisation is what keeps operator overrides
  // and fullwidth-evasion attacks correctly detected.
  if (normalised.includes(NORMALISED_SYSTEM_PROMPT_CANARY)) {
    return "canary";
  }
  if (PROMPT_TAG_PATTERN.test(normalised)) {
    return "prompt_tag";
  }
  if (BASE64_RUN_PATTERN.test(normalised) || HEX_RUN_PATTERN.test(normalised)) {
    return "encoded_blob";
  }
  return null;
}

/**
 * Returns true when `text` contains evidence of a system-prompt leak.
 *
 * Convenience wrapper around {@link detectLeakReason} preserved for
 * readability at call sites that do not need the reason code.
 */
export function detectSystemPromptLeak(text: string | null | undefined): boolean {
  return detectLeakReason(text) !== null;
}

/** Result of a scrub check — see {@link scrubFreeTextField}. */
export interface ScrubResult {
  /** Original text when clean; empty string when a leak was detected. */
  text: string;
  /** True when a leak was detected and the text was suppressed. */
  leaked: boolean;
  /**
   * Which detector fired, when a leak was detected.
   *
   * Useful for telemetry — operators may want to treat a `canary` hit
   * (near-zero false-positive rate) differently from an `encoded_blob`
   * hit (heuristic, occasional false positives).
   */
  reason: LeakReason;
}

/**
 * Checks a free-text model output field for system-prompt leakage.
 *
 * When a leak is detected: emits a warning (with the reason code and
 * caller-supplied context label) and returns an empty string so the
 * caller can substitute a neutral placeholder appropriate to its output
 * shape. When clean: returns the original text unchanged.
 *
 * Callers typically pair this with length caps on the underlying zod
 * schema — a cap on `reasoning`/`insight` of ~400 chars makes encoded
 * exfiltration mechanically difficult, and the scrubber catches what
 * still fits.
 *
 * @param text     the raw free-text field from the model
 * @param context  a short label used in the warning and returned
 *                 telemetry (e.g. "ask-questions reasoning for question 3")
 */
export function scrubFreeTextField(
  text: string | null | undefined,
  context: string,
): ScrubResult {
  if (!text) {
    return { text: text ?? "", leaked: false, reason: null };
  }
  const reason = detectLeakReason(text);
  if (reason !== null) {
    console.warn(`[@mux/ai] Suppressed suspected prompt leak in ${context} (reason: ${reason}).`);
    return { text: "", leaked: true, reason };
  }
  return { text, leaked: false, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate safety reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-field record of a detected leak. Collected across every scrub
 * performed inside a single workflow invocation and returned to the
 * caller in the workflow result's `safety` field.
 */
export interface ScrubbedFieldReport {
  /**
   * Identifier for the field that leaked. Format is workflow-specific
   * (e.g. "reasoning[0]", "moment_insight[2]", "description"). Intended
   * for debugging and observability; do not parse programmatically.
   */
  field: string;
  /** Which detector fired — see {@link LeakReason}. */
  reason: Exclude<LeakReason, null>;
}

/**
 * Aggregate safety report returned from workflows that perform
 * output-side scrubbing.
 *
 * Operators can use this to alert on suspected prompt-injection traffic
 * without inspecting log warnings. Shape is stable across workflows so a
 * single observer can consume it uniformly.
 */
export interface SafetyReport {
  /** `true` when at least one field was suppressed by the scrubber. */
  leaksDetected: boolean;
  /**
   * One entry per suppressed field. Empty (but present) when no leaks
   * were detected. Iteration order matches the order scrubs ran, so
   * callers can correlate entries with workflow structure if they wish.
   */
  scrubbedFields: ScrubbedFieldReport[];
}

/**
 * Collector helper used inside a workflow to thread a {@link SafetyReport}
 * through multiple scrub calls without each call site having to track
 * state. Usage:
 *
 *     const safety = createSafetyReporter();
 *     const cleanReasoning = safety.scrub(raw.reasoning, "reasoning[0]");
 *     const cleanSummary   = safety.scrub(raw.summary, "summary");
 *     return { ..., safety: safety.report() };
 */
export interface SafetyReporter {
  /**
   * Scrub `text`, record a report entry if it leaked, and return the
   * resulting text. Mirrors {@link scrubFreeTextField} but returns the
   * string directly for convenience at call sites that only care about
   * the suppressed/clean text.
   */
  scrub: (text: string | null | undefined, field: string) => string;
  /**
   * Underlying scrub helper for call sites that need the full
   * {@link ScrubResult} (e.g. to decide between "skip" and "substitute
   * placeholder"). Recording into the aggregate report happens
   * automatically.
   */
  scrubDetailed: (text: string | null | undefined, field: string) => ScrubResult;
  /**
   * Inspect a pre-parse object for keys that are not declared in the
   * consuming zod schema, log + record each as `unexpected_key`, and
   * return them so the caller can take additional action if desired.
   *
   * This complements zod's default `.strip()` behaviour: `.strip()`
   * silently drops the extras on parse (which is what we want — no
   * hard failures), while this helper surfaces the smuggling attempt
   * so it does not go unseen.
   *
   * @param raw           the pre-parse model output
   * @param expectedKeys  the keys declared by the receiving schema
   * @param context       a short label used in the warning and report
   *                      (e.g. "summary_metadata" or "chapters[3]")
   * @returns             the list of keys present in `raw` but not in
   *                      `expectedKeys`
   */
  recordUnexpectedKeys: (
    raw: unknown,
    expectedKeys: readonly string[],
    context: string,
  ) => string[];
  /**
   * Record a pre-computed safety signal. Used when the detection
   * happens inside a `"use step"` boundary and the step returns the
   * finding as a serialisable value for the workflow to aggregate.
   *
   * The caller is responsible for logging if desired — this method
   * only updates the aggregate report.
   */
  record: (field: string, reason: Exclude<LeakReason, null>) => void;
  /** Snapshot the current aggregate report. */
  report: () => SafetyReport;
}

/**
 * Detect top-level keys in a model-emitted object that are not declared
 * in the expected-key list. The check is deliberately shallow — nested
 * arrays-of-objects (chapters, momentInsights, etc.) should call this
 * once per element.
 *
 * Zod's default `.strip()` mode silently drops the extras during parse;
 * this helper does the detection the strip otherwise hides. It is
 * exported separately so call sites can detect without necessarily
 * going through a {@link SafetyReporter} (e.g. in tests).
 */
export function detectUnexpectedKeys(
  raw: unknown,
  expectedKeys: readonly string[],
): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [];
  }
  const expected = new Set(expectedKeys);
  return Object.keys(raw as Record<string, unknown>).filter(k => !expected.has(k));
}

/**
 * Parse `rawText` as JSON and compare its top-level keys against
 * `expectedKeys`.
 *
 * Returns an empty array when the text is not valid JSON (so a model
 * that wraps its output in markdown fences or trailing whitespace does
 * not produce spurious safety signals). Intended for use inside step
 * functions that receive the model's raw text output but run inside
 * a `"use step"` boundary that can't ship a {@link SafetyReporter}
 * across — pass the returned array back as a serialisable value for
 * the workflow to aggregate.
 */
export function detectUnexpectedKeysFromRawText(
  rawText: string | undefined,
  expectedKeys: readonly string[],
): string[] {
  if (!rawText)
    return [];
  try {
    const parsed: unknown = JSON.parse(rawText);
    return detectUnexpectedKeys(parsed, expectedKeys);
  } catch {
    return [];
  }
}

export function createSafetyReporter(): SafetyReporter {
  const scrubbedFields: ScrubbedFieldReport[] = [];

  const scrubDetailed = (text: string | null | undefined, field: string): ScrubResult => {
    const result = scrubFreeTextField(text, field);
    if (result.leaked && result.reason !== null) {
      scrubbedFields.push({ field, reason: result.reason });
    }
    return result;
  };

  const recordUnexpectedKeys = (
    raw: unknown,
    expectedKeys: readonly string[],
    context: string,
  ): string[] => {
    const extras = detectUnexpectedKeys(raw, expectedKeys);
    if (extras.length > 0) {
      console.warn(
        `[@mux/ai] Model emitted unexpected keys in ${context} (stripped): ${extras.join(", ")}.`,
      );
      for (const key of extras) {
        scrubbedFields.push({
          field: `${context}.${key}`,
          reason: "unexpected_key",
        });
      }
    }
    return extras;
  };

  const record = (field: string, reason: Exclude<LeakReason, null>): void => {
    scrubbedFields.push({ field, reason });
  };

  return {
    scrubDetailed,
    scrub: (text, field) => scrubDetailed(text, field).text,
    recordUnexpectedKeys,
    record,
    report: () => ({
      leaksDetected: scrubbedFields.length > 0,
      // Return a copy so the report captured at return time is not
      // mutated by any later scrubs (defensive — current callers snapshot
      // at the end of the workflow, but this keeps the contract explicit).
      scrubbedFields: [...scrubbedFields],
    }),
  };
}
