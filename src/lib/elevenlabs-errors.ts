import { dependencyError, isTransientStatus, requestIdOf } from "./dependency-error.ts";
import { errorDetailFact, MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";
import type { MuxAiError, MuxAiErrorCode, MuxAiErrorFacts } from "./mux-ai-error.ts";

const MAX_ERROR_BODY_CHARS = 500;

/**
 * What went wrong with an ElevenLabs call, as plain data so it can cross a
 * workflow step boundary intact. Thrown errors lose their custom fields there.
 *
 * `detail` is internal diagnostics (status line, provider message, request ID)
 * and must never reach a customer; callers build the customer-facing message
 * from `reason` and `retryable` instead.
 */
export interface ElevenLabsFailure {
  /** HTTP status, when the call got a response. */
  httpStatus?: number;
  /**
   * ElevenLabs' machine-readable reason, such as `unsupported_target_language`,
   * or `timeout` / `network_error` / `unexpected_response` when there was no
   * usable response.
   */
  reason?: string;
  /**
   * Every machine-readable value the error body carried: its `code` and its legacy
   * `status` field (ElevenLabs is moving from `status` to `code`, and may send both).
   * The rules in `ELEVENLABS_ERROR_CODES` match any of them.
   */
  providerCodes?: string[];
  /** ElevenLabs' request ID, when the response carried one. */
  requestId?: string;
  /** Whether repeating the same call could succeed. */
  retryable: boolean;
  /** Internal diagnostics for logs. Never customer-facing. */
  detail: string;
}

export function isRetryableElevenLabsStatus(status: number): boolean {
  // Includes 425 Too Early: the dubbed output is not ready to download yet.
  return isTransientStatus(status);
}

type AudioReason = "corrupt" | "unsupported_format" | "too_long" | "too_short";

/**
 * ElevenLabs error codes that name a condition its status alone doesn't, from its error
 * reference (https://elevenlabs.io/docs/developers/resources/errors) and its 429 guide
 * (https://elevenlabs.io/docs/help-center/technical/api-error-code-429). A 429 is three
 * different conditions, and quota can arrive as a 401 or 402. Legacy names are kept
 * alongside current ones. Codes not listed keep the status's fallback code.
 */
const ELEVENLABS_ERROR_CODES: Readonly<Record<string, { code: MuxAiErrorCode; reason?: AudioReason }>> = {
  insufficient_credits: { code: MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED },
  quota_exceeded: { code: MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED },
  payment_required: { code: MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED },
  invalid_api_key: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  missing_api_key: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  invalid_authorization_header: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  insufficient_permissions: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  feature_not_available: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  subscription_required: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  model_access_denied: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  workspace_access_denied: { code: MUX_AI_ERROR_CODES.PROVIDER_CREDENTIALS_REJECTED },
  rate_limit_exceeded: { code: MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED },
  concurrent_limit_exceeded: { code: MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED },
  too_many_concurrent_requests: { code: MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED },
  system_busy: { code: MUX_AI_ERROR_CODES.PROVIDER_UNAVAILABLE },
  service_unavailable: { code: MUX_AI_ERROR_CODES.PROVIDER_UNAVAILABLE },
  maintenance: { code: MUX_AI_ERROR_CODES.PROVIDER_UNAVAILABLE },
  invalid_audio: { code: MUX_AI_ERROR_CODES.AUDIO_UNPROCESSABLE, reason: "corrupt" },
  invalid_audio_format: { code: MUX_AI_ERROR_CODES.AUDIO_UNPROCESSABLE, reason: "unsupported_format" },
  invalid_file_type: { code: MUX_AI_ERROR_CODES.AUDIO_UNPROCESSABLE, reason: "unsupported_format" },
  audio_too_long: { code: MUX_AI_ERROR_CODES.AUDIO_UNPROCESSABLE, reason: "too_long" },
  audio_too_short: { code: MUX_AI_ERROR_CODES.AUDIO_UNPROCESSABLE, reason: "too_short" },
};

/** The rule matching any of a failure's provider codes, if one does. */
export function elevenLabsErrorRule(failure: Pick<ElevenLabsFailure, "reason" | "providerCodes">): { code: MuxAiErrorCode; reason?: AudioReason } | undefined {
  const values = failure.providerCodes ?? (failure.reason ? [failure.reason] : []);
  return values.map(value => ELEVENLABS_ERROR_CODES[value]).find(rule => rule !== undefined);
}

/**
 * The classified error for a failed ElevenLabs call, raised once the workflow has
 * finished retrying it. The provider's detail goes in facts. Not transient: the
 * caller already retried, or the call is a paid create that must not repeat.
 * `failure.retryable` says whether a new job may succeed.
 */
export function elevenLabsFailureError(message: string, call: string, failure: ElevenLabsFailure, facts?: MuxAiErrorFacts): MuxAiError {
  const rule = elevenLabsErrorRule(failure);
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
    call,
    status: failure.httpStatus,
    requestId: failure.requestId,
    timedOut: failure.reason === "timeout",
    facts: {
      provider: "elevenlabs",
      ...(failure.reason && { providerCode: failure.reason }),
      ...(failure.detail && { detail: errorDetailFact(failure.detail) }),
      ...(rule?.reason && { reason: rule.reason }),
      ...facts,
    },
    ...(rule && { code: rule.code }),
    transient: false,
    // Quota stays spent whatever the status, so a new job can't succeed either.
    retryable: rule?.code === MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED ? false : failure.retryable,
  });
}

/** Describes a failed HTTP response, such as a download from a signed output URL. */
export async function elevenLabsResponseFailure(response: Response): Promise<ElevenLabsFailure> {
  const body = await response.text().catch(() => "");
  return httpFailure(response.status, response.statusText, body, response.headers);
}

/** Describes an error thrown by `@elevenlabs/elevenlabs-js`. */
export function elevenLabsSdkFailure(error: unknown): ElevenLabsFailure {
  const failure = error as { name?: string; message?: string; statusCode?: unknown; body?: unknown; rawResponse?: Response } | undefined;
  if (typeof failure?.statusCode === "number") {
    const body = typeof failure.body === "string" ? failure.body : JSON.stringify(failure.body ?? "");
    return httpFailure(failure.statusCode, failure.rawResponse?.statusText, body, failure.rawResponse?.headers);
  }
  const message = failure?.message ?? String(error);
  switch (failure?.name) {
    case "ElevenLabsTimeoutError":
      return { reason: "timeout", retryable: true, detail: message };
    // The SDK validates responses strictly: the API's response no longer matches
    // this SDK version, so the same call fails the same way.
    case "ParseError":
      return { reason: "unexpected_response", retryable: false, detail: `Unexpected ElevenLabs response: ${message}` };
    // The SDK's own error without a status: the request got no response.
    case "ElevenLabsError":
      return { reason: "network_error", retryable: true, detail: message };
    default:
      return { retryable: false, detail: message };
  }
}

function httpFailure(status: number, statusText: string | undefined, body: string, headers: unknown): ElevenLabsFailure {
  const statusLine = [status, statusText].filter(Boolean).join(" ");
  const { reason, providerCodes, detail, requestId } = parseElevenLabsErrorBody(body);
  const responseRequestId = requestId ?? requestIdOf(headers);
  const quota = elevenLabsErrorRule({ reason, providerCodes })?.code === MUX_AI_ERROR_CODES.PROVIDER_QUOTA_EXHAUSTED;
  return {
    httpStatus: status,
    reason,
    ...(providerCodes && { providerCodes }),
    ...(responseRequestId && { requestId: responseRequestId }),
    // A spent quota isn't restored by retrying, even when it arrives as a 429.
    retryable: !quota && isRetryableElevenLabsStatus(status),
    detail: detail ? `${statusLine}: ${detail}` : statusLine,
  };
}

function parseElevenLabsErrorBody(body: string): { reason?: string; providerCodes?: string[]; detail: string; requestId?: string } {
  const trimmed = body.trim();
  if (!trimmed) {
    return { detail: "" };
  }

  let detail: unknown;
  try {
    detail = (JSON.parse(trimmed) as { detail?: unknown }).detail;
  } catch {
    return { detail: trimmed.slice(0, MAX_ERROR_BODY_CHARS) };
  }

  if (typeof detail === "string" && detail) {
    return { detail };
  }
  // 422s carry a list of field validation errors.
  if (Array.isArray(detail) && detail.length > 0) {
    return {
      detail: detail
        .map((item: { loc?: unknown[]; msg?: string }) => [item.loc?.join("."), item.msg].filter(Boolean).join(": "))
        .join("; "),
    };
  }
  if (detail && typeof detail === "object") {
    const { status, code, message, param, request_id: requestId } = detail as Record<string, unknown>;
    const providerCodes = [code, status].filter((value): value is string => typeof value === "string" && value !== "");
    const reasonCode = [status, code].find((value): value is string => typeof value === "string" && value !== "");
    const reasonText = [reasonCode, message].filter(Boolean).join(": ");
    const context = [param && `param: ${param}`, requestId && `request_id: ${requestId}`].filter(Boolean).join(", ");
    if (reasonText) {
      return {
        reason: reasonCode,
        ...(providerCodes.length > 0 && { providerCodes }),
        detail: context ? `${reasonText} (${context})` : reasonText,
        ...(typeof requestId === "string" && requestId && { requestId }),
      };
    }
  }
  return { detail: trimmed.slice(0, MAX_ERROR_BODY_CHARS) };
}
