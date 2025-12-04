# `@mux/ai` 📼 🤝 🤖

A server-side TypeScript SDK for connecting your [Mux](https://www.mux.com) videos to a variety of hosted AI models (multi-modal LLMs, text embedding models, etc.). `@mux/ai` does this by providing:
- easy to use, production-ready, purpose-driven, cost effective, configurable **_workflow functions_** that integrate with a variety of popular AI/LLM providers (OpenAI, Anthropic, Google).
  - **Examples:** `generateChapters`, `getModerationScores`, `translateAudio`, `generateVideoEmbeddings`, `getSummaryAndTags`
- convenient, parameterized, commonly needed **_primitive functions_** backed by [Mux Video](https://www.mux.com/video-api) for building your own media-based AI workflows and integrations.
  - **Examples:** `getStoryboardUrl`, `chunkVTTCues`, `fetchTranscriptForAsset`

# Usage

```ts
import { translateCaptions } from "@mux/ai/workflows";

const result = await translateCaptions(
  "your-mux-asset-id",
  "en", // from
  "es", // to
  { provider: "anthropic" }
);

console.log(result.uploadedTrackId); // New Mux track ID
```

# Quick Start

## Prerequisites

- [`node`]() (≥ 21.0.0)
- A Mux account and necessary [credentials](#credentials---mux) for your environment (sign up [here](https://dashboard.mux.com/signup) for free!)
- Accounts and [credentials](#credentials---ai-providers) for any AI providers you intend to use for your workflows
- (For some workflows only) AWS S3 and [other credentials](#credentials---other)




## Credentials
### Credentials - Mux
### Credentials - AI Providers
### Credentials - Other


(TERSER: "A Mux Account and Mux Credentials" (link to more verbose section farther down))

### Mux Access
- A Mux Account (sign up for free [here](https://dashboard.mux.com/signup)!)
- A Mux [access token ID + secret](https://www.mux.com/docs/core/stream-video-files#1-get-an-api-access-token) with Read+Write Mux Video and Read Mux Data permissions for API access to your preferred environment (create a new access token [here](https://dashboard.mux.com/settings/access-tokens) if you're signed in to the [dashboard](https://dashboard.mux.com))

### AI API Access
- API keys and other environment setups



e.g.
- Credentials for whatever

(NOTE: vercel ai-sdk providers)


- document perms of token
- (signed URLs for subset/specific GET-based mux assets if/when relevant)
- node v21 (make sure to update engines and confirm github actions versions)
- validate deno + bun (and document if they work)
- .env












`@mux/ai` contains two abstractions:

**Workflows** are production-ready functions that handle common video<->LLM tasks. Each workflow orchestrates the entire process: fetching video data from Mux (transcripts, thumbnails, storyboards), formatting it for AI providers, and returning structured results. Use workflows when you need battle-tested solutions for tasks like summarization, content moderation, chapter generation, or translation.

**Primitives** are the low-level building blocks that workflows are composed from. They provide direct access to Mux video data (transcripts, storyboards, thumbnails) and utilities for chunking and processing text. Use primitives when you need complete control over your AI prompts or want to build custom workflows not covered by the pre-built options.

## Available pre-built workflows

| Workflow                                                                 | Description                                                       | Providers                 | Default Models                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| [`getSummaryAndTags`](./docs/WORKFLOWS.md#video-summarization)           | Generate titles, descriptions, and tags for an asset              | OpenAI, Anthropic, Google | `gpt-5-mini`, `claude-sonnet-4-5`, `gemini-2.5-flash`              |
| [`getModerationScores`](./docs/WORKFLOWS.md#content-moderation)          | Detect inappropriate (sexual or violent) content in an asset      | OpenAI, Hive              | `omni-moderation-latest` (OpenAI) or Hive visual moderation task   |
| [`hasBurnedInCaptions`](./docs/WORKFLOWS.md#burned-in-caption-detection) | Detect burned-in captions (hardcoded subtitles) in an asset       | OpenAI, Anthropic, Google | `gpt-5-mini`, `claude-sonnet-4-5`, `gemini-2.5-flash`              |
| [`generateChapters`](./docs/WORKFLOWS.md#chapter-generation)             | Generate chapter markers for an asset using the transcript        | OpenAI, Anthropic, Google | `gpt-5-mini`, `claude-sonnet-4-5`, `gemini-2.5-flash`              |
| [`generateVideoEmbeddings`](./docs/WORKFLOWS.md#video-embeddings)        | Generate vector embeddings for an asset's transcript chunks       | OpenAI, Google            | `text-embedding-3-small` (OpenAI), `gemini-embedding-001` (Google) |
| [`translateCaptions`](./docs/WORKFLOWS.md#caption-translation)           | Translate an asset's captions into different languages            | OpenAI, Anthropic, Google | `gpt-5-mini`, `claude-sonnet-4-5`, `gemini-2.5-flash`              |
| [`translateAudio`](./docs/WORKFLOWS.md#audio-dubbing)                    | Create AI-dubbed audio tracks in different languages for an asset | ElevenLabs only           | ElevenLabs Dubbing API                                             |

## Features

- **Cost-Effective by Default**: Uses affordable frontier models like `gpt-5-mini`, `claude-sonnet-4-5`, and `gemini-2.5-flash` to keep analysis costs low while maintaining high quality results
- **Multi-modal Analysis**: Combines storyboard images with video transcripts
- **Tone Control**: Normal, sassy, or professional analysis styles
- **Prompt Customization**: Override specific prompt sections to tune workflows to your use case
- **Configurable Thresholds**: Custom sensitivity levels for content moderation
- **TypeScript**: Fully typed for excellent developer experience
- **Provider Choice**: Switch between OpenAI, Anthropic, and Google for different perspectives
- **Composable Building Blocks**: Import primitives to fetch transcripts, thumbnails, and storyboards to build bespoke flows
- **Universal Language Support**: Automatic language name detection using `Intl.DisplayNames` for all ISO 639-1 codes

## Installation

```bash
npm install @mux/ai
```

## Configuration

Set environment variables:

```bash
# Required
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret

# Needed if your assets _only_ have signed playback IDs
MUX_SIGNING_KEY=your_signing_key_id
MUX_PRIVATE_KEY=your_base64_encoded_private_key

# You only need to configure API keys for the AI platforms you're using
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key

# Needed for audio dubbing workflow
ELEVENLABS_API_KEY=your_elevenlabs_api_key

# S3-Compatible Storage (required for translation & audio dubbing)
S3_ENDPOINT=https://your-s3-endpoint.com
S3_REGION=auto
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
```

Or pass credentials directly to each function:

```typescript
const result = await getSummaryAndTags(assetId, {
  muxTokenId: "your-token-id",
  muxTokenSecret: "your-token-secret",
  openaiApiKey: "your-openai-key"
});
```

## Quick Start

> **‼️ Important: ‼️** Most workflows rely on video transcripts for best results. Enable [auto-generated captions](https://www.mux.com/docs/guides/add-autogenerated-captions-and-use-transcripts) on your Mux assets to unlock the full potential of transcript-based workflows like summarization, chapters, and embeddings.

### Video Summarization

```typescript
import { getSummaryAndTags } from "@mux/ai/workflows";

const result = await getSummaryAndTags("your-mux-asset-id", {
  tone: "professional"
});

console.log(result.title);
console.log(result.description);
console.log(result.tags);
```

### Content Moderation

```typescript
import { getModerationScores } from "@mux/ai/workflows";

const result = await getModerationScores("your-mux-asset-id", {
  thresholds: { sexual: 0.7, violence: 0.8 }
});

console.log(result.exceedsThreshold); // true if content flagged
```

### Generate Chapters

```typescript
import { generateChapters } from "@mux/ai/workflows";

const result = await generateChapters("your-mux-asset-id", "en");

// Use with Mux Player
player.addChapters(result.chapters);
```

### Translate Captions

```typescript
import { translateCaptions } from "@mux/ai/workflows";

const result = await translateCaptions(
  "your-mux-asset-id",
  "en", // from
  "es", // to
  { provider: "anthropic" }
);

console.log(result.uploadedTrackId); // New Mux track ID
```

## Package Structure

This package ships with layered entry points:

- **`@mux/ai/workflows`** – Production-ready helpers like `getSummaryAndTags` and `generateChapters`
- **`@mux/ai/primitives`** – Low-level building blocks like `fetchTranscriptForAsset` and `getStoryboardUrl`
- **`@mux/ai`** – Main entry point that re-exports both namespaces plus shared types

```typescript
// Or import everything
import { primitives, workflows } from "@mux/ai";
// Low-level primitives for custom workflows
import { fetchTranscriptForAsset, getStoryboardUrl } from "@mux/ai/primitives";
// High-level workflows
import { getSummaryAndTags } from "@mux/ai/workflows";
```

Every workflow is composed from primitives, so you can start high-level and drop down to primitives when you need more control.

## Documentation

- **[Workflows](./docs/WORKFLOWS.md)** - Detailed guide to each pre-built workflow
- **[Primitives](./docs/PRIMITIVES.md)** - Low-level building blocks for custom workflows
- **[API Reference](./docs/API.md)** - Complete API documentation for all functions
- **[Examples](./docs/EXAMPLES.md)** - Running examples from the repository

## Development

```bash
# Clone and install
git clone https://github.com/muxinc/mux-ai.git
cd mux-ai
npm install  # Automatically sets up git hooks

# Linting and type checking
npm run lint
npm run lint:fix
npm run typecheck

# Run tests
npm test
```

This project uses ESLint with `@antfu/eslint-config`, TypeScript strict mode, and automated pre-commit hooks.

## License

[Apache 2.0](LICENSE)
