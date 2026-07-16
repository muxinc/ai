import { describe, expect, it } from "vitest";

import {
  resolveRenderableVideoScope,
  resolveWorkflowScope,
  timeRangesOverlap,
} from "../../src/lib/workflow-scope";

describe("resolveWorkflowScope", () => {
  it("uses the full asset when scope is omitted", () => {
    expect(resolveWorkflowScope(undefined, 120)).toEqual({
      startTime: 0,
      endTime: 120,
    });
  });

  it("fills either omitted boundary", () => {
    expect(resolveWorkflowScope({ startTime: 30 }, 120)).toEqual({
      startTime: 30,
      endTime: 120,
    });
    expect(resolveWorkflowScope({ endTime: 90 }, 120)).toEqual({
      startTime: 0,
      endTime: 90,
    });
  });

  it.each([
    [{ startTime: -1 }, 120, "scope.startTime"],
    [{ startTime: Number.NaN }, 120, "scope.startTime"],
    [{ endTime: Number.POSITIVE_INFINITY }, 120, "scope.endTime"],
    [{ endTime: 121 }, 120, "cannot exceed"],
    [{ startTime: 60, endTime: 60 }, 120, "must be less than"],
    [{ startTime: 70, endTime: 60 }, 120, "must be less than"],
  ])("rejects an invalid scope", (scope, duration, message) => {
    expect(() => resolveWorkflowScope(scope, duration)).toThrow(message);
  });
});

describe("resolveRenderableVideoScope", () => {
  it("treats an empty scope like an omitted scope", () => {
    expect(resolveRenderableVideoScope({}, 120, 100)).toBeUndefined();
    expect(resolveRenderableVideoScope(undefined, 120, 100)).toBeUndefined();
  });

  it("clamps an asset-relative scope to the video track duration", () => {
    expect(resolveRenderableVideoScope({ startTime: 70, endTime: 120 }, 120, 90)).toEqual({
      startTime: 70,
      endTime: 90,
    });
  });

  it("falls back to the asset duration when the video duration is unavailable", () => {
    expect(resolveRenderableVideoScope({ startTime: 70 }, 120, undefined)).toEqual({
      startTime: 70,
      endTime: 120,
    });
  });

  it("rejects a scope with no renderable video", () => {
    expect(() =>
      resolveRenderableVideoScope({ startTime: 100, endTime: 120 }, 120, 90),
    ).toThrow("does not include any renderable video");
    expect(() =>
      resolveRenderableVideoScope({ startTime: 0, endTime: 10 }, 120, 0),
    ).toThrow("does not include any renderable video");
  });
});

describe("timeRangesOverlap", () => {
  it("uses inclusive starts and exclusive ends", () => {
    expect(timeRangesOverlap(10, 20, { startTime: 20, endTime: 30 })).toBe(false);
    expect(timeRangesOverlap(20, 30, { startTime: 10, endTime: 20 })).toBe(false);
    expect(timeRangesOverlap(19, 21, { startTime: 20, endTime: 30 })).toBe(true);
  });

  it("supports one-sided scopes", () => {
    expect(timeRangesOverlap(10, 20, { startTime: 15 })).toBe(true);
    expect(timeRangesOverlap(20, 30, { endTime: 20 })).toBe(false);
  });
});
