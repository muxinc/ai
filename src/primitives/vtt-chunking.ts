import { estimateTokenCount } from "@mux/ai/primitives/text-chunking";
import type { VTTCue } from "@mux/ai/primitives/transcripts";

/**
 * VTT document-aware chunking utilities.
 *
 * Reach for this module when you need to split subtitle files while preserving
 * valid VTT structure, cue ordering, and the ability to stitch translated or
 * transformed segments back into one seamless output document.
 *
 * It supports both deterministic cue-budget chunking for model-safe request
 * sizing and duration-aware chunking when you want boundaries to roughly track
 * playback time.
 *
 * This is the right choice for workflows like caption translation, where each
 * chunk still needs to be a real VTT payload and the final consumer should
 * receive a single reconstructed VTT as if it had been processed in one pass.
 *
 * If you only need chunked text for AI tasks such as embeddings or retrieval,
 * prefer `@mux/ai/primitives/text-chunking` instead.
 */

export interface VTTDurationChunkingOptions {
  targetChunkDurationSeconds: number;
  maxChunkDurationSeconds: number;
  minChunkDurationSeconds?: number;
  boundaryLookaheadCues?: number;
  boundaryPauseSeconds?: number;
}

export interface VTTCueBudgetChunkingOptions {
  maxCuesPerChunk: number;
  maxTextTokensPerChunk?: number;
}

export interface VTTDurationChunk {
  id: string;
  cueStartIndex: number;
  cueEndIndex: number;
  cueCount: number;
  startTime: number;
  endTime: number;
}

const DEFAULT_MIN_CHUNK_DURATION_RATIO = 2 / 3;
const DEFAULT_BOUNDARY_LOOKAHEAD_CUES = 12;
const DEFAULT_BOUNDARY_PAUSE_SECONDS = 1.25;
const STRONG_BOUNDARY_SCORE = 4;
const PREFERRED_BOUNDARY_WINDOW_SECONDS = 5 * 60;
const SENTENCE_BOUNDARY_REGEX = /[.!?]["')\]]*$/;
const CLAUSE_BOUNDARY_REGEX = /[,;:]["')\]]*$/;
const NEXT_SENTENCE_START_REGEX = /^[A-Z0-9"'([{]/;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function scoreCueBoundary(cues: VTTCue[], index: number, boundaryPauseSeconds: number): number {
  const cue = cues[index];
  const nextCue = cues[index + 1];

  if (!nextCue) {
    return Number.POSITIVE_INFINITY;
  }

  const trimmedText = cue.text.trim();
  let score = 0;

  if (SENTENCE_BOUNDARY_REGEX.test(trimmedText)) {
    score += 4;
  } else if (CLAUSE_BOUNDARY_REGEX.test(trimmedText)) {
    score += 2;
  }

  if ((nextCue.startTime - cue.endTime) >= boundaryPauseSeconds) {
    score += 2;
  }

  if (NEXT_SENTENCE_START_REGEX.test(nextCue.text.trim())) {
    score += 1;
  }

  return score;
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

export function chunkVTTCuesByBudget(
  cues: VTTCue[],
  options: VTTCueBudgetChunkingOptions,
): VTTDurationChunk[] {
  if (cues.length === 0) {
    return [];
  }

  const maxCuesPerChunk = Math.max(1, options.maxCuesPerChunk);
  let maxTextTokensPerChunk = Number.POSITIVE_INFINITY;
  if (options.maxTextTokensPerChunk) {
    maxTextTokensPerChunk = Math.max(1, options.maxTextTokensPerChunk);
  }

  const chunks: VTTDurationChunk[] = [];
  let chunkIndex = 0;
  let cueStartIndex = 0;
  let currentTokenCount = 0;

  for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
    const cue = cues[cueIndex];
    const cueTokenCount = estimateTokenCount(cue.text);
    const currentCueCount = cueIndex - cueStartIndex;
    const wouldExceedCueCount = currentCueCount >= maxCuesPerChunk;
    const wouldExceedTokenCount =
      currentCueCount > 0 &&
      (currentTokenCount + cueTokenCount) > maxTextTokensPerChunk;

    if (wouldExceedCueCount || wouldExceedTokenCount) {
      chunks.push({
        id: `chunk-${chunkIndex}`,
        cueStartIndex,
        cueEndIndex: cueIndex - 1,
        cueCount: cueIndex - cueStartIndex,
        startTime: cues[cueStartIndex].startTime,
        endTime: cues[cueIndex - 1].endTime,
      });
      cueStartIndex = cueIndex;
      currentTokenCount = 0;
      chunkIndex++;
    }

    currentTokenCount += cueTokenCount;
  }

  chunks.push({
    id: `chunk-${chunkIndex}`,
    cueStartIndex,
    cueEndIndex: cues.length - 1,
    cueCount: cues.length - cueStartIndex,
    startTime: cues[cueStartIndex].startTime,
    endTime: cues[cues.length - 1].endTime,
  });

  return chunks;
}

export function chunkVTTCuesByDuration(
  cues: VTTCue[],
  options: VTTDurationChunkingOptions,
): VTTDurationChunk[] {
  if (cues.length === 0) {
    return [];
  }

  const targetChunkDurationSeconds = Math.max(1, options.targetChunkDurationSeconds);
  const maxChunkDurationSeconds = Math.max(targetChunkDurationSeconds, options.maxChunkDurationSeconds);
  const minChunkDurationSeconds = Math.min(
    targetChunkDurationSeconds,
    Math.max(
      1,
      options.minChunkDurationSeconds ?? Math.floor(targetChunkDurationSeconds * DEFAULT_MIN_CHUNK_DURATION_RATIO),
    ),
  );
  const boundaryLookaheadCues = Math.max(1, options.boundaryLookaheadCues ?? DEFAULT_BOUNDARY_LOOKAHEAD_CUES);
  const boundaryPauseSeconds = options.boundaryPauseSeconds ?? DEFAULT_BOUNDARY_PAUSE_SECONDS;
  const preferredBoundaryStartSeconds = Math.max(
    minChunkDurationSeconds,
    targetChunkDurationSeconds - Math.min(PREFERRED_BOUNDARY_WINDOW_SECONDS, targetChunkDurationSeconds / 6),
  );

  const chunks: VTTDurationChunk[] = [];
  let chunkIndex = 0;
  let cueStartIndex = 0;

  while (cueStartIndex < cues.length) {
    const chunkStartTime = cues[cueStartIndex].startTime;
    let cueEndIndex = cueStartIndex;
    let bestBoundaryIndex = -1;
    let bestBoundaryScore = -1;
    let bestPreferredBoundaryIndex = -1;
    let bestPreferredBoundaryScore = -1;

    while (cueEndIndex < cues.length) {
      const cue = cues[cueEndIndex];
      const currentDuration = cue.endTime - chunkStartTime;

      if (currentDuration >= minChunkDurationSeconds) {
        const boundaryScore = scoreCueBoundary(cues, cueEndIndex, boundaryPauseSeconds);
        if (boundaryScore >= bestBoundaryScore) {
          bestBoundaryIndex = cueEndIndex;
          bestBoundaryScore = boundaryScore;
        }

        if (currentDuration >= preferredBoundaryStartSeconds && boundaryScore >= bestPreferredBoundaryScore) {
          bestPreferredBoundaryIndex = cueEndIndex;
          bestPreferredBoundaryScore = boundaryScore;
        }
      }

      const nextCue = cues[cueEndIndex + 1];
      if (!nextCue) {
        break;
      }

      const nextDuration = nextCue.endTime - chunkStartTime;
      const lookaheadExceeded = cueEndIndex - cueStartIndex >= boundaryLookaheadCues;
      const preferredBoundaryIndex = bestPreferredBoundaryIndex >= cueStartIndex ?
        bestPreferredBoundaryIndex :
        bestBoundaryIndex;
      const preferredBoundaryScore = bestPreferredBoundaryIndex >= cueStartIndex ?
        bestPreferredBoundaryScore :
        bestBoundaryScore;

      if (currentDuration >= targetChunkDurationSeconds) {
        if (preferredBoundaryIndex >= cueStartIndex && preferredBoundaryScore >= STRONG_BOUNDARY_SCORE) {
          cueEndIndex = preferredBoundaryIndex;
          break;
        }

        if (nextDuration > maxChunkDurationSeconds || lookaheadExceeded) {
          cueEndIndex = preferredBoundaryIndex >= cueStartIndex ? preferredBoundaryIndex : cueEndIndex;
          break;
        }
      }

      if (nextDuration > maxChunkDurationSeconds) {
        cueEndIndex = preferredBoundaryIndex >= cueStartIndex ? preferredBoundaryIndex : cueEndIndex;
        break;
      }

      cueEndIndex++;
    }

    chunks.push({
      id: `chunk-${chunkIndex}`,
      cueStartIndex,
      cueEndIndex,
      cueCount: cueEndIndex - cueStartIndex + 1,
      startTime: cues[cueStartIndex].startTime,
      endTime: cues[cueEndIndex].endTime,
    });

    cueStartIndex = cueEndIndex + 1;
    chunkIndex++;
  }

  return chunks;
}
