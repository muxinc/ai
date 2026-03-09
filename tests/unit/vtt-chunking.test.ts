import { describe, expect, it } from "vitest";

import type { VTTCue } from "../../src/primitives/transcripts";
import {
  buildVttFromCueBlocks,
  buildVttFromTranslatedCueBlocks,
  chunkVTTCuesByBudget,
  chunkVTTCuesByDuration,
  concatenateVttSegments,
  splitVttPreambleAndCueBlocks,
} from "../../src/primitives/vtt-chunking";

const SAMPLE_VTT = `WEBVTT

NOTE
This note should be preserved in the final stitched transcript.

1
00:00:00.000 --> 00:05:00.000
Hello there.

2
00:05:00.000 --> 00:10:00.000
This is the second sentence.

3
00:10:00.000 --> 00:15:00.000
This clause continues,

4
00:15:00.000 --> 00:20:00.000
but now it finishes.

5
00:20:02.000 --> 00:25:00.000
New paragraph starts here.

6
00:25:00.000 --> 00:30:00.000
And it ends cleanly.

7
00:30:00.000 --> 00:35:00.000
Final wrap-up sentence.
`;

const SAMPLE_CUES: VTTCue[] = [
  { startTime: 0, endTime: 300, text: "Hello there." },
  { startTime: 300, endTime: 600, text: "This is the second sentence." },
  { startTime: 600, endTime: 900, text: "This clause continues," },
  { startTime: 900, endTime: 1200, text: "but now it finishes." },
  { startTime: 1202, endTime: 1500, text: "New paragraph starts here." },
  { startTime: 1500, endTime: 1800, text: "And it ends cleanly." },
  { startTime: 1800, endTime: 2100, text: "Final wrap-up sentence." },
];

describe("splitVttPreambleAndCueBlocks", () => {
  it("separates preamble metadata from cue blocks", () => {
    const result = splitVttPreambleAndCueBlocks(SAMPLE_VTT);

    expect(result.preamble).toContain("WEBVTT");
    expect(result.preamble).toContain("NOTE");
    expect(result.cueBlocks).toHaveLength(7);
    expect(result.cueBlocks[0]).toContain("00:00:00.000 --> 00:05:00.000");
  });
});

describe("buildVttFromCueBlocks", () => {
  it("builds a valid VTT document from cue blocks", () => {
    const { preamble, cueBlocks } = splitVttPreambleAndCueBlocks(SAMPLE_VTT);
    const rebuiltVtt = buildVttFromCueBlocks(cueBlocks.slice(0, 2), preamble);

    expect(rebuiltVtt.startsWith("WEBVTT")).toBe(true);
    expect(rebuiltVtt).toContain("00:00:00.000 --> 00:05:00.000");
    expect(rebuiltVtt).not.toContain("00:10:00.000 --> 00:15:00.000");
  });
});

describe("buildVttFromTranslatedCueBlocks", () => {
  it("reuses original cue headers while replacing cue text", () => {
    const { preamble, cueBlocks } = splitVttPreambleAndCueBlocks(SAMPLE_VTT);
    const translatedVtt = buildVttFromTranslatedCueBlocks(
      cueBlocks.slice(0, 2),
      ["Bonjour a tous.", "Voici la deuxieme phrase."],
      preamble,
    );

    expect(translatedVtt).toContain("00:00:00.000 --> 00:05:00.000");
    expect(translatedVtt).toContain("Bonjour a tous.");
    expect(translatedVtt).not.toContain("Hello there.");
  });
});

describe("concatenateVttSegments", () => {
  it("stitches translated segments into a single VTT while keeping the original preamble", () => {
    const { preamble, cueBlocks } = splitVttPreambleAndCueBlocks(SAMPLE_VTT);
    const segmentOne = buildVttFromCueBlocks(cueBlocks.slice(0, 3), "WEBVTT");
    const segmentTwo = buildVttFromCueBlocks(cueBlocks.slice(3), "WEBVTT");

    const stitched = concatenateVttSegments([segmentOne, segmentTwo], preamble);

    expect(stitched.startsWith("WEBVTT")).toBe(true);
    expect(stitched).toContain("This note should be preserved");
    expect(splitVttPreambleAndCueBlocks(stitched).cueBlocks).toHaveLength(7);
  });
});

describe("chunkVTTCuesByBudget", () => {
  it("splits deterministically by cue count", () => {
    const chunks = chunkVTTCuesByBudget(SAMPLE_CUES, {
      maxCuesPerChunk: 3,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0].cueStartIndex).toBe(0);
    expect(chunks[0].cueEndIndex).toBe(2);
    expect(chunks[1].cueStartIndex).toBe(3);
    expect(chunks[1].cueEndIndex).toBe(5);
    expect(chunks[2].cueStartIndex).toBe(6);
    expect(chunks[2].cueEndIndex).toBe(6);
  });

  it("splits by text token budget even when cue count stays low", () => {
    const cues: VTTCue[] = [
      { startTime: 0, endTime: 1, text: "one two three four five six seven eight nine ten" },
      { startTime: 1, endTime: 2, text: "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty" },
      { startTime: 2, endTime: 3, text: "short ending cue" },
    ];

    const chunks = chunkVTTCuesByBudget(cues, {
      maxCuesPerChunk: 10,
      maxTextTokensPerChunk: 20,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].cueCount).toBe(1);
    expect(chunks[1].cueCount).toBe(2);
  });
});

describe("chunkVTTCuesByDuration", () => {
  it("returns one chunk when content already fits under the target duration", () => {
    const chunks = chunkVTTCuesByDuration(SAMPLE_CUES.slice(0, 3), {
      targetChunkDurationSeconds: 1800,
      maxChunkDurationSeconds: 2100,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].cueCount).toBe(3);
  });

  it("splits near natural sentence boundaries around the target duration", () => {
    const chunks = chunkVTTCuesByDuration(SAMPLE_CUES, {
      targetChunkDurationSeconds: 1800,
      maxChunkDurationSeconds: 2100,
      minChunkDurationSeconds: 1200,
      boundaryLookaheadCues: 4,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].cueEndIndex).toBe(5);
    expect(chunks[0].endTime).toBe(1800);
    expect(chunks[1].cueStartIndex).toBe(6);
  });

  it("falls back to the best available boundary before the max duration", () => {
    const cues: VTTCue[] = [
      { startTime: 0, endTime: 400, text: "Lowercase continuation" },
      { startTime: 400, endTime: 800, text: "still going" },
      { startTime: 800, endTime: 1200, text: "and still going" },
      { startTime: 1200, endTime: 1600, text: "finally ending here." },
      { startTime: 1600, endTime: 2000, text: "Another sentence." },
    ];

    const chunks = chunkVTTCuesByDuration(cues, {
      targetChunkDurationSeconds: 900,
      maxChunkDurationSeconds: 1500,
      minChunkDurationSeconds: 600,
      boundaryLookaheadCues: 2,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].cueEndIndex).toBe(2);
    expect(chunks[1].cueStartIndex).toBe(3);
  });
});
