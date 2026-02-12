# Workflow Encryption

Use workflow encryption when running `@mux/ai` workflows with Workflow DevKit and passing per-request credentials.

Workflow DevKit serializes workflow inputs/outputs for observability. If you pass plaintext credentials in `start(...)`, those values may cross workflow serialization boundaries. Encryption keeps credential values opaque while in transit.

## When to use this

Use encryption when:

- You call workflows through `start(...)`
- You pass per-tenant or per-request credentials
- You do not want plaintext secrets in workflow input payloads

You can still use environment variables and/or `setWorkflowCredentialsProvider(...)` for secrets resolved on the execution host.

## 1) Configure the workflow secret key

Set `MUX_AI_WORKFLOW_SECRET_KEY` in every environment where workflow steps execute.

The key must be a base64-encoded 32-byte value.

```bash
MUX_AI_WORKFLOW_SECRET_KEY=your_base64_32_byte_key
```

Example key generation:

```bash
openssl rand -base64 32
```

## 2) Encrypt credentials before `start(...)`

Encrypt in your trigger host (API route/server action) before invoking Workflow DevKit:

```ts
import { start } from "workflow/api";
import { encryptForWorkflow } from "@mux/ai";
import { getSummaryAndTags } from "@mux/ai/workflows";

const encryptedCredentials = await encryptForWorkflow(
  {
    muxTokenId: process.env.MUX_TOKEN_ID!,
    muxTokenSecret: process.env.MUX_TOKEN_SECRET!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
  },
  process.env.MUX_AI_WORKFLOW_SECRET_KEY!,
);

const run = await start(getSummaryAndTags, [
  "asset-id",
  {
    provider: "openai",
    credentials: encryptedCredentials,
  },
]);
```

## 3) Resolve execution-host secrets (optional)

If you prefer not to pass some secrets at all, resolve them on the execution host:

```ts
import { setWorkflowCredentialsProvider } from "@mux/ai";

setWorkflowCredentialsProvider(async () => ({
  muxTokenId: process.env.MUX_TOKEN_ID,
  muxTokenSecret: process.env.MUX_TOKEN_SECRET,
}));
```

Resolution order is:

1. provider credentials (`setWorkflowCredentialsProvider`)
2. decrypted workflow credentials (`credentials`)
3. environment variable fallbacks

## Storage adapters and encryption

Storage customization should be passed through `storageAdapter` (not `credentials`).

Use `createWorkflowStorageClient(...)` when you need a workflow-compatible adapter instance:

```ts
import { createWorkflowStorageClient, workflows } from "@mux/ai";

await workflows.translateCaptions(assetId, "en", "es", {
  provider: "openai",
  s3Endpoint: "https://s3.amazonaws.com",
  s3Bucket: "my-bucket",
  storageAdapter: createWorkflowStorageClient({
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  }),
});
```

## Troubleshooting

- `Invalid workflow secret key: expected 32 bytes...`
  - Key is not valid base64-encoded 32 bytes.
- `Failed to decrypt workflow credentials...`
  - Encryption/decryption keys differ, or payload is malformed.
- `Plaintext workflow credentials are not allowed when using Workflow Dev Kit.`
  - You passed plaintext `credentials` in a workflow runtime. Encrypt first, or rely on env/provider credentials.
