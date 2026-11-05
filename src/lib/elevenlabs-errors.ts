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
  /** Whether repeating the same call could succeed. */
  retryable: boolean;
  /** Internal diagnostics for logs. Never customer-facing. */
  detail: string;
}

export function isRetryableElevenLabsStatus(status: number): boolean {
  // 425 Too Early: the dubbed output is not ready to download yet.
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Describes a failed HTTP response, such as a download from a signed output URL. */
export async function elevenLabsResponseFailure(response: Response): Promise<ElevenLabsFailure> {
  const body = await response.text().catch(() => "");
  return httpFailure(response.status, response.statusText, body);
}

/** Describes an error thrown by `@elevenlabs/elevenlabs-js`. */
export function elevenLabsSdkFailure(error: unknown): ElevenLabsFailure {
  const failure = error as { name?: string; message?: string; statusCode?: unknown; body?: unknown; rawResponse?: Response } | undefined;
  if (typeof failure?.statusCode === "number") {
    const body = typeof failure.body === "string" ? failure.body : JSON.stringify(failure.body ?? "");
    return httpFailure(failure.statusCode, failure.rawResponse?.statusText, body);
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

function httpFailure(status: number, statusText: string | undefined, body: string): ElevenLabsFailure {
  const statusLine = [status, statusText].filter(Boolean).join(" ");
  const { reason, detail } = parseElevenLabsErrorBody(body);
  return {
    httpStatus: status,
    reason,
    retryable: isRetryableElevenLabsStatus(status),
    detail: detail ? `${statusLine}: ${detail}` : statusLine,
  };
}

function parseElevenLabsErrorBody(body: string): { reason?: string; detail: string } {
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
      return { reason: reasonCode, detail: context ? `${reasonText} (${context})` : reasonText };
    }
  }
  return { detail: trimmed.slice(0, MAX_ERROR_BODY_CHARS) };
}
