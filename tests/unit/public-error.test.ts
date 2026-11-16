import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { describe, expect, it } from "vitest";

import { LegacyMuxAiError } from "../../src/lib/legacy-mux-ai-error.ts";
import type { MuxAiErrorInit } from "../../src/lib/mux-ai-error.ts";
import { MUX_AI_ERROR_CATALOG, MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "../../src/lib/mux-ai-error.ts";
import { resolveLegacyMp4SupportRendition } from "../../src/lib/mux-static-renditions.ts";
import { planTextTrackReplacement, trackReplacementBlockedError, trackTargetFacts } from "../../src/lib/mux-tracks.ts";
import { createPublicErrorView, genericPublicMessage, MUX_AI_ERROR_GENERIC_MESSAGES, MUX_AI_ERROR_PUBLIC_MAPPINGS, toPublicError } from "../../src/lib/public-error.ts";
import type { MuxAsset } from "../../src/types.ts";

function acrossStepBoundary(error: MuxAiError): MuxAiError {
  // Like Workflow DevKit, use the codec of the error's own class.
  const serde = error.constructor as unknown as Record<symbol, (value: unknown) => unknown>;
  return serde[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(serde[WORKFLOW_SERIALIZE](error)))) as MuxAiError;
}

describe("toPublicError", () => {
  it("never exposes an internal code, its facts or the error's message", () => {
    const error = new MuxAiError("Signed playback ID requires signing credentials. Set MUX_SIGNING_KEY …", {
      code: MUX_AI_ERROR_CODES.SIGNING_CREDENTIALS_MISSING,
      type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
      source: MUX_AI_ERROR_SOURCES.INTERNAL,
      facts: { env: "MUX_SIGNING_KEY" },
    });

    expect(toPublicError(error)).toEqual({ type: "server_error", message: MUX_AI_ERROR_GENERIC_MESSAGES.failed, retryable: false });
  });

  it("falls back to generic wording by source, then by type", () => {
    const view = (init: ConstructorParameters<typeof MuxAiError>[1]) => toPublicError(new MuxAiError("internal detail", init)).message;

    expect(view({ type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST })).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.request);
    expect(view({ type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET })).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.asset);
    expect(view({ type: MUX_AI_ERROR_TYPES.TIMEOUT_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO, transient: false })).toBe(`${MUX_AI_ERROR_GENERIC_MESSAGES.timeout} Please try again.`);
    expect(view({ type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO, facts: { status: 503 } })).toBe(`${MUX_AI_ERROR_GENERIC_MESSAGES.unavailable} Please try again.`);
    expect(view({ type: MUX_AI_ERROR_TYPES.SERVER_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL })).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.failed);
  });

  it("shows a legacy error's message as end-user text, with its type and retryability", () => {
    const error = new LegacyMuxAiError("No caption track found for language fr.", { type: "validation_error" });

    expect(toPublicError(error)).toEqual({ type: "validation_error", message: "No caption track found for language fr.", retryable: false });
    expect(toPublicError(acrossStepBoundary(error))).toEqual(toPublicError(error));
  });

  it("keeps a public code and only its allowed facts", () => {
    const error = new MuxAiError("Audio dubbing failed: No speech was detected in the source media.", {
      code: MUX_AI_ERROR_CODES.DUBBING_FAILED,
      type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
      source: MUX_AI_ERROR_SOURCES.UPSTREAM,
      dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
      facts: { call: "elevenlabs_get_dubbing", status: 200, providerCode: "no_speech", providerError: "No speech was detected in the source media." },
      retryable: false,
    });

    expect(toPublicError(error)).toEqual({
      type: "processing_error",
      code: "dubbing_failed",
      message: "Audio dubbing failed: No speech was detected in the source media.",
      retryable: false,
      facts: { providerError: "No speech was detected in the source media." },
    });
  });

  it("renders each public code from facts, as its sites raise it", () => {
    const view = (code: (typeof MUX_AI_ERROR_CODES)[keyof typeof MUX_AI_ERROR_CODES], facts?: Record<string, any>) =>
      // The code is chosen at runtime here, so its classification comes from the catalog.
      toPublicError(new MuxAiError("internal", { code, ...MUX_AI_ERROR_CATALOG[code], facts } as MuxAiErrorInit)).message;

    expect(view(MUX_AI_ERROR_CODES.INVALID_SCOPE, { reason: "exceeds_duration", endTime: 90, assetDurationSeconds: 60 }))
      .toBe("The requested end time (90s) is after the end of the asset (60s).");
    expect(view(MUX_AI_ERROR_CODES.INVALID_SCOPE, { reason: "no_transcript", startTime: 10 }))
      .toBe("The transcript has no content in the requested time range.");
    expect(view(MUX_AI_ERROR_CODES.INVALID_SCOPE, { reason: "no_video", startTime: 100, endTime: 120, videoEndTime: 90 }))
      .toBe("The requested time range starts at 100s, at or after the end of the asset's video (90s).");
    expect(view(MUX_AI_ERROR_CODES.INVALID_SCOPE, { reason: "no_video" }))
      .toBe("The requested time range doesn't include any video.");
    expect(view(MUX_AI_ERROR_CODES.CAPTION_TRACK_NOT_FOUND, { languageCode: "fr", availableLanguages: ["en", "es"] }))
      .toBe("No ready caption track was found for language fr. Available languages: en, es.");
    expect(view(MUX_AI_ERROR_CODES.CAPTION_TRACK_NOT_FOUND, { trackId: "trk_1", availableTrackIds: [] }))
      .toBe("Track trk_1 was not found or is not ready. Available track IDs: none.");
    expect(view(MUX_AI_ERROR_CODES.AUDIO_TRACK_UNSUPPORTED, { reason: "audio_only" })).toContain("audio-only assets");
    expect(view(MUX_AI_ERROR_CODES.DUBBING_LANGUAGE_UNSUPPORTED, { language: "ur", which: "target" }))
      .toBe("Audio dubbing doesn't support the target language \"ur\".");
    expect(view(MUX_AI_ERROR_CODES.CONTENT_POLICY_BLOCKED, { reason: "safety", category: "violence", provider: "openai" }))
      .toBe("The content was blocked by a content policy (reason: safety; category: violence).");
  });

  it("describes a blocked track replacement from the plan's facts, without SDK option names", () => {
    const asset = { id: "asset-1", tracks: [{ id: "up-en", type: "text", language_code: "en", name: "English", text_source: "uploaded", status: "ready" }] } as unknown as MuxAsset;
    const target = { languageCode: "en", name: "English" };
    const plan = planTextTrackReplacement(asset, target, "fail");
    if (plan.kind !== "blocked") {
      throw new Error("expected a blocked plan");
    }

    const view = toPublicError(trackReplacementBlockedError(plan, { facts: { ...trackTargetFacts(target), assetId: "asset-1" } }));

    expect(view).toMatchObject({ code: "track_replacement_blocked", type: "validation_error" });
    expect(view.message).toBe("A text track already exists for language 'en' or name 'English': English [en, uploaded, ready]. Allow existing tracks to be replaced to replace it.");
    expect(view.message).not.toContain("replaceExistingTracks");
    expect(view.facts).not.toHaveProperty("assetId");

    // A source track deleted before the block: say whether it came back.
    const restored = toPublicError(trackReplacementBlockedError(plan, { facts: { ...trackTargetFacts(target), sourceRestored: true, restoredTrackId: "track-restored" } }));
    expect(restored.message).toMatch(/ The source track was restored as track-restored\.$/);
    const notRestored = toPublicError(trackReplacementBlockedError(plan, { facts: { ...trackTargetFacts(target), sourceRestored: false, restoreError: "secret" } }));
    expect(notRestored.message).toMatch(/ Restoring the source track also failed\.$/);
    expect(notRestored.facts).not.toHaveProperty("restoreError");
  });

  it("words an unusable mp4_support rendition the same way the SDK reports it", () => {
    const rendition = resolveLegacyMp4SupportRendition({ id: "a", mp4_support: "standard", static_renditions: { status: "errored" } } as unknown as MuxAsset);
    if (rendition?.kind !== "unusable") {
      throw new Error("expected an unusable rendition");
    }

    const error = new MuxAiError(rendition.reason, {
      code: MUX_AI_ERROR_CODES.STATIC_RENDITION_UNSUPPORTED,
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      source: MUX_AI_ERROR_SOURCES.ASSET,
      facts: { reason: "unusable", mp4Support: rendition.mp4Support, renditionStatus: rendition.status! },
    });

    expect(toPublicError(error).message).toBe(rendition.reason);
  });

  it("keeps working after a step boundary", () => {
    const revived = acrossStepBoundary(new MuxAiError("x", { code: MUX_AI_ERROR_CODES.DUBBING_LANGUAGE_UNSUPPORTED, type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER, facts: { language: "ur", which: "source" } }));

    expect(toPublicError(revived)).toMatchObject({ code: "dubbing_language_unsupported", facts: { language: "ur", which: "source" } });
  });

  it("keeps the asset in model-output wording, never the provider or model", () => {
    const view = toPublicError(new MuxAiError("Failed to generate insights for asset abc.", {
      code: MUX_AI_ERROR_CODES.MODEL_OUTPUT_MISSING,
      type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
      source: MUX_AI_ERROR_SOURCES.UPSTREAM,
      dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
      facts: { call: "generate_engagement_insights", provider: "openai", model: "gpt-x", assetId: "abc" },
    }));

    expect(view).toEqual({ type: "processing_error", code: "model_output_missing", message: "The AI model returned no usable output for asset abc.", retryable: false, facts: { assetId: "abc" } });
  });

  it("only maps codes whose classification an end user can act on or needs to know", () => {
    expect(Object.keys(MUX_AI_ERROR_PUBLIC_MAPPINGS).sort()).toEqual([
      "asset_duration_unavailable",
      "asset_not_found",
      "audio_track_missing",
      "audio_track_unsupported",
      "caption_track_language_missing",
      "caption_track_not_found",
      "content_policy_blocked",
      "dubbing_failed",
      "dubbing_language_unsupported",
      "dubbing_timeout",
      "invalid_parameter",
      "invalid_scope",
      "model_output_invalid",
      "model_output_missing",
      "parameter_out_of_range",
      "playback_id_not_found",
      "primary_audio_track_conflict",
      "static_rendition_changed",
      "static_rendition_failed",
      "static_rendition_timeout",
      "static_rendition_unsupported",
      "track_replacement_blocked",
      "transcript_empty",
    ]);
  });
});

describe("createPublicErrorView", () => {
  const view = createPublicErrorView<string, string>({
    mappings: {
      [MUX_AI_ERROR_CODES.MODEL_OUTPUT_INVALID]: {
        facts: ["returnedCount"],
        message: facts => `The model returned ${String(facts.returnedCount)} unusable results.`,
      },
    },
    genericMessage: genericPublicMessage,
  });

  it("keeps a public code and only its allowed facts, built into its wording", () => {
    const error = new MuxAiError("Failed to generate valid insights for asset abc.", {
      code: MUX_AI_ERROR_CODES.MODEL_OUTPUT_INVALID,
      type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
      source: MUX_AI_ERROR_SOURCES.UPSTREAM,
      dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
      facts: { call: "generate_engagement_insights", provider: "openai", assetId: "abc", returnedCount: 3 },
    });

    expect(view(error)).toEqual({
      type: "processing_error",
      code: "model_output_invalid",
      message: "The model returned 3 unusable results.",
      retryable: false,
      facts: { returnedCount: 3 },
    });
  });

  it("puts a legacy error's own wording ahead of any mapping", () => {
    expect(view(new LegacyMuxAiError("Try a shorter asset.", { type: "validation_error" }))).toEqual({
      type: "validation_error",
      message: "Try a shorter asset.",
      retryable: false,
    });
  });
});
