import { APICallError } from "ai";

import type { ModelCallDiagnostics } from "./mux-ai-error.ts";
import { getErrorTokenUsage } from "./token-usage.ts";

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
  console.warn("[@mux/ai] Model call failed.", {
    ...diagnostics,
    finishReason: failure.finishReason,
    statusCode: failure.statusCode,
    errorName: error instanceof Error ? error.name : undefined,
    requestId: APICallError.isInstance(error) ? error.responseHeaders?.["x-request-id"] ?? error.responseHeaders?.["request-id"] : undefined,
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
