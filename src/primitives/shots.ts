import { getMuxClientFromEnv } from "../lib/client-factory";
import { MuxAiError } from "../lib/mux-ai-error";
import type { WorkflowCredentialsInput } from "../types";

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

export type ShotsResult = PendingShotsResult | ErroredShotsResult | CompletedShotsResult;

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

interface PendingShotsApiData {
  status: "pending";
  created_at: string;
}

interface ErroredShotsApiData {
  status: "errored";
  created_at: string;
  error: {
    type: string;
    messages: string[];
  };
}

interface CompletedShotsApiData {
  status: "completed";
  created_at: string;
  shots_manifest_url: string;
}

interface ShotsApiResponse {
  data: PendingShotsApiData | ErroredShotsApiData | CompletedShotsApiData;
}

interface ShotsManifestResponse {
  shots: Array<{
    startTime: number;
    imageUrl: string;
  }>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MIN_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_ATTEMPTS = 60;
const SHOTS_ALREADY_REQUESTED_MESSAGE = "shots generation has already been requested";

function getShotsPath(assetId: string): string {
  return `/video/v1/assets/${assetId}/shots`;
}

function mapManifestShots(
  shots: ShotsManifestResponse["shots"],
): Shot[] {
  return shots.map((shot, index) => {
    const { startTime, imageUrl } = shot;

    if (typeof startTime !== "number" || !Number.isFinite(startTime)) {
      throw new TypeError(`Invalid shot startTime in shots manifest at index ${index}`);
    }

    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw new TypeError(`Invalid shot imageUrl in shots manifest at index ${index}`);
    }

    return {
      startTime,
      imageUrl,
    };
  });
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

async function transformShotsResponse(
  response: ShotsApiResponse,
): Promise<ShotsResult> {
  switch (response.data.status) {
    case "pending":
      return {
        status: "pending",
        createdAt: response.data.created_at,
      };
    case "errored":
      return {
        status: "errored",
        createdAt: response.data.created_at,
        error: response.data.error,
      };
    case "completed":
      return {
        status: "completed",
        createdAt: response.data.created_at,
        shots: await fetchShotsFromManifest(response.data.shots_manifest_url),
      };
    default: {
      const exhaustiveCheck: never = response.data;
      throw new Error(`Unsupported shots response: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isShotsAlreadyRequestedError(error: unknown): boolean {
  const statusCode = (error as any)?.status ?? (error as any)?.statusCode;
  const messages: string[] | undefined = (error as any)?.error?.messages;
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
  const response = await mux.post<ShotsApiResponse>(
    getShotsPath(assetId),
    { body: {} },
  );
  const result = await transformShotsResponse(response);

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
  const response = await mux.get<ShotsApiResponse>(
    getShotsPath(assetId),
  );

  return await transformShotsResponse(response);
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

    if (attempt < normalizedMaxAttempts - 1) {
      await sleep(normalizedPollIntervalMs);
    }
  }

  throw new MuxAiError(
    `Timed out waiting for shots for asset ${assetId}. Last status: ${lastStatus ?? "unknown"}.`,
    { type: "timeout_error", retryable: true },
  );
}
