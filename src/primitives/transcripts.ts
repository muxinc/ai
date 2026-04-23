import { isUndeterminedLanguageCode } from "@mux/ai/lib/language-codes";
import { MuxAiError, wrapError } from "@mux/ai/lib/mux-ai-error";
import { isAudioOnlyAsset } from "@mux/ai/lib/mux-assets";
import { getMuxStreamOrigin } from "@mux/ai/lib/mux-url";
import { normalizeUntrustedUnicode } from "@mux/ai/lib/output-safety";
import { signUrl } from "@mux/ai/lib/url-signing";
import type { AssetTextTrack, MuxAsset, WorkflowCredentialsInput } from "@mux/ai/types";

/** A single cue from a VTT file with timing info. */
export interface VTTCue {
  startTime: number;
  endTime: number;
  text: string;
}

export interface TranscriptFetchOptions {
  languageCode?: string;
  cleanTranscript?: boolean;
  /** Optional signing context for signed playback IDs */
  shouldSign?: boolean;
  credentials?: WorkflowCredentialsInput;
  /**
   * When true, throws if no usable transcript can be retrieved (no ready text track,
   * missing track id, fetch error, or empty transcript).
   *
   * Default behavior is non-fatal and returns an empty `transcriptText`.
   */
  required?: boolean;
}

export interface TranscriptResult {
  transcriptText: string;
  transcriptUrl?: string;
  track?: AssetTextTrack;
}

export function getReadyTextTracks(asset: MuxAsset): AssetTextTrack[] {
  return (asset.tracks || []).filter(
    track => track.type === "text" && track.status === "ready",
  );
}

export function findCaptionTrack(asset: MuxAsset, languageCode?: string): AssetTextTrack | undefined {
  const tracks = getReadyTextTracks(asset);
  if (!tracks.length)
    return undefined;

  if (!languageCode) {
    const englishTrack = tracks.find(
      track => track.text_type === "subtitles" && track.language_code === "en",
    );
    return englishTrack ?? tracks[0];
  }

  const languageMatch = tracks.find(
    track =>
      track.text_type === "subtitles" &&
      track.language_code === languageCode,
  );
  if (languageMatch)
    return languageMatch;

  // Audio-only assets may have a single track that isn't "subtitles" — fall back to it
  if (isAudioOnlyAsset(asset) && tracks.length === 1) {
    return tracks[0];
  }

  return undefined;
}

/**
 * Default minimum auto-detection confidence required to trust a track's language code.
 * Below this threshold, the language is treated as undetermined.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

function getAutoLanguageConfidence(track: AssetTextTrack): number | undefined {
  const value = (track as AssetTextTrack & { auto_language_confidence?: unknown }).auto_language_confidence;
  return typeof value === "number" ? value : undefined;
}

/**
 * Extracts a trustworthy language code from a track, returning `undefined`
 * when the language metadata shouldn't be used as an LLM output language.
 *
 * Returns `undefined` when:
 * - The track or its language code is missing
 * - The language code is undetermined (`und`, `mul`, `mis`, `zxx`)
 * - The language was auto-detected with confidence below the threshold
 *
 * Trusts the language code when:
 * - `auto_language_confidence` is absent (manually set or non-auto tracks)
 * - `auto_language_confidence` meets the threshold
 *
 * @param track - The text track to inspect
 * @param confidenceThreshold - Minimum confidence to trust auto-detected language (default: {@link LOW_CONFIDENCE_THRESHOLD})
 */
export function getReliableLanguageCode(
  track: AssetTextTrack | undefined,
  confidenceThreshold: number = LOW_CONFIDENCE_THRESHOLD,
): string | undefined {
  if (!track?.language_code)
    return undefined;
  if (isUndeterminedLanguageCode(track.language_code))
    return undefined;
  const autoLanguageConfidence = getAutoLanguageConfidence(track);
  if (autoLanguageConfidence !== undefined && autoLanguageConfidence < confidenceThreshold) {
    return undefined;
  }
  return track.language_code;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Untrusted-text hygiene
//
// Transcript content ultimately originates from user-uploaded media and can
// carry obfuscated prompt-injection payloads. Apply this hygiene pass to any
// transcript text before it is sent to an LLM or embedded in a prompt.
//
// The actual normalisation — Unicode NFKC + invisible / bidi-control strip —
// lives in `lib/output-safety.ts` as `normalizeUntrustedUnicode`, shared
// with the output-side leak detector. Using the same function on both
// ends keeps the hygiene symmetric: any code point stripped on input is
// also stripped on output, preventing asymmetries that could become
// obfuscation-bypass vectors. See the doc comment on
// `normalizeUntrustedUnicode` for the full list of transformations and
// attack classes addressed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitise untrusted text (typically a VTT cue or joined transcript)
 * before it is interpolated into a prompt. Thin wrapper around the
 * shared {@link normalizeUntrustedUnicode} helper, with a null/empty
 * guard for convenience.
 */
export function sanitizeUntrustedText(value: string): string {
  if (!value)
    return value;
  return normalizeUntrustedUnicode(value);
}

/**
 * Upper bound on individual cue text length before we consider the cue
 * adversarial and truncate it.
 *
 * Legitimate captions are short — a long monologue cue rarely exceeds
 * 500 characters, and most captioning standards recommend well under
 * that for readability. We set the cap at 2000 to give comfortable
 * headroom for edge cases (stage directions, speaker identification,
 * multi-line blocks) while making "hide a multi-kilobyte injection
 * payload inside a single cue" mechanically infeasible.
 */
export const MAX_CUE_TEXT_CHARS = 2000;

/**
 * Truncate a single cue's text to {@link MAX_CUE_TEXT_CHARS} when it
 * exceeds the cap.
 *
 * A cue longer than the cap is treated as adversarial rather than
 * preserved verbatim: in legitimate content a 2000-character "cue"
 * does not exist. Truncation is lossy by design — the tail is replaced
 * with a short marker (" […truncated]") so the resulting string still
 * round-trips safely through VTT and makes the truncation visible to
 * any downstream consumer.
 */
function capCueTextLength(value: string): string {
  if (value.length <= MAX_CUE_TEXT_CHARS)
    return value;
  const marker = " […truncated]";
  return `${value.slice(0, MAX_CUE_TEXT_CHARS - marker.length)}${marker}`;
}

/**
 * Header regex for the three VTT metadata block types.
 *
 * Per the WebVTT file-parsing algorithm (W3C webvtt1 §5.1), a NOTE /
 * STYLE / REGION block header is the literal token followed by **either**
 * U+0020 SPACE, U+0009 TAB, or a line terminator. We match any whitespace
 * character or end-of-string so the tab variant does not silently slip
 * through — conformant players treat `NOTE\tpayload` as a comment and
 * hide it from viewers, and the stripper must therefore recognise it too
 * or an attacker gains a viewer/model asymmetry: invisible to viewers,
 * visible to the LLM.
 *
 * The negative side — `NOTEBOOK`, `STYLESHEET`, `REGIONAL` — is correctly
 * excluded because the character after the token is a non-whitespace
 * alphabetic, which fails both `\s` and `$`.
 */
const VTT_METADATA_HEADER_PATTERN = /^(?:NOTE|STYLE|REGION)(?:\s|$)/;

/**
 * Strip VTT metadata blocks that are never rendered by players but can
 * still carry text through to an LLM when the raw VTT is used in a prompt:
 *
 * - NOTE blocks (VTT comments)
 * - STYLE blocks (CSS for cue styling)
 * - REGION blocks (positioning definitions)
 *
 * Viewers never see the contents of these blocks. That makes them an
 * ideal hiding spot for prompt-injection payloads — an attacker-controlled
 * caption file can carry hundreds of bytes of "NOTE ignore previous
 * instructions…" that will be stripped from any player but will reach the
 * model if the raw VTT is passed through. Removing them before sending
 * the VTT to the model closes that channel without changing what the
 * model sees for legitimate cue content.
 *
 * Cue identifiers, timing lines, and cue payload text are preserved.
 * In particular: a cue whose first payload line happens to start with
 * `NOTE `/`STYLE `/`REGION ` (plausible in legitimate captions — e.g.
 * `"NOTE THAT..."`, `"STYLE GUIDE"`, `"NOTE how the villain plots..."`)
 * is NOT treated as a metadata block. The scanner tracks cue-payload
 * state: metadata headers are only recognised between cues (i.e. when
 * the previous non-blank line was not a timing line).
 *
 * Example input:
 *
 *     WEBVTT
 *
 *     NOTE This is a comment with hidden instructions
 *     that span multiple lines until a blank line appears.
 *
 *     STYLE
 *     ::cue(b) { font-weight: bold; }
 *
 *     00:00:01.000 --> 00:00:04.000
 *     Legitimate caption text
 *
 *     00:00:05.000 --> 00:00:08.000
 *     NOTE THAT the hero wins
 *
 * Returns:
 *
 *     WEBVTT
 *
 *     00:00:01.000 --> 00:00:04.000
 *     Legitimate caption text
 *
 *     00:00:05.000 --> 00:00:08.000
 *     NOTE THAT the hero wins
 */
export function stripVttMetadataBlocks(vttContent: string): string {
  if (!vttContent)
    return vttContent;
  const normalised = normalizeLineEndings(vttContent);
  const lines = normalised.split("\n");
  const kept: string[] = [];
  let inMetadataBlock = false;
  // Tracks whether we're inside a cue's payload (i.e. after a timing
  // line, before the next blank). Metadata headers are only recognised
  // OUTSIDE cue payload — inside a cue, `NOTE`/`STYLE`/`REGION` lines
  // are ordinary caption text and must be preserved verbatim.
  let inCuePayload = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inMetadataBlock) {
      // A blank line ends any NOTE / STYLE / REGION block. Emit the blank
      // so the resulting VTT still separates neighbouring cue blocks.
      if (trimmed === "") {
        inMetadataBlock = false;
        kept.push(line);
      }
      continue;
    }

    if (inCuePayload) {
      // A blank line closes the cue. Any other line is cue payload text
      // and MUST be kept — even if it begins with "NOTE "/"STYLE "/etc.
      // (a legitimate caption like "NOTE THAT..." would otherwise be
      // destroyed as a false-positive metadata block).
      if (trimmed === "") {
        inCuePayload = false;
      }
      kept.push(line);
      continue;
    }

    // A timing line opens a cue payload block. Keep it and flip the
    // flag so subsequent non-blank lines are treated as cue text.
    if (trimmed.includes("-->")) {
      inCuePayload = true;
      kept.push(line);
      continue;
    }

    // Between cues: check for a NOTE / STYLE / REGION header. The regex
    // accepts both SPACE and TAB separators, and a bare token at
    // end-of-line, per the WebVTT spec. A line like `NOTEBOOK` does
    // NOT match because the character after the token is alphabetic.
    if (VTT_METADATA_HEADER_PATTERN.test(trimmed)) {
      inMetadataBlock = true;
      continue;
    }

    kept.push(line);
  }

  // Collapse any runs of 3+ blank lines introduced by stripping blocks.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function isTimingLine(line: string): boolean {
  return line.includes("-->");
}

function parseNumericCueIdentifier(line: string): number | null {
  if (!/^\d+$/.test(line)) {
    return null;
  }

  return Number.parseInt(line, 10);
}

function isLikelyTitledCueIdentifier(line: string): boolean {
  return /^\d+\s+-\s+\S.*$/.test(line);
}

function isLikelyCueIdentifier({
  line,
  nextLine,
  previousCueIdentifier,
}: {
  line: string;
  nextLine?: string;
  previousCueIdentifier?: number | null;
}): boolean {
  if (!line || !nextLine || !isTimingLine(nextLine)) {
    return false;
  }

  const numericIdentifier = parseNumericCueIdentifier(line);
  if (numericIdentifier !== null) {
    if (previousCueIdentifier === null || previousCueIdentifier === undefined) {
      return numericIdentifier === 1;
    }

    return numericIdentifier === (previousCueIdentifier + 1);
  }

  return isLikelyTitledCueIdentifier(line);
}

function getCueIdentifierLineIndex(
  lines: string[],
  timingLineIndex: number,
  previousCueIdentifier: number | null,
): number {
  const identifierIndex = timingLineIndex - 1;
  if (identifierIndex < 0) {
    return -1;
  }

  const candidate = lines[identifierIndex].trim();
  if (!candidate || isTimingLine(candidate)) {
    return -1;
  }

  return isLikelyCueIdentifier({
    line: candidate,
    nextLine: lines[timingLineIndex]?.trim(),
    previousCueIdentifier,
  }) ?
    identifierIndex :
      -1;
}

export function extractTextFromVTT(vttContent: string): string {
  if (!vttContent.trim()) {
    return "";
  }

  const lines = vttContent.split("\n");
  const textLines: string[] = [];
  let previousCueIdentifier: number | null = null;
  let isInsideNoteBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const nextLine = lines[i + 1]?.trim();

    if (!line) {
      isInsideNoteBlock = false;
      continue;
    }
    if (isInsideNoteBlock)
      continue;
    if (line === "WEBVTT")
      continue;
    if (line === "NOTE" || line.startsWith("NOTE ")) {
      isInsideNoteBlock = true;
      continue;
    }
    if (isTimingLine(line))
      continue;
    if (isLikelyCueIdentifier({ line, nextLine, previousCueIdentifier })) {
      previousCueIdentifier = parseNumericCueIdentifier(line);
      continue;
    }
    if (line.startsWith("STYLE") || line.startsWith("REGION"))
      continue;

    // Length-cap per line: a single VTT line over the cap is always
    // adversarial (legitimate caption lines are short) and we don't
    // want an attacker's long line surviving into the joined prompt
    // text below.
    const cleanLine = capCueTextLength(line.replace(/<[^>]*>/g, "").trim());

    if (cleanLine) {
      textLines.push(cleanLine);
    }
  }

  // Strip invisible / bidi-control characters and apply Unicode NFKC
  // before returning: the result is about to be sent to an LLM as
  // transcript content, so a homoglyph/zero-width payload hidden in
  // cue text must not survive this boundary. See `sanitizeUntrustedText`
  // for the full rationale.
  return sanitizeUntrustedText(
    textLines.join(" ").replace(/\s+/g, " ").trim(),
  );
}

export function vttTimestampToSeconds(timestamp: string): number {
  const parts = timestamp.split(":");
  if (parts.length !== 3)
    return 0;

  const hours = Number.parseInt(parts[0], 10) || 0;
  const minutes = Number.parseInt(parts[1], 10) || 0;
  const seconds = Number.parseFloat(parts[2]) || 0;

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Converts seconds to a human-readable timestamp.
 * Returns M:SS for durations under an hour, H:MM:SS for an hour or more.
 *
 * @param seconds - The number of seconds to convert
 * @returns A formatted timestamp string (e.g., "2:05" or "01:02:05")
 */
export function secondsToTimestamp(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function extractTimestampedTranscript(vttContent: string): string {
  if (!vttContent.trim()) {
    return "";
  }

  const lines = vttContent.split("\n");
  const segments: Array<{ time: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.includes("-->")) {
      const startTime = line.split(" --> ")[0].trim();
      const timeInSeconds = vttTimestampToSeconds(startTime);

      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) {
        j++;
      }

      if (j < lines.length) {
        const text = capCueTextLength(lines[j].trim().replace(/<[^>]*>/g, ""));
        if (text) {
          segments.push({ time: timeInSeconds, text });
        }
      }
    }
  }

  // Sanitize before returning — this text reaches the chapters workflow's
  // user prompt, so obfuscation needs to be stripped on the way in.
  return sanitizeUntrustedText(
    segments
      .map(segment => `[${Math.floor(segment.time)}s] ${segment.text}`)
      .join("\n"),
  );
}

/**
 * Parses VTT content into structured cues with timing.
 *
 * @param vttContent - Raw VTT file content
 * @returns Array of VTT cues with start/end times and text
 */
export function parseVTTCues(vttContent: string): VTTCue[] {
  if (!vttContent.trim())
    return [];

  const lines = vttContent.split("\n");
  const cues: VTTCue[] = [];
  let previousCueIdentifier: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (isTimingLine(line)) {
      const [startStr, endStr] = line.split(" --> ").map(s => s.trim());
      const startTime = vttTimestampToSeconds(startStr);
      const endTime = vttTimestampToSeconds(endStr.split(" ")[0]); // Handle cue settings
      const currentCueIdentifierLine = lines[i - 1]?.trim() ?? "";
      const currentCueIdentifier: number | null = isLikelyCueIdentifier({
        line: currentCueIdentifierLine,
        nextLine: line,
        previousCueIdentifier,
      }) ?
          parseNumericCueIdentifier(currentCueIdentifierLine) :
        null;

      // Collect text lines until empty line or next timestamp
      const rawTextLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !isTimingLine(lines[j].trim())) {
        rawTextLines.push(lines[j].trim());
        j++;
      }

      // Some model-generated VTT output omits the blank line between cues.
      // In that case, strip a trailing sequential numeric cue identifier while
      // still preserving legitimate numeric subtitle text like countdowns.
      const trailingNumericLine = parseNumericCueIdentifier(rawTextLines.at(-1) ?? "");
      if (
        trailingNumericLine !== null &&
        isLikelyCueIdentifier({
          line: rawTextLines.at(-1) ?? "",
          nextLine: lines[j]?.trim(),
          previousCueIdentifier: currentCueIdentifier,
        }) &&
        rawTextLines.length > 1
      ) {
        rawTextLines.pop();
      }

      const textLines = rawTextLines
        .map(textLine => textLine.replace(/<[^>]*>/g, ""))
        .filter(Boolean);

      if (textLines.length > 0) {
        cues.push({
          startTime,
          endTime,
          // Sanitize at the cue boundary so every downstream consumer
          // (engagement-insights, translate-captions chunked path, etc.)
          // receives text free of invisible / bidi obfuscation. Length-
          // cap the result so an adversarially oversized cue cannot
          // smuggle a large injection payload into the prompt.
          text: capCueTextLength(sanitizeUntrustedText(textLines.join(" "))),
        });
      }

      previousCueIdentifier = currentCueIdentifier;
    }
  }

  return cues;
}

export function splitVttPreambleAndCueBlocks(vttContent: string): { preamble: string; cueBlocks: string[] } {
  const normalizedContent = normalizeLineEndings(vttContent).trim();
  if (!normalizedContent) {
    return {
      preamble: "WEBVTT",
      cueBlocks: [],
    };
  }

  const rawBlocks = normalizedContent
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean);

  const cueBlockStartIndex = rawBlocks.findIndex(block => block.includes("-->"));
  if (cueBlockStartIndex === -1) {
    return {
      preamble: normalizedContent.startsWith("WEBVTT") ? normalizedContent : `WEBVTT\n\n${normalizedContent}`,
      cueBlocks: [],
    };
  }

  const hasMergedCueBlocks = rawBlocks
    .slice(cueBlockStartIndex)
    .some(block => (block.match(/-->/g) ?? []).length > 1);
  if (hasMergedCueBlocks) {
    const lines = normalizedContent.split("\n");
    const timingLineIndices = lines
      .map((line, index) => (isTimingLine(line.trim()) ? index : -1))
      .filter(index => index >= 0);

    let previousCueIdentifier: number | null = null;
    const firstCueStartIndex = getCueIdentifierLineIndex(lines, timingLineIndices[0], previousCueIdentifier);
    const preambleEndIndex = firstCueStartIndex >= 0 ? firstCueStartIndex : timingLineIndices[0];
    const preamble = lines.slice(0, preambleEndIndex).join("\n").trim() || "WEBVTT";
    const cueBlocks = timingLineIndices.map((timingLineIndex, index) => {
      const cueIdentifierLineIndex = getCueIdentifierLineIndex(lines, timingLineIndex, previousCueIdentifier);
      const cueStartIndex = cueIdentifierLineIndex >= 0 ? cueIdentifierLineIndex : timingLineIndex;
      const currentCueIdentifier = cueIdentifierLineIndex >= 0 ?
          parseNumericCueIdentifier(lines[cueIdentifierLineIndex].trim()) :
        null;
      const nextTimingLineIndex = timingLineIndices[index + 1] ?? lines.length;
      let cueEndIndex = nextTimingLineIndex - 1;

      while (cueEndIndex > timingLineIndex && !lines[cueEndIndex].trim()) {
        cueEndIndex--;
      }

      const nextCueIdentifierLineIndex = index < (timingLineIndices.length - 1) ?
          getCueIdentifierLineIndex(lines, nextTimingLineIndex, currentCueIdentifier) :
          -1;

      if (nextCueIdentifierLineIndex === cueEndIndex) {
        cueEndIndex--;
      }

      while (cueEndIndex > timingLineIndex && !lines[cueEndIndex].trim()) {
        cueEndIndex--;
      }

      previousCueIdentifier = currentCueIdentifier;

      return lines.slice(cueStartIndex, cueEndIndex + 1).join("\n").trim();
    });

    return {
      preamble,
      cueBlocks,
    };
  }

  const preambleBlocks = rawBlocks.slice(0, cueBlockStartIndex);
  const cueBlocks = rawBlocks.slice(cueBlockStartIndex);
  const preamble = preambleBlocks.length > 0 ? preambleBlocks.join("\n\n") : "WEBVTT";

  return {
    preamble,
    cueBlocks,
  };
}

export function buildVttFromCueBlocks(cueBlocks: string[], preamble: string = "WEBVTT"): string {
  if (cueBlocks.length === 0) {
    return `${preamble.trim()}\n`;
  }

  return `${preamble.trim()}\n\n${cueBlocks.map(block => block.trim()).join("\n\n")}\n`;
}

export function replaceCueText(cueBlock: string, translatedText: string): string {
  const lines = normalizeLineEndings(cueBlock)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const timingLineIndex = lines.findIndex(line => line.includes("-->"));

  if (timingLineIndex === -1) {
    throw new Error("Cue block is missing a timestamp line");
  }

  const headerLines = lines.slice(0, timingLineIndex + 1);
  const translatedLines = normalizeLineEndings(translatedText)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  return [...headerLines, ...translatedLines].join("\n");
}

export function buildVttFromTranslatedCueBlocks(
  cueBlocks: string[],
  translatedTexts: string[],
  preamble: string = "WEBVTT",
): string {
  if (cueBlocks.length !== translatedTexts.length) {
    throw new Error(`Expected ${cueBlocks.length} translated cues, received ${translatedTexts.length}`);
  }

  return buildVttFromCueBlocks(
    cueBlocks.map((cueBlock, index) => replaceCueText(cueBlock, translatedTexts[index])),
    preamble,
  );
}

export function concatenateVttSegments(
  segments: string[],
  preamble: string = "WEBVTT",
): string {
  const cueBlocks = segments.flatMap(segment => splitVttPreambleAndCueBlocks(segment).cueBlocks);
  return buildVttFromCueBlocks(cueBlocks, preamble);
}

/**
 * Builds a transcript URL for the given playback ID and track ID.
 * If a signing context is provided, the URL will be signed with a token.
 *
 * @param playbackId - The Mux playback ID
 * @param trackId - The text track ID
 * @param shouldSign - Flag for whether or not to use signed playback IDs
 * @returns Transcript URL (signed if context provided)
 */
export async function buildTranscriptUrl(
  playbackId: string,
  trackId: string,
  shouldSign: boolean = false,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  "use step";
  const baseUrl = `${getMuxStreamOrigin()}/${playbackId}/text/${trackId}.vtt`;

  if (shouldSign) {
    return signUrl(baseUrl, playbackId, "video", undefined, credentials);
  }

  return baseUrl;
}

export async function fetchTranscriptForAsset(
  asset: MuxAsset,
  playbackId: string,
  options: TranscriptFetchOptions = {},
): Promise<TranscriptResult> {
  "use step";
  const {
    languageCode,
    cleanTranscript = true,
    shouldSign,
    credentials,
    required = false,
  } = options;
  const track = findCaptionTrack(asset, languageCode);

  if (!track) {
    if (required) {
      const availableLanguages = getReadyTextTracks(asset)
        .map(t => t.language_code)
        .filter(Boolean)
        .join(", ");
      throw new MuxAiError(
        `No caption track found${languageCode ? ` for language ${languageCode}` : ""}. Available languages: ${availableLanguages || "none"}.`,
        { type: "validation_error" },
      );
    }
    return { transcriptText: "" };
  }

  if (!track.id) {
    if (required) {
      throw new MuxAiError("Transcript track is missing an id.", { type: "validation_error" });
    }
    return { transcriptText: "", track };
  }

  const transcriptUrl = await buildTranscriptUrl(playbackId, track.id, shouldSign, credentials);

  try {
    const response = await fetch(transcriptUrl);
    if (!response.ok) {
      if (required) {
        throw new Error(`Failed to fetch transcript (HTTP ${response.status})`);
      }
      return { transcriptText: "", transcriptUrl, track };
    }

    const rawVtt = await response.text();
    const transcriptText = cleanTranscript ? extractTextFromVTT(rawVtt) : rawVtt;

    if (required && !transcriptText.trim()) {
      throw new MuxAiError("Transcript is empty.", { type: "validation_error" });
    }

    return { transcriptText, transcriptUrl, track };
  } catch (error) {
    if (required) {
      wrapError(error, "Failed to fetch transcript");
    }
    console.warn("Failed to fetch transcript:", error);
    return { transcriptText: "", transcriptUrl, track };
  }
}
