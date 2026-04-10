/**
 * An error whose message is safe to surface .
 *
 * Uses a structural brand (`__robots_error = true`) so that downstream
 * consumers can identify customer-safe errors via duck typing — no
 * shared dependency required. Errors from @mux/ai that DON'T carry
 * this brand (unexpected SDK failures, upstream provider errors, etc.)
 * should be treated as internal and obfuscated.
 *
 * Own properties (`publicMessage`, `publicType`, `retryable`, `fatal`)
 * survive JSON serialization across workflow step boundaries, unlike
 * inherited `Error.message`.
 */
export class MuxAiError extends Error {
  /** Structural brand for duck-type identification. */
  readonly __robots_error = true;

  /** Error category shown in the API response. */
  readonly publicType: string;

  /** Customer-facing message. Must be safe to show verbatim. */
  readonly publicMessage: string;

  /** Whether the customer should retry the job. */
  readonly retryable: boolean;

  /** Tells the workflow runtime to skip step-level retries. */
  readonly fatal = true;

  constructor(message: string, opts?: {
    type?: string;
    retryable?: boolean;
  }) {
    super(message);
    this.name = "MuxAiError";
    this.publicType = opts?.type ?? "processing_error";
    this.publicMessage = message;
    this.retryable = opts?.retryable ?? false;
  }
}
