import { APICallError, DownloadError, NoOutputGeneratedError } from "ai";

/**
 * Retry configuration options
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "shouldRetry">> = {
  maxRetries: 3,
  baseDelay: 2000,
  maxDelay: 10000,
};

/**
 * Default retry condition - retries on transient timeout and download errors
 */
function defaultShouldRetry(error: Error, _attempt: number): boolean {
  if (error.message.includes("Timeout while downloading")) {
    return true;
  }

  // Some models intermittently emit degenerate output (empty or truncated
  // JSON) on an otherwise-healthy request; a fresh sample usually succeeds.
  // Content-policy blocks are converted to MuxAiError before output access,
  // so this never retries a refusal. Match by name as well because durable
  // workflow steps serialize errors, dropping the instance marker.
  if (
    NoOutputGeneratedError.isInstance(error) ||
    error.name === "AI_NoOutputGeneratedError" ||
    error.name === "AI_NoObjectGeneratedError"
  ) {
    return true;
  }

  // AI SDK generation helpers normally retry these internally. Workflows set
  // maxRetries: 0 so content-policy responses can be normalized before any
  // retry, then delegate genuinely transient provider failures here instead.
  if (APICallError.isInstance(error) || error.name === "AI_APICallError") {
    const apiError = error as Error & { isRetryable?: boolean; statusCode?: number };
    if (typeof apiError.isRetryable === "boolean") {
      return apiError.isRetryable;
    }

    return apiError.statusCode === 408 ||
      apiError.statusCode === 409 ||
      apiError.statusCode === 429 ||
      (apiError.statusCode !== undefined && apiError.statusCode >= 500);
  }

  // Durable workflow steps serialize errors, which removes the AI SDK's
  // symbol-based instance marker. Recognize that serialized shape by name so
  // transient download failures remain retryable across step boundaries.
  const isDownloadError = DownloadError.isInstance(error);
  const isSerializedDownloadError = error.name === "AI_DownloadError";

  if (!isDownloadError && !isSerializedDownloadError) {
    return false;
  }

  const statusCode = (error as Error & { statusCode?: number }).statusCode;
  return statusCode === undefined ||
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500;
}

/**
 * Calculates exponential backoff delay with jitter
 */
function calculateDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * 2 ** (attempt - 1);
  const delayWithJitter = exponentialDelay * (0.5 + Math.random() * 0.5);
  return Math.min(delayWithJitter, maxDelay);
}

/**
 * Executes an async function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries,
    baseDelay = DEFAULT_RETRY_OPTIONS.baseDelay,
    maxDelay = DEFAULT_RETRY_OPTIONS.maxDelay,
    shouldRetry = defaultShouldRetry,
  }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryError = error instanceof Error ? error : new Error(String(error));

      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt || !shouldRetry(retryError, attempt + 1)) {
        throw error;
      }

      const delay = calculateDelay(attempt + 1, baseDelay, maxDelay);
      console.warn(
        `Attempt ${attempt + 1} failed: ${retryError.message}. Retrying in ${Math.round(delay)}ms...`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error("Retry failed with unknown error");
}
