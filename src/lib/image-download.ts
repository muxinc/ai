import pRetry, { AbortError } from "p-retry";

import { dependencyError, requestIdOf } from "./dependency-error.ts";
import type { MuxAiErrorFacts } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";

const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  if (typeof globalThis.btoa !== "function") {
    throw new TypeError("Base64 encoder is not available in this environment.");
  }
  return globalThis.btoa(binary);
}

export interface ImageDownloadOptions {
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Maximum number of retry attempts (default: 3) */
  retries?: number;
  /** Base delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;
  /** Maximum delay between retries in milliseconds (default: 10000) */
  maxRetryDelay?: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
}

export interface ImageDownloadResult {
  /** Base64 encoded image data with data URI prefix (e.g., "data:image/png;base64,iVBORw0K...") */
  base64Data: string;
  /** Raw image bytes for multipart/form-data uploads */
  buffer: Uint8Array;
  /** Original image URL */
  url: string;
  /** Content type of the downloaded image */
  contentType: string;
  /** Size of the downloaded image in bytes */
  sizeBytes: number;
  /** Number of retry attempts made (0 if successful on first try) */
  attempts: number;
}

export interface AnthropicFileUploadResult {
  /** Anthropic Files API file ID */
  fileId: string;
  /** Original image URL */
  url: string;
  /** Content type of the uploaded image */
  contentType: string;
  /** Size of the uploaded image in bytes */
  sizeBytes: number;
}

const DEFAULT_OPTIONS: Required<ImageDownloadOptions> = {
  timeout: 10000,
  retries: 3,
  retryDelay: 1000,
  maxRetryDelay: 10000,
  exponentialBackoff: true,
};

/**
 * Downloads an image from a URL and converts it to base64 with robust retry logic
 *
 * @param url - The image URL to download
 * @param options - Download configuration options
 * @returns Promise resolving to ImageDownloadResult with base64 data and metadata
 * @throws Error if download fails after all retries
 */
/**
 * The image URLs are Mux storyboards and thumbnails that this library builds, so a
 * failure is a Mux delivery failure: a 404 means the asset has no such image (e.g.
 * not ready or no video), a 401/403 a signing or playback-restriction problem on the
 * Mux account. The URL is left out of the facts: it may carry a signed token.
 */
function imageFetchError(message: string, status: number | undefined, facts: MuxAiErrorFacts, init: { requestId?: string; timedOut?: boolean; cause?: unknown } = {}): MuxAiError {
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
    call: "fetch_image",
    status,
    facts,
    notFoundSource: MUX_AI_ERROR_SOURCES.ASSET,
    authSource: MUX_AI_ERROR_SOURCES.ACCOUNT,
    ...init,
  });
}

/** A successful (200) response that isn't a usable image; a retry would get the same. */
function unusableImageError(message: string, facts: MuxAiErrorFacts): MuxAiError {
  return new MuxAiError(message, {
    type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
    source: MUX_AI_ERROR_SOURCES.UPSTREAM,
    dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
    facts: { call: "fetch_image", status: 200, ...facts },
  });
}

function urlHostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function downloadImageAsBase64(
  url: string,
  options: ImageDownloadOptions = {},
): Promise<ImageDownloadResult> {
  "use step";
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attemptCount = 0;

  return pRetry(
    async () => {
      attemptCount++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeout);

      const facts = { host: urlHostOf(url), attempt: attemptCount };

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "@mux/ai image downloader",
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = imageFetchError(`Failed to download image (HTTP ${response.status})`, response.status, facts, {
            requestId: requestIdOf(response.headers),
          });
          // Don't retry 4xx errors (except 429 rate limiting)
          throw error.transient ? error : new AbortError(error);
        }

        const contentType = response.headers.get("content-type");
        if (!contentType?.startsWith("image/")) {
          throw new AbortError(unusableImageError(`Invalid content type: ${contentType}. Expected image/*`, { ...facts, contentType }));
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);

        if (buffer.length === 0) {
          throw new AbortError(unusableImageError("Downloaded image is empty", facts));
        }

        // Convert to base64 with data URI prefix
        const base64Data = `data:${contentType};base64,${bytesToBase64(buffer)}`;

        return {
          base64Data,
          buffer,
          url,
          contentType,
          sizeBytes: buffer.length,
          attempts: attemptCount,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        // Already classified: non-retryable (AbortError) or retryable (transient).
        if (error instanceof AbortError || MuxAiError.is(error)) {
          throw error;
        }

        // For network errors, timeout errors, etc., throw a retryable error
        if (error instanceof Error && error.name === "AbortError") {
          throw imageFetchError(`Request timeout after ${opts.timeout}ms`, undefined, { ...facts, timeoutMs: opts.timeout }, {
            timedOut: true,
            cause: error,
          });
        }
        throw imageFetchError("Image download failed", undefined, facts, { cause: error });
      }
    },
    {
      retries: opts.retries,
      minTimeout: opts.retryDelay,
      maxTimeout: opts.maxRetryDelay,
      factor: opts.exponentialBackoff ? 2 : 1,
      randomize: true, // Add jitter to prevent thundering herd
      onFailedAttempt: (error) => {
        console.warn(`Image download attempt ${error.attemptNumber} failed for ${url}`);
        if (error.retriesLeft > 0) {
          console.warn(`Retrying... (${error.retriesLeft} attempts left)`);
        }
      },
    },
  );
}

/**
 * Downloads multiple images concurrently with controlled concurrency
 *
 * @param urls - Array of image URLs to download
 * @param options - Download configuration options
 * @param maxConcurrent - Maximum concurrent downloads (default: 5)
 * @returns Promise resolving to array of ImageDownloadResult (in same order as input URLs)
 */
export async function downloadImagesAsBase64(
  urls: string[],
  options: ImageDownloadOptions = {},
  maxConcurrent: number = 5,
): Promise<ImageDownloadResult[]> {
  "use step";
  const results: ImageDownloadResult[] = [];

  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(url => downloadImageAsBase64(url, options));
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Uploads an image to Anthropic Files API for use in messages
 *
 * @param url - The image URL to download and upload
 * @param anthropicApiKey - Anthropic API key
 * @param options - Download configuration options
 * @returns Promise resolving to AnthropicFileUploadResult with file ID and metadata
 * @throws Error if download or upload fails
 */
export async function uploadImageToAnthropicFiles(
  url: string,
  anthropicApiKey: string,
  options: ImageDownloadOptions = {},
): Promise<AnthropicFileUploadResult> {
  "use step";
  // First download the image
  const downloadResult = await downloadImageAsBase64(url, options);

  // Create form data for Files API upload
  const formData = new FormData();

  // Create a Blob from the buffer for form data
  const imageBlob = new Blob([downloadResult.buffer], {
    type: downloadResult.contentType,
  });

  // Get file extension from content type
  const extension = downloadResult.contentType.split("/")[1] || "png";
  formData.append("file", imageBlob, `image.${extension}`);

  // Upload to Anthropic Files API
  const providerFacts = { provider: "anthropic" };
  const response = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
      // Don't set Content-Type header - let fetch set it with boundary for multipart
    },
    body: formData,
  }).catch((error: unknown) => {
    throw dependencyError("Anthropic Files API request failed", {
      dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
      call: "anthropic_upload_file",
      facts: providerFacts,
      cause: error,
    });
  });

  if (!response.ok) {
    // The response body is provider detail; keep it out of the message.
    throw dependencyError(`Anthropic Files API error (HTTP ${response.status})`, {
      dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER,
      call: "anthropic_upload_file",
      status: response.status,
      requestId: requestIdOf(response.headers),
      facts: providerFacts,
    });
  }

  const fileResult = await response.json() as { id: string };

  return {
    fileId: fileResult.id,
    url: downloadResult.url,
    contentType: downloadResult.contentType,
    sizeBytes: downloadResult.sizeBytes,
  };
}
