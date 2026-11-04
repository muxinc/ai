import { getMuxClientFromEnv } from "../lib/client-factory.ts";
import { dependencyError, dependencyErrorFrom, httpStatusOf, requestIdOf } from "../lib/dependency-error.ts";
import type { MuxAiErrorFacts } from "../lib/mux-ai-error.ts";
import { MUX_AI_ERROR_DEPENDENCIES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "../lib/mux-ai-error.ts";
import type { WorkflowCredentialsInput } from "../types.ts";

import type { AssetShots } from "@mux/ts/resources/video/assets";

export interface Shot {
  /** Start time of the shot in seconds from the beginning of the asset. */
  startTime: number;
  /** Signed URL for a representative image of the shot. */
  imageUrl: string;
}

export interface PendingShotsResult {
  status: "pending";
  createdAt: string;
}

export interface ErroredShotsResult {
  status: "errored";
  createdAt: string;
  error: {
    type: string;
    messages: string[];
  };
}

export interface CompletedShotsResult {
  status: "completed";
  createdAt: string;
  shots: Shot[];
}

/** Mux declined to run shot detection, e.g. the asset has no video track. */
export interface SkippedShotsResult {
  status: "skipped";
  createdAt: string;
}

export interface DeletedShotsResult {
  status: "deleted";
  createdAt: string;
}

export type ShotsResult = PendingShotsResult | ErroredShotsResult | CompletedShotsResult | SkippedShotsResult | DeletedShotsResult;

export interface ShotRequestOptions {
  /** Optional workflow credentials */
  credentials?: WorkflowCredentialsInput;
}

export interface WaitForShotsOptions extends ShotRequestOptions {
  /** Polling interval in milliseconds (default: 2000, minimum enforced: 1000) */
  pollIntervalMs?: number;
  /** Maximum number of polling attempts (default: 60) */
  maxAttempts?: number;
  /** When true, request shot generation before polling (default: true) */
  createIfMissing?: boolean;
}

interface ShotsManifestResponse {
  shots: Array<{
    start_time: number;
    shot_preview_image_url?: string;
    /** @deprecated Replaced by shot_preview_image_url. Will be removed in a future manifest version. */
    image_url?: string;
  }>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MIN_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_ATTEMPTS = 60;
const SHOTS_ALREADY_REQUESTED_MESSAGE = "shots generation has already been requested";
const SHOTS_ALREADY_REQUESTED_REASON = "shots_already_requested";

/** Mux answered, but with a shots payload we can't use. */
function malformedShotsError(message: string, call: string, facts?: MuxAiErrorFacts): MuxAiError {
  return new MuxAiError(message, {
    type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
    source: MUX_AI_ERROR_SOURCES.UPSTREAM,
    dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
    facts: { call, ...facts },
  });
}

function mapManifestShots(
  shots: ShotsManifestResponse["shots"],
): Shot[] {
  let usedDeprecatedField = false;

  const mapped = shots.map((shot, index) => {
    const { start_time: startTime } = shot;
    const imageUrl = shot.shot_preview_image_url ?? shot.image_url;

    if (shot.shot_preview_image_url === undefined && shot.image_url !== undefined) {
      usedDeprecatedField = true;
    }

    if (typeof startTime !== "number" || !Number.isFinite(startTime)) {
      throw malformedShotsError(`Invalid shot start_time in shots manifest at index ${index}`, "fetch_shots_manifest", { index });
    }

    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw malformedShotsError(`Invalid shot shot_preview_image_url in shots manifest at index ${index}`, "fetch_shots_manifest", { index });
    }

    return {
      startTime,
      imageUrl,
    };
  });

  if (usedDeprecatedField) {
    console.warn(
      "The 'image_url' field in the Mux shots manifest is deprecated and will be removed. Use 'shot_preview_image_url' instead.",
    );
  }

  return mapped;
}

async function fetchShotsFromManifest(
  shotsManifestUrl: string,
): Promise<Shot[]> {
  const call = "fetch_shots_manifest";
  let response: Response;
  try {
    response = await fetch(shotsManifestUrl);
  } catch (error) {
    throw dependencyError("Failed to fetch shots manifest", {
      dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
      call,
      cause: error,
    });
  }

  if (!response.ok) {
    throw dependencyError(`Failed to fetch shots manifest (HTTP ${response.status})`, {
      dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
      call,
      status: response.status,
      requestId: requestIdOf(response.headers),
      notFoundSource: MUX_AI_ERROR_SOURCES.ASSET,
      authSource: MUX_AI_ERROR_SOURCES.ACCOUNT,
    });
  }

  let manifest: ShotsManifestResponse;
  try {
    manifest = await response.json() as ShotsManifestResponse;
  } catch (error) {
    throw dependencyError("Failed to read shots manifest", {
      dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
      call,
      // The body failed mid-read or wasn't JSON: treated as no response, so transient.
      cause: error,
    });
  }

  if (!Array.isArray(manifest?.shots)) {
    throw malformedShotsError("Invalid shots manifest response: missing shots array", call);
  }

  return mapManifestShots(manifest.shots);
}

async function transformShotsResponse(data: AssetShots): Promise<ShotsResult> {
  switch (data.status) {
    case "pending":
    case "skipped":
    case "deleted":
      return {
        status: data.status,
        createdAt: data.created_at,
      };
    case "errored":
      return {
        status: "errored",
        createdAt: data.created_at,
        error: {
          type: data.errors?.type ?? "unknown",
          messages: data.errors?.messages ?? [],
        },
      };
    case "completed":
      if (!data.shots_manifest_url) {
        throw malformedShotsError("Completed shots response is missing shots_manifest_url", "get_shots");
      }
      return {
        status: "completed",
        createdAt: data.created_at,
        shots: await fetchShotsFromManifest(data.shots_manifest_url),
      };
    default:
      throw malformedShotsError(`Unsupported shots status '${data.status}'`, "get_shots", {
        shotsStatus: String(data.status),
      });
  }
}

/** A failed Mux Video API call: a 404 means the caller's asset ID doesn't exist. */
function muxShotsApiError(error: unknown, message: string, call: string, assetId: string): MuxAiError {
  return dependencyErrorFrom(error, message, {
    dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
    call,
    facts: { assetId },
    notFoundSource: MUX_AI_ERROR_SOURCES.REQUEST,
    authSource: MUX_AI_ERROR_SOURCES.ACCOUNT,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isShotsAlreadyRequestedError(error: unknown): boolean {
  if (MuxAiError.is(error)) {
    return error.facts.reason === SHOTS_ALREADY_REQUESTED_REASON;
  }
  const statusCode = (error as any)?.status ?? (error as any)?.statusCode;
  const body = (error as any)?.error;
  const messages: string[] | undefined = body?.error?.messages ?? body?.messages;
  const lowerCaseMessages = messages?.map(message => message.toLowerCase()) ?? [];
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : "";

  return statusCode === 400 &&
    (lowerCaseMessages.some(message => message.includes(SHOTS_ALREADY_REQUESTED_MESSAGE)) ||
      errorMessage.includes(SHOTS_ALREADY_REQUESTED_MESSAGE));
}

/**
 * Starts generating shots for an asset.
 *
 * @param assetId - The Mux asset ID
 * @param options - Request options
 * @returns Pending shot generation state
 */
export async function requestShotsForAsset(
  assetId: string,
  options: ShotRequestOptions = {},
): Promise<PendingShotsResult> {
  "use step";
  const { credentials } = options;
  const muxClient = await getMuxClientFromEnv(credentials);
  const mux = await muxClient.createClient();
  let data: AssetShots;
  try {
    data = await mux.video.assets.generateShots(assetId, {});
  } catch (error) {
    if (isShotsAlreadyRequestedError(error)) {
      throw new MuxAiError(`Shots have already been requested for asset ${assetId}.`, {
        type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
        source: MUX_AI_ERROR_SOURCES.REQUEST,
        dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
        facts: { call: "request_shots", status: httpStatusOf(error) ?? 400, assetId, reason: SHOTS_ALREADY_REQUESTED_REASON },
        cause: error,
      });
    }
    throw muxShotsApiError(error, "Failed to request shots", "request_shots", assetId);
  }
  const result = await transformShotsResponse(data);

  if (result.status !== "pending") {
    throw malformedShotsError(
      `Expected pending status after requesting shots for asset '${assetId}', received '${result.status}'`,
      "request_shots",
      { assetId, shotsStatus: result.status },
    );
  }

  return result;
}

/**
 * Gets the current shot generation status for an asset.
 *
 * @param assetId - The Mux asset ID
 * @param options - Request options
 * @returns Pending, errored, or completed shot result
 */
export async function getShotsForAsset(
  assetId: string,
  options: ShotRequestOptions = {},
): Promise<ShotsResult> {
  "use step";
  const { credentials } = options;
  const muxClient = await getMuxClientFromEnv(credentials);
  const mux = await muxClient.createClient();
  let data: AssetShots;
  try {
    data = await mux.video.assets.retrieveShots(assetId);
  } catch (error) {
    throw muxShotsApiError(error, "Failed to get shots", "get_shots", assetId);
  }

  return await transformShotsResponse(data);
}

/**
 * Requests shot generation if needed and polls until shots are completed.
 *
 * @param assetId - The Mux asset ID
 * @param options - Polling options
 * @returns Completed shot result
 */
export async function waitForShotsForAsset(
  assetId: string,
  options: WaitForShotsOptions = {},
): Promise<CompletedShotsResult> {
  "use step";
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    createIfMissing = true,
    credentials,
  } = options;

  if (createIfMissing) {
    try {
      await requestShotsForAsset(assetId, { credentials });
    } catch (error) {
      if (!isShotsAlreadyRequestedError(error)) {
        throw error;
      }
    }
  }

  const normalizedMaxAttempts = Math.max(1, maxAttempts);
  const normalizedPollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs);
  let lastStatus: ShotsResult["status"] | undefined;

  for (let attempt = 0; attempt < normalizedMaxAttempts; attempt++) {
    const result = await getShotsForAsset(assetId, { credentials });
    lastStatus = result.status;

    if (result.status === "completed") {
      return result;
    }

    if (result.status === "errored") {
      throw new MuxAiError(`Shot generation failed for asset ${assetId}.`, {
        type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR,
        source: MUX_AI_ERROR_SOURCES.UPSTREAM,
        dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
        // Mux answered (200) with its own job errored; repeating the poll gets the same.
        facts: { call: "get_shots", status: 200, assetId, shotsStatus: result.status, errorType: result.error.type },
        // Not retryable: a new job finds shots already requested and sees the same errored state.
        retryable: false,
      });
    }

    if (result.status === "skipped") {
      throw new MuxAiError(
        `Shot generation was skipped for asset ${assetId}; the asset may have no video track.`,
        {
          type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
          source: MUX_AI_ERROR_SOURCES.ASSET,
          facts: { assetId, shotsStatus: result.status },
        },
      );
    }

    if (result.status === "deleted") {
      throw new MuxAiError(`Shots for asset ${assetId} have been deleted.`, {
        type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
        source: MUX_AI_ERROR_SOURCES.ASSET,
        facts: { assetId, shotsStatus: result.status },
      });
    }

    if (attempt < normalizedMaxAttempts - 1) {
      await sleep(normalizedPollIntervalMs);
    }
  }

  throw new MuxAiError(
    `Timed out waiting for shots for asset ${assetId}. Last status: ${lastStatus ?? "unknown"}.`,
    {
      type: MUX_AI_ERROR_TYPES.TIMEOUT_ERROR,
      source: MUX_AI_ERROR_SOURCES.UPSTREAM,
      dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO,
      facts: {
        call: "get_shots",
        assetId,
        lastStatus: lastStatus ?? null,
        attempts: normalizedMaxAttempts,
        pollIntervalMs: normalizedPollIntervalMs,
      },
      // Not transient: this already polled for the whole budget.
      transient: false,
    },
  );
}
