import { WORKFLOW_DESERIALIZE } from "@workflow/serde";
import { describe, expect, it, vi } from "vitest";

import { isLegacyMuxAiError, LegacyMuxAiError, legacyWrapError } from "../../src/lib/legacy-mux-ai-error.ts";
import { assertNever, internalError, MUX_AI_ERROR_CATALOG, MUX_AI_ERROR_TYPE_VALUES, MuxAiError, stripUrlQueries, wrapError } from "../../src/lib/mux-ai-error.ts";

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
    const error = new MuxAiError("Generated text was empty", { code: "model_output_missing", type: "processing_error", source: "upstream", dependency: "ai_provider", facts: { call: "generate_text", provider: "openai" } });

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
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream", dependency: "mux_video", facts: { status: 503 } })).toMatchObject({ transient: true, retryable: true });
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream", dependency: "mux_video", facts: { status: 400 } })).toMatchObject({ transient: false, retryable: true });
    expect(new MuxAiError("x", { type: "timeout_error", source: "upstream", dependency: "mux_video", facts: { status: 400 } })).toMatchObject({ transient: false, retryable: true });
    expect(new MuxAiError("x", { type: "validation_error", source: "request" })).toMatchObject({ transient: false, retryable: false });
    expect(new MuxAiError("x", { type: "server_error", source: "internal" })).toMatchObject({ transient: false, retryable: false });
    // A site override wins, e.g. a create call that isn't idempotent.
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream", dependency: "mux_video", facts: { status: 503 }, transient: false })).toMatchObject({ transient: false, retryable: true, name: "FatalError" });
  });

  it("keeps a transient error retryable even if a site says otherwise", () => {
    const error = new MuxAiError("x", { type: "processing_error", source: "upstream", dependency: "mux_video", facts: { status: 503 }, retryable: false });
    expect(error).toMatchObject({ transient: true, retryable: true });
  });

  it("lets a code's catalog entry override the defaults", () => {
    // `upstream` with no status would be transient and retryable by rule.
    expect(new MuxAiError("x", { code: "model_output_invalid", type: "processing_error", source: "upstream", dependency: "ai_provider" })).toMatchObject({ source: "upstream", transient: false, retryable: false });
  });

  it("is named FatalError only when it is not transient", () => {
    expect(new MuxAiError("x", { type: "processing_error", source: "upstream", dependency: "mux_video" }).name).toBe("Error");
    expect(new MuxAiError("x", { type: "server_error", source: "internal" }).name).toBe("FatalError");
  });

  it("keeps the raw cause local and a bounded, scrubbed summary for transport", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { status: 503 });
    const outer = new Error("fetch failed", { cause: inner });
    const error = new MuxAiError("Failed to fetch VTT", { type: "processing_error", source: "upstream", dependency: "mux_video", cause: outer });

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
      expect(MUX_AI_ERROR_TYPE_VALUES).toContain(entry.type);
    }
  });

  it("names the dependency of every upstream code", () => {
    const missing = Object.entries(MUX_AI_ERROR_CATALOG)
      .filter(([, entry]: [string, { source: string; dependency?: string }]) => entry.source === "upstream" && !entry.dependency)
      .map(([code]) => code);

    expect(missing).toEqual([]);
  });

  it("revives a legacy error from its serialized shape", () => {
    const revived = (LegacyMuxAiError as unknown as Record<symbol, (value: unknown) => MuxAiError>)[WORKFLOW_DESERIALIZE]({
      message: "No caption track found.",
      publicType: "validation_error",
      retryable: false,
    });

    expect(revived).toBeInstanceOf(LegacyMuxAiError);
    expect(revived).toMatchObject({ publicMessage: "No caption track found.", publicType: "validation_error", type: "validation_error", source: "request", retryable: false });
  });
});

describe("legacyMuxAiError", () => {
  it("keeps the pre-classification fields and is never step-retried", () => {
    const error = new LegacyMuxAiError("The transcript is empty.", { type: "validation_error" });

    expect(error).toMatchObject({
      __robots_error: true,
      publicType: "validation_error",
      publicMessage: "The transcript is empty.",
      message: "The transcript is empty.",
      retryable: false,
      transient: false,
      name: "FatalError",
    });
    expect(error.code).toBeUndefined();
    expect(MuxAiError.is(error)).toBe(true);
    expect(isLegacyMuxAiError(error)).toBe(true);
  });

  it("defaults to a non-retryable processing error, even when classified as upstream would be", () => {
    expect(new LegacyMuxAiError("Failed.")).toMatchObject({ publicType: "processing_error", type: "processing_error", retryable: false, transient: false });
    expect(new LegacyMuxAiError("Try again.", { type: "timeout_error", retryable: true })).toMatchObject({ retryable: true, transient: false, name: "FatalError" });
  });

  it("is told apart from classified errors by its fields, including a revived plain object", () => {
    expect(isLegacyMuxAiError({ __robots_error: true, publicMessage: "x", publicType: "processing_error", retryable: false })).toBe(true);
    expect(isLegacyMuxAiError(new MuxAiError("x", { type: "server_error", source: "internal" }))).toBe(false);
    expect(isLegacyMuxAiError(new Error("x"))).toBe(false);
  });
});

describe("legacyWrapError", () => {
  it("passes SDK errors through and wraps anything else in a plain, step-retried Error", () => {
    const legacy = new LegacyMuxAiError("The transcript is empty.", { type: "validation_error" });
    expect(thrown(() => legacyWrapError(legacy, "Failed"))).toBe(legacy);

    const error = thrown(() => legacyWrapError(new Error("boom"), "Failed to parse output")) as Error;
    expect(MuxAiError.is(error)).toBe(false);
    expect(error).toMatchObject({ name: "Error", message: "Failed to parse output: boom" });
  });
});

describe("wrapError", () => {
  it("passes a legacy error through unchanged", () => {
    const legacy = new LegacyMuxAiError("The transcript is empty.", { type: "validation_error" });

    expect(thrown(() => wrapError(legacy, "Failed to summarize"))).toBe(legacy);
  });

  it("passes a classified error through, merging facts with its own winning", () => {
    const original = new MuxAiError("Mux returned 404", { type: "validation_error", source: "asset", facts: { call: "fetch_vtt", status: 404 } });

    const error = thrown(() => wrapError(original, "Failed to fetch VTT content", { call: "outer", trackId: "trk_1" }));

    expect(error).toBe(original);
    expect(original.facts).toEqual({ call: "fetch_vtt", status: 404, trackId: "trk_1" });
  });

  it("classifies anything else as internal, keeping usage and the cause", () => {
    const raw = Object.assign(new Error("Unexpected token"), { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });

    const error = thrown(() => wrapError(raw, "Failed to parse output")) as MuxAiError;

    expect(MuxAiError.is(error)).toBe(true);
    expect(error).toMatchObject({ type: "server_error", source: "internal", message: "Failed to parse output: Unexpected token" });
    expect(error.usage).toMatchObject({ totalTokens: 12 });
    expect(error.cause).toBe(raw);
  });

  it("strips URL query strings (signed tokens) from the detail and the cause summary", () => {
    const raw = new Error("Failed to download https://image.mux.com/abc/storyboard.png?token=SECRET_JWT: 403 Forbidden");

    const error = thrown(() => wrapError(raw, "Failed to analyze")) as MuxAiError;

    expect(error.message).toBe("Failed to analyze: Failed to download https://image.mux.com/abc/storyboard.png?… 403 Forbidden");
    expect(JSON.stringify(error.causes)).not.toContain("SECRET_JWT");
  });

  it("suppresses a suspected prompt leak in the detail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new Error("Failed to parse: <role>You are a helpful assistant</role>");

    const error = thrown(() => wrapError(raw, "Failed to parse output")) as MuxAiError;

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

describe("stripUrlQueries", () => {
  it("drops the query and fragment, keeping the host and path", () => {
    expect(stripUrlQueries("GET https://image.mux.com/abc/storyboard.png?token=SECRET: 403 Forbidden"))
      .toBe("GET https://image.mux.com/abc/storyboard.png?… 403 Forbidden");
    expect(stripUrlQueries("see https://stream.mux.com/abc.m3u8#t=10")).toBe("see https://stream.mux.com/abc.m3u8?…");
  });

  it("drops credentials", () => {
    expect(stripUrlQueries("PUT https://AKIAEXAMPLE:s3cr3t@bucket.s3.amazonaws.com/key failed"))
      .toBe("PUT https://bucket.s3.amazonaws.com/key failed");
  });

  it("leaves a URL with nothing to drop as it is", () => {
    expect(stripUrlQueries("fetch https://api.mux.com failed")).toBe("fetch https://api.mux.com failed");
  });

  it("still drops the query of a URL it can't parse", () => {
    expect(stripUrlQueries("bad https://[::1?token=x")).toBe("bad https://[::1?…");
  });
});
