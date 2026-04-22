import { detectSystemPromptLeak } from "@mux/ai/lib/output-safety";

export type MuxAiErrorType = "validation_error" | "processing_error" | "timeout_error";

/**
 * An error whose message is safe to surface verbatim to the customer.
 *
 * Uses a structural brand (`__robots_error = true`) so that downstream
 * consumers can identify customer-safe errors via duck typing — no
 * shared dependency required. Errors from @mux/ai that DON'T carry
 * this brand (unexpected SDK failures, upstream provider errors, etc.)
 * should be treated as internal and obfuscated.
 *
 * Own properties (`publicMessage`, `publicType`, `retryable`) survive
 * JSON serialization across workflow step boundaries, unlike inherited
 * `Error.message`.
 */
export class MuxAiError extends Error {
  /** Structural brand for duck-type identification. */
  readonly __robots_error = true;

  /** Error category shown in the API response. */
  readonly publicType: MuxAiErrorType;

  /** Customer-facing message. Must be safe to show verbatim. */
  readonly publicMessage: string;

  /** Whether the customer should retry the job. */
  readonly retryable: boolean;

  constructor(message: string, opts?: {
    type?: MuxAiErrorType;
    retryable?: boolean;
  }) {
    super(message);
    this.name = "FatalError";
    this.publicType = opts?.type ?? "processing_error";
    this.publicMessage = message;
    this.retryable = opts?.retryable ?? false;
  }
}

/**
 * Re-throws {@link MuxAiError} instances to preserve the structural brand,
 * wraps everything else in a plain `Error` with a contextual message.
 *
 * Use this in catch blocks that re-throw so a customer-safe error from a
 * callee isn't accidentally converted into an internal error.
 *
 * The upstream `detail` is scrubbed for signs of a system-prompt leak
 * before being folded into the thrown message. Rationale: the AI SDK and
 * some providers include the offending model output in their error
 * messages (e.g. "Failed to parse structured output: { reasoning: '<role>…' }").
 * If an injection payload caused the parse failure, the raw output would
 * otherwise bypass the free-text scrubber and reach the caller through
 * the error channel. When a leak is detected in the detail, we substitute
 * a generic "Upstream error details suppressed by safety filter" so the
 * caller still sees the outer context message (which we author) and a
 * one-line signal that the library intervened.
 */
export function wrapError(error: unknown, message: string): never {
  if (error instanceof MuxAiError) {
    throw error;
  }
  const rawDetail = error instanceof Error ? error.message : "Unknown error";
  const detail = detectSystemPromptLeak(rawDetail) ?
    "Upstream error details suppressed by safety filter" :
    rawDetail;
  if (detail !== rawDetail) {
    console.warn(`[@mux/ai] Suppressed suspected prompt leak in wrapped error (context: ${message}).`);
  }
  throw new Error(`${message}: ${detail}`);
}
