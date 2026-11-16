import { z } from "zod";

import { dependencyError, requestIdOf } from "./dependency-error.ts";
import type { MuxAiError, MuxAiErrorFacts, MuxAiSiteDependencyCode } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";

import type { APICallError } from "ai";

// Tokens only: OpenAI's free-text `message` stays in the scrubbed cause summary, not in facts.
const OpenAITokenSchema = z.string().regex(/^[\w.-]{1,64}$/);

/** The parts of an OpenAI API error body worth keeping: `{ error: { code, type } }`. */
const OpenAIErrorBodySchema = z.object({
  error: z.object({
    code: OpenAITokenSchema.nullish(),
    type: OpenAITokenSchema.nullish(),
  }),
});

/** OpenAI's own description of a failed call: its `error.code` and `error.type`, when they're tokens. */
export function parseOpenAIErrorBody(responseBody: string | undefined): { code?: string; type?: string } {
  if (!responseBody) {
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(responseBody);
  } catch {
    return {};
  }
  const parsed = OpenAIErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return {};
  }
  const { code, type } = parsed.data.error;
  return { ...(code && { code }), ...(type && { type }) };
}

// From OpenAI's error codes guide (https://developers.openai.com/api/docs/guides/error-codes),
// which says to branch on `error.code`: a billing error's `type` "can still be
// `insufficient_quota`". Quota and spend limits aren't restored by retrying; a rate limit
// (`slow_down` when the rate ramped too fast) and an overload are retried after a wait.
const OPENAI_QUOTA_CODES = new Set(["credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "insufficient_quota"]);
const OPENAI_RATE_LIMIT_CODES = new Set(["slow_down", "rate_limit_exceeded"]);
const OPENAI_UNAVAILABLE_CODES = new Set(["server_is_overloaded", "service_unavailable_error"]);

/**
 * The code OpenAI's own response names where its status alone doesn't, or `undefined`
 * so the status's fallback code applies. Every 401 in OpenAI's guide (the key, the
 * organization, the IP allowlist) is the configuration of the service running the SDK.
 */
export function openAIErrorRule(status: number | undefined, { code, type }: { code?: string; type?: string }): MuxAiSiteDependencyCode | undefined {
  if ((code && OPENAI_QUOTA_CODES.has(code)) || (!code && type === "insufficient_quota")) {
    return MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED;
  }
  if (code && OPENAI_RATE_LIMIT_CODES.has(code)) {
    return MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED;
  }
  if (code && OPENAI_UNAVAILABLE_CODES.has(code)) {
    return MUX_AI_ERROR_CODES.PROVIDER_UNAVAILABLE;
  }
  return status === 401 ? MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED : undefined;
}

/**
 * Classifies a failed OpenAI API call (see `dependencyError`): OpenAI's own `error.code`
 * decides where a rule names it (see {@link openAIErrorRule}), and the status otherwise.
 * Facts: `call`, `status`, `requestId`, and `providerCode` (OpenAI's `error.code`, else
 * its `error.type`).
 */
export function openAICallError(
  apiError: APICallError,
  message: string,
  init: { call: string; facts?: MuxAiErrorFacts; cause?: unknown },
): MuxAiError {
  const body = parseOpenAIErrorBody(apiError.responseBody);
  const providerCode = body.code ?? body.type;
  const code = openAIErrorRule(apiError.statusCode, body);
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
    call: init.call,
    status: apiError.statusCode,
    requestId: requestIdOf(apiError.responseHeaders),
    facts: { ...init.facts, ...(providerCode && { providerCode }) },
    ...(code && { code }),
    cause: init.cause ?? apiError,
  });
}
