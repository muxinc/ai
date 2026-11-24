import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { describe, expect, it } from "vitest";

import { MuxAiError, readSerializedClassification } from "../../src/lib/mux-ai-error.ts";

const revive = (record: unknown) => (MuxAiError as unknown as Record<symbol, (value: unknown) => MuxAiError>)[WORKFLOW_DESERIALIZE](record);

describe("readSerializedClassification", () => {
  it("reads a well-formed record as written", () => {
    const record = {
      message: "Provider unavailable",
      type: "capacity_error",
      source: "upstream",
      dependency: "ai_provider",
      code: "provider_unavailable",
      facts: { call: "summarize", status: 503 },
      retryable: true,
      transient: true,
      causes: [{ name: "Error", message: "Service Unavailable", status: 503 }],
      stack: "Error: Provider unavailable",
    };
    expect(readSerializedClassification(record)).toEqual(record);
  });

  it("falls back field by field for anything missing or malformed", () => {
    expect(readSerializedClassification({ message: 42, type: "", source: null, facts: [1], retryable: "yes", causes: [{ name: "Error" }, "x"], code: 7 })).toEqual({
      message: "Unknown error",
      type: "server_error",
      source: "internal",
      facts: {},
      retryable: false,
      transient: false,
      causes: [],
    });
  });

  it.each([null, undefined, "garbage", 42, []])("reads %j as an internal failure", (record) => {
    expect(readSerializedClassification(record)).toMatchObject({ message: "Unknown error", type: "server_error", source: "internal", facts: {}, causes: [] });
  });
});

describe("muxAiError deserialization", () => {
  it("round-trips a well-formed record unchanged", () => {
    const error = Object.assign(new MuxAiError("Provider unavailable", {
      code: "provider_unavailable",
      type: "capacity_error",
      source: "upstream",
      dependency: "ai_provider",
      facts: { call: "summarize", status: 503 },
    }), { usage: { totalTokens: 42 } });
    const record = (MuxAiError as unknown as Record<symbol, (value: MuxAiError) => unknown>)[WORKFLOW_SERIALIZE](error);

    expect(revive(record)).toMatchObject({ code: "provider_unavailable", type: "capacity_error", source: "upstream", dependency: "ai_provider", facts: { call: "summarize", status: 503 }, transient: true, retryable: true, usage: { totalTokens: 42 } });
  });

  it("reads a record from an unknown future version by the fields it knows", () => {
    const restored = revive({ v: 99, message: "Later shape", type: "processing_error", source: "upstream", code: "model_output_invalid", facts: { call: "x" }, retryable: true, transient: false, causes: [], newField: { anything: true } });

    expect(MuxAiError.is(restored)).toBe(true);
    expect(restored).toMatchObject({ message: "Later shape", code: "model_output_invalid", facts: { call: "x" }, retryable: true, transient: false });
  });

  it.each([
    ["no record", undefined],
    ["null", null],
    ["a string", "garbage"],
    ["null facts", { v: 2, message: "m", type: "processing_error", source: "upstream", facts: null }],
    ["missing fields", { v: 2 }],
    ["malformed usage and causes", { v: 2, message: "m", type: "processing_error", source: "internal", facts: {}, usage: "lots", causes: "none", diagnostics: 3 }],
  ])("never throws for %s, and stays classified", (_label, record) => {
    let restored: MuxAiError | undefined;
    expect(() => {
      restored = revive(record);
    }).not.toThrow();
    expect(MuxAiError.is(restored)).toBe(true);
    expect(restored).toMatchObject({ type: expect.any(String), source: expect.any(String) });
  });
});
