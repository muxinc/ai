import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { describe, expect, it } from "vitest";

import { dependencyError, dependencyFailureCode } from "../../src/lib/dependency-error";
import { MUX_AI_ERROR_CODES, MuxAiError } from "../../src/lib/mux-ai-error";
import type { SerializedMuxAiError } from "../../src/lib/mux-ai-error";
import { toPublicError } from "../../src/lib/public-error";

describe("dependencyFailureCode", () => {
  it.each([
    [{ status: undefined }, "dependency_no_response"],
    [{ status: undefined, timedOut: true }, "dependency_timeout"],
    [{ status: 408 }, "dependency_timeout"],
    [{ status: 429 }, "dependency_rate_limited"],
    [{ status: 425 }, "dependency_too_early"],
    [{ status: 500 }, "dependency_server_error"],
    [{ status: 503 }, "dependency_server_error"],
    [{ status: 401 }, "dependency_auth_rejected"],
    [{ status: 403 }, "dependency_auth_rejected"],
    [{ status: 404 }, "dependency_not_found"],
    [{ status: 400 }, "dependency_request_rejected"],
    [{ status: 409 }, "dependency_request_rejected"],
    [{ status: 200 }, "dependency_other_status"],
  ] as const)("names what was observed for %o", (init, code) => {
    expect(dependencyFailureCode(init)).toBe(code);
  });
});

describe("dependencyError", () => {
  it("gives an unrecognized failure its status's fallback code, keeping the status rules' classification", () => {
    const error = dependencyError("Upload failed", { dependency: "storage", call: "put_object", status: 503 });

    expect(error).toMatchObject({ code: "dependency_server_error", type: "processing_error", source: "upstream", dependency: "storage", transient: true, retryable: true, facts: { call: "put_object", status: 503 } });
  });

  it("keeps the caller's source for a fallback code", () => {
    const error = dependencyError("Gone", { dependency: "mux_video", call: "get_track", status: 404, notFoundSource: "asset" });

    expect(error).toMatchObject({ code: "dependency_not_found", type: "validation_error", source: "asset" });
  });

  it("lets a recognized code's policy win over the status: a quota 429 isn't retried", () => {
    const error = dependencyError("Out of credits", { dependency: "ai_provider", call: "transcribe", status: 429, code: MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED });

    expect(error).toMatchObject({ code: "provider_quota_exhausted", type: "server_error", source: "internal", dependency: "ai_provider", transient: false, retryable: false, name: "FatalError", facts: { status: 429 } });
  });

  it("doesn't read a recognized code without a status as no response", () => {
    // e.g. a per-item error inside a successful response.
    const error = dependencyError("Bad image", { dependency: "ai_provider", call: "moderate", code: MUX_AI_ERROR_CODES.AUDIO_UNPROCESSABLE });

    expect(error).toMatchObject({ code: "audio_unprocessable", source: "asset", transient: false, retryable: false });
  });

  it("lets the site's override win over a recognized code's policy", () => {
    // e.g. a provider call the workflow already retried itself.
    const error = dependencyError("Rate limited", { dependency: "ai_provider", call: "dub", status: 429, code: MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED, transient: false });

    expect(error).toMatchObject({ code: "provider_rate_limited", type: "capacity_error", source: "upstream", transient: false, retryable: true });
  });

  it.each([
    [503, MUX_AI_ERROR_CODES.PROVIDER_UNAVAILABLE],
    [503, MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED],
  ])("doesn't step-retry a non-idempotent call that may have taken effect (%i, %s)", (status, code) => {
    const error = dependencyError("Create failed", { dependency: "ai_provider", call: "create_project", status, code, idempotent: false });

    expect(error).toMatchObject({ code, transient: false, retryable: true });
  });

  it("still step-retries a non-idempotent call the dependency didn't process (429)", () => {
    const error = dependencyError("Rate limited", { dependency: "ai_provider", call: "create_project", status: 429, code: MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED, idempotent: false });

    expect(error).toMatchObject({ transient: true });
  });

  it("takes a fallback code from the site when the status can't say what happened", () => {
    // The provider answered, but with an error of its own instead of a result.
    const error = dependencyError("Provider error", { dependency: "ai_provider", call: "moderate", code: "dependency_other_status", transient: false, retryable: true });

    expect(error).toMatchObject({ code: "dependency_other_status", type: "processing_error", source: "upstream", transient: false, retryable: true });
  });

  it.each([
    dependencyError("Upload failed", { dependency: "storage", call: "put_object", status: 503 }),
    dependencyError("Out of credits", { dependency: "ai_provider", call: "transcribe", status: 402, code: MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED }),
  ])("keeps its code and classification across a step boundary ($code)", (error) => {
    const serialized = (MuxAiError as unknown as Record<symbol, (e: MuxAiError) => SerializedMuxAiError>)[WORKFLOW_SERIALIZE](error);
    const revived = (MuxAiError as unknown as Record<symbol, (v: SerializedMuxAiError) => MuxAiError>)[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(serialized)));

    expect(revived).toMatchObject({ code: error.code, type: error.type, source: error.source, dependency: error.dependency, transient: error.transient, retryable: error.retryable });
  });
});

describe("provider codes' public views", () => {
  it("keeps fallback codes internal", () => {
    const view = toPublicError(dependencyError("Upload failed", { dependency: "storage", call: "put_object", status: 503 }));

    expect(view).not.toHaveProperty("code");
  });

  it("keeps the service's own provider account internal, without naming the provider", () => {
    const view = toPublicError(dependencyError("Out of credits", { dependency: "ai_provider", call: "transcribe", status: 402, code: MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED, facts: { provider: "elevenlabs" } }));

    expect(view).not.toHaveProperty("code");
    expect(view).toMatchObject({ type: "server_error", retryable: false });
    expect(JSON.stringify(view)).not.toMatch(/elevenlabs/i);
  });

  it.each([
    ["corrupt", "The asset's audio couldn't be processed: it may be corrupt."],
    ["too_long", "The asset's audio couldn't be processed: it's too long."],
    [undefined, "The asset's audio couldn't be processed."],
  ])("explains unprocessable audio (%s)", (reason, message) => {
    const view = toPublicError(dependencyError("Bad audio", { dependency: "ai_provider", call: "transcribe", status: 400, code: MUX_AI_ERROR_CODES.AUDIO_UNPROCESSABLE, facts: reason ? { reason } : {} }));

    expect(view).toMatchObject({ type: "validation_error", code: "audio_unprocessable", message, retryable: false });
  });
});
