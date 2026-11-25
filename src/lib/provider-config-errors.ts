import type { ClassifiedErrorsOption } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";

// Failures resolving a model provider and model before any call is made: the provider's
// configuration, or the provider and model the request asked for. Neither is step-retried:
// configuration and request options don't change between attempts, so a retry fails the
// same way.

export type ProviderNotConfiguredReason = "api_key_missing" | "model_missing" | "base_url_missing" | "base_url_unsupported";

/**
 * The provider's key, default model or endpoint URL comes from the service running the SDK
 * (environment variables or workflow credentials), so it's an `internal` problem.
 * `settings` names what configures it, never values.
 */
export function providerNotConfiguredError(
  message: string,
  facts: { provider: string; reason: ProviderNotConfiguredReason; settings: string[] },
): MuxAiError {
  return new MuxAiError(message, {
    code: MUX_AI_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
    source: MUX_AI_ERROR_SOURCES.INTERNAL,
    facts,
  });
}

/** The caller asked for a provider the SDK doesn't support. */
export function providerUnsupportedError(message: string, provider: unknown): MuxAiError {
  return new MuxAiError(message, {
    code: MUX_AI_ERROR_CODES.MODEL_UNSUPPORTED,
    type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
    source: MUX_AI_ERROR_SOURCES.REQUEST,
    // JavaScript callers can pass anything here, so the value is capped.
    facts: { reason: "provider_unsupported", provider: String(provider).slice(0, 100), inputs: ["provider"] },
  });
}

/** The caller asked for a model that has been retired. */
export function modelRetiredError(
  message: string,
  facts: { provider: string; model: string; replacementModel?: string },
): MuxAiError {
  return new MuxAiError(message, {
    code: MUX_AI_ERROR_CODES.MODEL_UNSUPPORTED,
    type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
    source: MUX_AI_ERROR_SOURCES.REQUEST,
    facts: {
      reason: "model_retired",
      provider: facts.provider,
      model: facts.model,
      ...(facts.replacementModel && { replacementModel: facts.replacementModel }),
      inputs: ["model"],
    },
  });
}

/**
 * The error to throw for a provider configuration failure on a path that may not have
 * opted in. Embeddings haven't moved onto classified errors, so without the opt-in the
 * failure stays a plain `Error` with the same message, which the step runner retries,
 * as before (see "Shared helpers opt in per workflow" in docs/ERRORS.md).
 */
export function providerConfigError(error: MuxAiError, { classifiedErrors }: ClassifiedErrorsOption): Error {
  return classifiedErrors ? error : new Error(error.message);
}
