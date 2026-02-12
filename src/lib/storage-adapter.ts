import { createPresignedGetUrl, putObjectToS3 } from "@mux/ai/lib/s3-sigv4";
import type {
  StorageAdapter,
  StoragePresignGetObjectInput,
  StoragePutObjectInput,
} from "@mux/ai/types";

function requireCredentials(
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
): { accessKeyId: string; secretAccessKey: string } {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 credentials are required for default storage operations. " +
      "Provide S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY or pass options.storageAdapter.",
    );
  }

  return { accessKeyId, secretAccessKey };
}

export async function putObjectWithStorageAdapter(
  input: StoragePutObjectInput,
  adapter?: StorageAdapter,
): Promise<void> {
  if (adapter) {
    await adapter.putObject(input);
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
  });
}
