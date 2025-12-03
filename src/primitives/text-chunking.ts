import type { ChunkingStrategy, TextChunk } from "../types";

import type { VTTCue } from "./transcripts";

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
