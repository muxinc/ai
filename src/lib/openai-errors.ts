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

/**
 * OpenAI's answer when it couldn't fetch an input URL (an image passed by URL) before its own
 * download deadline, in either of its wordings: "Unable to download content from the provided URL
 * before the timeout. …" (`error.code` `invalid_value`) or "Timeout while downloading <url>". The
 * request was valid; OpenAI's fetch timed out, and the same request usually succeeds on a later
 * attempt. Matched on the message, since `invalid_value` alone also covers requests that are
 * really invalid.
 */
const OPENAI_URL_DOWNLOAD_TIMEOUT = /unable to download content from the provided url before the timeout|timeout while downloading\b/i;

/**
 * Whether an error message is OpenAI's URL download timeout (see {@link OPENAI_URL_DOWNLOAD_TIMEOUT}).
 * Shared by the in-call retry and the classification, so the two agree on what's transient.
 */
export function isOpenAIUrlDownloadTimeoutMessage(message: string): boolean {
  return OPENAI_URL_DOWNLOAD_TIMEOUT.test(message);
}

const OpenAIErrorMessageSchema = z.object({ error: z.object({ message: z.string() }) });

/** Whether an OpenAI error body is its URL download timeout, answered as a 400. */
export function isOpenAIUrlDownloadTimeout(status: number | undefined, responseBody: string | undefined): boolean {
  if (status !== 400 || !responseBody) {
    return false;
  }
  try {
    const parsed = OpenAIErrorMessageSchema.safeParse(JSON.parse(responseBody));
    return parsed.success && isOpenAIUrlDownloadTimeoutMessage(parsed.data.error.message);
  } catch {
    return false;
  }
}

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
 * Classifies a failed OpenAI API call (see `dependencyError`): OpenAI's URL download timeout
 * is `dependency_timeout` (see {@link isOpenAIUrlDownloadTimeout}); otherwise OpenAI's own
 * `error.code` decides where a rule names it (see {@link openAIErrorRule}), and the status.
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
  const code = isOpenAIUrlDownloadTimeout(apiError.statusCode, apiError.responseBody) ?
    MUX_AI_ERROR_CODES.DEPENDENCY_TIMEOUT :
      openAIErrorRule(apiError.statusCode, body);
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

/**
 * Classifies a failed OpenAI call made with `fetch` rather than the AI SDK: no `status`
 * means no response; a rejection is read like {@link openAICallError}, from its status and
 * the body's `error.code` (else `error.type`). Facts: `call`, `status`, `requestId`, and
 * `providerCode` when the body had one.
 */
export function openAIFetchError(
  message: string,
  init: { call: string; status?: number; requestId?: string; body?: string; timedOut?: boolean; facts?: MuxAiErrorFacts; cause?: unknown },
): MuxAiError {
  const body = parseOpenAIErrorBody(init.body);
  const providerCode = body.code ?? body.type;
  const code = init.status === undefined ?
    undefined :
    isOpenAIUrlDownloadTimeout(init.status, init.body) ? MUX_AI_ERROR_CODES.DEPENDENCY_TIMEOUT : openAIErrorRule(init.status, body);
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
    call: init.call,
    status: init.status,
    requestId: init.requestId,
    timedOut: init.timedOut,
    facts: { ...init.facts, ...(providerCode && { providerCode }) },
    ...(code && { code }),
    cause: init.cause,
  });
}
