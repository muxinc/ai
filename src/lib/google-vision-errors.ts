import { dependencyError } from "./dependency-error.ts";
import type { MuxAiError, MuxAiErrorFacts, MuxAiSiteDependencyCode } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";

// Google Vision's per-image errors are google.rpc codes
// (https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto); retrying per
// https://google.aip.dev/194.
const GOOGLE_RPC_INVALID_ARGUMENT = "3";
const GOOGLE_RPC_RESOURCE_EXHAUSTED = "8";
const GOOGLE_RPC_UNAVAILABLE = "14";

/**
 * What a per-image `error` in a Vision response says: a code, and whether a new attempt may
 * succeed. `undefined` when no rule matches, so `dependency_response_failed` applies.
 */
export function googleVisionImageErrorRule(
  rpcCode: string | undefined,
  { inline }: { inline: boolean },
): { code?: MuxAiSiteDependencyCode; retryable?: boolean } | undefined {
  switch (rpcCode) {
    // Per image, not per request. With the image sent inline, it's that image that can't be
    // used. With a URL, Vision fetches the image itself and reports a failed fetch with the
    // same code ("The URL does not appear to be accessible by us"), which says nothing about
    // the image, so it stays `dependency_response_failed`.
    case GOOGLE_RPC_INVALID_ARGUMENT:
      return inline ? { code: MUX_AI_ERROR_CODES.IMAGE_UNPROCESSABLE } : undefined;
    case GOOGLE_RPC_UNAVAILABLE:
      return { code: MUX_AI_ERROR_CODES.PROVIDER_UNAVAILABLE };
    // A rate limit or a spent quota, which Google can't tell apart here: "generally don't retry".
    case GOOGLE_RPC_RESOURCE_EXHAUSTED:
      return { retryable: false };
    default:
      return undefined;
  }
}

/**
 * Classifies a failed Google Vision call (see `dependencyError`). A rejected request or no
 * response is coded by its status. `answered`: Vision answered 200 with a per-image `error`,
 * read from its `rpcCode` by {@link googleVisionImageErrorRule}, else
 * `dependency_response_failed`; `inline` says whether the image was sent as content rather
 * than a URL Vision fetched. Facts: `call`, `provider`, `status`, `requestId`, and
 * `providerCode` (the rpc code, when it's a token).
 */
export function googleVisionCallError(
  message: string,
  init: { call: string; status?: number; requestId?: string; timedOut?: boolean; answered?: boolean; rpcCode?: string; inline?: boolean; facts?: MuxAiErrorFacts; cause?: unknown },
): MuxAiError {
  const answered = init.answered === true;
  const rule = answered ? googleVisionImageErrorRule(init.rpcCode, { inline: init.inline === true }) : undefined;
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
    call: init.call,
    status: init.status,
    requestId: init.requestId,
    timedOut: init.timedOut,
    facts: { provider: "google-vision-api", ...init.facts, ...(init.rpcCode && { providerCode: init.rpcCode }) },
    ...(answered && { code: rule?.code ?? MUX_AI_ERROR_CODES.DEPENDENCY_RESPONSE_FAILED }),
    ...(rule?.retryable !== undefined && { retryable: rule.retryable }),
    cause: init.cause,
  });
}
