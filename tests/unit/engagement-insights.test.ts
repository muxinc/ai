import { describe, expect, it } from "vitest";

import type { Hotspot } from "../../src/primitives/hotspots";
import type { Shot } from "../../src/primitives/shots";
import {
  extractTranscriptSegmentsForHotspots,
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
