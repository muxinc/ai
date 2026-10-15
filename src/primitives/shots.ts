import { getMuxClientFromEnv } from "../lib/client-factory.ts";
import { MuxAiError } from "../lib/mux-ai-error.ts";
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
      throw new TypeError(`Invalid shot start_time in shots manifest at index ${index}`);
    }

    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw new TypeError(`Invalid shot shot_preview_image_url in shots manifest at index ${index}`);
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
  const response = await fetch(shotsManifestUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch shots manifest: ${response.status} ${response.statusText}`,
    );
  }

  const manifest = await response.json() as ShotsManifestResponse;

  if (!Array.isArray(manifest.shots)) {
    throw new TypeError("Invalid shots manifest response: missing shots array");
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
        throw new Error("Completed shots response is missing shots_manifest_url");
      }
      return {
        status: "completed",
        createdAt: data.created_at,
        shots: await fetchShotsFromManifest(data.shots_manifest_url),
      };
    default:
      throw new Error(`Unsupported shots status '${data.status}'`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isShotsAlreadyRequestedError(error: unknown): boolean {
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
  const data = await mux.video.assets.generateShots(assetId, {});
  const result = await transformShotsResponse(data);

  if (result.status !== "pending") {
    throw new Error(
      `Expected pending status after requesting shots for asset '${assetId}', received '${result.status}'`,
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
  const data = await mux.video.assets.retrieveShots(assetId);

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
      throw new MuxAiError(`Shot generation failed for asset ${assetId}.`);
    }

    if (result.status === "skipped") {
      throw new MuxAiError(
        `Shot generation was skipped for asset ${assetId}; the asset may have no video track.`,
        { type: "validation_error" },
      );
    }

    if (result.status === "deleted") {
      throw new MuxAiError(`Shots for asset ${assetId} have been deleted.`, { type: "validation_error" });
    }

    if (attempt < normalizedMaxAttempts - 1) {
      await sleep(normalizedPollIntervalMs);
    }
  }

  throw new MuxAiError(
    `Timed out waiting for shots for asset ${assetId}. Last status: ${lastStatus ?? "unknown"}.`,
    { type: "timeout_error", retryable: true },
  );
}
