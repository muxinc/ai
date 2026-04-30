import type { ChunkingStrategy, TextChunk } from "../types.ts";

import type { VTTCue } from "./transcripts.ts";

/**
 * Generic text-first chunking utilities.
 *
 * Reach for this module when the downstream consumer only needs chunk text plus
 * lightweight metadata such as token count or approximate start/end times.
 * These helpers are ideal for embeddings, retrieval, summarization inputs, or
 * other workflows where preserving the original document format is not required.
 *
 * This module also includes cue-preserving chunk planners for VTT workflows.
 * Those helpers still operate at the chunk-planning layer; if you need to split
 * or rebuild full VTT documents, use the VTT structure helpers from
 * `@mux/ai/primitives/transcripts`.
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

/**
 * Simple token counter that approximates tokens by word count.
 * For production use with OpenAI, consider using a proper tokenizer like tiktoken.
 * This approximation is generally close enough for chunking purposes (1 token ≈ 0.75 words).
 */
export function estimateTokenCount(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words / 0.75);
}

/**
 * Chunks text into overlapping segments based on token count.
 *
 * @param text - The text to chunk
 * @param maxTokens - Maximum tokens per chunk
 * @param overlapTokens - Number of tokens to overlap between chunks
 * @returns Array of text chunks with metadata
 */
export function chunkByTokens(
  text: string,
  maxTokens: number,
  overlapTokens: number = 0,
): TextChunk[] {
  if (!text.trim()) {
    return [];
  }

  const chunks: TextChunk[] = [];
  const words = text.trim().split(/\s+/);

  // Convert tokens to approximate word count
  const wordsPerChunk = Math.floor(maxTokens * 0.75);
  const overlapWords = Math.floor(overlapTokens * 0.75);

  let chunkIndex = 0;
  let currentPosition = 0;

  while (currentPosition < words.length) {
    const chunkWords = words.slice(
      currentPosition,
      currentPosition + wordsPerChunk,
    );
    const chunkText = chunkWords.join(" ");
    const tokenCount = estimateTokenCount(chunkText);

    chunks.push({
      id: `chunk-${chunkIndex}`,
      text: chunkText,
      tokenCount,
    });

    // Move forward by chunk size minus overlap
    currentPosition += wordsPerChunk - overlapWords;
    chunkIndex++;

    // Prevent infinite loop if overlap is too large
    if (currentPosition <= (chunkIndex - 1) * (wordsPerChunk - overlapWords)) {
      break;
    }
  }

  return chunks;
}

/**
 * Creates a TextChunk from a group of VTT cues.
 */
function createChunkFromCues(cues: VTTCue[], index: number): TextChunk {
  const text = cues.map(c => c.text).join(" ");
  return {
    id: `chunk-${index}`,
    text,
    tokenCount: estimateTokenCount(text),
    startTime: cues[0].startTime,
    endTime: cues[cues.length - 1].endTime,
  };
}

/**
 * Chunks VTT cues into groups that respect natural cue boundaries.
 * Splits at cue boundaries rather than mid-sentence, preserving accurate timestamps.
 *
 * @param cues - Array of VTT cues to chunk
 * @param maxTokens - Maximum tokens per chunk
 * @param overlapCues - Number of cues to overlap between chunks (default: 2)
 * @returns Array of text chunks with accurate start/end times
 */
export function chunkVTTCues(
  cues: VTTCue[],
  maxTokens: number,
  overlapCues: number = 2,
): TextChunk[] {
  if (cues.length === 0)
    return [];

  const chunks: TextChunk[] = [];
  let currentCues: VTTCue[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const cueTokens = estimateTokenCount(cue.text);

    // If adding this cue would exceed limit, finalize current chunk
    if (currentTokens + cueTokens > maxTokens && currentCues.length > 0) {
      chunks.push(createChunkFromCues(currentCues, chunkIndex));
      chunkIndex++;

      // Start new chunk with overlap from end of previous
      const overlapStart = Math.max(0, currentCues.length - overlapCues);
      currentCues = currentCues.slice(overlapStart);
      currentTokens = currentCues.reduce(
        (sum, c) => sum + estimateTokenCount(c.text),
        0,
      );
    }

    currentCues.push(cue);
    currentTokens += cueTokens;
  }

  // Don't forget the last chunk
  if (currentCues.length > 0) {
    chunks.push(createChunkFromCues(currentCues, chunkIndex));
  }

  return chunks;
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

/**
 * Chunks text according to the specified strategy.
 *
 * @param text - The text to chunk
 * @param strategy - The chunking strategy to use
 * @returns Array of text chunks
 */
export function chunkText(text: string, strategy: ChunkingStrategy): TextChunk[] {
  switch (strategy.type) {
    case "token": {
      return chunkByTokens(text, strategy.maxTokens, strategy.overlap ?? 0);
    }
    default: {
      const exhaustiveCheck: never = strategy as never;
      throw new Error(`Unsupported chunking strategy: ${exhaustiveCheck}`);
    }
  }
}
