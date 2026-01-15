# Encrypted Secrets

This guide shows how encrypted credentials work with workflows and how provider
type coverage narrows to each workflow's supported providers.

## How this works on Vercel (serverless-only setup)

There are two phases, both running in Vercel serverless functions:

- Trigger phase — your API route calls `start()` and passes encrypted credentials.
- Execution phase — the workflow steps run in a separate serverless invocation; this is the execution host where decryption happens.

## Example: Summarization (default providers only)

`getSummaryAndTags` accepts the default language-model providers (`openai`,
`anthropic`, `google`). The type of `provider` is restricted to those values.

```typescript
import { start } from "workflow/api";
import { encryptForWorkflow, getSummaryAndTags } from "@mux/ai/workflows";

// Trigger phase (API route): encrypt before calling start()
const workflowKey = process.env.MUX_AI_WORKFLOW_SECRET_KEY!;
const encryptedCredentials = await encryptForWorkflow(
  {
    muxTokenId: "mux-token-id",
    muxTokenSecret: "mux-token-secret",
    openaiApiKey: "openai-api-key",
  },
  workflowKey,
);

// Execution phase happens later in a separate invocation.
// The workflow runtime decrypts inside steps using MUX_AI_WORKFLOW_SECRET_KEY.
const run = await start(getSummaryAndTags, [
  "your-asset-id",
  { provider: "openai", credentials: encryptedCredentials },
]);
```

## Example: Moderation (workflow-specific providers)

`getModerationScores` supports `openai` and `hive`. The `provider` type is
limited to those values, even though `hive` is not a default language provider.

```typescript
import { start } from "workflow/api";
import { encryptForWorkflow, getModerationScores } from "@mux/ai/workflows";

const workflowKey = process.env.MUX_AI_WORKFLOW_SECRET_KEY!;
const encryptedCredentials = await encryptForWorkflow(
  {
    muxTokenId: "mux-token-id",
    muxTokenSecret: "mux-token-secret",
    hiveApiKey: "hive-api-key",
  },
  workflowKey,
);

const run = await start(getModerationScores, [
  "your-asset-id",
  { provider: "hive", credentials: encryptedCredentials },
]);
```

## Example: Audio Translation (workflow-specific provider)

`translateAudio` only supports `elevenlabs`. The `provider` type is restricted
to that value, and the helper resolves the API key from encrypted credentials.

```typescript
import { start } from "workflow/api";
import { encryptForWorkflow, translateAudio } from "@mux/ai/workflows";

const workflowKey = process.env.MUX_AI_WORKFLOW_SECRET_KEY!;
const encryptedCredentials = await encryptForWorkflow(
  {
    muxTokenId: "mux-token-id",
    muxTokenSecret: "mux-token-secret",
    elevenLabsApiKey: "elevenlabs-api-key",
  },
  workflowKey,
);

const run = await start(translateAudio, [
  "your-asset-id",
  "es",
  { provider: "elevenlabs", credentials: encryptedCredentials },
]);
```
