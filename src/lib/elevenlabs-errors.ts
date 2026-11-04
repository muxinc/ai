import { dependencyError, isTransientStatus, requestIdOf } from "./dependency-error.ts";
import { errorDetailFact, MUX_AI_ERROR_DEPENDENCY_VALUES } from "./mux-ai-error.ts";
import type { MuxAiError, MuxAiErrorFacts } from "./mux-ai-error.ts";

const MAX_ERROR_BODY_CHARS = 500;

export interface ElevenLabsErrorOptions {
  /** Snake_case name of the call, e.g. `elevenlabs_create_dubbing`. */
  call?: string;
  facts?: MuxAiErrorFacts;
  /** False for a call that isn't safe to repeat (e.g. creating a dubbing job). */
  idempotent?: boolean;
}

/**
 * Builds the classified `ai_provider` error to throw for a failed ElevenLabs
 * response. The reason from the body goes in facts (`detail`, `providerCode`),
 * not the message. Statuses that can succeed on retry (408, 425, 429, 5xx) are
 * `transient`, so Workflow DevKit retries the step; any other status is fatal.
 * A 401/403 is our own API key, and other 4xx are requests we built: `internal`.
 */
export async function elevenLabsResponseError(
  context: string,
  response: Response,
  options: ElevenLabsErrorOptions = {},
): Promise<MuxAiError> {
  const { detail, providerCode, requestId } = await describeElevenLabsErrorResponse(response);
  return dependencyError(`${context} (HTTP ${response.status})`, {
    dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.ai_provider,
    call: options.call ?? "elevenlabs_request",
    status: response.status,
    requestId: requestId ?? requestIdOf(response.headers),
    idempotent: options.idempotent,
    facts: {
      provider: "elevenlabs",
      ...(providerCode && { providerCode }),
      ...(detail && { detail: errorDetailFact(detail) }),
      ...options.facts,
    },
  });
}

export function isRetryableElevenLabsStatus(status: number): boolean {
  // 425 Too Early: the dubbed output is not ready to download yet.
  return isTransientStatus(status);
}

interface ElevenLabsErrorDescription {
  detail?: string;
  providerCode?: string;
  requestId?: string;
}

async function describeElevenLabsErrorResponse(response: Response): Promise<ElevenLabsErrorDescription> {
  const body = await response.text().catch(() => "");
  return formatElevenLabsErrorBody(body);
}

function formatElevenLabsErrorBody(body: string): ElevenLabsErrorDescription {
  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  let detail: unknown;
  try {
    detail = (JSON.parse(trimmed) as { detail?: unknown }).detail;
  } catch {
    return { detail: trimmed.slice(0, MAX_ERROR_BODY_CHARS) };
  }

  if (typeof detail === "string" && detail) {
    return { detail: detail.slice(0, MAX_ERROR_BODY_CHARS) };
  }
  // 422s carry a list of field validation errors.
  if (Array.isArray(detail) && detail.length > 0) {
    return {
      detail: detail
        .map((item: { loc?: unknown[]; msg?: string }) => [item.loc?.join("."), item.msg].filter(Boolean).join(": "))
        .join("; ")
        .slice(0, MAX_ERROR_BODY_CHARS),
    };
  }
  if (detail && typeof detail === "object") {
    const { status, code, message, param, request_id: requestId } = detail as Record<string, unknown>;
    const providerCode = typeof (status ?? code) === "string" ? String(status ?? code) : undefined;
    const reason = [typeof message === "string" ? message : undefined, param && `param: ${String(param)}`]
      .filter(Boolean)
      .join(" ");
    return {
      ...(reason && { detail: reason.slice(0, MAX_ERROR_BODY_CHARS) }),
      ...(providerCode && { providerCode }),
      ...(typeof requestId === "string" && requestId && { requestId }),
    };
  }
  return { detail: trimmed.slice(0, MAX_ERROR_BODY_CHARS) };
}
