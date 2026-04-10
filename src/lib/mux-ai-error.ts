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
    this.name = "MuxAiError";
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
 */
export function wrapError(error: unknown, message: string): never {
  if (error instanceof MuxAiError) {
    throw error;
  }
  const detail = error instanceof Error ? error.message : "Unknown error";
  throw new Error(`${message}: ${detail}`);
}
