# Workflows

Detailed documentation for each pre-built workflow.

## What are Workflows?

Workflows are production-ready functions that orchestrate complete video AI tasks from start to finish. Each workflow handles the entire process: fetching video data from Mux (transcripts, storyboards, thumbnails), formatting it appropriately for AI providers, making the AI call with optimized prompts, and returning structured, typed results.

Internally, every workflow is composed from [primitives](./PRIMITIVES.md) - the low-level building blocks that provide direct access to Mux video data. This layered architecture means you can start with workflows for common tasks, and when you need more control, drop down to primitives to build custom solutions. Think of workflows as the "batteries included" layer and primitives as the foundation you can build on.

## Video Summarization

Generate AI-powered titles, descriptions, and tags from video content.

```typescript
import { getSummaryAndTags } from "@mux/ai/workflows";

const result = await getSummaryAndTags("your-mux-asset-id", {
  provider: "anthropic",
  tone: "professional"
});

console.log(result.title); // Short, descriptive title
console.log(result.description); // Detailed description
console.log(result.tags); // Array of relevant keywords
```

### Image Submission Modes

Choose between two methods for submitting images to AI providers:

**URL Mode (Default):**

- Fast initial response
- Lower bandwidth usage
- Relies on AI provider's image downloading
- May encounter timeouts with slow/unreliable image sources

**Base64 Mode (Recommended for Production):**

- Downloads images locally with robust retry logic
- Eliminates AI provider timeout issues
- Better control over slow TTFB and network issues
- Slightly higher bandwidth usage but more reliable results
- For OpenAI: submits images as base64 data URIs
- For Anthropic/Google: the AI SDK handles converting the base64 payload into the provider-specific format automatically

```typescript
// High reliability mode - recommended for production
const result = await getSummaryAndTags(assetId, {
  imageSubmissionMode: "base64",
  imageDownloadOptions: {
    timeout: 15000, // 15s timeout per image
    retries: 3, // Retry failed downloads 3x
    retryDelay: 1000, // 1s base delay with exponential backoff
    exponentialBackoff: true
  }
});
```

### Custom Prompts

Customize specific sections of the prompt for different use cases:

```typescript
// SEO-optimized metadata
const seoResult = await getSummaryAndTags(assetId, {
  promptOverrides: {
    task: "Generate SEO-optimized metadata for search engines.",
    title: "Create a search-optimized title (50-60 chars) with primary keyword.",
    keywords: "Focus on high search volume and long-tail keywords.",
  },
});
```

See [API Reference](./API.md#custom-prompts-with-promptoverrides) for more examples.

## Content Moderation

Analyze video content for inappropriate material using OpenAI or Hive.

```typescript
import { getModerationScores } from "@mux/ai/workflows";

// Analyze with OpenAI (default)
const result = await getModerationScores("your-mux-asset-id", {
  thresholds: { sexual: 0.7, violence: 0.8 }
});

console.log(result.maxScores); // Highest scores across all thumbnails
console.log(result.exceedsThreshold); // true if content should be flagged

// Use Hive for visual moderation
const hiveResult = await getModerationScores("your-mux-asset-id", {
  provider: "hive",
  thresholds: { sexual: 0.9, violence: 0.9 },
});
```

### Provider Comparison

- **OpenAI**: Uses the `omni-moderation-latest` model with dedicated moderation API
- **Hive**: Specialized visual moderation API with different scoring algorithms

## Burned-in Caption Detection

Detect hardcoded subtitles permanently embedded in video frames.

```typescript
import { hasBurnedInCaptions } from "@mux/ai/workflows";

const result = await hasBurnedInCaptions("your-mux-asset-id", {
  provider: "openai"
});

console.log(result.hasBurnedInCaptions); // true/false
console.log(result.confidence); // 0.0-1.0 confidence score
console.log(result.detectedLanguage); // Language if captions detected
```

### Detection Logic

- Analyzes video storyboard frames to identify text overlays
- Distinguishes between actual captions and marketing/end-card text
- Text appearing only in final 1-2 frames is classified as marketing copy
- Caption text must appear across multiple frames throughout the timeline
- Optimized prompts minimize false positives

## Chapter Generation

Generate AI-powered chapter markers from video captions.

```typescript
import { generateChapters } from "@mux/ai/workflows";

const result = await generateChapters("your-mux-asset-id", "en", {
  provider: "openai"
});

console.log(result.chapters); // Array of {startTime: number, title: string}

// Use with Mux Player
const player = document.querySelector("mux-player");
player.addChapters(result.chapters);
```

### Requirements

- Asset must have caption track in the specified language
- Caption track must be in 'ready' status
- Uses existing auto-generated or uploaded captions

## Video Embeddings

Generate vector embeddings for semantic video search.

```typescript
import { generateVideoEmbeddings } from "@mux/ai/workflows";

// Token-based chunking
const result = await generateVideoEmbeddings("your-mux-asset-id", {
  provider: "openai",
  chunkingStrategy: {
    type: "token",
    maxTokens: 500,
    overlap: 100
  }
});

console.log(result.chunks); // Array of chunk embeddings with timestamps
console.log(result.averagedEmbedding); // Single embedding for entire video

// Store chunks in vector database for timestamp-accurate search
for (const chunk of result.chunks) {
  await vectorDB.insert({
    id: `${result.assetId}:${chunk.chunkId}`,
    embedding: chunk.embedding,
    startTime: chunk.metadata.startTime,
    endTime: chunk.metadata.endTime
  });
}
```

### Chunking Strategies

**Token-based Chunking:**

- Splits transcript by token count
- Simple overlap between chunks
- Good for general semantic search

**VTT-based Chunking:**

- Respects caption cue boundaries
- Overlap measured in cues
- Better preserves natural speech breaks

```typescript
// VTT-based chunking
const vttResult = await generateVideoEmbeddings("your-mux-asset-id", {
  provider: "google",
  chunkingStrategy: {
    type: "vtt",
    maxTokens: 500,
    overlapCues: 2
  }
});
```

## Caption Translation

Translate existing captions to different languages and add as new tracks.

```typescript
import { translateCaptions } from "@mux/ai/workflows";

// Translate English to Spanish and upload to Mux
const result = await translateCaptions(
  "your-mux-asset-id",
  "en", // from language
  "es", // to language
  {
    provider: "google",
    model: "gemini-2.5-flash"
  }
);

console.log(result.uploadedTrackId); // New Mux track ID
console.log(result.presignedUrl); // S3 file URL
console.log(result.translatedVtt); // Translated VTT content
```

### S3-Compatible Storage Requirements

Caption translation requires S3-compatible storage to host VTT files for Mux ingestion.

**Supported Providers:**

- **AWS S3** - Amazon's object storage
- **DigitalOcean Spaces** - S3-compatible with CDN
- **Cloudflare R2** - Zero egress fees
- **MinIO** - Self-hosted S3 alternative
- **Backblaze B2** - Cost-effective storage
- **Wasabi** - Hot cloud storage

**Configuration:**

Set environment variables:

```bash
S3_ENDPOINT=https://your-s3-endpoint.com
S3_REGION=auto
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
```

> **⚠️ Important:** Currently, the only way to set secrets is as ENV vars. The reason for this is to avoid leaking secrets into Workflow DevKit observability tooling. `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are considered secrets. The other values for S3: `S3_ENDPOINT`, `S3_REGION` and `S3_BUCKET` are not considered secrets. They can be passed in explicitly at runtime.


**Why S3 Storage?**

Mux requires a publicly accessible URL to ingest subtitle tracks. The translation workflow:

1. Uploads translated VTT to your S3 storage
2. Generates a presigned URL for secure access
3. Mux fetches the file using the presigned URL
4. File remains in your storage for future use

### Supported Languages

All ISO 639-1 language codes are automatically supported using `Intl.DisplayNames`. Examples: Spanish (es), French (fr), German (de), Italian (it), Portuguese (pt), Polish (pl), Japanese (ja), Korean (ko), Chinese (zh), Russian (ru), Arabic (ar), Hindi (hi), Thai (th), Swahili (sw), and many more.

## Audio Dubbing

Create AI-dubbed audio tracks using ElevenLabs voice cloning.

```typescript
import { translateAudio } from "@mux/ai/workflows";

// Create dubbed audio and upload to Mux
// Uses default audio track, language auto-detected
const result = await translateAudio(
  "your-mux-asset-id",
  "es", // target language
  {
    provider: "elevenlabs",
    numSpeakers: 0 // Auto-detect speakers
  }
);

console.log(result.dubbingId); // ElevenLabs dubbing job ID
console.log(result.uploadedTrackId); // New Mux audio track ID
console.log(result.presignedUrl); // S3 audio file URL
```

### Requirements

- Asset must have an `audio.m4a` static rendition
- ElevenLabs API key with Creator plan or higher
- S3-compatible storage (same as caption translation)

### Supported Languages

ElevenLabs supports 32+ languages with automatic language name detection via `Intl.DisplayNames`. Supported languages include English, Spanish, French, German, Italian, Portuguese, Polish, Japanese, Korean, Chinese, Russian, Arabic, Hindi, Thai, and many more. Track names are automatically generated (e.g., "Polish (auto-dubbed)").

### Audio Dubbing Workflow

1. Checks asset has audio.m4a static rendition
2. Downloads default audio track from Mux
3. Creates ElevenLabs dubbing job with automatic language detection
4. Polls for completion (up to 30 minutes)
5. Downloads dubbed audio file
6. Uploads to S3-compatible storage
7. Generates presigned URL (1-hour expiry)
8. Adds new audio track to Mux asset
9. Track name: "{Language} (auto-dubbed)"

## Multi-Provider Support

All workflows support multiple AI providers with consistent interfaces.

### Comparing Providers

Run the same workflow across different providers to compare results:

```typescript
import { getSummaryAndTags } from "@mux/ai/workflows";

const assetId = "your-mux-asset-id";

// OpenAI analysis (default: gpt-5.1)
const openaiResult = await getSummaryAndTags(assetId, {
  provider: "openai",
  tone: "professional"
});

// Anthropic analysis (default: claude-sonnet-4-5)
const anthropicResult = await getSummaryAndTags(assetId, {
  provider: "anthropic",
  tone: "professional"
});

// Google Gemini analysis (default: gemini-2.5-flash)
const googleResult = await getSummaryAndTags(assetId, {
  provider: "google",
  tone: "professional"
});

// Compare results
console.log("OpenAI:", openaiResult.title);
console.log("Anthropic:", anthropicResult.title);
console.log("Google:", googleResult.title);
```

Works with any workflow:

```typescript
import { generateChapters } from "@mux/ai/workflows";

// OpenAI (default: gpt-5.1)
const openaiChapters = await generateChapters(assetId, "en", {
  provider: "openai"
});

// Anthropic (default: claude-sonnet-4-5)
const anthropicChapters = await generateChapters(assetId, "en", {
  provider: "anthropic"
});

// Google (default: gemini-2.5-flash)
const googleChapters = await generateChapters(assetId, "en", {
  provider: "google"
});
```

### Overriding Default Models

Override default models when you need different cost or capability trade-offs:

```typescript
import { getSummaryAndTags } from "@mux/ai/workflows";

// Use a more powerful model
const result = await getSummaryAndTags(assetId, {
  provider: "openai",
  model: "gpt-4o" // Instead of default gpt-5.1
});

// Use a faster/cheaper model
const fastResult = await getSummaryAndTags(assetId, {
  provider: "google",
  model: "gemini-1.5-flash-8b" // Smallest/fastest Gemini
});
```

**Cost Optimization Tip:** The defaults (`gpt-5.1`, `claude-sonnet-4-5`, `gemini-2.5-flash`) are optimized for cost/quality balance. Only upgrade to more powerful models when quality needs justify the higher cost.
