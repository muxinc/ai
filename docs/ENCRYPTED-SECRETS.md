# Encrypted Secrets

This guide shows how encrypted credentials work with workflows and how provider
type coverage narrows to each workflow's supported providers.

## How this works on Vercel (serverless-only setup)

There are two phases, both running in Vercel serverless functions:

- Trigger phase — your API route calls `start()` and passes encrypted credentials.
- Execution phase — the workflow steps run in a separate serverless invocation; this is the execution host where decryption happens.

When running inside a workflow runtime (or when `MUX_AI_WORKFLOW_SECRET_KEY` is set),
passing plaintext `credentials` will throw an error to prevent accidental exposure.

## Creating a Workflow Secret Key

The `MUX_AI_WORKFLOW_SECRET_KEY` must be a 256-bit (32-byte) key encoded as
base64. This key is used for AES-256-GCM encryption of your credentials.

### Using OpenSSL

Generate a cryptographically secure key with OpenSSL:

```bash
openssl rand -base64 32
```

This outputs a 44-character base64 string (32 bytes + padding) you can use
directly as your secret key.

### Using Node.js

Generate a key programmatically with Node.js:

```javascript
const crypto = require("crypto");
const key = crypto.randomBytes(32).toString("base64");
console.log(key);
```

Or as a one-liner:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Storing the Key

Store the generated key as an environment variable:

```bash
# .env or environment configuration
MUX_AI_WORKFLOW_SECRET_KEY=your_base64_encoded_key_here
```

Keep this key secure and never commit it to version control.

## Rotating the Workflow Secret Key

Key rotation is the process of replacing an existing encryption key with a new
one. You should rotate keys periodically or immediately if you suspect a key
may have been compromised.

### Key ID (`kid`) Support

The `encryptForWorkflow` function accepts an optional third parameter—a key ID
(`kid`)—that is stored in plaintext alongside the encrypted payload. This
enables zero-downtime key rotation by allowing the execution host to identify
which key was used for encryption.

```typescript
// Encrypt with a key ID
const encrypted = await encryptForWorkflow(
  credentials,
  env.MUX_AI_WORKFLOW_SECRET_KEY!,
  "key-2026-01", // key ID stored in payload.kid
);
```

Security notes:
- The `kid` is stored unencrypted—don't put sensitive data in it
- If an attacker modifies `kid`, decryption simply fails—the wrong key can't
  decrypt the payload

### Rotation Strategy

The built-in credential resolution always reads from `MUX_AI_WORKFLOW_SECRET_KEY`.
For most use cases, a simple key swap works well:

1. **Generate a new key** using the methods above.
2. **Update `MUX_AI_WORKFLOW_SECRET_KEY`** on the execution host.
3. **Deploy the change**.

Any workflows triggered after the deployment will use the new key. Workflows
already in progress will complete because credentials are decrypted at step
execution time—if a step already started with the old key, it continues with
those decrypted credentials.

### Advanced: Zero-Downtime Rotation with Key IDs

For zero-downtime rotation, you can use the `kid` field to tag encrypted payloads
with a key identifier, then implement custom decryption logic that looks up the
correct key. This requires bypassing the built-in credential resolution.

```typescript
import { decryptFromWorkflow, encryptForWorkflow } from "@mux/ai";

// Trigger phase: tag payload with the key ID
const encrypted = await encryptForWorkflow(
  credentials,
  process.env.MUX_AI_WORKFLOW_KEY_V2!,
  "v2", // stored in payload.kid
);

// Execution phase: look up key by ID before decrypting
function getKeyById(kid: string | undefined): string {
  const keys: Record<string, string | undefined> = {
    v1: process.env.MUX_AI_WORKFLOW_KEY_V1,
    v2: process.env.MUX_AI_WORKFLOW_KEY_V2,
  };
  const key = keys[kid ?? "v1"];
  if (!key) throw new Error(`Unknown key ID: ${kid}`);
  return key;
}

const key = getKeyById(encrypted.kid);
const decrypted = await decryptFromWorkflow(encrypted, key);
```

This approach lets you keep both keys active during the transition, then remove
the old key once all in-flight workflows have completed.

## Example: Summarization (default providers only)

`getSummaryAndTags` accepts the default language-model providers (`openai`,
`anthropic`, `google`). The type of `provider` is restricted to those values.

```typescript
import { start } from "workflow/api";
import { encryptForWorkflow } from "@mux/ai"
import { getSummaryAndTags } from "@mux/ai/workflows";

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
import { encryptForWorkflow } from "@mux/ai"
import { getModerationScores } from "@mux/ai/workflows";

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
import { encryptForWorkflow } from "@mux/ai"
import { translateAudio } from "@mux/ai/workflows";

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
