import { z } from "zod";

import { dependencyError, requestIdOf } from "./dependency-error.ts";
import type { MuxAiError, MuxAiErrorFacts } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";

import type { APICallError } from "ai";

// Tokens only: free text from the body stays out of facts.
const GoogleTokenSchema = z.string().regex(/^[\w.-]{1,128}$/);

/**
 * The parts of a Gemini API error body worth keeping: Google's canonical status
 * (e.g. `RESOURCE_EXHAUSTED`) and, for a quota failure, which quota ran out.
 */
const GoogleErrorBodySchema = z.object({
  error: z.object({
    status: GoogleTokenSchema.optional(),
    details: z.array(z.object({
      violations: z.array(z.object({ quotaId: GoogleTokenSchema.optional() })).max(16).optional(),
    })).max(16).optional(),
  }),
});

/**
 * Google's own description of a failed call, as facts: `providerStatus` and, for a
 * quota failure, `quotaIds`. A 429 can be a short rate limit or a spent daily quota,
 * which the status alone can't tell apart; these facts can.
 */
export function googleErrorFacts(responseBody: string | undefined): MuxAiErrorFacts {
  if (!responseBody) {
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(responseBody);
  } catch {
    return {};
  }
  const parsed = GoogleErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return {};
  }
  const quotaIds = [...new Set((parsed.data.error.details ?? [])
    .flatMap(detail => detail.violations ?? [])
    .map(violation => violation.quotaId)
    .filter((quotaId): quotaId is string => quotaId !== undefined))];
  return {
    ...(parsed.data.error.status && { providerStatus: parsed.data.error.status }),
    ...(quotaIds.length > 0 && { quotaIds }),
  };
}

/**
 * Classifies a failed Gemini API call by its status (see `dependencyError`), with
 * Google's own status and quota as facts. The service's API key and request shapes
 * are its own, so a rejected request (including a 401/403) is `internal`.
 */
export function googleCallError(
  apiError: APICallError,
  message: string,
  init: { call: string; facts?: MuxAiErrorFacts; cause?: unknown },
): MuxAiError {
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
    call: init.call,
    status: apiError.statusCode,
    requestId: requestIdOf(apiError.responseHeaders),
    facts: { ...init.facts, ...googleErrorFacts(apiError.responseBody) },
    cause: init.cause ?? apiError,
  });
}
