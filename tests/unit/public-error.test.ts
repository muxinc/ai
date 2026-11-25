import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { describe, expect, it } from "vitest";

import { LegacyMuxAiError } from "../../src/lib/legacy-mux-ai-error.ts";
import type { MuxAiErrorCode, MuxAiErrorFacts, MuxAiErrorInit } from "../../src/lib/mux-ai-error.ts";
import { MUX_AI_ERROR_CATALOG, MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "../../src/lib/mux-ai-error.ts";
import { resolveLegacyMp4SupportRendition } from "../../src/lib/mux-static-renditions.ts";
import { planTextTrackReplacement, trackReplacementBlockedError, trackTargetFacts } from "../../src/lib/mux-tracks.ts";
import type { MuxAiPublicError } from "../../src/lib/public-error.ts";
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
    expect(view(MUX_AI_ERROR_CODES.INVALID_PARAMETER, { parameter: "maxFreeFormAnswerLength", reason: "not_positive", value: 0 }))
      .toBe("maxFreeFormAnswerLength must be a positive number (received 0).");
    // Out of range: the bound that was crossed, so a "maxLength" below its minimum doesn't read as too long.
    expect(view(MUX_AI_ERROR_CODES.PARAMETER_OUT_OF_RANGE, { parameter: "maxLength.value", value: 4, min: 5, max: 3000, integer: true, unit: "words" }))
      .toBe("maxLength.value must be at least 5 words (received 4).");
    expect(view(MUX_AI_ERROR_CODES.PARAMETER_OUT_OF_RANGE, { parameter: "hotspotLimit", value: 11, min: 1, max: 10, integer: true }))
      .toBe("hotspotLimit must be at most 10 (received 11).");
    expect(view(MUX_AI_ERROR_CODES.PARAMETER_OUT_OF_RANGE, { parameter: "hotspotLimit", value: 2.5, min: 1, max: 10, integer: true }))
      .toBe("hotspotLimit must be an integer between 1 and 10 (received 2.5).");
    expect(view(MUX_AI_ERROR_CODES.PARAMETER_OUT_OF_RANGE, { parameter: "maxLength.value", value: "NaN", min: 5, max: 3000, integer: true, unit: "words" }))
      .toBe("maxLength.value must be an integer between 5 and 3000 words (received NaN).");
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
      "audio_unprocessable",
      "caption_track_language_missing",
      "caption_track_not_found",
      "content_policy_blocked",
      "dubbing_failed",
      "dubbing_language_unsupported",
      "dubbing_timeout",
      "image_unprocessable",
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

describe("model output wording", () => {
  it.each([
    ["model_output_invalid", "The AI model's output for asset a1 couldn't be used."],
    ["model_output_missing", "The AI model returned no usable output for asset a1."],
  ] as const)("adds the retry hint to %s only when a new generation may succeed", (code, base) => {
    const error = (retryable: boolean) => new MuxAiError("x", { code, type: "processing_error", source: "upstream", dependency: "ai_provider", facts: { assetId: "a1" }, retryable });

    expect(toPublicError(error(true)).message).toBe(`${base} Please try again.`);
    expect(toPublicError(error(false)).message).toBe(base);
  });
});

/** The public view of an error with this code and these facts, classified as the catalog says. */
function viewOf(code: MuxAiErrorCode, facts: MuxAiErrorFacts = {}): MuxAiPublicError {
  // The code is chosen at runtime here, so its classification comes from the catalog.
  return toPublicError(new MuxAiError("internal", { code, ...MUX_AI_ERROR_CATALOG[code], facts } as MuxAiErrorInit));
}

// Each case is a failure as a workflow or helper raises it, with the facts it carries (internal ones included).
// The wording is tested here only; the tests of those workflows and helpers assert the codes and facts.
describe("public wording of the SDK's failures", () => {
  it.each<[string, MuxAiErrorCode, MuxAiErrorFacts, string]>([
    // Scope checks.
    ["an end time past the asset", "invalid_scope", { reason: "exceeds_duration", endTime: 121, assetDurationSeconds: 120, inputs: ["scope.endTime"] }, "The requested end time (121s) is after the end of the asset (120s)."],
    // Asset and track state.
    ["a missing asset", "asset_not_found", { call: "get_asset", status: 404, assetId: "asset-9", inputs: ["assetId"], muxErrorType: "not_found" }, "Asset asset-9 could not be found."],
    ["an asset without a duration", "asset_duration_unavailable", { assetId: "asset-1" }, "Asset asset-1 has no valid duration."],
    ["a source track without a language", "caption_track_language_missing", { assetId: "asset-1", trackId: "track-en" }, "Track track-en has no language set, so its source language can't be determined."],
    [
      "a trackName equal to the kept source track's name",
      "track_replacement_blocked",
      {
        trackType: "text",
        languageCode: "en",
        trackName: " english ",
        assetId: "asset-1",
        policy: "fail",
        reason: "name_collision",
        conflictingTracks: [{ id: "track-en", type: "text", name: "English", languageCode: "en", status: "ready", textSource: "uploaded" }],
      },
      "A text track already has the name ' english ': English [en, uploaded, ready]. Choose a different track name.",
    ],
    // invalid_parameter, one case per reason as the SDK's options raise it.
    ["a track passthrough over its limit", "invalid_parameter", { parameter: "trackPassthrough", reason: "too_long", length: 256, maxLength: 255, inputs: ["trackPassthrough"] }, "trackPassthrough must be at most 255 characters (received 256)."],
    ["an audience over its limit", "invalid_parameter", { parameter: "audience", reason: "too_long", length: 161, maxLength: 160, inputs: ["audience"] }, "audience must be at most 160 characters (received 161)."],
    ["a never-translate term over its limit", "invalid_parameter", { parameter: "neverTranslate", reason: "too_long", index: 0, length: 101, maxLength: 100, inputs: ["neverTranslate"] }, "neverTranslate entries must be at most 100 characters (received 101) (entry 0)."],
    ["no edit operation", "invalid_parameter", { reason: "one_of_required", parameters: ["autoCensorProfanity", "replacements", "speakerReplacements"], inputs: ["autoCensorProfanity", "replacements", "speakerReplacements"] }, "Provide at least one of autoCensorProfanity, replacements or speakerReplacements."],
    ["autoCensorProfanity without a provider", "invalid_parameter", { parameter: "provider", reason: "required_with", with: "autoCensorProfanity", inputs: ["provider", "autoCensorProfanity"] }, "provider is required when autoCensorProfanity is set."],
    ["fail without a trackName", "invalid_parameter", { parameter: "trackName", reason: "required_with", with: "replaceExistingTracks", withValue: "fail", inputs: ["trackName", "replaceExistingTracks"] }, "trackName is required when replaceExistingTracks is set to 'fail'."],
    ["deprecated naming mixed with the new options", "invalid_parameter", { parameter: "deleteOriginalTrack", reason: "conflicts_with", with: ["trackName"], inputs: ["deleteOriginalTrack", "trackName"] }, "deleteOriginalTrack can't be combined with trackName."],
    ["an unsupported replaceExistingTracks policy", "invalid_parameter", { parameter: "replaceExistingTracks", reason: "not_allowed", allowed: ["replace", "fail"], value: "replace_all", inputs: ["replaceExistingTracks"] }, "replaceExistingTracks must be 'replace' or 'fail' (received 'replace_all')."],
    ["a speaker-count override", "invalid_parameter", { parameter: "numSpeakers", reason: "not_allowed", allowed: [0], value: 2, inputs: ["numSpeakers"] }, "numSpeakers must be '0' (received '2')."],
    ["a dubbing provider other than the supported one", "invalid_parameter", { parameter: "provider", reason: "not_allowed", allowed: ["elevenlabs"], value: "openai", inputs: ["provider"] }, "provider must be 'elevenlabs' (received 'openai')."],
    ["an unknown voice, echoing a short token", "invalid_parameter", { parameter: "voice", reason: "not_allowed", allowed: ["conversational", "editorial", "playful", "professional"], value: "pirate", inputs: ["voice"] }, "voice must be 'conversational' or 'editorial' or 'playful' or 'professional' (received 'pirate')."],
    ["no artifacts", "invalid_parameter", { parameter: "artifacts", reason: "empty", inputs: ["artifacts"] }, "artifacts must be non-empty."],
    ["blank instructions", "invalid_parameter", { parameter: "variants[0].instructions", reason: "empty", inputs: ["variants"] }, "variants[0].instructions must be non-empty."],
    ["an empty speaker label", "invalid_parameter", { parameter: "speakerReplacements", reason: "empty", index: 1, inputs: ["speakerReplacements"] }, "speakerReplacements entries must be non-empty (entry 1)."],
    ["a blank never-translate term", "invalid_parameter", { parameter: "neverTranslate", reason: "empty", index: 1, inputs: ["neverTranslate"] }, "neverTranslate entries must be non-empty (entry 1)."],
    ["too many variants", "invalid_parameter", { parameter: "variants", reason: "too_many", count: 6, max: 5, inputs: ["variants"] }, "variants accepts at most 5 entries (received 6)."],
    ["too many never-translate terms", "invalid_parameter", { parameter: "neverTranslate", reason: "too_many", count: 101, max: 100, inputs: ["neverTranslate"] }, "neverTranslate accepts at most 100 entries (received 101)."],
    ["a repeated artifact key", "invalid_parameter", { parameter: "artifacts", reason: "duplicate", value: "post", index: 1, inputs: ["artifacts"] }, "artifacts has the key 'post' more than once; each key must be unique."],
    ["a malformed artifact key", "invalid_parameter", { parameter: "artifacts[0].key", reason: "invalid_format", format: "lowercase snake_case beginning with a letter, up to 64 characters", inputs: ["artifacts"] }, "artifacts[0].key must be lowercase snake_case beginning with a letter, up to 64 characters."],
    ["a language code that isn't a tag", "invalid_parameter", { parameter: "languageCode", reason: "invalid_format", format: "a BCP 47 language tag such as 'en' or 'pt-BR'", inputs: ["languageCode"] }, "languageCode must be a BCP 47 language tag such as 'en' or 'pt-BR'."],
    ["an output language code that isn't a tag, without echoing it", "invalid_parameter", { parameter: "outputLanguageCode", reason: "invalid_format", format: "a BCP 47 language tag such as 'en' or 'pt-BR'", inputs: ["outputLanguageCode"] }, "outputLanguageCode must be a BCP 47 language tag such as 'en' or 'pt-BR'."],
    ["a speaker label with brackets", "invalid_parameter", { parameter: "speakerReplacements", reason: "disallowed_characters", index: 0, characters: ["[", "]"], inputs: ["speakerReplacements"] }, "speakerReplacements entries must not contain '[' or ']' (entry 0)."],
    ["a never-translate term with markup characters", "invalid_parameter", { parameter: "neverTranslate", reason: "disallowed_characters", index: 0, characters: ["<", ">"], inputs: ["neverTranslate"] }, "neverTranslate entries must not contain '<' or '>' (entry 0)."],
    ["a never-translate term NFKC normalization changes", "invalid_parameter", { parameter: "neverTranslate", reason: "not_normalized", index: 0, inputs: ["neverTranslate"] }, "neverTranslate entries must not contain invisible characters or characters altered by Unicode NFKC normalization (entry 0)."],
    ["a multi-line speaker label", "invalid_parameter", { parameter: "speakerReplacements", reason: "multiline", index: 0, inputs: ["speakerReplacements"] }, "speakerReplacements entries must be a single line (entry 0)."],
    // Keeps the old hint: the asset is audio-only and needs a ready caption track.
    ["an audio-only asset without a transcript", "invalid_parameter", { parameter: "includeTranscript", reason: "audio_only", allowed: [true], value: false, assetId: "asset-123", inputs: ["includeTranscript"] }, "includeTranscript must be 'true' for an audio-only asset, which is processed from its transcript and needs a ready caption or subtitle track."],
    // parameter_out_of_range.
    ["an artifact maxLength under its minimum", "parameter_out_of_range", { parameter: "artifacts[0].maxLength.value", value: 4, min: 5, max: 3000, integer: true, unit: "words", inputs: ["artifacts"] }, "artifacts[0].maxLength.value must be at least 5 words (received 4)."],
    ["an artifact maxLength over its channel's ceiling", "parameter_out_of_range", { parameter: "artifacts[0].maxLength.value", value: 300, min: 10, max: 280, integer: true, unit: "characters", channel: "x", inputs: ["artifacts"] }, "artifacts[0].maxLength.value must be at most 280 characters (received 300)."],
    // Variants not covered above.
    ["a scope without a reason", "invalid_scope", { startTime: 1.0001, endTime: 1.0004 }, "The requested time range can't be used for this asset."],
    ["a scope with no shots in it", "invalid_scope", { reason: "no_shots", startTime: 10, endTime: 12 }, "The requested time range can't be used for this asset."],
    ["a static rendition that wasn't ready in time", "static_rendition_timeout", { assetId: "asset-1", waitedMs: 600_000, maxWaitMs: 600_000, lastStatus: "preparing" }, "The asset's static rendition wasn't ready in time. Please try again in a moment."],
    ["an asset with no usable playback ID", "playback_id_not_found", { assetId: "asset-1" }, "The asset has no public or signed playback ID. DRM playback IDs aren't supported."],
    [
      "an mp4_support rendition that's too large",
      "static_rendition_unsupported",
      { reason: "too_large", renditionName: "capped-1080p.mp4", sizeBytes: 1_500_000_000, maxBytes: 1_000_000_000 },
      "This asset uses the deprecated mp4_support setting, and its capped-1080p.mp4 static rendition (1.5 GB) is larger than the 1 GB this workflow can process. Move the asset to the Static Renditions API (https://www.mux.com/docs/guides/enable-static-mp4-renditions) and add an audio-only static rendition, then retry.",
    ],
    ["a content-policy block with a known reason", "content_policy_blocked", { call: "score_frame", provider: "google", model: "gemini-test", reason: "PROHIBITED_CONTENT", reasons: ["PROHIBITED_CONTENT"] }, "The content was blocked by a content policy (reason: PROHIBITED_CONTENT)."],
    ["a content-policy block without a reason", "content_policy_blocked", { call: "score_frame", provider: "openai", model: "gpt-test" }, "The content was blocked by a content policy."],
    ["an empty transcript", "transcript_empty", { assetId: "asset-1", trackId: "track-1", reason: "empty_body" }, "The transcript has no usable content."],
  ])("words %s", (_, code, facts, message) => {
    expect(viewOf(code, facts).message).toBe(message);
  });
});

describe("audio_unprocessable wording", () => {
  // As the transcription and dubbing dependency rules raise it.
  const facts = (reason?: string): MuxAiErrorFacts => ({ call: "transcribe", status: 400, ...(reason === undefined ? {} : { reason }) });

  it("words only the reasons it knows, never an object's own properties", () => {
    for (const reason of ["constructor", "toString", "__proto__"]) {
      expect(viewOf("audio_unprocessable", facts(reason)).message, reason).toBe("The asset's audio couldn't be processed.");
    }
  });

  it.each([
    ["corrupt", "The asset's audio couldn't be processed: it may be corrupt."],
    ["too_long", "The asset's audio couldn't be processed: it's too long."],
    [undefined, "The asset's audio couldn't be processed."],
  ])("explains unprocessable audio (%s)", (reason, message) => {
    expect(viewOf("audio_unprocessable", facts(reason))).toMatchObject({ type: "validation_error", code: "audio_unprocessable", message, retryable: false });
  });
});
