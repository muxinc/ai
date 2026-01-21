import { describe, expect, it } from "vitest";

import { getThumbnailUrls } from "../../src/primitives/thumbnails";

describe("getThumbnailUrls", () => {
  const testPlaybackId = "test-playback-id";

  describe("basic thumbnail generation", () => {
    it("should generate thumbnails at default 10 second intervals", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        shouldSign: false,
      });

      // 100 seconds / 10 second interval = 10 thumbnails (0, 10, 20, ..., 90)
      expect(urls.length).toBe(10);
      expect(urls[0]).toContain("time=0");
      expect(urls[9]).toContain("time=90");
    });

    it("should generate thumbnails at custom intervals", async () => {
      const duration = 60;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        interval: 20,
        shouldSign: false,
      });

      // 60 seconds / 20 second interval = 3 thumbnails (0, 20, 40)
      expect(urls.length).toBe(3);
      expect(urls[0]).toContain("time=0");
      expect(urls[1]).toContain("time=20");
      expect(urls[2]).toContain("time=40");
    });

    it("should generate 5 thumbnails for short videos (≤50 seconds)", async () => {
      const duration = 30;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        shouldSign: false,
      });

      // Short videos use special logic: 5 evenly spaced thumbnails
      expect(urls.length).toBe(5);
    });
  });

  describe("maxSamples parameter", () => {
    it("should cap thumbnails to maxSamples when limit is lower than default", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 5,
        shouldSign: false,
      });

      // Should be capped at 5 thumbnails
      expect(urls.length).toBe(5);
    });

    it("should not affect count when maxSamples is greater than default", async () => {
      const duration = 50;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        interval: 10,
        maxSamples: 100,
        shouldSign: false,
      });

      // 50 / 10 = 5 thumbnails, maxSamples of 100 should not change this
      expect(urls.length).toBe(5);
    });

    it("should always include first frame (time=0) when maxSamples is set", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 3,
        shouldSign: false,
      });

      expect(urls[0]).toContain("time=0");
    });

    it("should always include last frame when maxSamples >= 2", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 4,
        shouldSign: false,
      });

      expect(urls.length).toBe(4);
      expect(urls[0]).toContain("time=0");
      expect(urls[3]).toContain("time=100");
    });

    it("should evenly distribute timestamps when maxSamples is applied", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 5,
        shouldSign: false,
      });

      // 5 samples: 0, 25, 50, 75, 100 (evenly distributed)
      expect(urls.length).toBe(5);
      expect(urls[0]).toContain("time=0");
      expect(urls[1]).toContain("time=25");
      expect(urls[2]).toContain("time=50");
      expect(urls[3]).toContain("time=75");
      expect(urls[4]).toContain("time=100");
    });

    it("should handle maxSamples = 1 (only first frame)", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 1,
        shouldSign: false,
      });

      expect(urls.length).toBe(1);
      expect(urls[0]).toContain("time=0");
    });

    it("should handle maxSamples = 2 (first and last frames)", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 2,
        shouldSign: false,
      });

      expect(urls.length).toBe(2);
      expect(urls[0]).toContain("time=0");
      expect(urls[1]).toContain("time=100");
    });

    it("should work with maxSamples on short videos", async () => {
      const duration = 30;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 3,
        shouldSign: false,
      });

      // Short video generates 5 frames, but maxSamples caps it to 3
      expect(urls.length).toBe(3);
      expect(urls[0]).toContain("time=0");
      expect(urls[2]).toContain("time=30");
    });

    it("should distribute evenly with maxSamples = 10 on 200 second video", async () => {
      const duration = 200;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        interval: 10,
        maxSamples: 10,
        shouldSign: false,
      });

      // Without maxSamples: 200/10 = 20 thumbnails
      // With maxSamples: capped to 10, evenly distributed
      expect(urls.length).toBe(10);

      // Extract timestamps from URLs
      const timestamps = urls.map((url) => {
        const match = url.match(/time=(\d+\.?\d*)/);
        return match ? Number.parseFloat(match[1]) : 0;
      });

      // First and last should be pinned
      expect(timestamps[0]).toBe(0);
      expect(timestamps[9]).toBeCloseTo(200, 1);

      // Middle timestamps should be evenly spaced
      // Expected spacing: 200 / (10-1) = ~22.22
      for (let i = 1; i < timestamps.length - 1; i++) {
        const expected = (200 / (10 - 1)) * i;
        expect(timestamps[i]).toBeCloseTo(expected, 1);
      }
    });
  });

  describe("formatting of URLs", () => {
    it("should include width parameter", async () => {
      const duration = 30;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        width: 1280,
        shouldSign: false,
      });

      urls.forEach((url) => {
        expect(url).toContain("width=1280");
      });
    });

    it("should generate correct base URL structure", async () => {
      const duration = 30;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        shouldSign: false,
      });

      urls.forEach((url) => {
        expect(url).toContain(`https://image.mux.com/${testPlaybackId}/thumbnail.png`);
        expect(url).toContain("time=");
        expect(url).toContain("width=");
      });
    });
  });

  describe("edge cases", () => {
    it("should handle very short duration", async () => {
      const duration = 5;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        shouldSign: false,
      });

      // Short video logic applies
      expect(urls.length).toBeGreaterThan(0);
    });

    it("should handle maxSamples = 0", async () => {
      const duration = 100;
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 0,
        shouldSign: false,
      });

      // maxSamples of 0 should result in empty newTimestamps array, but code pushes at least first frame
      expect(urls.length).toBe(1);
      expect(urls[0]).toContain("time=0");
    });

    it("should handle very long video with small maxSamples", async () => {
      const duration = 3600; // 1 hour
      const urls = await getThumbnailUrls(testPlaybackId, duration, {
        maxSamples: 4,
        shouldSign: false,
      });

      expect(urls.length).toBe(4);

      const timestamps = urls.map((url) => {
        const match = url.match(/time=(\d+\.?\d*)/);
        return match ? Number.parseFloat(match[1]) : 0;
      });

      expect(timestamps[0]).toBe(0);
      expect(timestamps[3]).toBeCloseTo(3600, 1);
    });
  });
});
