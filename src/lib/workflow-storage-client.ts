import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

import {
  createPresignedGetUrl,
  putObjectToS3,
} from "@mux/ai/lib/s3-sigv4";
import type {
  StoragePresignGetObjectInput,
  StoragePutObjectInput,
} from "@mux/ai/types";

export interface WorkflowStorageClientOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * Serializable storage client wrapper for workflow boundaries.
 *
 * By default, this uses the internal SigV4 implementation to keep object
 * operations compatible across edge/ESM and Node runtimes.
 */
export class WorkflowStorageClient {
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;

  constructor(options: WorkflowStorageClientOptions = {}) {
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
  }

  private resolveCredentials(input: {
    accessKeyId?: string;
    secretAccessKey?: string;
  }): { accessKeyId: string; secretAccessKey: string } {
    const accessKeyId = input.accessKeyId ?? this.accessKeyId;
    const secretAccessKey = input.secretAccessKey ?? this.secretAccessKey;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "Storage credentials are required. " +
        "Provide accessKeyId/secretAccessKey in WorkflowStorageClient options " +
        "or in the storage operation input.",
      );
    }

    return { accessKeyId, secretAccessKey };
  }

  async putObject(input: StoragePutObjectInput): Promise<void> {
    const credentials = this.resolveCredentials(input);
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

  async createPresignedGetUrl(input: StoragePresignGetObjectInput): Promise<string> {
    const credentials = this.resolveCredentials(input);
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

  static [WORKFLOW_SERIALIZE](instance: WorkflowStorageClient): WorkflowStorageClientOptions {
    return {
      accessKeyId: instance.accessKeyId,
      secretAccessKey: instance.secretAccessKey,
    };
  }

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowStorageClient, value: WorkflowStorageClientOptions): WorkflowStorageClient {
    return new this(value);
  }
}

function isSerializedWorkflowStorageClient(value: unknown): value is WorkflowStorageClientOptions {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as WorkflowStorageClientOptions;
  return "accessKeyId" in candidate || "secretAccessKey" in candidate;
}

export function normalizeWorkflowStorageClient(value: unknown): WorkflowStorageClient | undefined {
  if (value instanceof WorkflowStorageClient) {
    return value;
  }

  if (isSerializedWorkflowStorageClient(value)) {
    return new WorkflowStorageClient(value);
  }

  return undefined;
}

export function createWorkflowStorageClient(
  options: WorkflowStorageClientOptions = {},
): WorkflowStorageClient {
  return new WorkflowStorageClient(options);
}
