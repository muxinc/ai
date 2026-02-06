# Storage Adapters

Use `storageAdapter` when you want custom object storage behavior (for example, runtime-specific SDK usage) instead of the built-in SigV4 uploader.

## Why built-in `s3-sigv4` exists

The default storage path uses the internal `s3-sigv4` implementation on purpose.

- It avoids forcing downstream apps to depend on AWS SDK packages.
- It helps prevent CommonJS vs ESM compatibility issues in consumer apps.
- It is designed to work cleanly in edge/Worker-style runtimes that rely on `fetch` and Web Crypto APIs.
- It still supports standard Node runtimes.

`storageAdapter` is an escape hatch for teams that want to use a specific SDK (AWS SDK, MinIO, etc.) while keeping the same workflow APIs.

## Workflow serialization note

If your code runs through Workflow DevKit step boundaries, prefer passing a
serializable storage client via `credentials.storageClient` (similar to
`credentials.muxClient`) instead of passing function closures in `storageAdapter`.

```typescript
import {
  createWorkflowStorageClient,
  workflows,
} from "@mux/ai";

await workflows.translateCaptions(assetId, "en", "es", {
  provider: "openai",
  s3Endpoint: "https://s3.amazonaws.com",
  s3Bucket: "my-bucket",
  credentials: {
    storageClient: createWorkflowStorageClient({
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    }),
  },
});
```

You can still pass `storageAdapter` directly, but `credentials.storageClient` is the most consistent workflow-safe pattern.

## When to use this

- You need a storage SDK that better fits your runtime constraints.
- You want to centralize upload/presign behavior in your own app.
- You still want to use `translateCaptions` and `translateAudio` workflows.

## Adapter contract

`storageAdapter` must implement:

```typescript
import type {
  StorageAdapter,
  StoragePresignGetObjectInput,
  StoragePutObjectInput,
} from "@mux/ai";

const adapter: StorageAdapter = {
  putObject: async (input: StoragePutObjectInput) => {
    // upload logic
  },
  createPresignedGetUrl: async (input: StoragePresignGetObjectInput) => {
    // presign logic
    return "https://...";
  },
};
```

## Using the adapter in workflows

```typescript
import { workflows } from "@mux/ai";

await workflows.translateCaptions(assetId, "en", "es", {
  provider: "openai",
  s3Endpoint: "https://s3.amazonaws.com",
  s3Bucket: "my-bucket",
  storageAdapter: adapter,
});
```

```typescript
import { workflows } from "@mux/ai";

await workflows.translateAudio(assetId, "es", {
  provider: "elevenlabs",
  s3Endpoint: "https://s3.amazonaws.com",
  s3Bucket: "my-bucket",
  storageAdapter: adapter,
});
```

> Note: even with a custom adapter, `s3Endpoint` and `s3Bucket` are still required workflow inputs.

---

## Example: AWS SDK v3 (S3)

```typescript
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageAdapter } from "@mux/ai";

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export const awsS3Adapter: StorageAdapter = {
  putObject: async (input) => {
    await s3.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }));
  },
  createPresignedGetUrl: async (input) => {
    return getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  },
};
```

---

## Example: Cloudflare R2 (S3 API via AWS SDK v3)

R2 is S3-compatible, so you can use the same AWS SDK commands with an R2 endpoint.

```typescript
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageAdapter } from "@mux/ai";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!;

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export const cloudflareR2Adapter: StorageAdapter = {
  putObject: async (input) => {
    await r2.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }));
  },
  createPresignedGetUrl: async (input) => {
    return getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  },
};
```

For Worker-first/edge-only runtimes, verify your chosen signing path is Worker-compatible before using AWS SDK packages.

---

## Example: MinIO SDK (`minio`)

```typescript
import * as Minio from "minio";
import type { StorageAdapter } from "@mux/ai";

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT!, // e.g. "play.min.io"
  port: Number(process.env.MINIO_PORT ?? 443),
  useSSL: (process.env.MINIO_USE_SSL ?? "true") === "true",
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

export const minioAdapter: StorageAdapter = {
  putObject: async (input) => {
    const metaData = input.contentType ? { "Content-Type": input.contentType } : undefined;
    const body = typeof input.body === "string" ? input.body : Buffer.from(input.body);
    await minioClient.putObject(input.bucket, input.key, body, metaData);
  },
  createPresignedGetUrl: async (input) => {
    return minioClient.presignedGetObject(
      input.bucket,
      input.key,
      input.expiresInSeconds,
    );
  },
};
```

---

## Runtime guidance

- **Best default for cross-runtime support:** keep using built-in SigV4 (default behavior when no adapter is provided).
- **Node-first environments:** AWS SDK v3 or MinIO adapters are straightforward.
- **R2 with S3 compatibility:** use the R2 endpoint and `region: "auto"` when using AWS SDK v3.
