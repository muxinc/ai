import pRetry, { AbortError } from "p-retry";

import { requestIdOf } from "./dependency-error.ts";
import type { ClassifiedErrorsOption } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";
import { muxVideoError } from "./mux-video-errors.ts";

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

/**
 * Opts a download in to classified errors. Every caller downloads a Mux image (a
 * storyboard or thumbnail), so failures are Mux Video's, named by `call`.
 */
export interface ImageDownloadErrorOptions extends ClassifiedErrorsOption {
  /** The `call` fact on a classified failure (default `fetch_image`). */
  call?: string;
}

/** What the last attempt saw, for the classified error once retries run out. */
type ImageDownloadFailure =
  | { kind: "status"; status: number; requestId?: string } |
  { kind: "invalid"; reason: "not_image" | "empty"; contentType?: string } |
  { kind: "no_response"; timedOut: boolean };

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
 * @param errorOptions - Opts in to classified errors (see {@link ImageDownloadErrorOptions})
 * @returns Promise resolving to ImageDownloadResult with base64 data and metadata
 * @throws Error if download fails after all retries
 */
export async function downloadImageAsBase64(
  url: string,
  options: ImageDownloadOptions = {},
  errorOptions: ImageDownloadErrorOptions = {},
): Promise<ImageDownloadResult> {
  "use step";
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attemptCount = 0;
  let failure: ImageDownloadFailure | undefined;

  return pRetry(
    async () => {
      attemptCount++;
      failure = undefined;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeout);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "@mux/ai image downloader",
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          failure = { kind: "status", status: response.status, requestId: requestIdOf(response.headers) };
          // Don't retry 4xx errors (except 429 rate limiting)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new AbortError(`HTTP ${response.status}: ${response.statusText}`);
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type");
        if (!contentType?.startsWith("image/")) {
          failure = { kind: "invalid", reason: "not_image", ...(contentType && { contentType: contentType.slice(0, 100) }) };
          throw new AbortError(`Invalid content type: ${contentType}. Expected image/*`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);

        if (buffer.length === 0) {
          failure = { kind: "invalid", reason: "empty" };
          throw new AbortError("Downloaded image is empty");
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

        // If it's an AbortError (non-retryable), re-throw it
        if (error instanceof AbortError) {
          throw error;
        }

        // For network errors, timeout errors, etc., wrap in retryable error
        failure ??= { kind: "no_response", timedOut: error instanceof Error && error.name === "AbortError" };
        if (error instanceof Error) {
          if (error.name === "AbortError") {
            throw new Error(`Request timeout after ${opts.timeout}ms`);
          }
          throw new Error(`Download failed: ${error.message}`);
        }

        throw new Error("Unknown download error");
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
  ).catch((error: unknown) => {
    if (!errorOptions.classifiedErrors) {
      throw error;
    }
    throw imageDownloadError(failure, errorOptions.call ?? "fetch_image", error);
  });
}

/**
 * The classified error for a download whose retries ran out. The URL may carry a
 * signed token, so it stays out of the message and facts.
 */
function imageDownloadError(failure: ImageDownloadFailure | undefined, call: string, cause: unknown): MuxAiError {
  if (failure?.kind === "status") {
    return muxVideoError(`Failed to download image from Mux (HTTP ${failure.status})`, {
      call,
      status: failure.status,
      requestId: failure.requestId,
    });
  }
  if (failure?.kind === "invalid") {
    return new MuxAiError(
      failure.reason === "empty" ? "Mux returned an empty image." : `Mux returned ${failure.contentType ?? "no content type"} instead of an image.`,
      {
        code: MUX_AI_ERROR_CODES.IMAGE_RESPONSE_INVALID,
        type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
        source: MUX_AI_ERROR_SOURCES.UPSTREAM,
        dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
        facts: { call, reason: failure.reason, ...(failure.contentType && { contentType: failure.contentType }) },
      },
    );
  }
  // No response (a network failure or the timeout): transient.
  return muxVideoError(
    failure?.timedOut ? "Image download from Mux timed out" : "Failed to download image from Mux",
    { call, cause },
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
  const response = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
      // Don't set Content-Type header - let fetch set it with boundary for multipart
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic Files API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const fileResult = await response.json() as { id: string };

  return {
    fileId: fileResult.id,
    url: downloadResult.url,
    contentType: downloadResult.contentType,
    sizeBytes: downloadResult.sizeBytes,
  };
}
