import { findProviderServiceError } from "./content-policy-error.ts";
import type { ModelCallDiagnostics } from "./mux-ai-error.ts";
import { getErrorTokenUsage } from "./token-usage.ts";

import type { APICallError } from "ai";

/** Log inside the step; never include prompts, model output, headers, or raw causes. */
export function recordModelCallFailure(error: unknown, diagnostics: ModelCallDiagnostics, observedUsage = getErrorTokenUsage(error)): void {
  if (typeof error !== "object" || error === null) {
    return;
  }
  const failure = error as { diagnostics?: ModelCallDiagnostics; finishReason?: string; statusCode?: number };
  // A repair call can be reported before its containing artifact step fails.
  if (failure.diagnostics) {
    return;
  }
  failure.diagnostics = { ...diagnostics };
  // A failure classified where the call failed keeps the provider's own error as its cause.
  const providerError: APICallError | undefined = findProviderServiceError(error);
  const reported = providerError ?? error;
  console.warn("[@mux/ai] Model call failed.", {
    ...diagnostics,
    finishReason: failure.finishReason,
    statusCode: providerError?.statusCode ?? failure.statusCode,
    errorName: reported instanceof Error ? reported.name : undefined,
    requestId: providerError?.responseHeaders?.["x-request-id"] ?? providerError?.responseHeaders?.["request-id"],
    usage: observedUsage,
  });
}

export async function withModelCallDiagnostics<T>(diagnostics: ModelCallDiagnostics, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    recordModelCallFailure(error, diagnostics);
    throw error;
  }
}
