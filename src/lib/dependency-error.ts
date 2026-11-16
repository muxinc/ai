import type { ErrorCatalogEntry, MuxAiDependencyStatusCode, MuxAiErrorCode, MuxAiErrorDependency, MuxAiErrorFacts, MuxAiErrorInit, MuxAiErrorSource, MuxAiErrorType, SourceAndDependency } from "./mux-ai-error.ts";
import { isTransientStatus, MUX_AI_DEPENDENCY_STATUS_CODES, MUX_AI_ERROR_CATALOG, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";

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
  /** The caller's inputs a 401/403 is blamed on (e.g. `credentials`), recorded as the `inputs` fact. */
  authInputs?: readonly string[];
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

/**
 * {@link DependencyErrorInit} plus the catalog code a per-dependency rule recognized in
 * the response, e.g. `provider_rate_limited`. Kept apart from `DependencyErrorInit` so
 * consumers that build their own errors from it can add their own `code`.
 */
export interface RecognizedDependencyErrorInit extends DependencyErrorInit {
  /**
   * A catalog code sets the type and source, and its own retry policy wins over the
   * status rules. A fallback code names what was observed when the status can't, e.g.
   * `dependency_other_status` for a response that answered but reported a failure;
   * the status rules still classify it. Without one, the error gets the status's
   * fallback code (see {@link dependencyFailureCode}).
   */
  code?: MuxAiErrorCode | MuxAiDependencyStatusCode;
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
export function classifyDependencyFailure(init: Pick<DependencyErrorInit, "call" | "status" | "requestId" | "facts" | "notFoundSource" | "authSource" | "authInputs" | "timedOut" | "idempotent" | "transient" | "retryable">): {
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

  const authFailure = !transient && (status === 401 || status === 403);
  return {
    type,
    source,
    facts: {
      call,
      ...(status !== undefined && { status }),
      ...(requestId && { requestId }),
      ...(authFailure && init.authInputs?.length && { inputs: [...init.authInputs] }),
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
 * The fallback code for a remote call's failure, from its HTTP status (or the lack of
 * one). Use it only when no per-dependency rule recognized the response. It names what
 * was observed, never a cause: a 400 is `dependency_request_rejected`, not a bad request.
 */
export function dependencyFailureCode({ status, timedOut }: Pick<DependencyErrorInit, "status" | "timedOut">): MuxAiDependencyStatusCode {
  if (timedOut || status === 408) {
    return MUX_AI_DEPENDENCY_STATUS_CODES.TIMEOUT;
  }
  if (status === undefined) {
    return MUX_AI_DEPENDENCY_STATUS_CODES.NO_RESPONSE;
  }
  if (status === 429) {
    return MUX_AI_DEPENDENCY_STATUS_CODES.RATE_LIMITED;
  }
  if (status === 425) {
    return MUX_AI_DEPENDENCY_STATUS_CODES.TOO_EARLY;
  }
  if (status >= 500 && status < 600) {
    return MUX_AI_DEPENDENCY_STATUS_CODES.SERVER_ERROR;
  }
  if (status === 401 || status === 403) {
    return MUX_AI_DEPENDENCY_STATUS_CODES.AUTH_REJECTED;
  }
  if (status === 404) {
    return MUX_AI_DEPENDENCY_STATUS_CODES.NOT_FOUND;
  }
  return status >= 400 && status < 500 ? MUX_AI_DEPENDENCY_STATUS_CODES.REQUEST_REJECTED : MUX_AI_DEPENDENCY_STATUS_CODES.OTHER_STATUS;
}

/**
 * Classifies a failed call to a remote service. With a `code` from a per-dependency
 * rule, the code sets the type and source; otherwise the HTTP status does (see
 * {@link classifyDependencyFailure}) and the error gets the status's fallback code.
 * Transient failures are retried by the Workflow step runner; everything else is fatal.
 */
export function dependencyError(message: string, init: RecognizedDependencyErrorInit): MuxAiError {
  const { source, transient, retryable, ...classification } = classifyDependencyFailure(init);
  if (init.code && init.code in MUX_AI_ERROR_CATALOG) {
    const entry: ErrorCatalogEntry<MuxAiErrorType, MuxAiErrorDependency> = MUX_AI_ERROR_CATALOG[init.code as MuxAiErrorCode];
    return new MuxAiError(message, {
      code: init.code,
      type: entry.type,
      source: entry.source,
      dependency: init.dependency,
      facts: classification.facts,
      // The site's override wins, then the code's policy, then the status rules.
      transient: init.transient ?? entry.transient ?? transient,
      ...((init.retryable ?? entry.retryable) !== undefined && { retryable: init.retryable ?? entry.retryable }),
      cause: init.cause,
    } as MuxAiErrorInit);
  }
  // Every source is fine here: the dependency is always named.
  const where: SourceAndDependency<MuxAiErrorDependency> = { source, dependency: init.dependency };
  return new MuxAiError(message, {
    ...classification,
    ...where,
    code: (init.code as MuxAiDependencyStatusCode | undefined) ?? dependencyFailureCode(init),
    transient,
    ...(retryable !== undefined && { retryable }),
    cause: init.cause,
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
