# Credentials

This guide covers all the credentials you need to configure for `@mux/ai` workflows.

You only need to set up credentials for the services you actually use. Most workflows only require Mux credentials plus one AI provider.

## Mux Credentials

### Access Token (required)

All workflows require a Mux API access token to interact with your video assets. If you're already logged into the dashboard, you can [create a new access token here](https://dashboard.mux.com/settings/access-tokens).

**Required Permissions:**
- **Mux Video**: Read + Write access
- **Mux Data**: Read access

These permissions cover all current workflows. You can set these when creating your token in the dashboard.

```bash
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret
```

> **💡 Tip:** For security reasons, consider creating a dedicated access token specifically for your AI workflows rather than reusing existing tokens.

### Signing Key (conditionally required)

If your Mux assets use [signed playback URLs](https://docs.mux.com/guides/secure-video-playback) for security, you'll need to provide signing credentials so `@mux/ai` can access the video data.

**When needed:** Only if your assets have signed playback policies enabled and no public playback ID.

**How to get:**
1. Go to [Settings > Signing Keys](https://dashboard.mux.com/settings/signing-keys) in your Mux dashboard
2. Create a new signing key or use an existing one
3. Save both the **Signing Key ID** and the **Base64-encoded Private Key**

```bash
MUX_SIGNING_KEY=your_signing_key_id
MUX_PRIVATE_KEY=your_base64_encoded_private_key
```

## AI Provider Credentials

Different workflows support various AI providers. You only need to configure API keys for the providers you plan to use.

### OpenAI

**Used by:** `getSummaryAndTags`, `getModerationScores`, `hasBurnedInCaptions`, `askQuestions`, `generateChapters`, `generateEmbeddings`, `translateCaptions`

**Get your API key:** [OpenAI API Keys](https://platform.openai.com/api-keys)

```bash
OPENAI_API_KEY=your_openai_api_key
```

### Anthropic

**Used by:** `getSummaryAndTags`, `hasBurnedInCaptions`, `askQuestions`, `generateChapters`, `translateCaptions`

**Get your API key:** [Anthropic Console](https://console.anthropic.com/)

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### Google Generative AI

**Used by:** `getSummaryAndTags`, `hasBurnedInCaptions`, `askQuestions`, `generateChapters`, `generateEmbeddings`, `translateCaptions`

**Get your API key:** [Google AI Studio](https://aistudio.google.com/app/apikey)

```bash
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key
```

### ElevenLabs

**Used by:** `translateAudio` (audio dubbing)

**Get your API key:** [ElevenLabs API Keys](https://elevenlabs.io/app/settings/api-keys)

**Note:** Requires a Creator plan or higher for dubbing features.

```bash
ELEVENLABS_API_KEY=your_elevenlabs_api_key
```

### Hive

**Used by:** `getModerationScores` (alternative to OpenAI moderation)

**Get your API key:** [Hive Console](https://thehive.ai/)

```bash
HIVE_API_KEY=your_hive_api_key
```

## Cloud Infrastructure Credentials

### AWS S3 (or S3-compatible storage)

**Required for:** `translateCaptions`, `translateAudio` (only when `uploadToMux` is true, which is the default)

Translation workflows need temporary storage to upload translated files before attaching them to your Mux assets. Any S3-compatible storage service works (AWS S3, Cloudflare R2, DigitalOcean Spaces, etc.).

**AWS S3 Setup:**
1. [Create an S3 bucket](https://s3.console.aws.amazon.com/s3/home)
2. [Create an IAM user](https://console.aws.amazon.com/iam/) with programmatic access
3. Attach a policy with `s3:PutObject`, `s3:GetObject`, and `s3:PutObjectAcl` permissions for your bucket

**Configuration:**

```bash
S3_ENDPOINT=https://s3.amazonaws.com  # Or your S3-compatible endpoint
S3_REGION=us-east-1                   # Your bucket region
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
```

**Cloudflare R2 Example:**

```bash
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-r2-access-key
S3_SECRET_ACCESS_KEY=your-r2-secret-key
```

For custom storage SDK usage (AWS SDK v3, MinIO, etc.), see the [Storage Adapters](./STORAGE-ADAPTERS.md) guide.

## Runtime Credentials

Environment variables are the simplest way to get started, but `@mux/ai` also supports providing credentials at runtime on a per-request basis. This is essential for multi-tenant applications where different users or tenants have their own API keys.

### The `credentials` option

Every workflow accepts an optional `credentials` object. Pass it directly to supply API keys at call time instead of relying on environment variables:

```ts
import { getSummaryAndTags } from "@mux/ai/workflows";

const result = await getSummaryAndTags("asset-id", {
  provider: "openai",
  credentials: {
    muxTokenId: tenant.muxTokenId,
    muxTokenSecret: tenant.muxTokenSecret,
    openaiApiKey: tenant.openaiKey,
  },
});
```

Supported credential fields:

| Field | Description |
| --- | --- |
| `muxTokenId` | Mux API token ID |
| `muxTokenSecret` | Mux API token secret |
| `muxSigningKey` | Mux signing key ID (for signed playback) |
| `muxPrivateKey` | Mux private key (for signed playback) |
| `openaiApiKey` | OpenAI API key |
| `anthropicApiKey` | Anthropic API key |
| `googleApiKey` | Google Generative AI API key |
| `hiveApiKey` | Hive API key |
| `elevenLabsApiKey` | ElevenLabs API key |

### Global credentials provider

For dynamic key resolution — rotating keys, per-tenant secrets fetched from a vault, etc. — register a global provider that runs before every workflow:

```ts
import { setWorkflowCredentialsProvider } from "@mux/ai";

setWorkflowCredentialsProvider(async () => ({
  muxTokenId: await getSecret("mux-token-id"),
  muxTokenSecret: await getSecret("mux-token-secret"),
  openaiApiKey: await getSecretForCurrentTenant("openai-key"),
}));
```

### Resolution order

Credentials are merged from multiple sources in order of precedence:

1. **Credentials provider** (`setWorkflowCredentialsProvider`) — highest priority
2. **Direct `credentials` option** passed to the workflow call
3. **Environment variables** — lowest priority fallback

This means you can set shared credentials via environment variables and override specific keys per-request or per-tenant.

### Encrypted credentials (Workflow DevKit)

When running workflows through [Workflow DevKit](https://useworkflow.dev), inputs and outputs are serialized for observability. To avoid plaintext secrets in those payloads, encrypt credentials before passing them:

```ts
import { encryptForWorkflow } from "@mux/ai";
import { start } from "workflow/api";
import { getSummaryAndTags } from "@mux/ai/workflows";

const encrypted = await encryptForWorkflow(
  { muxTokenId: "...", muxTokenSecret: "...", openaiApiKey: "..." },
  process.env.MUX_AI_WORKFLOW_SECRET_KEY!,
);

const run = await start(getSummaryAndTags, [
  "asset-id",
  { provider: "openai", credentials: encrypted },
]);
```

See the [Workflow Encryption guide](./WORKFLOW-ENCRYPTION.md) for full setup details.

## Full `.env` Example

Here's a complete example showing all possible environment variables:

```bash
# Mux (required)
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret

# Mux Signing (only for signed playback assets)
MUX_SIGNING_KEY=your_signing_key_id
MUX_PRIVATE_KEY=your_base64_encoded_private_key

# AI Providers (configure only what you need)
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
HIVE_API_KEY=your_hive_api_key

# S3-Compatible Storage (for translation & audio dubbing only)
S3_ENDPOINT=https://your-s3-endpoint.com
S3_REGION=auto
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
```

> **💡 Tip:** If you're using `.env` in a repository or version tracking system, make sure you add this file to your `.gitignore` to avoid committing secrets.

We support [dotenv](https://www.npmjs.com/package/dotenv), so placing these variables in a `.env` file at the root of your project is all you need.
