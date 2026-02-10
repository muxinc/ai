import { describe, expect, it } from "vitest";

import { planSamplingTimestamps, roundToNearestFrameMs } from "../../src/lib/sampling-plan";

describe("sampling-plan", () => {
  it("returns empty when trim removes all usable duration", () => {
    const timestamps = planSamplingTimestamps({
      duration_sec: 2,
      trim_start_sec: 1,
      trim_end_sec: 1,
    });

    expect(timestamps).toEqual([]);
  });

  it("returns a bounded, sorted, unique list", () => {
    const maxCandidates = 8;
    const timestamps = planSamplingTimestamps({
      duration_sec: 120,
      min_candidates: 5,
      max_candidates: maxCandidates,
    });

    expect(timestamps.length).toBeLessThanOrEqual(maxCandidates);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  it("quantizes timestamps to frame boundaries", () => {
    const fps = 30;
    const timestamps = planSamplingTimestamps({
      duration_sec: 20,
      min_candidates: 3,
      max_candidates: 3,
      fps,
    });

    for (const ts of timestamps) {
      expect(ts).toBe(roundToNearestFrameMs(ts, fps));
    }
  });

  it("roundToNearestFrameMs returns values with at most 2 decimal places", () => {
    const fps = 29.97;
    const inputs = [0, 1000 / 3, 1234.5678, 9999.999, 50000];

    for (const ms of inputs) {
      const rounded = roundToNearestFrameMs(ms, fps);
      const decimalPart = rounded.toString().split(".")[1];
      const decimalPlaces = decimalPart ? decimalPart.length : 0;
      expect(decimalPlaces).toBeLessThanOrEqual(2);
    }
  });
});
