import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

import type { TokenUsage } from "../types.ts";

import { detectLeakReason } from "./output-safety.ts";
import { getErrorTokenUsage } from "./token-usage.ts";

/** `["a", "b"]` → `{ a: "a", b: "b" }`, so values can be referenced by name. */
function valuesOf<const T extends string>(values: readonly T[]): { readonly [K in T]: K } {
  return Object.fromEntries(values.map(value => [value, value])) as { readonly [K in T]: K };
}

/**
 * Public error categories for job outcomes. One list for the SDK and its consumers,
 * which may extend it with their own types (e.g. request-time HTTP errors). Treat
 * `type` as an open string, so adding a value is not a breaking change.
 */
export const MUX_AI_ERROR_TYPES = [
  "validation_error",
  "processing_error",
  "timeout_error",
  "content_policy_error",
  "capacity_error",
  "server_error",
] as const;
export type MuxAiErrorType = typeof MUX_AI_ERROR_TYPES[number];
export const MUX_AI_ERROR_TYPE_VALUES = valuesOf(MUX_AI_ERROR_TYPES);

/**
 * Whose problem a failure is, judged from the SDK caller's side: `request` (the
 * caller's input), `asset` (the Mux asset's state), `account` (the Mux account or
 * environment), `upstream` (a remote service failed), `internal` (this code or the
 * configuration of the service running it). A consumer may re-attribute it.
 */
export const MUX_AI_ERROR_SOURCES = ["request", "asset", "account", "upstream", "internal"] as const;
export type MuxAiErrorSource = typeof MUX_AI_ERROR_SOURCES[number];
export const MUX_AI_ERROR_SOURCE_VALUES = valuesOf(MUX_AI_ERROR_SOURCES);

/** A remote service reached over the network. Libraries in this process are not dependencies. */
export const MUX_AI_ERROR_DEPENDENCIES = ["mux_video", "ai_provider", "storage"] as const;
export type MuxAiErrorDependency = typeof MUX_AI_ERROR_DEPENDENCIES[number];
export const MUX_AI_ERROR_DEPENDENCY_VALUES = valuesOf(MUX_AI_ERROR_DEPENDENCIES);

export type MuxAiErrorFactValue = string | number | boolean | null | MuxAiErrorFactValue[] | { [key: string]: MuxAiErrorFactValue };

/**
 * Details of one occurrence, JSON-safe so they survive step boundaries. Internal by
 * default: a consumer chooses what, if anything, to show. Dependency errors always
 * carry `call` (the outside call's snake_case name), plus `status` and `requestId`
 * when there was a response.
 */
export type MuxAiErrorFacts = Readonly<Record<string, MuxAiErrorFactValue>>;

interface MuxAiErrorCatalogEntry {
  type: MuxAiErrorType;
  source: MuxAiErrorSource;
  dependency?: MuxAiErrorDependency;
  /** Overrides the default from {@link defaultRetryable} for every error with this code. */
  retryable?: boolean;
  /** Overrides the default from {@link defaultTransient} for every error with this code. */
  transient?: boolean;
}

/**
 * Codes for conditions precise enough to name (rung 3). A code implies its type,
 * source and dependency, so a site raising it can't contradict them. Codes name the
 * condition, never the vendor.
 */
export const MUX_AI_ERROR_CATALOG = {
  // The caller's input.
  invalid_scope: { type: "validation_error", source: "request" },
  track_replacement_blocked: { type: "validation_error", source: "request" },
  // The asset's state.
  caption_track_not_found: { type: "validation_error", source: "asset" },
  playback_id_not_found: { type: "validation_error", source: "asset" },
  transcript_empty: { type: "validation_error", source: "asset" },
  // The configuration of the service running the SDK.
  signing_credentials_missing: { type: "server_error", source: "internal" },
  storage_not_configured: { type: "server_error", source: "internal" },
  // Model calls.
  content_policy_blocked: { type: "content_policy_error", source: "asset", dependency: "ai_provider" },
  // The model-output policies below keep what these failures did before classification
  // (fatal, not resubmittable); sites that differed keep their old values explicitly.
  // Whether they should be retried is an open follow-up, not decided here.
  // No output, or a required field empty.
  model_output_missing: { type: "processing_error", source: "upstream", dependency: "ai_provider", transient: false, retryable: false },
  // Output came back but breaks the expected shape or constraints (counts, allowed values, limits).
  model_output_invalid: { type: "processing_error", source: "upstream", dependency: "ai_provider", transient: false, retryable: false },
  // Output withheld by our output safety filter (a suspected prompt leak).
  model_output_suppressed: { type: "processing_error", source: "upstream", dependency: "ai_provider", transient: false, retryable: false },
  // Not transient: a step retry would repeat a full generation; the job can be resubmitted.
  model_output_incomplete: { type: "processing_error", source: "upstream", dependency: "ai_provider", transient: false },
  model_output_truncated: { type: "processing_error", source: "internal", dependency: "ai_provider" },
} as const satisfies Record<string, MuxAiErrorCatalogEntry>;
export type MuxAiErrorCode = keyof typeof MUX_AI_ERROR_CATALOG;
export const MUX_AI_ERROR_CODES = valuesOf(Object.keys(MUX_AI_ERROR_CATALOG) as MuxAiErrorCode[]);

export interface ModelCallDiagnostics {
  phase: "brief" | "draft" | "format_repair" | "length_repair";
  provider: string;
  modelId: string;
  maxOutputTokens?: number;
}

/**
 * No response, a timeout, "too early", rate limiting or a server error: worth retrying.
 * A 409 is not: unlike the AI SDK's own retry loop, a conflict here means state that
 * a retry would hit again.
 */
export function isTransientStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Default for `transient`: an `upstream` failure with no response or a transient
 * status (the `status` fact). Everything else would fail the same way on a step retry.
 */
export function defaultTransient(source: MuxAiErrorSource, facts: MuxAiErrorFacts = {}): boolean {
  return source === MUX_AI_ERROR_SOURCE_VALUES.upstream &&
    isTransientStatus(typeof facts.status === "number" ? facts.status : undefined);
}

/**
 * Default for `retryable`: whether resubmitting the same job may succeed. Yes when
 * the failure is transient, a timeout, capacity, or otherwise `upstream`; no when the
 * request, asset, account or this service's own code or configuration is the problem.
 */
export function defaultRetryable(type: MuxAiErrorType, source: MuxAiErrorSource, transient: boolean): boolean {
  if (transient || type === MUX_AI_ERROR_TYPE_VALUES.timeout_error || type === MUX_AI_ERROR_TYPE_VALUES.capacity_error) {
    return true;
  }
  if (type === MUX_AI_ERROR_TYPE_VALUES.validation_error || type === MUX_AI_ERROR_TYPE_VALUES.content_policy_error) {
    return false;
  }
  return source === MUX_AI_ERROR_SOURCE_VALUES.upstream;
}

/** A short record of one raw cause, kept across step boundaries in place of the cause itself. */
export interface MuxAiErrorCauseSummary {
  name: string;
  message: string;
  status?: number;
}

/** Either a code (which implies type and source) or an explicit type and source, never both. */
type MuxAiErrorClassification =
  | { code: MuxAiErrorCode; type?: never; source?: never } |
  { code?: never; type: MuxAiErrorType; source: MuxAiErrorSource };

export type MuxAiErrorInit = MuxAiErrorClassification & {
  dependency?: MuxAiErrorDependency;
  facts?: MuxAiErrorFacts;
  /**
   * Whether submitting the same job again, unchanged, may succeed. Not "fixable":
   * whether the caller can change something first is what `source` and `code` say.
   * Defaults from the classification ({@link defaultRetryable}); set it only to
   * override, with a comment saying why. Ignored when the error is transient.
   */
  retryable?: boolean;
  /**
   * Whether the step runner should retry the step. Defaults from the classification
   * ({@link defaultTransient}); set it only to override, with a comment saying why
   * (e.g. a call that isn't idempotent).
   */
  transient?: boolean;
  /** The raw cause. Kept locally only; a bounded summary crosses step boundaries. */
  cause?: unknown;
};

/**
 * What crosses a Workflow step boundary. Runs started before a deploy replay events
 * written by the previous code, so `v` is bumped on a shape change and earlier
 * versions stay readable.
 */
interface SerializedMuxAiErrorV2 {
  v: 2;
  message: string;
  type: MuxAiErrorType;
  source: MuxAiErrorSource;
  dependency?: MuxAiErrorDependency;
  code?: MuxAiErrorCode;
  facts: MuxAiErrorFacts;
  retryable: boolean;
  transient: boolean;
  causes: MuxAiErrorCauseSummary[];
  stack?: string;
  usage?: TokenUsage;
  finishReason?: string;
  rawFinishReason?: string;
  diagnostics?: ModelCallDiagnostics;
}

/** The pre-classification shape (no `v`), still readable for in-flight runs. */
interface SerializedMuxAiErrorV1 {
  v?: undefined;
  message: string;
  publicType: MuxAiErrorType;
  retryable: boolean;
  stack?: string;
  usage?: TokenUsage;
  finishReason?: string;
  rawFinishReason?: string;
  diagnostics?: ModelCallDiagnostics;
}

const MAX_CAUSE_DEPTH = 3;
const MAX_CAUSE_MESSAGE_LENGTH = 500;

function statusOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { status, statusCode } = value as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === "number" ? status : statusCode;
  return typeof candidate === "number" && candidate >= 100 && candidate < 600 ? candidate : undefined;
}

/** Summarizes a cause chain, scrubbing high-confidence prompt leaks from each message. */
function summarizeCauses(cause: unknown): MuxAiErrorCauseSummary[] {
  const causes: MuxAiErrorCauseSummary[] = [];
  let current = cause;
  while (current !== undefined && current !== null && causes.length < MAX_CAUSE_DEPTH) {
    if (MuxAiError.is(current)) {
      causes.push(...current.causes.slice(0, MAX_CAUSE_DEPTH - causes.length));
      break;
    }
    const status = statusOf(current);
    causes.push({
      // Duck-typed: an error from another realm (e.g. a Workflow step VM) fails instanceof.
      name: typeof (current as { name?: unknown }).name === "string" ? (current as { name: string }).name : typeof current,
      message: scrubDetail(extractErrorDetail(current)).slice(0, MAX_CAUSE_MESSAGE_LENGTH),
      ...(status !== undefined && { status }),
    });
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return causes;
}

/**
 * A classified @mux/ai failure. Every instance carries a `type` and a `source`; a
 * remote failure also carries its `dependency`; a precise condition carries a `code`.
 * `message` is internal detail. Consumers decide what their customers see, e.g. by
 * rendering public text from their own catalog keyed by `code`.
 *
 * Fields, not subclasses, carry the classification: a custom Workflow codec keeps
 * them across step boundaries, and every subclass revives as `MuxAiError`.
 */
export class MuxAiError extends Error {
  /** Structural brand for duck-type identification across copies of the SDK. */
  readonly __mux_ai_error = true;

  readonly type: MuxAiErrorType;
  readonly source: MuxAiErrorSource;
  readonly dependency?: MuxAiErrorDependency;
  readonly code?: MuxAiErrorCode;
  readonly facts: MuxAiErrorFacts;

  /** Whether submitting the same job again, unchanged, may succeed. Always true when transient. */
  readonly retryable: boolean;

  /**
   * Whether the step runner should retry the step. Workflow DevKit skips retries
   * for errors named `FatalError`, so only non-transient errors take that name.
   */
  readonly transient: boolean;

  declare usage?: TokenUsage;
  declare diagnostics?: ModelCallDiagnostics;

  /** Raw cause; non-enumerable, local only. */
  declare readonly cause?: unknown;

  /** Bounded summary of the cause chain; non-enumerable, crosses step boundaries. */
  declare readonly causes: MuxAiErrorCauseSummary[];

  constructor(message: string, init: MuxAiErrorInit) {
    super(message);
    const entry = init.code ? MUX_AI_ERROR_CATALOG[init.code] as MuxAiErrorCatalogEntry : undefined;
    this.type = entry?.type ?? init.type!;
    this.source = entry?.source ?? init.source!;
    const dependency = init.dependency ?? entry?.dependency;
    if (dependency) {
      this.dependency = dependency;
    }
    if (init.code) {
      this.code = init.code;
    }
    this.facts = init.facts ?? {};
    // The site's value wins, then the code's, then the default from the classification.
    this.transient = init.transient ?? entry?.transient ?? defaultTransient(this.source, this.facts);
    // Transient implies retryable: if a step retry may succeed, so may resubmitting.
    this.retryable = this.transient || (init.retryable ?? entry?.retryable ?? defaultRetryable(this.type, this.source, false));
    this.name = this.transient ? "Error" : "FatalError";
    if (init.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: init.cause, writable: true, configurable: true });
    }
    Object.defineProperty(this, "causes", { value: summarizeCauses(init.cause), writable: true, configurable: true });
  }

  static is(value: unknown): value is MuxAiError {
    return (
      typeof value === "object" &&
      value !== null &&
      "__mux_ai_error" in value &&
      value.__mux_ai_error === true
    );
  }

  static [WORKFLOW_SERIALIZE](instance: MuxAiError): SerializedMuxAiErrorV2 {
    const incomplete = instance as MuxAiError & { finishReason?: string; rawFinishReason?: string };
    return {
      v: 2,
      message: instance.message,
      type: instance.type,
      source: instance.source,
      ...(instance.dependency && { dependency: instance.dependency }),
      ...(instance.code && { code: instance.code }),
      facts: instance.facts,
      retryable: instance.retryable,
      transient: instance.transient,
      causes: instance.causes,
      stack: instance.stack,
      usage: getErrorTokenUsage(instance),
      finishReason: incomplete.finishReason,
      rawFinishReason: incomplete.rawFinishReason,
      diagnostics: instance.diagnostics,
    };
  }

  static [WORKFLOW_DESERIALIZE](value: SerializedMuxAiErrorV2 | SerializedMuxAiErrorV1): MuxAiError {
    // Subclasses inherit this codec. Restore their fields for structural guards
    // without depending on subclass constructor signatures or raw causes. The
    // stored classification wins over the catalog's current mapping for a code.
    const error = value.v === 2 ?
        new MuxAiError(value.message, {
          type: value.type,
          source: value.source,
          dependency: value.dependency,
          facts: value.facts,
          retryable: value.retryable,
          transient: value.transient,
        }) :
      // Written before classification existed (an in-flight run replaying an older
      // event). Most of those errors were checks of the caller's input, so
      // `request` is an approximation; no new error is written in this shape.
        new MuxAiError(value.message, { type: value.publicType, source: "request", retryable: value.retryable });
    Object.assign(error, {
      ...(value.v === 2 && value.code && { code: value.code }),
      usage: value.usage,
      diagnostics: value.diagnostics,
      ...(value.finishReason !== undefined && { finishReason: value.finishReason }),
      ...(value.rawFinishReason !== undefined && { rawFinishReason: value.rawFinishReason }),
    });
    if (value.v === 2) {
      Object.defineProperty(error, "causes", { value: value.causes, writable: true, configurable: true });
    }
    if (value.stack !== undefined) {
      error.stack = value.stack;
    }
    return error;
  }
}

/**
 * Extract a human-readable detail from an unknown thrown value.
 *
 * An error thrown inside a Workflow DevKit step crosses a VM/serialization
 * boundary before it reaches a workflow-level catch, arriving as a plain
 * object that fails `instanceof Error` but still carries a `message` string.
 * Duck-typing `message` avoids collapsing the real cause (e.g. "fetch failed")
 * to "Unknown error".
 */
function extractErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "Unknown error";
}

const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;

/**
 * Drops the query string and fragment from every URL in `text`. Signed Mux and
 * presigned S3 URLs carry their tokens there; the host and path stay for debugging.
 */
export function stripUrlQueries(text: string): string {
  return text.replace(URL_QUERY, "$1?…");
}

/**
 * Prepares free text from a dependency (a provider's failure reason, a raw error
 * message) for an error's facts: URL tokens stripped, high-confidence prompt leaks
 * suppressed, length capped.
 */
export function errorDetailFact(text: string, maxLength = 500): string {
  return scrubDetail(text).slice(0, maxLength);
}

/**
 * Scrubs a raw error detail for **high-confidence** signs of a system-prompt leak
 * before it is kept on an error (message or cause summary). Rationale: the AI SDK
 * and some providers include the offending model output in their error messages
 * (e.g. "Failed to parse structured output: { reasoning: '<role>…' }"). If an
 * injection payload caused the parse failure, the raw output would otherwise bypass
 * the free-text scrubber and reach the caller through the error channel.
 *
 * Only the `canary` and `prompt_tag` detectors trigger suppression here — they
 * have very low false-positive rates. The `encoded_blob` heuristic is
 * intentionally NOT applied to error messages: legitimate upstream errors from
 * infrastructure (S3 errors containing ETags, git errors containing SHAs, AWS
 * request IDs, content hashes) can match the encoded-blob shape without being a
 * prompt leak. Suppressing those would erase useful debugging information with no
 * security benefit, because an attacker exfiltrating through a shaped blob would
 * trigger the much stronger field-level scrubber on the preceding model output.
 */
function scrubDetail(detail: string, context?: string): string {
  const leakReason = detectLeakReason(detail);
  if (leakReason !== "canary" && leakReason !== "prompt_tag") {
    return stripUrlQueries(detail);
  }
  console.warn(`[@mux/ai] Suppressed suspected prompt leak in error detail${context ? ` (context: ${context})` : ""} (reason: ${leakReason}).`);
  return "Upstream error details suppressed by safety filter";
}

/**
 * Re-throws a classified error unchanged, merging any `facts` into it (its own
 * values win). Anything else is re-thrown as a plain `Error` with the context
 * prepended: an unclassified failure may be remote (and worth a step retry), so it
 * isn't labelled here.
 *
 * Use this in catch blocks that re-throw, so a classified error from a callee
 * keeps its classification. Token usage carries over either way.
 */
export function wrapError(error: unknown, message: string, facts?: MuxAiErrorFacts): never {
  if (MuxAiError.is(error)) {
    if (facts) {
      Object.assign(error, { facts: { ...facts, ...error.facts } });
    }
    throw error;
  }
  const wrapped = new Error(`${message}: ${scrubDetail(extractErrorDetail(error), message)}`);
  // Carry `usage` through wrapping so failed workflows still report tokens burned.
  const usage = getErrorTokenUsage(error);
  if (usage) {
    (wrapped as Error & { usage?: TokenUsage }).usage = usage;
  }
  throw wrapped;
}

/**
 * This code's own failure: a broken invariant, an unexpected shape it produced, or
 * an in-process library throwing. Use it instead of `throw new Error(...)`.
 */
export function internalError(message: string, facts?: MuxAiErrorFacts, cause?: unknown): MuxAiError {
  return new MuxAiError(message, {
    type: MUX_AI_ERROR_TYPE_VALUES.server_error,
    source: MUX_AI_ERROR_SOURCE_VALUES.internal,
    facts,
    cause,
  });
}

/** Exhaustiveness guard for switch statements over closed unions. */
export function assertNever(value: never, what = "value"): never {
  throw internalError(`Unexpected ${what}: ${String(value)}`);
}
