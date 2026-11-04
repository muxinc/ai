import type { MuxAiErrorDependency, MuxAiErrorFacts, MuxAiErrorSource, MuxAiErrorType } from "./mux-ai-error.ts";
import { isTransientStatus, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";

export interface DependencyErrorInit {
  dependency: MuxAiErrorDependency;
  /** Snake_case name of the outside call, e.g. `fetch_transcript`. */
  call: string;
  /** HTTP status, when there was a response. */
  status?: number;
  requestId?: string;
  facts?: MuxAiErrorFacts;
  cause?: unknown;
  /** Source for a 404. Defaults to `internal` (we built the request). */
  notFoundSource?: MuxAiErrorSource;
  /** Source for a 401/403. Defaults to `internal` (our own credentials). */
  authSource?: MuxAiErrorSource;
  /** The call timed out before a response arrived. */
  timedOut?: boolean;
  /**
   * False for a call that isn't safe to repeat (e.g. a create): even a transient
   * failure is then not retried by the step runner, since the first attempt may
   * have taken effect. The job stays retryable.
   */
  idempotent?: boolean;
  /** Site override, as on `MuxAiError`, e.g. for a failure the caller already retried. */
  transient?: boolean;
  /** Site override, as on `MuxAiError`, e.g. when the dependency says whether a new attempt may succeed. */
  retryable?: boolean;
}

export { isTransientStatus };

/**
 * Classifies a failed call to a remote service from its HTTP status. Transient
 * failures (no response, 408/425/429, 5xx) are `upstream` and `transient`, so the
 * Workflow step runner keeps retrying them; everything else is fatal.
 */
export function dependencyError(message: string, init: DependencyErrorInit): MuxAiError {
  const { dependency, call, status, requestId, facts, cause, timedOut } = init;
  const transient = timedOut === true || isTransientStatus(status);

  let source: MuxAiErrorSource;
  let type: MuxAiErrorType;
  if (transient) {
    source = MUX_AI_ERROR_SOURCES.UPSTREAM;
    type = timedOut || status === 408 ?
      MUX_AI_ERROR_TYPES.TIMEOUT_ERROR :
      status === 429 ? MUX_AI_ERROR_TYPES.CAPACITY_ERROR : MUX_AI_ERROR_TYPES.PROCESSING_ERROR;
  } else {
    source = status === 404 ?
        (init.notFoundSource ?? MUX_AI_ERROR_SOURCES.INTERNAL) :
      status === 401 || status === 403 ?
          (init.authSource ?? MUX_AI_ERROR_SOURCES.INTERNAL) :
        MUX_AI_ERROR_SOURCES.INTERNAL;
    type = source === MUX_AI_ERROR_SOURCES.INTERNAL ?
      MUX_AI_ERROR_TYPES.SERVER_ERROR :
      MUX_AI_ERROR_TYPES.VALIDATION_ERROR;
  }

  return new MuxAiError(message, {
    type,
    source,
    dependency,
    facts: {
      call,
      ...(status !== undefined && { status }),
      ...(requestId && { requestId }),
      ...facts,
    },
    // A timeout with no status is transient by the default rule too; retryable and
    // transient otherwise follow from the classification.
    // A non-idempotent call may have taken effect only with no response or a 5xx;
    // a 408, 425 or 429 means it wasn't processed, so retrying stays safe.
    ...(init.idempotent === false && (status === undefined || status >= 500) && { transient: false }),
    ...(init.transient !== undefined && { transient: init.transient }),
    ...(init.retryable !== undefined && { retryable: init.retryable }),
    cause,
  });
}

/** Reads the HTTP status off an SDK error (`status` or `statusCode`), if it has one. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === "number" ? status : statusCode;
  return typeof candidate === "number" && candidate >= 100 && candidate < 600 ? candidate : undefined;
}

/** Reads a request id from response headers (a `Headers` instance or a plain record). */
export function requestIdOf(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const names = ["x-request-id", "x-amz-request-id", "request-id"];
  for (const name of names) {
    const value = typeof (headers as Headers).get === "function" ?
        (headers as Headers).get(name) :
        (headers as Record<string, unknown>)[name];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Classifies an error thrown by an SDK call (e.g. the Mux Node SDK). A classified
 * error passes through; otherwise the status (if any) decides the classification.
 */
export function dependencyErrorFrom(error: unknown, message: string, init: Omit<DependencyErrorInit, "status" | "cause" | "requestId">): MuxAiError {
  if (MuxAiError.is(error)) {
    return error;
  }
  return dependencyError(message, {
    ...init,
    status: httpStatusOf(error),
    requestId: requestIdOf((error as { headers?: unknown } | null)?.headers),
    cause: error,
  });
}
