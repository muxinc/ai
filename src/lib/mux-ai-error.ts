import { detectLeakReason } from "./output-safety";

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
 * The upstream `detail` is scrubbed for **high-confidence** signs of a
 * system-prompt leak before being folded into the thrown message.
 * Rationale: the AI SDK and some providers include the offending model
 * output in their error messages (e.g. "Failed to parse structured
 * output: { reasoning: '<role>…' }"). If an injection payload caused
 * the parse failure, the raw output would otherwise bypass the
 * free-text scrubber and reach the caller through the error channel.
 *
 * Only the `canary` and `prompt_tag` detectors trigger suppression
 * here — they have very low false-positive rates. The `encoded_blob`
 * heuristic is intentionally NOT applied to error messages: legitimate
 * upstream errors from infrastructure (S3 errors containing ETags,
 * git errors containing SHAs, AWS request IDs, content hashes) can
 * match the encoded-blob shape without being a prompt leak. Suppressing
 * those would erase useful debugging information with no security
 * benefit, because an attacker exfiltrating through a shaped blob would
 * trigger the much stronger field-level scrubber on the preceding
 * model output.
 */
export function wrapError(error: unknown, message: string): never {
  if (error instanceof MuxAiError) {
    throw error;
  }
  const rawDetail = error instanceof Error ? error.message : "Unknown error";
  const leakReason = detectLeakReason(rawDetail);
  const shouldSuppress = leakReason === "canary" || leakReason === "prompt_tag";
  const detail = shouldSuppress ?
    "Upstream error details suppressed by safety filter" :
    rawDetail;
  if (shouldSuppress) {
    console.warn(`[@mux/ai] Suppressed suspected prompt leak in wrapped error (context: ${message}, reason: ${leakReason}).`);
  }
  throw new Error(`${message}: ${detail}`);
}
