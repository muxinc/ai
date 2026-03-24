import { describe, expect, it } from "vitest";

import { computeHeatmapPercentile, computeHeatmapStatistics } from "../../src/primitives/heatmap";
import type { Hotspot } from "../../src/primitives/hotspots";
import type { Shot } from "../../src/primitives/shots";
import {
  deduplicateHotspots,
  extractTranscriptSegmentsForHotspots,
  mapShotsToHotspots,
} from "../../src/workflows/engagement-insights";
import { MOCK_HEATMAP_DATA, MOCK_HOTSPOTS_COMBINED, MOCK_SHOTS } from "../helpers/mock-engagement-data";

// ─────────────────────────────────────────────────────────────────────────────
// computeHeatmapStatistics
// ─────────────────────────────────────────────────────────────────────────────

describe("computeHeatmapStatistics", () => {
  it("throws on empty heatmap", () => {
    expect(() => computeHeatmapStatistics([], 180)).toThrow("Heatmap data is empty");
  });

  it("handles single-element heatmap", () => {
    const stats = computeHeatmapStatistics([0.5], 180);
    expect(stats.average).toBe(0.5);
    expect(stats.peak.value).toBe(0.5);
    expect(stats.lowest.value).toBe(0.5);
    expect(stats.significantDrops).toEqual([]);
  });

  it("handles all-zero heatmap", () => {
    const zeros = Array.from<number>({ length: 100 }).fill(0);
    const stats = computeHeatmapStatistics(zeros, 180);
    expect(stats.average).toBe(0);
    expect(stats.peak.value).toBe(0);
    expect(stats.lowest.value).toBe(0);
    expect(stats.significantDrops).toEqual([]);
  });

  it("computes correct statistics for realistic data", () => {
    const stats = computeHeatmapStatistics(MOCK_HEATMAP_DATA, 180);

    expect(stats.average).toBeGreaterThan(0);
    expect(stats.peak.value).toBe(Math.max(...MOCK_HEATMAP_DATA));
    expect(stats.lowest.value).toBe(Math.min(...MOCK_HEATMAP_DATA));
    expect(stats.peak.timestamp).toBeDefined();
    expect(stats.lowest.timestamp).toBeDefined();
  });

  it("merges consecutive significant drops into ranges", () => {
    // Create a heatmap with a steep, sustained drop in the middle
    const heatmap = [
      ...Array.from<number>({ length: 20 }).fill(0.9), // high
      ...Array.from<number>({ length: 10 }).fill(0.3), // sharp sustained drop
      ...Array.from<number>({ length: 70 }).fill(0.9), // high again
    ];

    const stats = computeHeatmapStatistics(heatmap, 180);

    // Drops at indices ~20-29 should be merged into one range, not 10 individual drops
    const dropsInMidSection = stats.significantDrops.filter(
      d => d.startIndex >= 18 && d.endIndex <= 32,
    );
    expect(dropsInMidSection.length).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeHeatmapPercentile
// ─────────────────────────────────────────────────────────────────────────────

describe("computeHeatmapPercentile", () => {
  it("returns 0 for empty heatmap", () => {
    expect(computeHeatmapPercentile(0.5, [])).toBe(0);
  });

  it("returns 0 for lowest value", () => {
    const min = Math.min(...MOCK_HEATMAP_DATA);
    expect(computeHeatmapPercentile(min, MOCK_HEATMAP_DATA)).toBe(0);
  });

  it("returns high percentile for peak value", () => {
    const max = Math.max(...MOCK_HEATMAP_DATA);
    const percentile = computeHeatmapPercentile(max, MOCK_HEATMAP_DATA);
    expect(percentile).toBeGreaterThanOrEqual(90);
  });

  it("returns correct percentile for median-ish value", () => {
    const sorted = [...MOCK_HEATMAP_DATA].sort((a, b) => a - b);
    const median = sorted[50];
    const percentile = computeHeatmapPercentile(median, MOCK_HEATMAP_DATA);
    expect(percentile).toBeGreaterThanOrEqual(30);
    expect(percentile).toBeLessThanOrEqual(70);
  });

  it("handles all-same scores", () => {
    const same = Array.from<number>({ length: 100 }).fill(0.5);
    expect(computeHeatmapPercentile(0.5, same)).toBe(0);
    expect(computeHeatmapPercentile(0.6, same)).toBe(100);
  });
});

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
// deduplicateHotspots
// ─────────────────────────────────────────────────────────────────────────────

describe("deduplicateHotspots", () => {
  it("returns all hotspots when no duplicates", () => {
    const result = deduplicateHotspots(MOCK_HOTSPOTS_COMBINED);
    expect(result.length).toBe(MOCK_HOTSPOTS_COMBINED.length);
  });

  it("removes exact startMs duplicates, keeping first", () => {
    const hotspots: Hotspot[] = [
      { startMs: 1000, endMs: 2000, score: 0.8 },
      { startMs: 1000, endMs: 2500, score: 0.3 }, // same startMs
      { startMs: 3000, endMs: 4000, score: 0.5 },
    ];
    const result = deduplicateHotspots(hotspots);
    expect(result.length).toBe(2);
    expect(result[0].score).toBe(0.8); // first one kept
    expect(result[1].startMs).toBe(3000);
  });

  it("handles empty array", () => {
    expect(deduplicateHotspots([])).toEqual([]);
  });
});
