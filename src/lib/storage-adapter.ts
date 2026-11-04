import type {
  StorageAdapter,
  StoragePresignGetObjectInput,
  StoragePutObjectInput,
} from "../types.ts";

import { dependencyError, httpStatusOf } from "./dependency-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCY_VALUES, MuxAiError } from "./mux-ai-error.ts";
import { createPresignedGetUrl, putObjectToS3 } from "./s3-sigv4.ts";

function requireCredentials(
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
): { accessKeyId: string; secretAccessKey: string } {
  if (!accessKeyId || !secretAccessKey) {
    throw storageNotConfiguredError([
      ...(!accessKeyId ? ["S3_ACCESS_KEY_ID"] : []),
      ...(!secretAccessKey ? ["S3_SECRET_ACCESS_KEY"] : []),
    ]);
  }

  return { accessKeyId, secretAccessKey };
}

export async function putObjectWithStorageAdapter(
  input: StoragePutObjectInput,
  adapter?: StorageAdapter,
): Promise<void> {
  if (adapter) {
    try {
      await adapter.putObject(input);
    } catch (error) {
      throw adapterError(error, "Failed to upload to storage", "put_object", input.bucket);
    }
    return;
  }

  const credentials = requireCredentials(input.accessKeyId, input.secretAccessKey);
  await putObjectToS3({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    key: input.key,
    body: input.body,
    contentType: input.contentType,
  });
}

export async function createPresignedGetUrlWithStorageAdapter(
  input: StoragePresignGetObjectInput,
  adapter?: StorageAdapter,
): Promise<string> {
  if (adapter) {
    try {
      return await adapter.createPresignedGetUrl(input);
    } catch (error) {
      throw adapterError(error, "Failed to presign a storage URL", "presign_get_object", input.bucket);
    }
  }

  const credentials = requireCredentials(input.accessKeyId, input.secretAccessKey);
  return createPresignedGetUrl({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    key: input.key,
    expiresInSeconds: input.expiresInSeconds,
  });
}

/**
 * Uploading needs an S3 endpoint and bucket (options or env) and, without a custom
 * storage adapter, S3 keys from env. The service running the SDK supplies them, so
 * their absence is an `internal` problem. `missing` names the settings, never values.
 */
export function storageNotConfiguredError(missing: string[]): MuxAiError {
  return new MuxAiError(
    "Storage configuration is required for uploading. Provide s3Endpoint and s3Bucket in options " +
    "or set S3_ENDPOINT and S3_BUCKET. If no storageAdapter is supplied, also set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.",
    { code: MUX_AI_ERROR_CODES.storage_not_configured, facts: { missing } },
  );
}

/**
 * Classifies a failure from a caller-supplied storage adapter, which bypasses the
 * classified S3 client. Reads the status from the error, including the AWS SDK v3
 * shape (`$metadata.httpStatusCode`); without one it's treated as no response.
 */
function adapterError(error: unknown, message: string, call: string, bucket: string): MuxAiError {
  if (MuxAiError.is(error)) {
    return error;
  }
  const awsStatus = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return dependencyError(message, {
    dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.storage,
    call,
    status: httpStatusOf(error) ?? (typeof awsStatus === "number" ? awsStatus : undefined),
    facts: { bucket },
    cause: error,
  });
}
