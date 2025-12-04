# 📼 🤝 🤖 @mux/ai 

A set of tools for connecting videos in your Mux account to multi-modal LLMs.

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
