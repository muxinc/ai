import { dependencyError, requestIdOf } from "./dependency-error.ts";
import type { MuxAiError, MuxAiErrorFacts, MuxAiSiteDependencyCode } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES } from "./mux-ai-error.ts";

// Tokens only: S3's free-text <Message> stays in the scrubbed cause summary, not in facts.
const S3_TOKEN = /^[\w.-]{1,64}$/;

/**
 * S3 error codes that name a condition its status alone doesn't, from S3's error code list
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/API_Error.html) and AWS's retry
 * guidance (https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
 * Every other code keeps the status's fallback code, with S3's code as the `s3Code` fact.
 * That includes credential codes (`AccessDenied`, `InvalidAccessKeyId`, …): the storage
 * keys come from the service's configuration, so the status rules' `internal` is right.
 */
const S3_ERROR_CODES: Readonly<Record<string, MuxAiSiteDependencyCode>> = {
  // 503: S3 is scaling to a new request rate; AWS retries it as throttling.
  SlowDown: MUX_AI_ERROR_CODES.PROVIDER_RATE_LIMITED,
};

/** S3's `<Code>` and `<RequestId>` from an XML error body, when they're plain tokens. */
export function s3ErrorDetails(body: string): { s3Code?: string; requestId?: string } {
  const field = (name: string) => {
    const value = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1]?.trim();
    return value && S3_TOKEN.test(value) ? value : undefined;
  };
  const s3Code = field("Code");
  const requestId = field("RequestId");
  return { ...(s3Code && { s3Code }), ...(requestId && { requestId }) };
}

/**
 * A failed S3 request that got a response, classified while the response is in hand:
 * S3's error code decides where it names a condition (see `S3_ERROR_CODES`), and the
 * status otherwise. `RequestTimeout` is a 400 S3 sends when the upload stalled, so it's
 * a timeout (transient), not a request we built wrong. Facts: `call`, `status`,
 * `requestId`, `s3Code`. S3's free text belongs in `cause`, never in `message`: the
 * cause summary is scrubbed of URL tokens, the message isn't.
 */
export function s3ResponseError(message: string, call: string, response: { status: number; headers: unknown }, body: string, facts?: MuxAiErrorFacts, cause?: unknown): MuxAiError {
  const { s3Code, requestId } = s3ErrorDetails(body);
  const code = s3Code ? S3_ERROR_CODES[s3Code] : undefined;
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.STORAGE,
    call,
    status: response.status,
    requestId: requestIdOf(response.headers) ?? requestId,
    timedOut: s3Code === "RequestTimeout",
    facts: { ...(s3Code && { s3Code }), ...facts },
    ...(code && { code }),
    cause,
  });
}

/** An S3 request that got no response (a network failure): transient. */
export function s3NoResponseError(message: string, call: string, cause: unknown, facts?: MuxAiErrorFacts): MuxAiError {
  return dependencyError(message, { dependency: MUX_AI_ERROR_DEPENDENCIES.STORAGE, call, facts, cause });
}
