import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

import type { TokenUsage } from "../types.ts";

import { isLegacyMuxAiError } from "./error-guards.ts";
import type { ModelCallDiagnostics, MuxAiErrorSource, MuxAiErrorType, SerializedMuxAiError } from "./mux-ai-error.ts";
import { extractErrorDetail, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";
import { detectLeakReason } from "./output-safety.ts";
import { toSerializableValue } from "./serializable-value.ts";
import { getErrorTokenUsage } from "./token-usage.ts";

// Errors raised the way they were before classification, for modules not yet on the
// classified model (see docs/ERRORS.md, "Legacy errors"). Everything here goes away
// when the last module has moved.

/**
 * What a legacy error carries across a Workflow step boundary: the pre-classification
 * shape, so it revives with its end-user message.
 */
export interface LegacySerializedMuxAiError {
  message: string;
  publicType: MuxAiErrorType;
  retryable: boolean;
  stack?: string;
  usage?: TokenUsage;
  finishReason?: string;
  rawFinishReason?: string;
  diagnostics?: ModelCallDiagnostics;
}

/**
 * The source a legacy error is recorded with. Approximate: legacy errors carry only a
 * type, and are reworded by their own end-user message, never by source.
 */
function legacySource(type: MuxAiErrorType): Exclude<MuxAiErrorSource, typeof MUX_AI_ERROR_SOURCES.UPSTREAM> {
  switch (type) {
    case MUX_AI_ERROR_TYPES.VALIDATION_ERROR:
      return MUX_AI_ERROR_SOURCES.REQUEST;
    case MUX_AI_ERROR_TYPES.CONTENT_POLICY_ERROR:
      return MUX_AI_ERROR_SOURCES.ASSET;
    default:
      return MUX_AI_ERROR_SOURCES.INTERNAL;
  }
}

/**
 * A failure raised the way it was before classification: its message is end-user
 * text, shown verbatim by the public view, and it is never step-retried. It keeps
 * the fields consumers read before classification (`__robots_error`, `publicType`,
 * `publicMessage`, `retryable`), so their handling of it doesn't change.
 *
 * Temporary and internal: each module moves its sites to {@link MuxAiError} with a
 * type and source (and a code when there is one), and this class goes away with the
 * last one.
 *
 * @deprecated Raise a {@link MuxAiError}. A lint rule bans this class in migrated modules.
 */
export class LegacyMuxAiError extends MuxAiError {
  readonly __robots_error = true;

  readonly publicType: MuxAiErrorType;

  /** End-user text. Same as `message`. */
  readonly publicMessage: string;

  constructor(message: string, opts?: {
    type?: MuxAiErrorType;
    retryable?: boolean;
    cause?: unknown;
  }) {
    const type = opts?.type ?? MUX_AI_ERROR_TYPES.PROCESSING_ERROR;
    // Never step-retried, as before classification.
    super(message, { type, source: legacySource(type), retryable: opts?.retryable ?? false, transient: false, cause: opts?.cause });
    this.publicType = type;
    this.publicMessage = message;
  }

  // Its own codec, so a legacy error crosses step boundaries in its previous shape and
  // revives as a legacy error (subclasses such as IncompleteGenerationError inherit it).
  static [WORKFLOW_SERIALIZE](instance: LegacyMuxAiError): LegacySerializedMuxAiError {
    const incomplete = instance as LegacyMuxAiError & { finishReason?: string; rawFinishReason?: string };
    return {
      message: instance.publicMessage,
      publicType: instance.publicType,
      retryable: instance.retryable,
      stack: instance.stack,
      usage: getErrorTokenUsage(instance),
      finishReason: incomplete.finishReason,
      rawFinishReason: incomplete.rawFinishReason,
      diagnostics: toSerializableValue(instance.diagnostics) as ModelCallDiagnostics | undefined,
    };
  }

  // Typed to match the base codec; this codec only ever reads the legacy shape it writes. Never
  // throws: a malformed record reads with fallbacks, since a throw here would hand the workflow an
  // unclassified error instead.
  static [WORKFLOW_DESERIALIZE](record: LegacySerializedMuxAiError | SerializedMuxAiError): LegacyMuxAiError {
    const value = (typeof record === "object" && record !== null ? record : {}) as Partial<LegacySerializedMuxAiError>;
    const message = typeof value.message === "string" ? value.message : "Unknown error";
    try {
      const error = new LegacyMuxAiError(message, {
        type: typeof value.publicType === "string" ? value.publicType : MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
        retryable: value.retryable === true,
      });
      Object.assign(error, {
        usage: typeof value.usage === "object" && value.usage !== null ? value.usage : undefined,
        diagnostics: typeof value.diagnostics === "object" && value.diagnostics !== null ? value.diagnostics : undefined,
        ...(typeof value.finishReason === "string" && { finishReason: value.finishReason }),
        ...(typeof value.rawFinishReason === "string" && { rawFinishReason: value.rawFinishReason }),
      });
      if (typeof value.stack === "string") {
        error.stack = value.stack;
      }
      return error;
    } catch {
      return new LegacyMuxAiError(message, { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR });
    }
  }
}

export { isLegacyMuxAiError };

/**
 * `wrapError()` as it was before classification, for modules not yet migrated:
 * passes an SDK error through, and wraps anything else in a plain `Error` (which the
 * step runner retries) with a scrubbed detail.
 *
 * @deprecated Use `wrapError()`. Goes away with {@link LegacyMuxAiError}.
 */
export function legacyWrapError(error: unknown, message: string): never {
  if (MuxAiError.is(error) || isLegacyMuxAiError(error)) {
    throw error;
  }
  const rawDetail = extractErrorDetail(error);
  const leakReason = detectLeakReason(rawDetail);
  const shouldSuppress = leakReason === "canary" || leakReason === "prompt_tag";
  const detail = shouldSuppress ?
    "Upstream error details suppressed by safety filter" :
    rawDetail;
  if (shouldSuppress) {
    console.warn(`[@mux/ai] Suppressed suspected prompt leak in wrapped error (context: ${message}, reason: ${leakReason}).`);
  }
  const wrapped = new Error(`${message}: ${detail}`);
  // Carry `usage` through wrapping so failed workflows still report tokens burned.
  const usage = getErrorTokenUsage(error);
  if (usage) {
    (wrapped as Error & { usage?: TokenUsage }).usage = usage;
  }
  throw wrapped;
}
