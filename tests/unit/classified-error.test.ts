import { describe, expect, it } from "vitest";

import { LegacyMuxAiError } from "../../src/lib/legacy-mux-ai-error.ts";
import type { ClassifiedErrorInit, ErrorCatalogEntry, SerializedClassification } from "../../src/lib/mux-ai-error.ts";
import { classificationInit, ClassifiedError, MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError, restoreClassification, serializeClassification } from "../../src/lib/mux-ai-error.ts";
import { createPublicErrorView, MUX_AI_ERROR_PUBLIC_MAPPINGS } from "../../src/lib/public-error.ts";

// A consumer's own error on the shared model: its own extra type, codes and dependency.
const APP_TYPES = { ...MUX_AI_ERROR_TYPES, CONFLICT: "conflict" } as const;
type AppType = typeof APP_TYPES[keyof typeof APP_TYPES];
const APP_CODES = { JOB_ALREADY_RUNNING: "job_already_running", INDEX_UNAVAILABLE: "index_unavailable" } as const;
type AppCode = typeof APP_CODES[keyof typeof APP_CODES];
type AppDependency = "search_index";

const APP_CATALOG = {
  [APP_CODES.JOB_ALREADY_RUNNING]: { type: APP_TYPES.CONFLICT, source: MUX_AI_ERROR_SOURCES.REQUEST },
  [APP_CODES.INDEX_UNAVAILABLE]: { type: APP_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: "search_index" },
} as const satisfies Record<AppCode, ErrorCatalogEntry<AppType, AppDependency>>;

class AppError extends ClassifiedError<AppType, AppCode, AppDependency> {
  constructor(message: string, init: ClassifiedErrorInit<AppType, AppCode, AppDependency, typeof APP_CATALOG>) {
    super(message, init, APP_CATALOG);
  }

  static fromRecord(record: SerializedClassification<AppType, AppCode, AppDependency>): AppError {
    return restoreClassification(new AppError(record.message, classificationInit(record) as ClassifiedErrorInit<AppType, AppCode, AppDependency, typeof APP_CATALOG>), record);
  }
}

describe("classifiedError as a shared base", () => {
  it("applies the same catalog and retry policy to a consumer's own codes", () => {
    const error = new AppError("Search index returned 503", { code: APP_CODES.INDEX_UNAVAILABLE, type: APP_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: "search_index", facts: { status: 503 } });

    expect(error).toMatchObject({ type: "processing_error", source: "upstream", dependency: "search_index", transient: true, retryable: true, name: "Error" });
    expect(new AppError("Already running", { code: APP_CODES.JOB_ALREADY_RUNNING, type: APP_TYPES.CONFLICT, source: MUX_AI_ERROR_SOURCES.REQUEST })).toMatchObject({ type: "conflict", retryable: false, name: "FatalError" });
    expect(ClassifiedError.isClassified(error)).toBe(true);
    expect(MuxAiError.is(error)).toBe(false);
  });

  it("round-trips through the shared serializer helpers", () => {
    const original = new AppError("Search index returned 503", { code: APP_CODES.INDEX_UNAVAILABLE, type: APP_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: "search_index", facts: { status: 503 }, cause: new Error("socket hang up") });

    const revived = AppError.fromRecord(JSON.parse(JSON.stringify(serializeClassification(original))));

    expect(revived).toMatchObject({ code: "index_unavailable", type: "processing_error", transient: true, facts: { status: 503 } });
    expect(revived.causes).toEqual([{ name: "Error", message: "socket hang up" }]);
  });

  it("renders one public view over the SDK's errors and the consumer's", () => {
    const view = createPublicErrorView<string, string>({
      mappings: {
        ...MUX_AI_ERROR_PUBLIC_MAPPINGS,
        [APP_CODES.JOB_ALREADY_RUNNING]: { message: "A job with these parameters is already running." },
      },
      genericMessage: error => (error.source === MUX_AI_ERROR_SOURCES.REQUEST ? "Bad request." : "The job failed."),
    });

    expect(view(new AppError("dup", { code: APP_CODES.JOB_ALREADY_RUNNING, type: APP_TYPES.CONFLICT, source: MUX_AI_ERROR_SOURCES.REQUEST }))).toEqual({
      type: "conflict",
      code: "job_already_running",
      message: "A job with these parameters is already running.",
      retryable: false,
    });
    expect(view(new AppError("index down", { code: APP_CODES.INDEX_UNAVAILABLE, type: APP_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: "search_index", facts: { status: 400 } })).message).toBe("The job failed.");
    // An SDK code keeps its public wording, and an internal one gets the consumer's generic wording.
    expect(view(new MuxAiError("x", { code: MUX_AI_ERROR_CODES.MODEL_OUTPUT_INVALID, type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER, facts: { assetId: "abc", provider: "openai" } })))
      .toEqual({ type: "processing_error", code: "model_output_invalid", message: "The AI model's output for asset abc couldn't be used.", retryable: false, facts: { assetId: "abc" } });
    expect(view(new MuxAiError("x", { code: MUX_AI_ERROR_CODES.SIGNING_CREDENTIALS_MISSING, type: MUX_AI_ERROR_TYPES.SERVER_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL })))
      .toEqual({ type: "server_error", message: "The job failed.", retryable: false });
    // A module not yet on the model: its message is end-user text, shown as before.
    expect(view(new LegacyMuxAiError("The transcript is empty.", { type: "validation_error" })))
      .toEqual({ type: "validation_error", message: "The transcript is empty.", retryable: false });
  });
});
