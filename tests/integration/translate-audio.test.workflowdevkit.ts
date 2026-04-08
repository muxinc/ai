import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import { translateAudio } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("audio Translation Integration Tests for Workflow DevKit", () => {
  const assetId = muxTestAssets.assetId;

  it("should translate audio to French without uploading to Mux", async () => {
    const run = await start(translateAudio, [assetId, "fr", {
      provider: "elevenlabs",
      uploadToMux: false,
    }]);
    expect(run.runId).toMatch(/^wrun_/);
    const result = await run.returnValue;

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("targetLanguageCode");
    expect(result).toHaveProperty("dubbingId");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify target language code
    expect(result.targetLanguageCode).toBe("fr");

    // Verify dubbing ID exists
    expect(typeof result.dubbingId).toBe("string");
    expect(result.dubbingId.length).toBeGreaterThan(0);

    // Since uploadToMux is false, no Mux track should be created
    expect(result.uploadedTrackId).toBeUndefined();
    // But presignedUrl should still be present (S3 upload always happens)
    expect(result.presignedUrl).toBeDefined();
  }, 300000); // 5 minute timeout for ElevenLabs processing
});
