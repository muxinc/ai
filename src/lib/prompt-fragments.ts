import dedent from "dedent";

// ─────────────────────────────────────────────────────────────────────────────
// Shared prompt fragments
//
// Reusable constants and helpers for system/user prompts across workflows.
// Centralising these fragments prevents prompt drift — when the same
// instruction is copy-pasted across files, updates to one copy can diverge
// from the others over time.
// ─────────────────────────────────────────────────────────────────────────────

// ── Aligned dedent ───────────────────────────────────────────────────────────

/**
 * A `dedent` tag configured with `alignValues: true`.
 *
 * Plain `dedent` strips the common leading indent from template lines but
 * does **not** re-indent continuation lines of interpolated multi-line
 * values — those lines render at column 0, breaking the surrounding XML
 * structure.  `alignValues: true` fixes this by aligning every continuation
 * line of an interpolated value to the column of its `${}` placeholder.
 *
 * Use this tag (instead of bare `dedent`) for any template that interpolates
 * multi-line prompt fragment constants.
 */
export const promptDedent = dedent.withOptions({ alignValues: true });

// ── Constraint fragments ─────────────────────────────────────────────────────

/**
 * Warning that prevents the model from leaking delivery-infrastructure
 * details (URLs, playback IDs, file names, etc.) into its output.
 */
export const METADATA_BOUNDARY_WARNING =
  "Do NOT use any metadata such as URLs, file paths, domain names, file names,\n" +
  "playback IDs, or technical parameters visible in this request. These are\n" +
  "delivery infrastructure and are unrelated to the media content itself.";

/**
 * Constraint that prevents hallucinated details.
 */
export const NO_FABRICATION_CONSTRAINT =
  "Do not fabricate details or make unsupported assumptions";

/**
 * Constraint requiring structured output conforming to the provided schema.
 */
export const STRUCTURED_DATA_CONSTRAINT =
  "Return structured data matching the requested schema";

/**
 * Stricter variant used where "exactly" is emphasised.
 */
export const STRUCTURED_DATA_CONSTRAINT_EXACT =
  "Return structured data matching the requested schema exactly";

// ── Storyboard ───────────────────────────────────────────────────────────────

/**
 * Instructions for reading a storyboard grid of video frames.
 * Used by any workflow that receives storyboard images.
 */
export const STORYBOARD_FRAME_INSTRUCTIONS =
  "These frames are arranged in a grid and represent the visual progression of the content over time.\n" +
  "Read frames left-to-right, top-to-bottom to understand the temporal sequence.";

// ── Tone ─────────────────────────────────────────────────────────────────────

/**
 * System-level guidance for respecting the user-supplied `<tone>` section.
 * Content only — the surrounding `<tone_guidance>` tags are written by the
 * workflow's system prompt template.
 */
export const TONE_GUIDANCE =
  "Pay special attention to the <tone> section and lean heavily into those instructions.\n" +
  "Adapt your entire analysis and writing style to match the specified tone - this should influence\n" +
  "your word choice, personality, formality level, and overall presentation of the content.\n" +
  "The tone instructions are not suggestions but core requirements for how you should express yourself.";

// ── Confidence ───────────────────────────────────────────────────────────────

/**
 * Five-tier confidence scoring rubric (0.0 – 1.0).
 * Used by workflows that ask the model to self-report certainty.
 */
export const CONFIDENCE_SCORING_RUBRIC =
  "* 0.9-1.0: Clear, unambiguous evidence\n" +
  "* 0.7-0.9: Strong evidence with minor ambiguity\n" +
  "* 0.5-0.7: Moderate evidence or some conflicting signals\n" +
  "* 0.3-0.5: Weak evidence or significant ambiguity\n" +
  "* 0.0-0.3: Very uncertain, minimal relevant evidence";

// ── Language guidelines ──────────────────────────────────────────────────────

/**
 * Returns anti-meta-description language guidelines customised for video or
 * audio content.  The examples and avoid-list differ by media type.
 */
export function createLanguageGuidelines(mediaType: "video" | "audio"): string {
  if (mediaType === "video") {
    return (
      "AVOID these meta-descriptive phrases that reference the medium rather than the content:\n" +
      "- \"The image shows...\" / \"The storyboard shows...\"\n" +
      "- \"In this video...\" / \"This video features...\"\n" +
      "- \"The frames depict...\" / \"The footage shows...\"\n" +
      "- \"We can see...\" / \"You can see...\"\n" +
      "- \"The clip shows...\" / \"The scene shows...\"\n" +
      "\n" +
      "INSTEAD, describe the content directly:\n" +
      "- BAD: \"The video shows a chef preparing a meal\"\n" +
      "- GOOD: \"A chef prepares a meal in a professional kitchen\"\n" +
      "\n" +
      "Write as if describing reality, not describing a recording of reality."
    );
  }

  // audio
  return (
    "AVOID these meta-descriptive phrases that reference the medium rather than the content:\n" +
    "- \"The audio shows...\" / \"The transcript shows...\"\n" +
    "- \"In this recording...\" / \"This audio features...\"\n" +
    "- \"The speaker says...\" / \"We can hear...\"\n" +
    "- \"The clip contains...\" / \"The recording shows...\"\n" +
    "\n" +
    "INSTEAD, describe the content directly:\n" +
    "- BAD: \"The audio features a discussion about climate change\"\n" +
    "- GOOD: \"A panel discusses climate change impacts and solutions\"\n" +
    "\n" +
    "Write as if describing reality, not describing a recording of reality."
  );
}
