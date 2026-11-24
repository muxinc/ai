import type { MuxAiErrorFacts } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MuxAiError } from "./mux-ai-error.ts";

/**
 * Waiting out a dependency's rate limit (HTTP 429) at the Workflow DevKit step boundary.
 *
 * ## One retry owner
 *
 * A 429 is retried in exactly one place: the step that made the call. Clients' own retries are
 * off (`@mux/ts` runs with `maxRetries: 0`, the AI SDK with `maxRetries: 0`), and nothing loops
 * inside a step. The step classifies the failure as usual, then hands it to
 * {@link rateLimitStepRetry}: while the dependency's policy has attempts left, that returns the
 * same classified error marked for a delayed retry, which the step throws. Workflow DevKit then
 * waits durably, without holding a function open, and reruns just that step; earlier steps'
 * results (paid work) come from the event log. On the last attempt, or outside a step, it returns
 * `undefined` and the step fails, returns or throws exactly as it would have without this.
 *
 * So keep each call that can be rate limited in a step of its own, after any paid work and
 * before nothing that can't be repeated, and set the step's `maxRetries` to the policy's.
 *
 * ## Who owns what
 *
 * - The classifier (`dependencyError` and the per-dependency helpers built on it) records what the
 *   429 said, as facts: `retryAfterMs`, `rateLimitLimit`, `rateLimitRemaining`.
 * - A {@link RateLimitPolicy} per dependency decides how long to wait and how often.
 * - Workflow DevKit owns the attempt count (`getStepMetadata().attempt`) and the wait itself. Nothing
 *   passes a retry count across a step boundary.
 *
 * ## The delay: `Retry-After` is a floor, not an answer
 *
 * A `Retry-After` often says when *a* request may succeed, not when *this* one will. Mux's is its
 * token bucket's refill interval (2s for video `POST`s) however many callers are queued, so jobs
 * that each wait exactly `Retry-After` collide again. {@link rateLimitRetryDelayMs} keeps it as the
 * floor and adds full jitter over a window that doubles with each attempt, so competing callers
 * (parallel jobs, a directive's fan-out, a customer's backfill) spread out without knowing how many
 * there are.
 *
 * If that proves not enough, the next steps need shared state and belong to the caller (e.g.
 * Robots): widen the window by the number of in-flight jobs sharing the bucket, or reserve slots per
 * bucket so first attempts are paced too.
 */

/** How a dependency's rate limit is waited out at the step boundary. */
export interface RateLimitPolicy {
  /**
   * Retries after the first attempt. Set the step's own `maxRetries` to the same value
   * (`myStep.maxRetries = policy.maxRetries`): Workflow DevKit counts the attempts, and this
   * decides when to stop asking for another.
   */
  maxRetries: number;
  /** The first attempt's jitter window, in ms; it doubles with each attempt. */
  jitterBaseMs: number;
  /** The widest jitter window, in ms. */
  jitterCapMs: number;
  /** The floor when a 429 carries no usable `Retry-After`, in ms. */
  defaultRetryAfterMs: number;
}

/**
 * Mux Video API: each customer's token bucket, per environment or organization and shared with
 * their own traffic. Video `POST`s sustain about one request per second. Eight retries wait at
 * most about 8½ minutes in all (about half that on average).
 */
export const MUX_VIDEO_RATE_LIMIT_POLICY: Readonly<RateLimitPolicy> = Object.freeze({
  maxRetries: 8,
  jitterBaseMs: 2_000,
  jitterCapMs: 120_000,
  defaultRetryAfterMs: 1_000,
});

/** What a 429 said about the rate limit, read from its response headers. */
export interface RateLimitInfo {
  /** `retry-after-ms`, or `retry-after` (seconds, or an HTTP date), in milliseconds. */
  retryAfterMs?: number;
  /** `x-ratelimit-limit`. */
  limit?: number;
  /** `x-ratelimit-remaining`. */
  remaining?: number;
}

/** A response header from a thrown HTTP client error: `Headers`, or a plain record once revived. */
function responseHeader(error: unknown, name: string): string | undefined {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const value = typeof (headers as Headers).get === "function" ?
      (headers as Headers).get(name) :
      (headers as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function headerNumber(error: unknown, name: string): number | undefined {
  const value = responseHeader(error, name);
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The rate-limit headers on a thrown HTTP client error (e.g. a `@mux/ts` `APIError`). */
export function readRateLimit(error: unknown, now: number = Date.now()): RateLimitInfo {
  let retryAfterMs = headerNumber(error, "retry-after-ms");
  if (retryAfterMs === undefined) {
    const seconds = headerNumber(error, "retry-after");
    if (seconds !== undefined) {
      retryAfterMs = seconds * 1000;
    } else {
      const at = Date.parse(responseHeader(error, "retry-after") ?? "");
      retryAfterMs = Number.isNaN(at) ? undefined : Math.max(0, at - now);
    }
  }
  const limit = headerNumber(error, "x-ratelimit-limit");
  const remaining = headerNumber(error, "x-ratelimit-remaining");
  return {
    ...(retryAfterMs !== undefined && { retryAfterMs: Math.round(retryAfterMs) }),
    ...(limit !== undefined && { limit }),
    ...(remaining !== undefined && { remaining }),
  };
}

/**
 * The facts a classifier records for a 429: `retryAfterMs`, `rateLimitLimit`, `rateLimitRemaining`.
 * Empty for any other status, or when the response sent none of those headers.
 */
export function rateLimitFacts(error: unknown, status: number | undefined): MuxAiErrorFacts {
  if (status !== 429) {
    return {};
  }
  const { retryAfterMs, limit, remaining } = readRateLimit(error);
  return {
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    ...(limit !== undefined && { rateLimitLimit: limit }),
    ...(remaining !== undefined && { rateLimitRemaining: remaining }),
  };
}

/**
 * How long to wait before rerunning a rate-limited step: the `Retry-After` floor plus full jitter
 * over `min(cap, base × 2^attempt)`. `attempt` is the attempt that was just rate limited, from 1.
 */
export function rateLimitRetryDelayMs(
  retryAfterMs: number | undefined,
  attempt: number,
  policy: RateLimitPolicy,
  random: () => number = Math.random,
): number {
  const floor = retryAfterMs ?? policy.defaultRetryAfterMs;
  const window = Math.min(policy.jitterCapMs, policy.jitterBaseMs * 2 ** Math.max(0, attempt));
  return Math.round(floor + random() * window);
}

const RATE_LIMITED_CODES: ReadonlySet<string> = new Set([
  MUX_AI_ERROR_CODES.DEPENDENCY_RATE_LIMITED,
  MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED,
]);

/** Whether `error` is a classified rate-limit failure. */
export function isRateLimitedError(error: unknown): error is MuxAiError {
  return MuxAiError.is(error) && error.code !== undefined && RATE_LIMITED_CODES.has(error.code);
}

/** The running step's attempt (from 1), or `undefined` outside a Workflow DevKit step. */
export async function currentStepAttempt(): Promise<number | undefined> {
  try {
    const { getStepMetadata } = await import("workflow");
    return getStepMetadata().attempt;
  } catch {
    // Not installed, or not inside a step.
    return undefined;
  }
}

/** A classified error marked for a delayed step retry. */
export type RateLimitRetryError = MuxAiError & { name: "RetryableError"; retryAfter: Date };

/**
 * For a rate-limited classified error raised inside a Workflow DevKit step with attempts left under
 * `policy`: the same error, marked so Workflow DevKit reruns the step after a jittered delay. Throw
 * it. Otherwise `undefined`: not rate limited, not in a step, or the last attempt; handle the
 * error as you would without this.
 *
 * The mark is Workflow DevKit's own contract, matched by shape so `@mux/ai` doesn't import it:
 * the name `RetryableError` and a `retryAfter` date (the same way a non-transient classified error
 * is named `FatalError`). The classification is unchanged, so the step's retry event records the
 * code and facts. Across the step boundary the error revives under its usual name.
 */
export async function rateLimitStepRetry(
  error: unknown,
  policy: RateLimitPolicy,
  options: { attempt?: number; now?: number; random?: () => number } = {},
): Promise<RateLimitRetryError | undefined> {
  if (!isRateLimitedError(error)) {
    return undefined;
  }
  const attempt = options.attempt ?? await currentStepAttempt();
  if (attempt === undefined || attempt > policy.maxRetries) {
    return undefined;
  }
  const retryAfterMs = typeof error.facts.retryAfterMs === "number" ? error.facts.retryAfterMs : undefined;
  const delayMs = rateLimitRetryDelayMs(retryAfterMs, attempt, policy, options.random);
  return Object.assign(error, {
    name: "RetryableError" as const,
    retryAfter: new Date((options.now ?? Date.now()) + delayMs),
  });
}
