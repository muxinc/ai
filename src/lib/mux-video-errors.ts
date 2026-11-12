import { z } from "zod";

import { dependencyError, httpStatusOf, requestIdOf } from "./dependency-error.ts";
import type { DependencyErrorInit } from "./dependency-error.ts";
import type { MuxAiErrorFacts } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";

// Tokens only: Mux's free-text messages stay in the scrubbed cause summary, not in facts.
const MuxTokenSchema = z.string().regex(/^[\w.-]{1,64}$/);

/** The parsed body the Mux SDK keeps on an API error: `{ error: { type, messages } }`. */
const MuxApiErrorSchema = z.object({
  error: z.object({
    error: z.object({ type: MuxTokenSchema }),
  }),
});

/**
 * What Mux said about a failed API call, as facts: `muxErrorType` (e.g.
 * `invalid_parameters`), read from the response body the Mux SDK keeps on its error.
 * Its messages already reach the scrubbed `causes` through the error's message.
 */
export function muxVideoErrorFacts(error: unknown): MuxAiErrorFacts {
  const parsed = MuxApiErrorSchema.safeParse(error);
  return parsed.success ? { muxErrorType: parsed.data.error.error.type } : {};
}

/**
 * Classifies a failed Mux Video call (see `dependencyError`): a 401/403 is the caller's
 * Mux `account` (its `credentials`), and a 404 means the asset or track is gone or not
 * ready (`asset`).
 */
export function muxVideoError(
  message: string,
  init: Omit<DependencyErrorInit, "dependency" | "notFoundSource" | "authSource" | "authInputs">,
): MuxAiError {
  return dependencyError(message, {
    ...init,
    dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
    notFoundSource: MUX_AI_ERROR_SOURCES.ASSET,
    authSource: MUX_AI_ERROR_SOURCES.ACCOUNT,
    authInputs: ["credentials"],
    // A create may have taken effect despite the failure; retrying could duplicate the track.
    idempotent: init.call !== "create_track",
  });
}

/**
 * `muxVideoError` for an error thrown by a Mux SDK call, classified while the error is
 * still in hand: its status, request id and Mux's error type become facts, and the error
 * itself the cause (summarized, scrubbed, across step boundaries). An already classified
 * error passes through with `facts` merged in. Only wrap the Mux call itself: a status-less
 * failure is read as no response (transient), so a configuration failure such as missing
 * credentials must be raised before, as `internal`.
 */
export function muxVideoCallError(message: string, call: string, error: unknown, facts?: MuxAiErrorFacts): MuxAiError {
  if (MuxAiError.is(error)) {
    if (facts) {
      Object.assign(error, { facts: { ...facts, ...error.facts } });
    }
    return error;
  }
  return muxVideoError(message, {
    call,
    status: httpStatusOf(error),
    requestId: requestIdOf((error as { headers?: unknown } | null)?.headers),
    facts: { ...facts, ...muxVideoErrorFacts(error) },
    cause: error,
  });
}

/**
 * A failed asset fetch: a 404 is `asset_not_found`, blamed on the caller's `assetId`;
 * anything else is classified by status like any Mux Video call.
 */
export function muxAssetFetchError(assetId: string, error: unknown): MuxAiError {
  if (!MuxAiError.is(error) && httpStatusOf(error) === 404) {
    return new MuxAiError(`Mux asset ${assetId} not found`, {
      code: MUX_AI_ERROR_CODES.ASSET_NOT_FOUND,
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      source: MUX_AI_ERROR_SOURCES.REQUEST,
      dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
      facts: { call: "get_asset", status: 404, assetId, inputs: ["assetId"], ...muxVideoErrorFacts(error) },
      cause: error,
    });
  }
  return muxVideoCallError("Failed to fetch the asset from Mux", "get_asset", error, { assetId });
}

/**
 * Mux answered a create without a track id. The track may exist, so a retry could
 * duplicate it: not transient, but the job stays retryable.
 */
export function missingTrackIdError(message: string, facts?: MuxAiErrorFacts): MuxAiError {
  return new MuxAiError(message, {
    code: MUX_AI_ERROR_CODES.TRACK_ID_MISSING,
    type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
    source: MUX_AI_ERROR_SOURCES.UPSTREAM,
    dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
    facts: { call: "create_track", ...facts },
  });
}
