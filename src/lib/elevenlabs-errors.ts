import { dependencyError, isTransientStatus, requestIdOf } from "./dependency-error.ts";
import { errorDetailFact, MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";
import type { MuxAiError, MuxAiErrorFacts } from "./mux-ai-error.ts";

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

/**
 * The classified error for a failed ElevenLabs call, raised once the workflow has
 * finished retrying it. The provider's detail goes in facts. Not transient: the
 * caller already retried, or the call is a paid create that must not repeat.
 * `failure.retryable` says whether a new job may succeed.
 */
export function elevenLabsFailureError(message: string, call: string, failure: ElevenLabsFailure, facts?: MuxAiErrorFacts): MuxAiError {
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
      ...facts,
    },
    transient: false,
    retryable: failure.retryable,
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
  const { reason, detail, requestId } = parseElevenLabsErrorBody(body);
  const responseRequestId = requestId ?? requestIdOf(headers);
  return {
    httpStatus: status,
    reason,
    ...(responseRequestId && { requestId: responseRequestId }),
    retryable: isRetryableElevenLabsStatus(status),
    detail: detail ? `${statusLine}: ${detail}` : statusLine,
  };
}

function parseElevenLabsErrorBody(body: string): { reason?: string; detail: string; requestId?: string } {
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
    const reasonCode = [status, code].find((value): value is string => typeof value === "string" && value !== "");
    const reasonText = [reasonCode, message].filter(Boolean).join(": ");
    const context = [param && `param: ${param}`, requestId && `request_id: ${requestId}`].filter(Boolean).join(", ");
    if (reasonText) {
      return {
        reason: reasonCode,
        detail: context ? `${reasonText} (${context})` : reasonText,
        ...(typeof requestId === "string" && requestId && { requestId }),
      };
    }
  }
  return { detail: trimmed.slice(0, MAX_ERROR_BODY_CHARS) };
}
