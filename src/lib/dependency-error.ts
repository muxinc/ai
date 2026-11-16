import type { ErrorCatalogEntry, MuxAiDependencyStatusCode, MuxAiErrorDependency, MuxAiErrorFacts, MuxAiErrorInit, MuxAiErrorSource, MuxAiErrorType, MuxAiSiteDependencyCode } from "./mux-ai-error.ts";
import { isTransientStatus, MUX_AI_DEPENDENCY_STATUS_CODES, MUX_AI_ERROR_CATALOG, MUX_AI_ERROR_CODES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";

export interface DependencyErrorInit {
  dependency: MuxAiErrorDependency;
  /** Snake_case name of the outside call, e.g. `fetch_transcript`. */
  call: string;
  /** HTTP status, when there was a response. */
  status?: number;
  requestId?: string;
  facts?: MuxAiErrorFacts;
  cause?: unknown;
  /**
   * Source for a 404. Defaults to `internal` (we built the request). `asset` when the
   * call was for something belonging to the asset: `dependencyError` codes it
   * `asset_resource_not_found`. Only sources with a code; `classifyDependencyFailure`
   * takes any (see {@link DependencyFailureInit}).
   */
  notFoundSource?: typeof MUX_AI_ERROR_SOURCES.INTERNAL | typeof MUX_AI_ERROR_SOURCES.ASSET;
  /**
   * Source for a 401/403. Defaults to `internal` (our own credentials). `account` when
   * the call used the caller's Mux credentials: `dependencyError` codes it
   * `account_credentials_rejected`. Only sources with a code, as for `notFoundSource`.
   */
  authSource?: typeof MUX_AI_ERROR_SOURCES.INTERNAL | typeof MUX_AI_ERROR_SOURCES.ACCOUNT;
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
   * The code sets the type and source, and its own retry policy wins over the status
   * rules. Only codes whose site names the dependency, so the error can't contradict the
   * catalog's dependency. A fallback code a status can't express is passed the same way,
   * e.g. `dependency_response_failed` for a dependency that answered with an error of its
   * own. Without one, the error gets the status's fallback code (see
   * {@link dependencyFailureCode}).
   */
  code?: MuxAiSiteDependencyCode;
}

/**
 * What {@link classifyDependencyFailure} reads: {@link DependencyErrorInit}'s fields, with
 * any source for a 404 or 401/403, for consumers classifying failures on their own catalogs.
 */
export type DependencyFailureInit = Pick<DependencyErrorInit, "call" | "status" | "requestId" | "facts" | "authInputs" | "timedOut" | "idempotent" | "transient" | "retryable"> & {
  notFoundSource?: MuxAiErrorSource;
  authSource?: MuxAiErrorSource;
};

export { isTransientStatus };

/**
 * The classification of a failed call to a remote service, from its HTTP status:
 * no response, a timeout, 408/425/429 and 5xx are `upstream` and transient (408 and
 * timeouts as `timeout_error`, 429 as `capacity_error`); 404 and 401/403 take the
 * caller's chosen source; any other status is `internal`, a request we built. Shared
 * by {@link dependencyError} and by consumers building their own errors on the same
 * model, so remote failures are classified the same way everywhere.
 */
export function classifyDependencyFailure(init: DependencyFailureInit): {
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

/** The code for a 404 or 401/403 whose source the site chose (see `notFoundSource`, `authSource`). */
function attributedFailureCode({ status, timedOut, notFoundSource, authSource }: DependencyErrorInit): MuxAiSiteDependencyCode | undefined {
  if (timedOut) {
    return undefined;
  }
  if (status === 404 && notFoundSource === MUX_AI_ERROR_SOURCES.ASSET) {
    return MUX_AI_ERROR_CODES.ASSET_RESOURCE_NOT_FOUND;
  }
  if ((status === 401 || status === 403) && authSource === MUX_AI_ERROR_SOURCES.ACCOUNT) {
    return MUX_AI_ERROR_CODES.ACCOUNT_CREDENTIALS_REJECTED;
  }
  return undefined;
}

/**
 * Classifies a failed call to a remote service. Every failure gets a code, and the code
 * sets the type and source: the site's `code` from a per-dependency rule; else the code
 * for a source the site chose for a 404 or 401/403; else the status's fallback code
 * (see {@link dependencyFailureCode}). Transient failures are retried by the Workflow
 * step runner; everything else is fatal.
 */
export function dependencyError(message: string, init: RecognizedDependencyErrorInit): MuxAiError {
  const { facts, transient } = classifyDependencyFailure(init);
  const code = init.code ?? attributedFailureCode(init) ?? dependencyFailureCode(init);
  const entry: ErrorCatalogEntry<MuxAiErrorType, MuxAiErrorDependency> = MUX_AI_ERROR_CATALOG[code];
  // A call that isn't idempotent may have taken effect after a timeout, no response or a 5xx.
  const mayHaveTakenEffect = init.timedOut === true ||
    (init.status === undefined ? code === MUX_AI_ERROR_CODES.DEPENDENCY_NO_RESPONSE : init.status >= 500);
  const retryable = init.retryable ?? entry.retryable;
  return new MuxAiError(message, {
    code,
    type: entry.type,
    source: entry.source,
    dependency: init.dependency,
    facts,
    // The site's override wins, then a non-idempotent call that may have taken effect,
    // then the code's policy, then the status rules. A code other than no response or a
    // timeout means the dependency answered, so a missing status isn't "no response" here.
    transient: init.transient ??
      (init.idempotent === false && mayHaveTakenEffect ? false : undefined) ??
      entry.transient ??
      (init.status === undefined && !init.timedOut ? false : transient),
    ...(retryable !== undefined && { retryable }),
    cause: init.cause,
  } as MuxAiErrorInit);
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
