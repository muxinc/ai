/**
 * Retry configuration options
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'shouldRetry'>> = {
  maxRetries: 3,
  baseDelay: 2000,
  maxDelay: 10000,
};

/**
 * Default retry condition - retries on timeout errors
 */
function defaultShouldRetry(error: Error, attempt: number): boolean {
  return Boolean(error.message && error.message.includes('Timeout while downloading'));
}

/**
 * Calculates exponential backoff delay with jitter
 */
function calculateDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
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
    shouldRetry = defaultShouldRetry
  }: RetryOptions = {}
): Promise<T> {

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt || !shouldRetry(lastError, attempt + 1)) {
        throw lastError;
      }

      const delay = calculateDelay(attempt + 1, baseDelay, maxDelay);
      console.warn(
        `Attempt ${attempt + 1} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Retry failed with unknown error');
}
