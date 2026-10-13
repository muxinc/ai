const MAX_ERROR_BODY_CHARS = 500;

/**
 * Builds the error to throw for a failed ElevenLabs response, including the
 * reason from its body.
 *
 * Always a plain `Error`, never `MuxAiError`: provider detail is internal
 * diagnostics, not a customer-safe message. Statuses that cannot succeed on
 * retry are named `FatalError` so Workflow DevKit fails the step at once
 * instead of retrying it.
 */
export async function elevenLabsResponseError(context: string, response: Response): Promise<Error> {
  const error = new Error(`${context}: ${await describeElevenLabsErrorResponse(response)}`);
  if (!isRetryableElevenLabsStatus(response.status)) {
    error.name = "FatalError";
  }
  return error;
}

export function isRetryableElevenLabsStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function describeElevenLabsErrorResponse(response: Response): Promise<string> {
  const statusLine = [response.status, response.statusText].filter(Boolean).join(" ");
  const body = await response.text().catch(() => "");
  const detail = formatElevenLabsErrorBody(body);
  return detail ? `${statusLine}: ${detail}` : statusLine;
}

function formatElevenLabsErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }

  let detail: unknown;
  try {
    detail = (JSON.parse(trimmed) as { detail?: unknown }).detail;
  } catch {
    return trimmed.slice(0, MAX_ERROR_BODY_CHARS);
  }

  if (typeof detail === "string" && detail) {
    return detail;
  }
  // 422s carry a list of field validation errors.
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((item: { loc?: unknown[]; msg?: string }) => [item.loc?.join("."), item.msg].filter(Boolean).join(": "))
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    const { status, code, message, param, request_id: requestId } = detail as Record<string, unknown>;
    const reason = [status ?? code, message].filter(Boolean).join(": ");
    const context = [param && `param: ${param}`, requestId && `request_id: ${requestId}`].filter(Boolean).join(", ");
    if (reason) {
      return context ? `${reason} (${context})` : reason;
    }
  }
  return trimmed.slice(0, MAX_ERROR_BODY_CHARS);
}
