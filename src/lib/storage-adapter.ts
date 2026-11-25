import type {
  StorageAdapter,
  StoragePresignGetObjectInput,
  StoragePutObjectInput,
} from "../types.ts";

import type { ClassifiedErrorsOption } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";
import { createPresignedGetUrl, putObjectToS3 } from "./s3-sigv4.ts";

/**
 * Uploading needs an S3 endpoint and bucket (options or env) and, without a custom
 * storage adapter, S3 keys. The service running the SDK supplies them, so their
 * absence is an `internal` problem. `missing` names the settings, never values.
 */
export function storageNotConfiguredError(missing: string[]): MuxAiError {
  return new MuxAiError(
    "Storage configuration is required for uploading. Provide s3Endpoint and s3Bucket in options " +
    "or set S3_ENDPOINT and S3_BUCKET. If no storageAdapter is supplied, also set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.",
    {
      code: MUX_AI_ERROR_CODES.STORAGE_NOT_CONFIGURED,
      type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
      source: MUX_AI_ERROR_SOURCES.INTERNAL,
      facts: { missing },
    },
  );
}

function requireCredentials(
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
  { classifiedErrors }: ClassifiedErrorsOption = {},
): { accessKeyId: string; secretAccessKey: string } {
  if (!accessKeyId || !secretAccessKey) {
    if (classifiedErrors) {
      throw storageNotConfiguredError(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    }
    throw new Error(
      "S3 credentials are required for default storage operations. " +
      "Provide S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY or pass options.storageAdapter.",
    );
  }

  return { accessKeyId, secretAccessKey };
}

/**
 * Uploads through the caller's storage adapter, or to S3. With `classifiedErrors`, an S3
 * failure is a classified `storage` error (see `storage-errors.ts`); a custom adapter's
 * errors are its own and pass through unchanged.
 */
export async function putObjectWithStorageAdapter(
  input: StoragePutObjectInput,
  adapter?: StorageAdapter,
  options: ClassifiedErrorsOption = {},
): Promise<void> {
  if (adapter) {
    await adapter.putObject(input);
    return;
  }

  const credentials = requireCredentials(input.accessKeyId, input.secretAccessKey, options);
  await putObjectToS3({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    key: input.key,
    body: input.body,
    contentType: input.contentType,
    classifiedErrors: options.classifiedErrors,
  });
}

export async function createPresignedGetUrlWithStorageAdapter(
  input: StoragePresignGetObjectInput,
  adapter?: StorageAdapter,
): Promise<string> {
  if (adapter) {
    return adapter.createPresignedGetUrl(input);
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
    responseContentType: input.responseContentType,
    responseContentDisposition: input.responseContentDisposition,
  });
}
