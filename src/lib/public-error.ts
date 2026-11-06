import type { ClassifiedError, MuxAiErrorCode, MuxAiErrorFacts, MuxAiErrorType } from "./mux-ai-error.ts";
import { isLegacyMuxAiError, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES } from "./mux-ai-error.ts";

/**
 * What end users may see about a failure. `type` and `retryable` are always public;
 * `code` and `facts` only for codes with a public mapping. The error's own `message`
 * never appears here.
 */
export interface PublicError<TType extends string = string, TCode extends string = string> {
  type: TType;
  /** Present only for codes with a public mapping. */
  code?: TCode;
  message: string;
  retryable: boolean;
  /** Only the facts the code's mapping allows. */
  facts?: MuxAiErrorFacts;
}

/** The public view of a `MuxAiError`. */
export type MuxAiPublicError = PublicError<MuxAiErrorType, MuxAiErrorCode>;

/** How one code is shown to end users. */
export interface PublicErrorMapping {
  /** Facts that may reach end users. Every other fact is dropped. */
  facts?: readonly string[];
  /** End-user text, built only from the allowed facts. */
  message: string | ((facts: MuxAiErrorFacts, error: { retryable: boolean }) => string);
}

const TRY_AGAIN = " Please try again.";

/**
 * Wording for a failure whose code has no public mapping (or that has no code):
 * by source for failures the caller can act on, otherwise by type.
 */
export const MUX_AI_ERROR_GENERIC_MESSAGES = {
  request: "The request's parameters can't be used for this operation.",
  asset: "The asset can't be processed by this operation.",
  account: "The Mux account or environment can't be used for this operation.",
  timeout: "The operation timed out.",
  capacity: "A required service is over capacity.",
  contentPolicy: "The content was blocked by a content policy.",
  unavailable: "A required service was temporarily unavailable.",
  failed: "The operation failed.",
} as const;

/**
 * The codes end users may see, and how. A code absent here is internal: it renders
 * through {@link MUX_AI_ERROR_GENERIC_MESSAGES} and its code and facts are dropped.
 * Add a code only when its condition is something an end user can act on or needs
 * to know, and allow only facts that are safe to show (never URLs, credentials,
 * provider internals or model output).
 */
export const MUX_AI_ERROR_PUBLIC_MAPPINGS: Readonly<Partial<Record<MuxAiErrorCode, PublicErrorMapping>>> = {};

/** The SDK's wording for a failure without a public code: by source, then by type. */
export function genericPublicMessage(error: ClassifiedError): string {
  const retry = error.retryable ? TRY_AGAIN : "";
  switch (error.source) {
    case MUX_AI_ERROR_SOURCES.REQUEST:
      return MUX_AI_ERROR_GENERIC_MESSAGES.request;
    case MUX_AI_ERROR_SOURCES.ASSET:
      return `${MUX_AI_ERROR_GENERIC_MESSAGES.asset}${retry}`;
    case MUX_AI_ERROR_SOURCES.ACCOUNT:
      return MUX_AI_ERROR_GENERIC_MESSAGES.account;
  }
  switch (error.type) {
    case MUX_AI_ERROR_TYPES.TIMEOUT_ERROR:
      return `${MUX_AI_ERROR_GENERIC_MESSAGES.timeout}${retry}`;
    case MUX_AI_ERROR_TYPES.CAPACITY_ERROR:
      return `${MUX_AI_ERROR_GENERIC_MESSAGES.capacity}${retry}`;
    case MUX_AI_ERROR_TYPES.CONTENT_POLICY_ERROR:
      return MUX_AI_ERROR_GENERIC_MESSAGES.contentPolicy;
    default:
      return error.retryable ? `${MUX_AI_ERROR_GENERIC_MESSAGES.unavailable}${TRY_AGAIN}` : MUX_AI_ERROR_GENERIC_MESSAGES.failed;
  }
}

function allowedFacts(facts: MuxAiErrorFacts | undefined, allowed: readonly string[] | undefined): MuxAiErrorFacts | undefined {
  if (!facts || !allowed?.length) {
    return undefined;
  }
  const picked = Object.fromEntries(allowed.filter(key => facts[key] !== undefined).map(key => [key, facts[key]]));
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * Builds the end-user view for errors on the shared model ({@link ClassifiedError}):
 * a code with a public mapping keeps its code and allowed facts and renders the
 * mapping's text; anything else renders `genericMessage`. Never includes the error's
 * own `message`, except for a legacy error (raised before classification), whose
 * message is end-user text and is shown as it always was. Consumers build one with their own mappings (which may include the
 * SDK's) and their own generic wording.
 */
export function createPublicErrorView<TType extends string, TCode extends string>(config: {
  mappings: Readonly<Partial<Record<TCode, PublicErrorMapping>>>;
  genericMessage: (error: ClassifiedError<TType, TCode>) => string;
}): (error: ClassifiedError<TType, TCode>) => PublicError<TType, TCode> {
  return (error) => {
    // Raised before classification: its message is end-user text (see LegacyMuxAiError).
    if (isLegacyMuxAiError(error)) {
      return { type: error.publicType as string as TType, message: error.publicMessage, retryable: error.retryable };
    }
    const mapping: PublicErrorMapping | undefined = error.code ? config.mappings[error.code] : undefined;
    if (!mapping) {
      return { type: error.type, message: config.genericMessage(error), retryable: error.retryable };
    }
    const facts = allowedFacts(error.facts, mapping.facts);
    return {
      type: error.type,
      code: error.code,
      message: typeof mapping.message === "string" ? mapping.message : mapping.message(facts ?? {}, error),
      retryable: error.retryable,
      ...(facts && { facts }),
    };
  };
}

/** The end-user view of a `MuxAiError`, with the SDK's public mappings and generic wording. */
export const toPublicError: (error: ClassifiedError<MuxAiErrorType, MuxAiErrorCode>) => MuxAiPublicError = createPublicErrorView<MuxAiErrorType, MuxAiErrorCode>({
  mappings: MUX_AI_ERROR_PUBLIC_MAPPINGS,
  genericMessage: genericPublicMessage,
});
