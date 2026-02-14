# Workflows

Detailed documentation for each pre-built workflow.

## What are Workflows?

Workflows are production-ready functions that orchestrate complete video AI tasks from start to finish. Each workflow handles the entire process: fetching video data from Mux (transcripts, storyboards, thumbnails), formatting it appropriately for AI providers, making the AI call with optimized prompts, and returning structured, typed results.

For audio-only assets (no video track), see [Audio-Only Workflows](./AUDIO-ONLY.md).

Internally, every workflow is composed from [primitives](./PRIMITIVES.md) - the low-level building blocks that provide direct access to Mux video data. This layered architecture means you can start with workflows for common tasks, and when you need more control, drop down to primitives to build custom solutions. Think of workflows as the "batteries included" layer and primitives as the foundation you can build on.

Workflows in this project are exported with the `"use workflow"` directive, which makes them compatible with [Workflow DevKit](https://useworkflow.dev). See "Compatability with Workflow DevKit" in the [README](./README.md) for details.

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

Analyze a Mux asset for inappropriate material using OpenAI or Hive.

- For **video assets**, moderation runs over storyboard thumbnails.
- For **audio-only assets**, moderation runs over transcript text.

```typescript
import { getModerationScores } from "@mux/ai/workflows";

// Analyze with OpenAI (default)
const result = await getModerationScores("your-mux-asset-id", {
  thresholds: { sexual: 0.7, violence: 0.8 }
});

console.log(result.maxScores); // Highest scores across all thumbnails (or transcript for audio-only)
console.log(result.exceedsThreshold); // true if content should be flagged

// Use Hive for visual moderation
const hiveResult = await getModerationScores("your-mux-asset-id", {
  provider: "hive",
  thresholds: { sexual: 0.9, violence: 0.9 },
});
```

### Provider Comparison

- **OpenAI**: Uses the `omni-moderation-latest` model with dedicated moderation API
- **Hive**: Visual moderation by default; audio-only/text moderation requires a Hive **Text Moderation** project/API key (otherwise Hive will reject `text_data`) — see [Hive Text Moderation docs](https://docs.thehive.ai/docs/classification-text)

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

## Ask Questions

Answer questions about video content by analyzing storyboard frames and optional transcripts. By default, answers are "yes"/"no", but you can override the allowed responses.

```typescript
import { askQuestions } from "@mux/ai/workflows";

// Single question
const result = await askQuestions("your-mux-asset-id", [
  { question: "Does this video contain cooking?" }
], {
  provider: "openai"
});

console.log(result.answers[0].answer); // "yes" or "no" by default
console.log(result.answers[0].confidence); // 0.0-1.0 confidence score
console.log(result.answers[0].reasoning); // AI's explanation
```

### Multiple Questions

Process multiple questions in a single API call for efficiency:

```typescript
const result = await askQuestions(assetId, [
  { question: "Does this video contain people?" },
  { question: "Is this video in color?" },
  { question: "Does this video contain violence?" },
  { question: "Is this suitable for children?" }
]);

// Process all answers
result.answers.forEach(answer => {
  console.log(`Q: ${answer.question}`);
  console.log(`A: ${answer.answer} (${Math.round(answer.confidence * 100)}% confident)`);
  console.log(`Reasoning: ${answer.reasoning}\n`);
});
```

### Use Cases

- **Content Classification:** "Is this a product demo?", "Does this contain advertisements?"
- **Content Moderation:** "Does this show violence?", "Is there inappropriate content?"
- **Quality Checks:** "Is the audio clear?", "Is the lighting professional?"
- **Accessibility Audits:** "Are there visual text elements?", "Does this rely only on audio?"
- **Metadata Validation:** "Does the content match the title?", "Is this in English?"

### Configuration Options

```typescript
const result = await askQuestions(assetId, questions, {
  provider: "openai", // "openai", "anthropic", "google", "bedrock", or "vertex" (default: "openai")
  model: "gpt-5.1", // Override default model
  answerOptions: ["yes", "no", "unsure"], // Override allowed answers
  includeTranscript: true, // Include transcript (default: true)
  cleanTranscript: true, // Remove timestamps/markup (default: true)
  imageSubmissionMode: "url", // "url" or "base64" (default: "url")
  storyboardWidth: 640 // Storyboard resolution in pixels (default: 640)
});
```

### Tips for Effective Questions

- **Be specific:** "Does this show a person cooking in a kitchen?" vs "Does this have food?"
- **Frame positively:** "Is this video in color?" vs "Is this video not black and white?"
- **Avoid ambiguity:** Questions should have clear answers that map to your allowed options
- **Use objective criteria:** Focus on observable evidence rather than subjective opinions

### Transcript Integration

When `includeTranscript` is enabled (default), the AI considers both visual frames and audio/dialogue:

```typescript
// Without transcript - visual analysis only
const visualOnly = await askQuestions(assetId, [
  { question: "Does someone speak in this video?" }
], {
  includeTranscript: false
});

// With transcript - analyzes both visual and audio
const withAudio = await askQuestions(assetId, [
  { question: "Does someone speak in this video?" }
], {
  includeTranscript: true
});
```

The AI will prioritize visual evidence when transcript and visuals conflict.

## Chapter Generation

Generate AI-powered chapter markers from video or audio transcripts.

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

- Asset must have a ready caption/transcript track in the specified language
- Uses existing auto-generated or uploaded captions/transcripts

## Embeddings

Generate vector embeddings for semantic search over video or audio transcripts.

```typescript
import { generateEmbeddings } from "@mux/ai/workflows";

// Token-based chunking
const result = await generateEmbeddings("your-mux-asset-id", {
  provider: "openai",
  chunkingStrategy: {
    type: "token",
    maxTokens: 500,
    overlap: 100
  }
});

console.log(result.chunks); // Array of chunk embeddings with timestamps
console.log(result.averagedEmbedding); // Single embedding for entire transcript

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
const vttResult = await generateEmbeddings("your-mux-asset-id", {
  provider: "google",
  chunkingStrategy: {
    type: "vtt",
    maxTokens: 500,
    overlapCues: 2
  }
});
```

## Caption Translation

Translate existing captions to different languages and add as new tracks (video or audio-only assets).

```typescript
import { translateCaptions } from "@mux/ai/workflows";

// Translate English to Spanish and upload to Mux
const result = await translateCaptions(
  "your-mux-asset-id",
  "en", // from language
  "es", // to language
  {
    provider: "google",
    model: "gemini-3-flash-preview"
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

`s3Endpoint`, `s3Region` and `s3Bucket` can also be used to override the environment varialbes

```typescript
const result = await translateCaptions(assetId, "en", "es", {
  provider: "anthropic",
  s3Endpoint: "https://your-endpoint.com",
  s3Region: "auto",
  s3Bucket: "your-bucket",
});
```

> **⚠️ Important:** Workflow Dev Kit serializes workflow inputs/outputs. Do not pass plaintext secrets as workflow args.
> Use the `encryptForWorkflow` helper and pass `credentials` to workflows when running multi-tenant.
> `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` must still be set as ENV vars on the execution host.


**Why S3 Storage?**

Mux requires a publicly accessible URL to ingest subtitle tracks. The translation workflow:

1. Uploads translated VTT to your S3 storage
2. Generates a presigned URL for secure access
3. Mux fetches the file using the presigned URL
4. File remains in your storage for future use

### Supported Languages

All ISO 639-1 language codes are automatically supported using `Intl.DisplayNames`. Examples: Spanish (es), French (fr), German (de), Italian (it), Portuguese (pt), Polish (pl), Japanese (ja), Korean (ko), Chinese (zh), Russian (ru), Arabic (ar), Hindi (hi), Thai (th), Swahili (sw), and many more.

## Audio Dubbing

Create AI-dubbed audio tracks using ElevenLabs voice cloning (video or audio-only assets).

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

All workflows support multiple AI providers with consistent interfaces. In addition to direct API providers (OpenAI, Anthropic, Google), you can also use **Amazon Bedrock** and **Google Vertex AI** for enterprise cloud deployments.

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

// Google Gemini analysis (default: gemini-3-flash-preview)
const googleResult = await getSummaryAndTags(assetId, {
  provider: "google",
  tone: "professional"
});

// Amazon Bedrock (default: us.anthropic.claude-sonnet-4-5-20250929-v1:0)
const bedrockResult = await getSummaryAndTags(assetId, {
  provider: "bedrock",
  tone: "professional"
});

// Google Vertex AI (default: gemini-3-flash-preview)
const vertexResult = await getSummaryAndTags(assetId, {
  provider: "vertex",
  tone: "professional"
});

// Compare results
console.log("OpenAI:", openaiResult.title);
console.log("Anthropic:", anthropicResult.title);
console.log("Google:", googleResult.title);
console.log("Bedrock:", bedrockResult.title);
console.log("Vertex:", vertexResult.title);
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

// Google (default: gemini-3-flash-preview)
const googleChapters = await generateChapters(assetId, "en", {
  provider: "google"
});

// Amazon Bedrock (default: us.anthropic.claude-sonnet-4-5-20250929-v1:0)
const bedrockChapters = await generateChapters(assetId, "en", {
  provider: "bedrock"
});

// Google Vertex AI (default: gemini-3-flash-preview)
const vertexChapters = await generateChapters(assetId, "en", {
  provider: "vertex"
});
```

### Using Amazon Bedrock

Amazon Bedrock lets you access foundation models through your AWS account, using AWS credentials for authentication. This is ideal for teams with existing AWS spend commitments.

```typescript
// Uses AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY from env
const result = await getSummaryAndTags(assetId, {
  provider: "bedrock"
});

// Override the default model
const result = await getSummaryAndTags(assetId, {
  provider: "bedrock",
  model: "us.anthropic.claude-3-7-sonnet-20250219-v1:0"
});
```

Bedrock also supports AWS credential chains (IAM roles, instance profiles) when explicit credentials are not set. See the [Amazon Bedrock docs](https://docs.aws.amazon.com/bedrock/latest/userguide/) for details.

### Using Google Vertex AI

Google Vertex AI lets you access Gemini models through your Google Cloud account. Authentication supports API key (express mode) or Application Default Credentials (ADC).

```typescript
// Uses GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION from env
const result = await getSummaryAndTags(assetId, {
  provider: "vertex"
});

// Override the default model
const result = await getSummaryAndTags(assetId, {
  provider: "vertex",
  model: "gemini-2.5-flash"
});
```

When running on GCP (Cloud Run, GKE, etc.), Application Default Credentials are automatically available. See the [Vertex AI docs](https://cloud.google.com/vertex-ai/docs/start/introduction-unified-platform) for details.

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

// Use a different Bedrock model
const bedrockResult = await getSummaryAndTags(assetId, {
  provider: "bedrock",
  model: "us.meta.llama3-3-70b-instruct-v1:0" // Llama on Bedrock
});
```

**Cost Optimization Tip:** The defaults (`gpt-5.1`, `claude-sonnet-4-5`, `gemini-3-flash-preview`) are optimized for cost/quality balance. Bedrock and Vertex give you the same models with potential cost savings through committed cloud spend. Only upgrade to more powerful models when quality needs justify the higher cost.
