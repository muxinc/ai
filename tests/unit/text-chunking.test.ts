import { describe, expect, it } from "vitest";

import {
  chunkByTokens,
  chunkText,
  chunkVTTCues,
  estimateTokenCount,
} from "../../src/primitives/text-chunking";
import type { VTTCue } from "../../src/primitives/transcripts";
import { parseVTTCues } from "../../src/primitives/transcripts";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_VTT_TRANSCRIPT = `WEBVTT

1
00:00:01.050 --> 00:00:01.850
Ow!

2
00:00:02.190 --> 00:00:03.630
Stupid thumbnails.

3
00:00:03.720 --> 00:00:08.160
You know, there's an easier way to get thumbnails.

4
00:00:08.470 --> 00:00:12.660
Quickly grab a still image from any part of your video with the Mux API.

5
00:00:12.780 --> 00:00:15.390
All you need are a few query parameters.

6
00:00:15.560 --> 00:00:16.960
Thumbnail.

7
00:00:16.980 --> 00:00:18.090
What about GIFs?

8
00:00:18.330 --> 00:00:18.960
What?

9
00:00:19.890 --> 00:00:20.880
Not you, Jeff.

10
00:00:20.910 --> 00:00:22.340
GIFs.

11
00:00:22.380 --> 00:00:23.700
I thought it was GIFs.

12
00:00:24.340 --> 00:00:28.805
GIFs, GIFS, it's all the same to Mux with a simple get request.

13
00:00:29.105 --> 00:00:32.015
Because video is fun with Mux.

14
00:00:32.744 --> 00:00:34.315
Fun with Mux.
`;

// ─────────────────────────────────────────────────────────────────────────────
// estimateTokenCount
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateTokenCount", () => {
  it("estimates tokens for a simple sentence", () => {
    const result = estimateTokenCount("Hello world");
    // 2 words / 0.75 = 2.67 -> ceil = 3
    expect(result).toBe(3);
  });

  it("estimates tokens for longer text", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = estimateTokenCount(text);
    // 9 words / 0.75 = 12
    expect(result).toBe(12);
  });

  it("handles single word", () => {
    const result = estimateTokenCount("Hello");
    // 1 word / 0.75 = 1.33 -> ceil = 2
    expect(result).toBe(2);
  });

  it("handles empty string", () => {
    const result = estimateTokenCount("");
    // Empty string split gives [""], length 1
    expect(result).toBe(2);
  });

  it("handles whitespace-only string", () => {
    const result = estimateTokenCount("   ");
    // Trimmed to empty, split gives [""], length 1
    expect(result).toBe(2);
  });

  it("handles text with extra whitespace", () => {
    const result = estimateTokenCount("  Hello   world  ");
    // Trimmed then split by whitespace = 2 words
    expect(result).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chunkByTokens
// ─────────────────────────────────────────────────────────────────────────────

describe("chunkByTokens", () => {
  it("returns empty array for empty text", () => {
    const result = chunkByTokens("", 100);
    expect(result).toEqual([]);
  });

  it("returns empty array for whitespace-only text", () => {
    const result = chunkByTokens("   \n\t  ", 100);
    expect(result).toEqual([]);
  });

  it("creates single chunk for short text", () => {
    const text = "Hello world";
    const result = chunkByTokens(text, 100);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("chunk-0");
    expect(result[0].text).toBe("Hello world");
    expect(result[0].tokenCount).toBeGreaterThan(0);
  });

  it("creates multiple chunks for long text", () => {
    // Create text that will require multiple chunks
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const result = chunkByTokens(text, 50);

    expect(result.length).toBeGreaterThan(1);
    expect(result[0].id).toBe("chunk-0");
    expect(result[1].id).toBe("chunk-1");
  });

  it("respects maxTokens limit", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const maxTokens = 20;
    const result = chunkByTokens(text, maxTokens);

    // Each chunk's token count should be reasonable (not drastically over limit)
    for (const chunk of result) {
      // Allow some flexibility due to approximation
      expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens + 5);
    }
  });

  it("creates overlapping chunks when overlap is specified", () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const resultNoOverlap = chunkByTokens(text, 30, 0);
    const resultWithOverlap = chunkByTokens(text, 30, 10);

    // With overlap, we should have more chunks
    expect(resultWithOverlap.length).toBeGreaterThanOrEqual(resultNoOverlap.length);
  });

  it("assigns sequential chunk IDs", () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const result = chunkByTokens(text, 20);

    result.forEach((chunk, index) => {
      expect(chunk.id).toBe(`chunk-${index}`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chunkVTTCues
// ─────────────────────────────────────────────────────────────────────────────

describe("chunkVTTCues", () => {
  const createCue = (startTime: number, endTime: number, text: string): VTTCue => ({
    startTime,
    endTime,
    text,
  });

  it("returns empty array for empty cues", () => {
    const result = chunkVTTCues([], 100);
    expect(result).toEqual([]);
  });

  it("creates single chunk for few cues", () => {
    const cues: VTTCue[] = [
      createCue(0, 2, "Hello"),
      createCue(2, 4, "world"),
    ];

    const result = chunkVTTCues(cues, 100);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("chunk-0");
    expect(result[0].text).toBe("Hello world");
    expect(result[0].startTime).toBe(0);
    expect(result[0].endTime).toBe(4);
  });

  it("preserves accurate start and end times", () => {
    const cues: VTTCue[] = [
      createCue(10.5, 12.3, "First cue"),
      createCue(12.3, 15.7, "Second cue"),
      createCue(15.7, 20.1, "Third cue"),
    ];

    const result = chunkVTTCues(cues, 100);

    expect(result[0].startTime).toBe(10.5);
    expect(result[0].endTime).toBe(20.1);
  });

  it("splits into multiple chunks when token limit exceeded", () => {
    // Create cues that will exceed token limit
    const cues: VTTCue[] = [
      createCue(0, 10, "This is the first segment with some words"),
      createCue(10, 20, "This is the second segment with more words"),
      createCue(20, 30, "This is the third segment continuing on"),
      createCue(30, 40, "This is the fourth segment with text"),
      createCue(40, 50, "This is the fifth segment ending here"),
    ];

    // Very low token limit to force multiple chunks
    const result = chunkVTTCues(cues, 15);

    expect(result.length).toBeGreaterThan(1);
  });

  it("includes overlapping cues between chunks", () => {
    const cues: VTTCue[] = [
      createCue(0, 10, "First sentence here"),
      createCue(10, 20, "Second sentence here"),
      createCue(20, 30, "Third sentence here"),
      createCue(30, 40, "Fourth sentence here"),
      createCue(40, 50, "Fifth sentence here"),
    ];

    // Set low token limit and overlap of 2 cues
    const result = chunkVTTCues(cues, 12, 2);

    // With overlap, consecutive chunks should share timestamps
    if (result.length >= 2) {
      // The end of chunk 0 should overlap with the start of chunk 1
      expect(result[1].startTime).toBeLessThan(result[0].endTime!);
    }
  });

  it("handles zero overlap", () => {
    const cues: VTTCue[] = [
      createCue(0, 10, "First segment text"),
      createCue(10, 20, "Second segment text"),
      createCue(20, 30, "Third segment text"),
    ];

    const result = chunkVTTCues(cues, 10, 0);

    // Should still produce valid chunks
    expect(result.length).toBeGreaterThan(0);
    result.forEach((chunk, index) => {
      expect(chunk.id).toBe(`chunk-${index}`);
    });
  });

  it("calculates correct token count for combined cue text", () => {
    const cues: VTTCue[] = [
      createCue(0, 5, "Hello"),
      createCue(5, 10, "world"),
    ];

    const result = chunkVTTCues(cues, 100);

    expect(result[0].tokenCount).toBe(estimateTokenCount("Hello world"));
  });

  it("handles single cue", () => {
    const cues: VTTCue[] = [
      createCue(5.5, 10.2, "Single cue content"),
    ];

    const result = chunkVTTCues(cues, 100);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Single cue content");
    expect(result[0].startTime).toBe(5.5);
    expect(result[0].endTime).toBe(10.2);
  });

  it("handles cue with very long text", () => {
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const cues: VTTCue[] = [
      createCue(0, 60, longText),
    ];

    // Even with low limit, a single cue will form its own chunk
    const result = chunkVTTCues(cues, 10);

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].text).toBe(longText);
  });

  describe("with real transcript fixture", () => {
    it("parses and chunks actual VTT transcript", () => {
      const cues = parseVTTCues(SAMPLE_VTT_TRANSCRIPT);

      // Should parse all 14 cues from the sample transcript
      expect(cues.length).toBe(14);

      // Verify first and last cue timestamps
      expect(cues[0].startTime).toBeCloseTo(1.05, 2);
      expect(cues[0].text).toBe("Ow!");
      expect(cues[13].text).toBe("Fun with Mux.");
    });

    it("creates chunks with accurate timestamps from real transcript", () => {
      const cues = parseVTTCues(SAMPLE_VTT_TRANSCRIPT);
      const result = chunkVTTCues(cues, 500); // High limit = single chunk

      expect(result).toHaveLength(1);
      expect(result[0].startTime).toBeCloseTo(1.05, 2);
      expect(result[0].endTime).toBeCloseTo(34.315, 2);
      expect(result[0].text).toContain("Ow!");
      expect(result[0].text).toContain("Fun with Mux.");
    });

    it("splits real transcript into multiple chunks with low token limit", () => {
      const cues = parseVTTCues(SAMPLE_VTT_TRANSCRIPT);
      const result = chunkVTTCues(cues, 30);

      // With 30 token limit, should create multiple chunks
      expect(result.length).toBeGreaterThan(1);

      // Each chunk should have valid timestamps
      result.forEach((chunk) => {
        expect(chunk.startTime).toBeGreaterThanOrEqual(0);
        expect(chunk.endTime).toBeGreaterThan(chunk.startTime!);
        expect(chunk.text.length).toBeGreaterThan(0);
      });

      // Chunks should be in chronological order
      for (let i = 1; i < result.length; i++) {
        expect(result[i].startTime).toBeGreaterThanOrEqual(result[i - 1].startTime!);
      }
    });

    it("creates overlapping chunks from real transcript", () => {
      const cues = parseVTTCues(SAMPLE_VTT_TRANSCRIPT);
      const result = chunkVTTCues(cues, 40, 2);

      if (result.length >= 2) {
        // With overlap of 2 cues, second chunk should start before first chunk ends
        expect(result[1].startTime).toBeLessThan(result[0].endTime!);

        // Verify overlapping content
        const chunk0Words = result[0].text.split(" ");
        const chunk1Words = result[1].text.split(" ");
        const lastWordsChunk0 = chunk0Words.slice(-5).join(" ");

        // Some words from end of chunk 0 should appear in chunk 1
        expect(chunk1Words.some(word => lastWordsChunk0.includes(word))).toBe(true);
      }
    });

    it("preserves semantic boundaries in real transcript", () => {
      const cues = parseVTTCues(SAMPLE_VTT_TRANSCRIPT);
      const result = chunkVTTCues(cues, 50);

      // Each chunk should contain complete sentences (not cut mid-word)
      result.forEach((chunk) => {
        // Text should not start or end with partial words
        expect(chunk.text).not.toMatch(/^\s/);
        expect(chunk.text).not.toMatch(/\s$/);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chunkText
// ─────────────────────────────────────────────────────────────────────────────

describe("chunkText", () => {
  it("delegates to chunkByTokens for token strategy", () => {
    const text = "Hello world this is a test";
    const result = chunkText(text, { type: "token", maxTokens: 100 });

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(text);
  });

  it("respects overlap in token strategy", () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const resultNoOverlap = chunkText(text, { type: "token", maxTokens: 30 });
    const resultWithOverlap = chunkText(text, { type: "token", maxTokens: 30, overlap: 10 });

    expect(resultWithOverlap.length).toBeGreaterThanOrEqual(resultNoOverlap.length);
  });

  it("handles empty text with token strategy", () => {
    const result = chunkText("", { type: "token", maxTokens: 100 });
    expect(result).toEqual([]);
  });
});
