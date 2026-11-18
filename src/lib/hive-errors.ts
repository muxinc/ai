import { dependencyError } from "./dependency-error.ts";
import type { MuxAiError, MuxAiErrorFacts, MuxAiSiteDependencyCode } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";

// Hive's error codes (https://docs.thehive.ai/reference/error-codes): 405 is an account out
// of credits, 403 a key without access, 429 a rate limit.

/** The code Hive's response names where its status alone doesn't, or `undefined` so the status's fallback code applies. */
export function hiveErrorRule(status: number | undefined): MuxAiSiteDependencyCode | undefined {
  switch (status) {
    case 405:
      return MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED;
    case 403:
      return MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED;
    case 429:
      return MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED;
    default:
      return undefined;
  }
}

/**
 * Classifies a failed Hive call (see `dependencyError`): by {@link hiveErrorRule}, else its
 * status. `answered`: Hive answered 200 with a nonzero `return_code`, an error of its own
 * (`dependency_response_failed`), kept as `providerCode` when it's a token. No `status` and
 * not answered means no response. Facts: `call`, `provider`, `status`, `requestId`, and
 * `providerCode`.
 */
export function hiveCallError(
  message: string,
  init: { call: string; status?: number; requestId?: string; timedOut?: boolean; answered?: boolean; returnCode?: string; facts?: MuxAiErrorFacts; cause?: unknown },
): MuxAiError {
  const code = init.answered ? MUX_AI_ERROR_CODES.DEPENDENCY_RESPONSE_FAILED : hiveErrorRule(init.status);
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
    call: init.call,
    status: init.status,
    requestId: init.requestId,
    timedOut: init.timedOut,
    facts: { provider: "hive", ...init.facts, ...(init.returnCode && { providerCode: init.returnCode }) },
    ...(code && { code }),
    cause: init.cause,
  });
}
