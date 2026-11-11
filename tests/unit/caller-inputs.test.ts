import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { describe, expect, it } from "vitest";

import { dependencyError } from "../../src/lib/dependency-error.ts";
import type { SerializedMuxAiError } from "../../src/lib/mux-ai-error.ts";
import { attributeToCaller, MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "../../src/lib/mux-ai-error.ts";
import { getMuxAssetWithClient } from "../../src/lib/mux-assets.ts";
import { resolveLanguageModelConfig } from "../../src/lib/providers.ts";
import { toPublicError } from "../../src/lib/public-error.ts";
import { resolveWorkflowScope } from "../../src/lib/workflow-scope.ts";
import type { MuxAsset, WorkflowMuxClient } from "../../src/types.ts";
import { getSummaryAndTags } from "../../src/workflows/summarization.ts";

function capture(fn: () => unknown): MuxAiError {
  try {
    fn();
  } catch (error) {
    if (MuxAiError.is(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a throw");
}

function invalidScope(): MuxAiError {
  return capture(() => resolveWorkflowScope({ startTime: 50, endTime: 120 }, 100));
}

function muxClientRejecting(error: unknown): WorkflowMuxClient {
  return {
    createClient: async () => ({ video: { assets: { retrieve: () => Promise.reject(error) } } }) as never,
    getSigningKey: () => undefined,
    getPrivateKey: () => undefined,
  };
}

async function rejection(promise: Promise<unknown>): Promise<MuxAiError> {
  const error = await promise.then(() => undefined, (error: unknown) => error);
  if (!MuxAiError.is(error)) {
    throw new Error(`expected a MuxAiError, got ${String(error)}`);
  }
  return error;
}

describe("attributeToCaller", () => {
  it("leaves an input-blamed error with the end user when the caller didn't set the input", () => {
    const error = attributeToCaller(invalidScope(), ["credentials", "model"]);

    expect(error.source).toBe(MUX_AI_ERROR_SOURCES.REQUEST);
    expect(error.type).toBe(MUX_AI_ERROR_TYPES.VALIDATION_ERROR);
    expect(toPublicError(error).code).toBe(MUX_AI_ERROR_CODES.INVALID_SCOPE);
  });

  it("makes an input-blamed error internal when the caller set the input, keeping its code and facts", () => {
    const error = attributeToCaller(invalidScope(), ["scope"]);

    expect(error).toMatchObject({
      type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
      source: MUX_AI_ERROR_SOURCES.INTERNAL,
      code: MUX_AI_ERROR_CODES.INVALID_SCOPE,
      retryable: false,
      transient: false,
    });
    expect(error.facts).toMatchObject({ reason: "exceeds_duration", inputs: ["scope"], reattributedFrom: "request" });
  });

  it("shows generic wording once the code's catalog source no longer applies", () => {
    expect(toPublicError(attributeToCaller(invalidScope(), ["scope"]))).toEqual({
      type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
      message: "The operation failed.",
      retryable: false,
    });
  });

  it("matches an input by the first segment of its path", () => {
    const error = new MuxAiError("Replacement 2 is invalid", {
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      source: MUX_AI_ERROR_SOURCES.REQUEST,
      facts: { inputs: ["speakerReplacements.2.from"] },
    });

    expect(attributeToCaller(error, ["speakerReplacements"]).source).toBe(MUX_AI_ERROR_SOURCES.INTERNAL);
  });

  it("re-attributes when any one of several inputs is the caller's", () => {
    const error = new MuxAiError("Asset snapshot does not match the requested asset ID.", {
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      source: MUX_AI_ERROR_SOURCES.REQUEST,
      facts: { inputs: ["assetId", "assetSnapshot"] },
    });

    expect(attributeToCaller(error, ["assetSnapshot"]).source).toBe(MUX_AI_ERROR_SOURCES.INTERNAL);
  });

  it("leaves errors without inputs, and failures not blamed on an input, alone", () => {
    const noInputs = new MuxAiError("bad request", { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST });
    const upstream = dependencyError("Mux is down", {
      dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
      call: "get_asset",
      status: 503,
      facts: { inputs: ["credentials"] },
    });

    expect(attributeToCaller(noInputs, ["scope"]).source).toBe(MUX_AI_ERROR_SOURCES.REQUEST);
    expect(attributeToCaller(upstream, ["credentials"]).source).toBe(MUX_AI_ERROR_SOURCES.UPSTREAM);
    expect(attributeToCaller(invalidScope(), undefined).source).toBe(MUX_AI_ERROR_SOURCES.REQUEST);
    expect(attributeToCaller("not an error", ["scope"])).toBe("not an error");
  });

  it("keeps the re-attribution across a step boundary", () => {
    const error = attributeToCaller(invalidScope(), ["scope"]);
    const serialized = MuxAiError[WORKFLOW_SERIALIZE](error) as SerializedMuxAiError;
    const revived = MuxAiError[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(serialized)) as SerializedMuxAiError);

    expect(revived).toMatchObject({
      type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
      source: MUX_AI_ERROR_SOURCES.INTERNAL,
      code: MUX_AI_ERROR_CODES.INVALID_SCOPE,
      retryable: false,
    });
    expect(toPublicError(revived).message).toBe("The operation failed.");
  });
});

describe("dependency auth failures", () => {
  it("record their inputs on a 401/403 only", () => {
    const init = { dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO, call: "get_asset", authSource: MUX_AI_ERROR_SOURCES.ACCOUNT, authInputs: ["credentials"] } as const;

    expect(dependencyError("denied", { ...init, status: 403 }).facts.inputs).toEqual(["credentials"]);
    expect(dependencyError("down", { ...init, status: 503 }).facts.inputs).toBeUndefined();
  });
});

describe("getMuxAssetWithClient", () => {
  it("raises asset_not_found for a 404, with public wording naming the asset", async () => {
    const error = await rejection(getMuxAssetWithClient("asset-123", muxClientRejecting(Object.assign(new Error("Not Found"), { status: 404 }))));

    expect(error).toMatchObject({
      code: MUX_AI_ERROR_CODES.ASSET_NOT_FOUND,
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      source: MUX_AI_ERROR_SOURCES.REQUEST,
      dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
      retryable: false,
    });
    expect(error.facts).toMatchObject({ call: "get_asset", status: 404, assetId: "asset-123", inputs: ["assetId"] });
    expect(toPublicError(error)).toEqual({
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      code: MUX_AI_ERROR_CODES.ASSET_NOT_FOUND,
      message: "Asset asset-123 could not be found.",
      retryable: false,
      facts: { assetId: "asset-123" },
    });
  });

  it("blames the account for a 401 unless the caller supplied the credentials", async () => {
    const error = await rejection(getMuxAssetWithClient("asset-123", muxClientRejecting(Object.assign(new Error("Unauthorized"), { status: 401 }))));

    expect(error.source).toBe(MUX_AI_ERROR_SOURCES.ACCOUNT);
    expect(error.facts.inputs).toEqual(["credentials"]);
    expect(attributeToCaller(error, ["credentials"]).source).toBe(MUX_AI_ERROR_SOURCES.INTERNAL);
  });
});

describe("blocked language models", () => {
  it("blame the request for a model the caller chose", () => {
    const error = capture(() => resolveLanguageModelConfig({ provider: "google", model: "gemini-3.1-flash-lite-preview" as never }));

    expect(error).toMatchObject({ type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST });
    expect(error.facts.inputs).toEqual(["model"]);
    expect(attributeToCaller(error, ["provider", "model"]).source).toBe(MUX_AI_ERROR_SOURCES.INTERNAL);
  });
});

describe("workflow callerInputs", () => {
  it("re-attributes a failure blamed on an input the caller set", async () => {
    const options = { assetSnapshot: { id: "asset-b" } as MuxAsset };

    const fromEndUser = await rejection(getSummaryAndTags("asset-a", options));
    const fromCaller = await rejection(getSummaryAndTags("asset-a", { ...options, callerInputs: ["assetSnapshot", "credentials"] }));

    expect(fromEndUser.source).toBe(MUX_AI_ERROR_SOURCES.REQUEST);
    expect(fromCaller).toMatchObject({ source: MUX_AI_ERROR_SOURCES.INTERNAL, type: MUX_AI_ERROR_TYPES.SERVER_ERROR });
  });
});
