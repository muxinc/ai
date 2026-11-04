import { WORKFLOW_DESERIALIZE } from "@workflow/serde";
import { describe, expect, it, vi } from "vitest";

import {
  assertNever,
  internalError,
  MUX_AI_ERROR_CATALOG,
  MUX_AI_ERROR_TYPES,
  MuxAiError,
  wrapError,
} from "../../src/lib/mux-ai-error.ts";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("muxAiError", () => {
  it("takes type, source and dependency from a code's catalog entry", () => {
    const error = new MuxAiError("Generated text was empty", { code: "model_output_missing", facts: { call: "generate_text", provider: "openai" } });

    expect(error).toMatchObject({
      type: "processing_error",
      source: "upstream",
      dependency: "ai_provider",
      code: "model_output_missing",
      facts: { call: "generate_text", provider: "openai" },
      // The catalog entry keeps model-output failures fatal and not resubmittable, as before.
      retryable: false,
      transient: false,
      name: "FatalError",
    });
  });

  it("derives transient and retryable from the classification unless the site overrides them", () => {
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream", facts: { status: 503 } })).toMatchObject({ transient: true, retryable: true });
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream", facts: { status: 400 } })).toMatchObject({ transient: false, retryable: true });
    expect(new MuxAiError("x", { type: "timeout_error", source: "upstream", facts: { status: 400 } })).toMatchObject({ transient: false, retryable: true });
    expect(new MuxAiError("x", { type: "validation_error", source: "request" })).toMatchObject({ transient: false, retryable: false });
    expect(new MuxAiError("x", { type: "server_error", source: "internal" })).toMatchObject({ transient: false, retryable: false });
    // A site override wins, e.g. a create call that isn't idempotent.
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream", facts: { status: 503 }, transient: false })).toMatchObject({ transient: false, retryable: true, name: "FatalError" });
  });

  it("keeps a transient error retryable even if a site says otherwise", () => {
    const error = new MuxAiError("x", { type: "processing_error", source: "upstream", facts: { status: 503 }, retryable: false });
    expect(error).toMatchObject({ transient: true, retryable: true });
  });

  it("lets a code's catalog entry override the defaults", () => {
    expect(new MuxAiError("x", { code: "model_output_incomplete" })).toMatchObject({ source: "upstream", transient: false, retryable: true });
  });

  it("is named FatalError only when it is not transient", () => {
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream" }).name).toBe("Error");
    expect(new MuxAiError("x", { type: "server_error", source: "internal" }).name).toBe("FatalError");
  });

  it("keeps the raw cause local and a bounded, scrubbed summary for transport", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { status: 503 });
    const outer = new Error("fetch failed", { cause: inner });
    const error = new MuxAiError("Failed to fetch VTT", { type: "processing_error", source: "upstream", cause: outer });

    expect(error.cause).toBe(outer);
    expect(error.causes).toEqual([
      { name: "Error", message: "fetch failed" },
      { name: "Error", message: "connect ECONNREFUSED", status: 503 },
    ]);
    expect(Object.keys(error)).not.toContain("cause");
    expect(Object.keys(error)).not.toContain("causes");
  });

  it("has a catalog whose entries use listed types", () => {
    for (const entry of Object.values(MUX_AI_ERROR_CATALOG)) {
      expect(MUX_AI_ERROR_TYPES).toContain(entry.type);
    }
  });

  it("reads the pre-classification serialized shape", () => {
    const revived = (MuxAiError as unknown as Record<symbol, (value: unknown) => MuxAiError>)[WORKFLOW_DESERIALIZE]({
      message: "No caption track found.",
      publicType: "validation_error",
      retryable: false,
    });

    expect(MuxAiError.is(revived)).toBe(true);
    expect(revived).toMatchObject({ message: "No caption track found.", type: "validation_error", source: "request", retryable: false });
  });
});

describe("wrapError", () => {
  it("passes a classified error through, merging facts with its own winning", () => {
    const original = new MuxAiError("Mux returned 404", { type: "validation_error", source: "asset", facts: { call: "fetch_vtt", status: 404 } });

    const error = thrown(() => wrapError(original, "Failed to fetch VTT content", { call: "outer", trackId: "trk_1" }));

    expect(error).toBe(original);
    expect(original.facts).toEqual({ call: "fetch_vtt", status: 404, trackId: "trk_1" });
  });

  it("leaves anything else unclassified, keeping usage", () => {
    const raw = Object.assign(new Error("Unexpected token"), { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });

    const error = thrown(() => wrapError(raw, "Failed to parse output")) as Error & { usage?: unknown };

    expect(MuxAiError.is(error)).toBe(false);
    expect(error.message).toBe("Failed to parse output: Unexpected token");
    expect(error.usage).toMatchObject({ totalTokens: 12 });
  });

  it("strips URL query strings (signed tokens) from the detail", () => {
    const raw = new Error("Failed to download https://image.mux.com/abc/storyboard.png?token=SECRET_JWT: 403 Forbidden");

    const error = thrown(() => wrapError(raw, "Failed to analyze")) as Error;

    expect(error.message).toBe("Failed to analyze: Failed to download https://image.mux.com/abc/storyboard.png?… 403 Forbidden");
  });

  it("suppresses a suspected prompt leak in the detail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new Error("Failed to parse: <role>You are a helpful assistant</role>");

    const error = thrown(() => wrapError(raw, "Failed to parse output")) as Error;

    expect(error.message).toBe("Failed to parse output: Upstream error details suppressed by safety filter");
    warn.mockRestore();
  });
});

describe("internalError and assertNever", () => {
  it("builds an internal server error", () => {
    expect(internalError("bad state", { step: "plan" })).toMatchObject({ type: "server_error", source: "internal", facts: { step: "plan" } });
  });

  it("throws an internal error for an unexpected value", () => {
    expect(() => assertNever("x" as never, "phase")).toThrow("Unexpected phase: x");
  });
});
