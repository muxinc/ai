import { z } from "zod";

import { dependencyError, requestIdOf } from "./dependency-error.ts";
import type { MuxAiError, MuxAiErrorFacts, MuxAiSiteDependencyCode } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";

import type { APICallError } from "ai";

// Tokens only: free text from the body stays out of facts. A value that isn't one is dropped, not a
// reason to reject the whole body, so the body's other facts still reach the rules.
const GoogleTokenSchema = z.string().regex(/^[\w.-]{1,128}$/).optional().catch(undefined);

/**
 * The parts of a Gemini API error body worth keeping: Google's canonical status
 * (e.g. `RESOURCE_EXHAUSTED`), its newer snake_case error code (e.g. `quota_exceeded`)
 * where the body has one instead of the numeric HTTP code, and, for a quota failure,
 * which quota ran out.
 */
const GoogleErrorBodySchema = z.object({
  error: z.object({
    status: GoogleTokenSchema,
    code: z.union([z.string().regex(/^[\w.-]{1,128}$/), z.number()]).optional().catch(undefined),
    details: z.array(z.object({
      violations: z.array(z.object({ quotaId: GoogleTokenSchema })).max(16).optional(),
    })).max(16).optional(),
  }),
});

/**
 * Google's own description of a failed call, as facts: `providerStatus`, `providerCode`
 * (the snake_case error code when the body carries one, else the status) and, for a quota failure,
 * `quotaIds`. A 429 can be a short rate limit or a spent daily quota, which the status
 * alone can't tell apart; these facts can.
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
  const code = parsed.data.error.code;
  return {
    ...(parsed.data.error.status && { providerStatus: parsed.data.error.status }),
    // Google's own code, as every provider rule's `providerCode`: the snake_case code, else its status.
    ...((typeof code === "string" || parsed.data.error.status) && { providerCode: typeof code === "string" ? code : parsed.data.error.status }),
    ...(quotaIds.length > 0 && { quotaIds }),
  };
}

// Gemini API errors (https://ai.google.dev/gemini-api/docs/troubleshooting, the API errors
// reference and the rate-limits guide). Google says to retry 429 and 5xx with backoff, and
// never 400, 402 or 403. A 429 is a per-minute rate limit (RPM/TPM) unless a per-day quota
// (RPD/TPD, reset at midnight Pacific) ran out: its `QuotaFailure` quota ids name the
// window, e.g. `GenerateRequestsPerDayPerProjectPerModel`, and the newer error bodies say
// `quota_exceeded`. A 402 is a spent prepaid balance.
const GOOGLE_PER_DAY_QUOTA = /PerDay/i;
const GOOGLE_QUOTA_EXCEEDED_CODE = "quota_exceeded";

/**
 * What Google's response says about a failed call where its status alone doesn't: a code,
 * or that the call timed out. Undefined when no rule matches, so the status's fallback
 * code applies.
 */
export function googleCallRule(status: number | undefined, facts: MuxAiErrorFacts): { code?: MuxAiSiteDependencyCode; timedOut?: boolean } | undefined {
  const quotaIds = Array.isArray(facts.quotaIds) ? facts.quotaIds.map(String) : [];
  if (status === 402) {
    return { code: MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED };
  }
  if (status === 429) {
    const perDay = facts.providerCode === GOOGLE_QUOTA_EXCEEDED_CODE || quotaIds.some(id => GOOGLE_PER_DAY_QUOTA.test(id));
    return { code: perDay ? MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED : MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED };
  }
  // A key that's missing, invalid, leaked or blocked, or a project without permission,
  // verification or billing: the service's own key or account, not the caller's.
  if (status === 401 || status === 403) {
    return { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED };
  }
  if (status === 503) {
    return { code: MUX_AI_ERROR_CODES.PROVIDER_UNAVAILABLE };
  }
  // DEADLINE_EXCEEDED: the request didn't finish within the deadline.
  return status === 504 ? { timedOut: true } : undefined;
}

/**
 * Classifies a failed Gemini API call by Google's rules (see {@link googleCallRule}), else
 * by its status (see `dependencyError`), with Google's own status, code and quota as
 * facts. The service's API key and request shapes are its own, so a rejected request
 * (including a 401/403) is `internal`.
 */
export function googleCallError(
  apiError: APICallError,
  message: string,
  init: { call: string; facts?: MuxAiErrorFacts; cause?: unknown },
): MuxAiError {
  const facts = { ...init.facts, ...googleErrorFacts(apiError.responseBody) };
  const rule = googleCallRule(apiError.statusCode, facts);
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
    call: init.call,
    status: apiError.statusCode,
    requestId: requestIdOf(apiError.responseHeaders),
    facts,
    ...(rule?.code && { code: rule.code }),
    ...(rule?.timedOut && { timedOut: true }),
    cause: init.cause ?? apiError,
  });
}
