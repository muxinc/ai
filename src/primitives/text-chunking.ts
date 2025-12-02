import type { ChunkingStrategy, TextChunk } from "../types";

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
