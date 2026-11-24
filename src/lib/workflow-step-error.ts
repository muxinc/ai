/**
 * When a step's last attempt fails, Workflow DevKit doesn't rethrow the step's error into the
 * workflow: it throws a new `FatalError` ("Step "…" failed after N retries: …", or "… exceeded
 * max retries …") with the step's error as its `cause`. A workflow body that inspects what a step
 * threw (its code, facts, retryability or token usage) sees that wrapper, not the error, once a
 * transient failure has used up its retries.
 *
 * Returns the classified error inside such a wrapper, and anything else unchanged: an error
 * that is itself classified (including a non-transient one, which is named `FatalError` too and
 * isn't retried), a legacy error, a wrapper whose cause isn't classified, or any other value.
 *
 * The wrapper is recognized by shape (a `FatalError` that isn't classified, with a classified
 * `cause`), not by Workflow DevKit's message text, which isn't part of its API.
 */
export function unwrapWorkflowStepError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || isClassified(error) || isLegacy(error)) {
    return error;
  }
  const { name, cause } = error as { name?: unknown; cause?: unknown };
  return name === "FatalError" && isClassified(cause) ? cause : error;
}

// Duck-typed, as `ClassifiedError.isClassified()` is, so a copy from another realm (a step's VM)
// matches, and so this module imports nothing.
function isClassified(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { __classified_error?: unknown }).__classified_error === true;
}

function isLegacy(value: object): boolean {
  return (value as { __robots_error?: unknown }).__robots_error === true;
}
