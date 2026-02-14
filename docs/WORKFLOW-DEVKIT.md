# Workflow DevKit Integration

All workflows in `@mux/ai` are compatible with [Workflow DevKit](https://useworkflow.dev). Workflows are exported with `"use workflow"` directives and steps use `"use step"` directives, giving you observability, retries, and control flow patterns out of the box.

## Basic Usage

When using Workflow DevKit in your project, call workflow functions through `start(...)`:

```ts
import { start } from 'workflow/api';
import { getSummaryAndTags } from '@mux/ai/workflows';

const assetId = 'YOUR_ASSET_ID';
const run = await start(getSummaryAndTags, [assetId]);

// Optionally wait for the workflow run return value:
const result = await run.returnValue;
```

## Multi-Tenant Credentials

Workflow DevKit serializes workflow inputs/outputs for observability. To avoid sending plaintext secrets through `start(...)`, encrypt credentials in the trigger host and decrypt them in workflow steps.

### 1. Set a Shared Secret Key

Set a shared workflow secret key (base64-encoded 32-byte value) in your environment:

```bash
MUX_AI_WORKFLOW_SECRET_KEY=your_base64_32_byte_key
```

Generate one with:

```bash
openssl rand -base64 32
```

### 2. Encrypt Credentials Before `start(...)`

```ts
import { start } from "workflow/api";
import { encryptForWorkflow } from "@mux/ai";
import { getSummaryAndTags } from "@mux/ai/workflows";

const workflowKey = process.env.MUX_AI_WORKFLOW_SECRET_KEY!;
const encryptedCredentials = await encryptForWorkflow(
  {
    muxTokenId: "mux-token-id",
    muxTokenSecret: "mux-token-secret",
    openaiApiKey: "openai-api-key",
  },
  workflowKey,
);

const run = await start(getSummaryAndTags, [
  "your-asset-id",
  {
    provider: "openai",
    credentials: encryptedCredentials,
  },
]);
```

### 3. Use a Credentials Provider (Optional)

Register a credential provider on the execution host to resolve secrets inside steps. This is useful for dynamic key resolution, e.g. rotating keys or per-tenant secrets:

```ts
import { setWorkflowCredentialsProvider } from "@mux/ai";

setWorkflowCredentialsProvider(async () => ({
  muxTokenId: "mux-token-id",
  muxTokenSecret: "mux-token-secret",
  openaiApiKey: await getOpenAIKeyForTenant(),
}));
```

For Mux tokens specifically, `setWorkflowCredentialsProvider(...)` (or environment variables) is still recommended so raw Mux secrets are never embedded in workflow input payloads.

**Resolution order:**
1. Provider credentials (`setWorkflowCredentialsProvider`)
2. Decrypted workflow credentials (`credentials`)
3. Environment variable fallbacks

For full encryption details, see the [Workflow Encryption guide](./WORKFLOW-ENCRYPTION.md).

## Nesting Workflows

Workflows can be composed and nested:

```ts
import { start } from "workflow/api";
import { getSummaryAndTags } from '@mux/ai/workflows';

async function processVideoSummary(assetId: string) {
  'use workflow'

  const summary = await getSummaryAndTags(assetId);
  const emailResp = await emailSummaryToAdmins(summary);

  return { assetId, summary, emailResp }
}

async function emailSummaryToAdmins(summary: any) {
  'use step';
  return { sent: true }
}

// This calls processVideoSummary, which internally calls getSummaryAndTags
const run = await start(processVideoSummary, [assetId]);
```

## Features

Workflow DevKit gives you:

- [Observability Dashboard](https://useworkflow.dev/docs/observability) — full visibility into workflow runs
- [Control Flow Patterns](https://useworkflow.dev/docs/foundations/control-flow-patterns) — parallel execution, fan-out, and more
- [Errors and Retrying](https://useworkflow.dev/docs/foundations/errors-and-retries) — automatic retries with backoff
- [Hooks and Webhooks](https://useworkflow.dev/docs/foundations/hooks) — lifecycle hooks for custom logic
- [Human in the Loop](https://useworkflow.dev/docs/ai/human-in-the-loop) — patterns for agent-based workflows

## Related Guides

- [Workflow Encryption](./WORKFLOW-ENCRYPTION.md) — encrypting credentials across workflow boundaries
- [Storage Adapters](./STORAGE-ADAPTERS.md) — custom storage for translation workflows
