import Mux from "@mux/ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";

import env from "../../src/env";
import { MuxAiError } from "../../src/lib/mux-ai-error";
import { translateAudio } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

/** A failed run rejects with WorkflowRunFailedError; the hydrated thrown value is its cause. */
async function captureRunFailure(returnValue: Promise<unknown>): Promise<unknown> {
  try {
    await returnValue;
  } catch (error) {
    return (error as { cause?: unknown }).cause ?? error;
  }
  throw new Error("expected the workflow run to fail");
}

describe("audio Translation Integration Tests for Workflow DevKit", () => {
  const assetId = muxTestAssets.assetId;

  it("should translate audio to French without uploading to Mux", async () => {
    const run = await start(translateAudio, [assetId, "fr", {
      provider: "elevenlabs",
      uploadToS3: false,
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

    // Since both uploadToS3 and uploadToMux are false, neither should be present
    expect(result.uploadedTrackId).toBeUndefined();
    expect(result.presignedUrl).toBeUndefined();
  }, 300000); // 5 minute timeout for ElevenLabs processing

  describe("on a clipped asset", () => {
    const mux = new Mux({ tokenId: env.MUX_TOKEN_ID, tokenSecret: env.MUX_TOKEN_SECRET });
    let clipId: string | undefined;

    beforeAll(async () => {
      const clip = await mux.video.assets.create({
        inputs: [{ url: `mux://assets/${assetId}`, start_time: 0, end_time: 5 }],
        playback_policies: ["public"],
      });
      clipId = clip.id;

      const deadline = Date.now() + 120_000;
      while ((await mux.video.assets.retrieve(clipId)).status !== "ready") {
        if (Date.now() > deadline) {
          throw new Error(`Clip ${clipId} was not ready within 2 minutes`);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }, 180000);

    afterAll(async () => {
      if (clipId) {
        await mux.video.assets.delete(clipId).catch(() => {});
      }
    });

    it("marks the clip the way the pre-check expects", async () => {
      const clip = await mux.video.assets.retrieve(clipId!);

      expect(clip.ingest_type === "on_demand_clip" || clip.source_asset_id === assetId).toBe(true);
    });

    it("rejects before dubbing when the audio track would be uploaded to Mux", async () => {
      const run = await start(translateAudio, [clipId!, "fr", {
        provider: "elevenlabs",
        uploadToS3: false,
        uploadToMux: true,
      }]);

      const error = await captureRunFailure(run.returnValue);

      expect(MuxAiError.is(error)).toBe(true);
      expect((error as InstanceType<typeof MuxAiError>).publicType).toBe("validation_error");
      expect((error as Error).message).toContain(`Asset ${clipId} is a clip`);
    }, 300000);
  });

  it("rejects an audio-only asset before dubbing when the audio track would be uploaded to Mux", async () => {
    const audioOnlyAssetId = muxTestAssets.audioOnlyAssetId;
    const run = await start(translateAudio, [audioOnlyAssetId, "fr", {
      provider: "elevenlabs",
      uploadToS3: false,
      uploadToMux: true,
    }]);

    const error = await captureRunFailure(run.returnValue);

    expect(MuxAiError.is(error)).toBe(true);
    expect((error as InstanceType<typeof MuxAiError>).publicType).toBe("validation_error");
    expect((error as Error).message).toContain(`Asset ${audioOnlyAssetId} is audio-only`);
  }, 300000);
});
