import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { describe, expect, it } from "vitest";

import { LegacyMuxAiError, MUX_AI_ERROR_CODES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "../../src/lib/mux-ai-error.ts";
import { createPublicErrorView, genericPublicMessage, MUX_AI_ERROR_GENERIC_MESSAGES, MUX_AI_ERROR_PUBLIC_MAPPINGS, toPublicError } from "../../src/lib/public-error.ts";

function acrossStepBoundary(error: MuxAiError): MuxAiError {
  const serde = MuxAiError as unknown as Record<symbol, (value: unknown) => unknown>;
  return serde[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(serde[WORKFLOW_SERIALIZE](error)))) as MuxAiError;
}

describe("toPublicError", () => {
  it("never exposes an internal code, its facts or the error's message", () => {
    const error = new MuxAiError("Signed playback ID requires signing credentials. Set MUX_SIGNING_KEY …", {
      code: MUX_AI_ERROR_CODES.SIGNING_CREDENTIALS_MISSING,
      facts: { env: "MUX_SIGNING_KEY" },
    });

    expect(toPublicError(error)).toEqual({ type: "server_error", message: MUX_AI_ERROR_GENERIC_MESSAGES.failed, retryable: false });
  });

  it("falls back to generic wording by source, then by type", () => {
    const view = (init: ConstructorParameters<typeof MuxAiError>[1]) => toPublicError(new MuxAiError("internal detail", init)).message;

    expect(view({ type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST })).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.request);
    expect(view({ type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET })).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.asset);
    expect(view({ type: MUX_AI_ERROR_TYPES.TIMEOUT_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, transient: false })).toBe(`${MUX_AI_ERROR_GENERIC_MESSAGES.timeout} Please try again.`);
    expect(view({ type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, facts: { status: 503 } })).toBe(`${MUX_AI_ERROR_GENERIC_MESSAGES.unavailable} Please try again.`);
    expect(view({ type: MUX_AI_ERROR_TYPES.SERVER_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL })).toBe(MUX_AI_ERROR_GENERIC_MESSAGES.failed);
  });

  it("shows a legacy error's message as end-user text, with its type and retryability", () => {
    const error = new LegacyMuxAiError("No caption track found for language fr.", { type: "validation_error" });

    expect(toPublicError(error)).toEqual({ type: "validation_error", message: "No caption track found for language fr.", retryable: false });
    expect(toPublicError(acrossStepBoundary(error))).toEqual(toPublicError(error));
  });

  it("keeps working after a step boundary", () => {
    const revived = acrossStepBoundary(new MuxAiError("x", { code: MUX_AI_ERROR_CODES.MODEL_OUTPUT_INVALID, facts: { call: "generate_text" } }));

    expect(toPublicError(revived)).toEqual({ type: "processing_error", message: MUX_AI_ERROR_GENERIC_MESSAGES.failed, retryable: false });
  });

  it("has no public codes yet: each module adds its own as it moves onto the model", () => {
    expect(Object.keys(MUX_AI_ERROR_PUBLIC_MAPPINGS)).toEqual([]);
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
