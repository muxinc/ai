import type { MuxAiErrorDependency, MuxAiErrorFacts, MuxAiErrorSource, MuxAiErrorType, SourceAndDependency } from "./mux-ai-error.ts";
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
 * The classification of a failed call to a remote service, from its HTTP status:
 * no response, a timeout, 408/425/429 and 5xx are `upstream` and transient (408 and
 * timeouts as `timeout_error`, 429 as `capacity_error`); 404 and 401/403 take the
 * caller's chosen source; any other status is `internal`, a request we built. Shared
 * by {@link dependencyError} and by consumers building their own errors on the same
 * model, so remote failures are classified the same way everywhere.
 */
export function classifyDependencyFailure(init: Pick<DependencyErrorInit, "call" | "status" | "requestId" | "facts" | "notFoundSource" | "authSource" | "timedOut" | "idempotent" | "transient" | "retryable">): {
  type: MuxAiErrorType;
  source: MuxAiErrorSource;
  facts: MuxAiErrorFacts;
  transient: boolean;
  retryable?: boolean;
} {
  const { call, status, requestId, facts, timedOut } = init;
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

  return {
    type,
    source,
    facts: {
      call,
      ...(status !== undefined && { status }),
      ...(requestId && { requestId }),
      ...facts,
    },
    // Set here, not left to the default: only the call site knows a missing status
    // means no response (transient), rather than a failure the dependency reported.
    // A non-idempotent call may have taken effect only with no response or a 5xx;
    // a 408, 425 or 429 means it wasn't processed, so retrying stays safe.
    transient: init.transient ?? (init.idempotent === false && (status === undefined || status >= 500) ? false : transient),
    ...(init.retryable !== undefined && { retryable: init.retryable }),
  };
}

/**
 * Classifies a failed call to a remote service from its HTTP status (see
 * {@link classifyDependencyFailure}). Transient failures are retried by the Workflow
 * step runner; everything else is fatal.
 */
export function dependencyError(message: string, init: DependencyErrorInit): MuxAiError {
  const { source, ...classification } = classifyDependencyFailure(init);
  // Every source is fine here: the dependency is always named.
  const where: SourceAndDependency<MuxAiErrorDependency> = { source, dependency: init.dependency };
  return new MuxAiError(message, { ...classification, ...where, cause: init.cause });
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
