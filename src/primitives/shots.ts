import { getMuxClientFromEnv } from "@mux/ai/lib/client-factory";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

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
  /** Polling interval in milliseconds (default: 2000) */
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
}

interface CompletedShotsApiData {
  status: "completed";
  created_at: string;
  shot_locations: Array<{
    start_time: number;
    image_url: string;
  }>;
}

interface ShotsApiResponse {
  data: PendingShotsApiData | ErroredShotsApiData | CompletedShotsApiData;
}

type RequestShotsApiRequestBody = Record<string, never>;

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 60;
const SHOTS_ALREADY_REQUESTED_MESSAGE = "shots generation has already been requested";

function getShotsPath(assetId: string): string {
  return `/video/v1/assets/${assetId}/shot-locations`;
}

function transformShotsResponse(
  response: ShotsApiResponse,
): ShotsResult {
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
      };
    case "completed":
      return {
        status: "completed",
        createdAt: response.data.created_at,
        shots: response.data.shot_locations.map(shot => ({
          startTime: shot.start_time,
          imageUrl: shot.image_url,
        })),
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
  const response = await mux.post<RequestShotsApiRequestBody, ShotsApiResponse>(
    getShotsPath(assetId),
    { body: {} },
  );
  const result = transformShotsResponse(response);

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
  const response = await mux.get<unknown, ShotsApiResponse>(
    getShotsPath(assetId),
  );

  return transformShotsResponse(response);
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
  const normalizedPollIntervalMs = Math.max(0, pollIntervalMs);
  let lastStatus: ShotsResult["status"] | undefined;

  for (let attempt = 0; attempt < normalizedMaxAttempts; attempt++) {
    const result = await getShotsForAsset(assetId, { credentials });
    lastStatus = result.status;

    if (result.status === "completed") {
      return result;
    }

    if (result.status === "errored") {
      throw new Error(`Shots generation errored for asset '${assetId}'`);
    }

    if (attempt < normalizedMaxAttempts - 1) {
      await sleep(normalizedPollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for shots for asset '${assetId}' after ${normalizedMaxAttempts} attempts. Last status: ${lastStatus ?? "unknown"}`,
  );
}
