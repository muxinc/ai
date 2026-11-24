import type { LegacyMuxAiError } from "./legacy-mux-ai-error.ts";
import type { ClassifiedError } from "./mux-ai-error.ts";

/*
 * Duck-typed checks for the SDK's error shapes, shared by every module that needs them. They
 * match a copy from another realm (a Workflow DevKit step's VM) or another copy of the SDK, and
 * this module imports only types, so any module can use them without an import cycle.
 */

/** Whether `value` is any classified error, from this copy of the SDK or another. */
export function isClassifiedError(value: unknown): value is ClassifiedError {
  return (
    typeof value === "object" &&
    value !== null &&
    "__classified_error" in value &&
    value.__classified_error === true
  );
}

/**
 * Whether `value` is a legacy error, whose message is end-user text: a
 * {@link LegacyMuxAiError} from any copy of the SDK, or a consumer's own legacy error
 * with the same fields. Duck-typed, so it also matches one revived across a step boundary.
 */
export function isLegacyMuxAiError(value: unknown): value is LegacyMuxAiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "__robots_error" in value &&
    value.__robots_error === true &&
    typeof (value as { publicMessage?: unknown }).publicMessage === "string"
  );
}

/** How far down a `cause` chain {@link classifiedErrorOf} looks. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The classified error `error` is, or the first one in its `cause` chain.
 *
 * Workflow DevKit doesn't always hand a workflow the error a step threw. Once a step's last
 * attempt fails, it throws a new `FatalError` ("Step "…" failed after N retries: …", or "…
 * exceeded max retries …") with the step's error as its `cause`, so a workflow body that inspects
 * what a step threw sees an unclassified wrapper once a transient failure has used up its retries.
 * Looking down the chain, rather than matching that wrapper's shape or message, also covers any
 * other wrapper that keeps the original as its `cause`.
 *
 * Stops at a legacy error: returns it when it's classified (the SDK's are) and `undefined` when
 * it isn't, so a legacy error is never mistaken for the classified error it wraps. Returns
 * `undefined` for anything else with no classified error within {@link MAX_CAUSE_DEPTH} links.
 * Callers that want the original back use `classifiedErrorOf(error) ?? error`.
 */
export function classifiedErrorOf(error: unknown): ClassifiedError | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null && !seen.has(current); depth += 1) {
    if (isLegacyMuxAiError(current)) {
      return isClassifiedError(current) ? current : undefined;
    }
    if (isClassifiedError(current)) {
      return current;
    }
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
