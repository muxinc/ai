import { APICallError } from "ai";

import type { ModelCallDiagnostics } from "./mux-ai-error.ts";
import { MuxAiError } from "./mux-ai-error.ts";
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
  // A provider failure arrives classified (status and request id in its facts) or raw.
  const facts = MuxAiError.is(error) ? error.facts : undefined;
  console.warn("[@mux/ai] Model call failed.", {
    ...diagnostics,
    finishReason: failure.finishReason,
    statusCode: typeof facts?.status === "number" ? facts.status : failure.statusCode,
    errorName: error instanceof Error ? error.name : undefined,
    requestId: typeof facts?.requestId === "string" ?
      facts.requestId :
      APICallError.isInstance(error) ? error.responseHeaders?.["x-request-id"] ?? error.responseHeaders?.["request-id"] : undefined,
    ...(MuxAiError.is(error) && { source: error.source, ...(error.code && { code: error.code }) }),
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
