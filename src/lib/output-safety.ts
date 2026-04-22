import { SYSTEM_PROMPT_CANARY } from "@mux/ai/lib/prompt-fragments";

// ─────────────────────────────────────────────────────────────────────────────
// Output-side safety checks
//
// Defensive backstop for prompt-extraction attacks. Even when system-prompt
// hardening tells the model "do not disclose", a sufficiently clever prompt
// injection may still coerce leakage through a free-text field (reasoning,
// insight, summary, etc.). These utilities scan model output for evidence of
// a leak and let the caller scrub affected fields before returning them.
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

const PROMPT_TAG_PATTERN = new RegExp(`</?(?:${PROMPT_TAG_NAMES.join("|")})>`, "i");

/**
 * Returns true when `text` contains evidence of a system-prompt leak.
 *
 * Two signals:
 * - the canary token embedded in every system prompt
 * - XML tag markers from the prompt template
 *
 * Designed for low false-positive rate on legitimate video/audio content
 * analysis output.
 */
export function detectSystemPromptLeak(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  if (text.includes(SYSTEM_PROMPT_CANARY)) {
    return true;
  }
  return PROMPT_TAG_PATTERN.test(text);
}

/** Result of a scrub check — see {@link scrubFreeTextField}. */
export interface ScrubResult {
  /** Original text when clean; empty string when a leak was detected. */
  text: string;
  /** True when a leak was detected and the text was suppressed. */
  leaked: boolean;
}

/**
 * Checks a free-text model output field for system-prompt leakage.
 *
 * When a leak is detected: emits a warning and returns an empty string so
 * the caller can substitute a neutral placeholder appropriate to its
 * output shape. When clean: returns the original text unchanged.
 *
 * @param text  the raw free-text field from the model
 * @param context a short label used in the warning message
 */
export function scrubFreeTextField(
  text: string | null | undefined,
  context: string,
): ScrubResult {
  if (!text) {
    return { text: text ?? "", leaked: false };
  }
  if (detectSystemPromptLeak(text)) {
    console.warn(`[@mux/ai] Suppressed suspected prompt leak in ${context}.`);
    return { text: "", leaked: true };
  }
  return { text, leaked: false };
}
