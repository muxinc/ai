import { describe, expect, it } from "vitest";

import { isLegacyMuxAiError, MuxAiError } from "../../src/lib/mux-ai-error";
import { MUX_AI_ERROR_GENERIC_MESSAGES, toPublicError } from "../../src/lib/public-error";
import type { Hotspot } from "../../src/primitives/hotspots";
import type { Shot } from "../../src/primitives/shots";
import type { MuxAsset } from "../../src/types";
import {
  extractTranscriptSegmentsForHotspots,
  generateEngagementInsights,
  mapShotsToHotspots,
} from "../../src/workflows/engagement-insights";
import { MOCK_HOTSPOTS_COMBINED, MOCK_SHOTS } from "../helpers/mock-engagement-data";

// ─────────────────────────────────────────────────────────────────────────────
// mapShotsToHotspots
// ─────────────────────────────────────────────────────────────────────────────

describe("mapShotsToHotspots", () => {
  it("returns empty array for empty shots", () => {
    expect(mapShotsToHotspots([], MOCK_HOTSPOTS_COMBINED)).toEqual([]);
  });

  it("maps hotspot to shot within its time range", () => {
    // Hotspot at 86922-90331ms (86.9-90.3s), shot at 85s should match
    const urls = mapShotsToHotspots(MOCK_SHOTS, MOCK_HOTSPOTS_COMBINED);
    expect(urls.length).toBe(MOCK_HOTSPOTS_COMBINED.length);
    urls.forEach(url => expect(url).toMatch(/^https:\/\/image\.mux\.com/));
  });

  it("picks nearest shot when no shot in range", () => {
    // Single shot far from any hotspot
    const farShot: Shot[] = [{ startTime: 999, imageUrl: "https://image.mux.com/far.png" }];
    const urls = mapShotsToHotspots(farShot, MOCK_HOTSPOTS_COMBINED);
    expect(urls.length).toBe(MOCK_HOTSPOTS_COMBINED.length);
    expect(urls[0]).toBe("https://image.mux.com/far.png");
  });

  it("picks shot closest to midpoint when multiple in range", () => {
    // Hotspot 65000-70000ms (65-70s). Two shots in range at 66s and 69s
    const shots: Shot[] = [
      { startTime: 66, imageUrl: "https://image.mux.com/shot-66.png" },
      { startTime: 69, imageUrl: "https://image.mux.com/shot-69.png" },
    ];
    const hotspots: Hotspot[] = [{ startMs: 65000, endMs: 70000, score: 0.5 }];
    // Midpoint is 67.5s, so shot at 66s is slightly closer than 69s
    const urls = mapShotsToHotspots(shots, hotspots);
    expect(urls[0]).toBe("https://image.mux.com/shot-66.png");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractTranscriptSegmentsForHotspots
// ─────────────────────────────────────────────────────────────────────────────

describe("extractTranscriptSegmentsForHotspots", () => {
  const sampleVTT = `WEBVTT

00:00:14.000 --> 00:00:18.000
Welcome to the show

00:00:28.000 --> 00:00:32.000
Now let me demonstrate

00:01:05.000 --> 00:01:10.000
This is the transition part

00:01:26.000 --> 00:01:32.000
Here is the key technique`;

  it("returns empty array for empty VTT", () => {
    const result = extractTranscriptSegmentsForHotspots("", MOCK_HOTSPOTS_COMBINED);
    expect(result).toEqual([]);
  });

  it("returns empty array for whitespace VTT", () => {
    const result = extractTranscriptSegmentsForHotspots("   \n  ", MOCK_HOTSPOTS_COMBINED);
    expect(result).toEqual([]);
  });

  it("extracts overlapping cues for each hotspot", () => {
    const result = extractTranscriptSegmentsForHotspots(sampleVTT, MOCK_HOTSPOTS_COMBINED);
    expect(result.length).toBe(MOCK_HOTSPOTS_COMBINED.length);

    // First hotspot at 15000-20000ms (15-20s) should match "Welcome to the show"
    expect(result[0].text).toContain("Welcome to the show");

    // Second hotspot at 28974-30678ms (28.9-30.7s) should match "Now let me demonstrate"
    expect(result[1].text).toContain("demonstrate");
  });

  it("returns empty text when no cues overlap", () => {
    // Hotspot in a gap between cues
    const hotspots: Hotspot[] = [{ startMs: 45000, endMs: 50000, score: 0.5 }];
    const result = extractTranscriptSegmentsForHotspots(sampleVTT, hotspots);
    expect(result[0].text).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Classified failures
// ─────────────────────────────────────────────────────────────────────────────

describe("generateEngagementInsights failures", () => {
  async function failure(run: () => Promise<unknown>): Promise<MuxAiError> {
    const error = await run().then(() => undefined, (thrown: unknown) => thrown);
    if (!MuxAiError.is(error)) {
      throw new Error(`expected a MuxAiError, got ${String(error)}`);
    }
    return error;
  }

  it("rejects an out-of-range hotspotLimit as the caller's input", async () => {
    const error = await failure(() => generateEngagementInsights("asset-1", { hotspotLimit: 11 }));

    expect(error).toMatchObject({
      type: "validation_error",
      source: "request",
      facts: { parameter: "hotspotLimit", value: 11, min: 1, max: 10 },
      retryable: false,
      name: "FatalError",
    });
    expect(isLegacyMuxAiError(error)).toBe(false);
    expect(toPublicError(error).message).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.request);
  });

  it("rejects an asset without a duration as the asset's state", async () => {
    const assetSnapshot = { id: "asset-1", playback_ids: [{ id: "pb-1", policy: "public" }], tracks: [] } as unknown as MuxAsset;

    const error = await failure(() => generateEngagementInsights("asset-1", { assetSnapshot }));

    expect(error).toMatchObject({ type: "validation_error", source: "asset", facts: { assetId: "asset-1" } });
    expect(toPublicError(error).message).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.asset);
  });
});
