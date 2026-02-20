import Mux from "@mux/mux-node";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { env, reloadEnv } from "../../src/env";
import { getMuxImageOrigin, getMuxStoryboardBaseUrl, getMuxThumbnailBaseUrl } from "../../src/lib/mux-image-url";
import type { SigningContext } from "../../src/lib/url-signing";
import { getMuxSigningContextFromEnv, signPlaybackId, signUrl } from "../../src/lib/url-signing";
import { buildTranscriptUrl, getStoryboardUrl, getThumbnailUrls } from "../../src/primitives";
import { generateChapters, getModerationScores, getSummaryAndTags, hasBurnedInCaptions } from "../../src/workflows";

/**
 * Integration tests for signed playback functionality.
 *
 * These tests require:
 * - MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables
 *
 * Tests will be skipped if the required environment variables are not set.
 */
describe("signed Playback Integration Tests", () => {
  // Hardcoded signed asset ID for testing
  const signedAssetId = "4t018u5y00GavGPz3rhnxPjqAs7P1wsWeFL2kOuKatSXg";
  const signingKeyId = env.MUX_SIGNING_KEY;
  const privateKey = env.MUX_PRIVATE_KEY;

  // Check if signed playback testing is available
  const hasSigningCredentials = !!(signingKeyId && privateKey);
  const canRunSignedTests = hasSigningCredentials;

  // SigningContext is only used for low-level signing function tests
  let signingContext: SigningContext;
  let playbackId: string;
  let muxClient: Mux;

  beforeAll(async () => {
    if (!canRunSignedTests)
      return;

    // Setup signing context for low-level signing function tests
    signingContext = {
      keyId: signingKeyId!,
      keySecret: privateKey!,
    };

    muxClient = new Mux();

    // Fetch the signed asset to get its playback ID
    const asset = await muxClient.video.assets.retrieve(signedAssetId);
    const signedPlayback = asset.playback_ids?.find(pid => pid.policy === "signed");

    if (!signedPlayback?.id) {
      throw new Error(`Asset ${signedAssetId} does not have a signed playback ID`);
    }

    playbackId = signedPlayback.id;
  });

  describe("getMuxSigningContextFromEnv", () => {
    it("should return undefined when no credentials are provided", async () => {
      // Temporarily clear env vars to test the "no credentials" case
      vi.stubEnv("MUX_SIGNING_KEY", "");
      vi.stubEnv("MUX_PRIVATE_KEY", "");
      reloadEnv();

      const context = getMuxSigningContextFromEnv();
      expect(context).toBeUndefined();

      vi.unstubAllEnvs();
      reloadEnv();
    });

    it.skipIf(!hasSigningCredentials)("should resolve signing context from environment variables", async () => {
      // Clear config values to test env var fallback
      const context = await getMuxSigningContextFromEnv();

      // This will use MUX_SIGNING_KEY and MUX_PRIVATE_KEY from env
      if (hasSigningCredentials) {
        expect(context).toBeDefined();
        expect(context?.keyId).toBe(signingKeyId);
        expect(context?.keySecret).toBe(privateKey);
      }
    });
  });

  describe("signPlaybackId", () => {
    it.skipIf(!hasSigningCredentials)("should generate a valid JWT token", async () => {
      const token = await signPlaybackId("test-playback-id", signingContext, "video");

      // JWT tokens have 3 parts separated by dots
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3);
    });

    it.skipIf(!hasSigningCredentials)("should generate different tokens for different types", async () => {
      const videoToken = await signPlaybackId("test-playback-id", signingContext, "video");
      const thumbnailToken = await signPlaybackId("test-playback-id", signingContext, "thumbnail");
      const storyboardToken = await signPlaybackId("test-playback-id", signingContext, "storyboard");

      // Tokens should be different due to different 'aud' claims
      expect(videoToken).not.toBe(thumbnailToken);
      expect(videoToken).not.toBe(storyboardToken);
      expect(thumbnailToken).not.toBe(storyboardToken);
    });
  });

  describe("signUrl", () => {
    it.skipIf(!hasSigningCredentials)("should append token to URL without query params", async () => {
      const baseUrl = getMuxStoryboardBaseUrl("test-id");
      const signedUrl = await signUrl(baseUrl, "test-id", "storyboard");

      expect(signedUrl).toContain(baseUrl);
      expect(signedUrl).toContain("?token=");
    });

    it.skipIf(!hasSigningCredentials)("should append token to URL with existing query params", async () => {
      const baseUrl = `${getMuxThumbnailBaseUrl("test-id")}?width=640`;
      const signedUrl = await signUrl(baseUrl, "test-id", "thumbnail");

      expect(signedUrl).toContain(baseUrl);
      expect(signedUrl).toContain("&token=");
    });
  });

  describe("primitives with Signing", () => {
    describe("getStoryboardUrl", () => {
      it.skipIf(!canRunSignedTests)("should generate signed storyboard URL", async () => {
        const url = await getStoryboardUrl(playbackId, 640, true);

        expect(url).toContain(`${getMuxImageOrigin()}/${playbackId}/storyboard.png`);
        expect(url).toContain("token=");

        // Verify the URL is accessible
        const response = await fetch(url, { method: "HEAD" });
        expect(response.ok).toBe(true);
      });

      it("should return unsigned URL when shouldSign is false", async () => {
        const testPlaybackId = "test-playback-id";
        const url = await getStoryboardUrl(testPlaybackId, 640, false);

        expect(url).toBe(`${getMuxStoryboardBaseUrl(testPlaybackId)}?width=640`);
        expect(url).not.toContain("token=");
      });
    });

    describe("getThumbnailUrls", () => {
      it.skipIf(!canRunSignedTests)("should generate signed thumbnail URLs", async () => {
        const urls = await getThumbnailUrls(playbackId, 30, {
          interval: 10,
          width: 640,
          shouldSign: true,
        });

        expect(urls.length).toBeGreaterThan(0);
        urls.forEach((url) => {
          expect(url).toContain(`${getMuxImageOrigin()}/${playbackId}/thumbnail.png`);
          expect(url).toContain("token=");
        });

        // Verify the first URL is accessible
        const response = await fetch(urls[0], { method: "HEAD" });
        expect(response.ok).toBe(true);
      });

      it("should return unsigned URLs when shouldSign is false", async () => {
        const testPlaybackId = "test-playback-id";
        const urls = await getThumbnailUrls(testPlaybackId, 30, {
          interval: 10,
          width: 640,
          shouldSign: false,
        });

        expect(urls.length).toBeGreaterThan(0);
        urls.forEach((url) => {
          expect(url).toContain(`${getMuxImageOrigin()}/${testPlaybackId}/thumbnail.png`);
          expect(url).not.toContain("token=");
        });
      });

      it.skipIf(!canRunSignedTests)("should work with maxSamples on signed URLs", async () => {
        const urls = await getThumbnailUrls(playbackId, 100, {
          interval: 10,
          width: 640,
          shouldSign: true,
          maxSamples: 5,
        });

        // Should be capped at 5 thumbnails
        expect(urls.length).toBe(5);

        // All URLs should be signed
        urls.forEach((url) => {
          expect(url).toContain(`${getMuxImageOrigin()}/${playbackId}/thumbnail.png`);
          expect(url).toContain("token=");
        });

        // Verify the first URL is accessible
        const response = await fetch(urls[0], { method: "HEAD" });
        expect(response.ok).toBe(true);
      });
    });

    describe("buildTranscriptUrl", () => {
      it.skipIf(!canRunSignedTests)("should generate signed transcript URL", async () => {
        const trackId = "test-track-id";
        const url = await buildTranscriptUrl(playbackId, trackId, true);

        expect(url).toContain(`https://stream.mux.com/${playbackId}/text/${trackId}.vtt`);
        expect(url).toContain("token=");
      });

      it("should return unsigned URL when shouldSign is false", async () => {
        const testPlaybackId = "test-playback-id";
        const trackId = "test-track-id";
        const url = await buildTranscriptUrl(testPlaybackId, trackId, false);

        expect(url).toBe(`https://stream.mux.com/${testPlaybackId}/text/${trackId}.vtt`);
        expect(url).not.toContain("token=");
      });
    });
  });

  describe("workflow Functions with Signed Assets", () => {
    describe("getSummaryAndTags", () => {
      it.skipIf(!canRunSignedTests)("should generate summary for signed asset", async () => {
        const result = await getSummaryAndTags(signedAssetId, {
          provider: "anthropic",
          tone: "neutral",
        });

        expect(result).toBeDefined();
        expect(result.assetId).toBe(signedAssetId);
        expect(result.title).toBeDefined();
        expect(result.description).toBeDefined();
        expect(Array.isArray(result.tags)).toBe(true);
        expect(result.storyboardUrl).toContain("token=");
      });

      it("should throw error for signed asset without signing credentials", async () => {
        // Temporarily clear env vars to test the "no credentials" error case
        vi.stubEnv("MUX_SIGNING_KEY", "");
        vi.stubEnv("MUX_PRIVATE_KEY", "");
        reloadEnv();

        // This test verifies the error message when credentials are missing
        await expect(
          getSummaryAndTags(signedAssetId, {
            provider: "anthropic",
          }),
        ).rejects.toThrow("Signed playback ID requires signing credentials");

        vi.unstubAllEnvs();
        reloadEnv();
      });
    });

    describe("hasBurnedInCaptions", () => {
      it.skipIf(!canRunSignedTests)("should detect burned-in captions for signed asset", async () => {
        const result = await hasBurnedInCaptions(signedAssetId, {
          provider: "anthropic",
        });

        expect(result).toBeDefined();
        expect(result.assetId).toBe(signedAssetId);
        expect(typeof result.hasBurnedInCaptions).toBe("boolean");
        expect(typeof result.confidence).toBe("number");
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      });
    });

    describe("getModerationScores", () => {
      it.skipIf(!canRunSignedTests)("should generate moderation scores for signed asset", async () => {
        const result = await getModerationScores(signedAssetId, {
          provider: "openai",
          model: "omni-moderation-latest",
        });

        expect(result).toBeDefined();
        expect(result.assetId).toBe(signedAssetId);
        expect(result).toHaveProperty("maxScores");
        expect(result).toHaveProperty("thumbnailScores");
        expect(Array.isArray(result.thumbnailScores)).toBe(true);
      });
    });

    describe("generateChapters", () => {
      it.skipIf(!canRunSignedTests)("should generate chapters for signed asset", async () => {
        const result = await generateChapters(signedAssetId, "en", {
          provider: "anthropic",
        });

        expect(result).toBeDefined();
        expect(result.chapters).toBeDefined();
        expect(Array.isArray(result.chapters)).toBe(true);

        // Verify chapter structure if chapters exist
        if (result.chapters.length > 0) {
          result.chapters.forEach((chapter) => {
            expect(chapter).toHaveProperty("startTime");
            expect(chapter).toHaveProperty("title");
            expect(typeof chapter.startTime).toBe("number");
            expect(typeof chapter.title).toBe("string");
          });
        }
      });
    });
  });
});
