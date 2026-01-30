# API Reference

## `getSummaryAndTags(assetId, options?)`

Analyzes a Mux video asset and returns AI-generated metadata.

**Parameters:**

- `assetId` (string) - Mux video asset ID
- `options` (optional) - Configuration options

**Options:**

- `provider?: 'openai' | 'anthropic' | 'google'` - AI provider (default: 'openai')
- `tone?: 'neutral' | 'playful' | 'professional'` - Analysis tone (default: 'neutral')
- `model?: string` - AI model to use (defaults: `gpt-5.1`, `claude-sonnet-4-5`, or `gemini-3-flash-preview`)
- `includeTranscript?: boolean` - Include video transcript in analysis (default: true)
- `cleanTranscript?: boolean` - Remove VTT timestamps and formatting from transcript (default: true)
- `imageSubmissionMode?: 'url' | 'base64'` - How to submit storyboard to AI providers (default: 'url')
- `imageDownloadOptions?: object` - Options for image download when using base64 mode
  - `timeout?: number` - Request timeout in milliseconds (default: 10000)
  - `retries?: number` - Maximum retry attempts (default: 3)
  - `retryDelay?: number` - Base delay between retries in milliseconds (default: 1000)
  - `maxRetryDelay?: number` - Maximum delay between retries in milliseconds (default: 10000)
  - `exponentialBackoff?: boolean` - Whether to use exponential backoff (default: true)
- `promptOverrides?: object` - Override specific sections of the prompt for custom use cases
  - `task?: string` - Override the main task instruction
  - `title?: string` - Override title generation guidance
  - `description?: string` - Override description generation guidance
  - `keywords?: string` - Override keywords generation guidance
  - `qualityGuidelines?: string` - Override quality guidelines

**Returns:**

```typescript
interface SummaryAndTagsResult {
  assetId: string;
  title: string; // Short title (max 100 chars)
  description: string; // Detailed description
  tags: string[]; // Relevant keywords
  storyboardUrl: string; // Video storyboard URL
}
```

## `getModerationScores(assetId, options?)`

Analyzes a Mux asset for inappropriate content using OpenAI's Moderation API or Hive's Moderation API.

- For **video assets**, this moderates **storyboard thumbnails** (image moderation).
- For **audio-only assets**, this moderates the **underlying transcript text** (text moderation).

**Parameters:**

- `assetId` (string) - Mux asset ID (video or audio-only)
- `options` (optional) - Configuration options

**Options:**

- `provider?: 'openai' | 'hive'` - Moderation provider (default: 'openai')
- `model?: string` - OpenAI moderation model to use (default: `omni-moderation-latest`)
- `languageCode?: string` - Transcript language code when moderating audio-only assets (optional)
- `thresholds?: { sexual?: number; violence?: number }` - Custom thresholds (default: {sexual: 0.7, violence: 0.8})
- `thumbnailInterval?: number` - Seconds between thumbnails for long videos (default: 10)
- `thumbnailWidth?: number` - Thumbnail width in pixels (default: 640)
- `maxConcurrent?: number` - Maximum concurrent API requests (default: 5)
- `imageSubmissionMode?: 'url' | 'base64'` - How to submit images to AI providers (default: 'url')
- `imageDownloadOptions?: object` - Options for image download when using base64 mode
  - `timeout?: number` - Request timeout in milliseconds (default: 10000)
  - `retries?: number` - Maximum retry attempts (default: 3)
  - `retryDelay?: number` - Base delay between retries in milliseconds (default: 1000)
  - `maxRetryDelay?: number` - Maximum delay between retries in milliseconds (default: 10000)
  - `exponentialBackoff?: boolean` - Whether to use exponential backoff (default: true)

Credentials (`MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `OPENAI_API_KEY`, `HIVE_API_KEY`) are read from environment variables by default. For Workflow Dev Kit multi-tenant usage, pass encrypted `credentials` in options (see README).

**Hive note (audio-only):** transcript moderation submits `text_data` and requires a Hive **Text Moderation** project/API key. If you use a Visual Moderation key, Hive will reject the request (see [Hive Text Moderation docs](https://docs.thehive.ai/docs/classification-text)).

**Returns:**

```typescript
{
  assetId: string;
  mode: 'thumbnails' | 'transcript';
  isAudioOnly: boolean;
  thumbnailScores: Array<{ // Individual thumbnail results
    url: string;
    sexual: number; // 0-1 score
    violence: number; // 0-1 score
    error: boolean;
  }>;
  maxScores: { // Highest scores across all thumbnails (or transcript chunks for audio-only)
    sexual: number;
    violence: number;
  };
  exceedsThreshold: boolean; // true if content should be flagged
  thresholds: { // Threshold values used
    sexual: number;
    violence: number;
  };
}
```

## `hasBurnedInCaptions(assetId, options?)`

Analyzes video frames to detect burned-in captions (hardcoded subtitles) that are permanently embedded in the video image.

**Parameters:**

- `assetId` (string) - Mux video asset ID
- `options` (optional) - Configuration options

**Options:**

- `provider?: 'openai' | 'anthropic' | 'google'` - AI provider (default: 'openai')
- `model?: string` - AI model to use (defaults: `gpt-5.1`, `claude-sonnet-4-5`, or `gemini-3-flash-preview`)
- `imageSubmissionMode?: 'url' | 'base64'` - How to submit storyboard to AI providers (default: 'url')
- `imageDownloadOptions?: object` - Options for image download when using base64 mode
  - `timeout?: number` - Request timeout in milliseconds (default: 10000)
  - `retries?: number` - Maximum retry attempts (default: 3)
  - `retryDelay?: number` - Base delay between retries in milliseconds (default: 1000)
  - `maxRetryDelay?: number` - Maximum delay between retries in milliseconds (default: 10000)
  - `exponentialBackoff?: boolean` - Whether to use exponential backoff (default: true)

**Returns:**

```typescript
{
  assetId: string;
  hasBurnedInCaptions: boolean; // Whether burned-in captions were detected
  confidence: number; // Confidence score (0.0-1.0)
  detectedLanguage: string | null; // Language of detected captions, or null
  storyboardUrl: string; // URL to analyzed storyboard
}
```

**Detection Logic:**

- Analyzes video storyboard frames to identify text overlays
- Distinguishes between actual captions and marketing/end-card text
- Text appearing only in final 1-2 frames is classified as marketing copy
- Caption text must appear across multiple frames throughout the timeline
- Both providers use optimized prompts to minimize false positives

## `askQuestions(assetId, questions, options?)`

Answer yes/no questions about video content by analyzing storyboard frames and optional transcripts. Process multiple questions in a single API call for efficiency.

**Parameters:**

- `assetId` (string) - Mux video asset ID
- `questions` (array) - Array of question objects
  - Each question object must have a `question` field (string)
  - Example: `[{ question: "Does this video contain cooking?" }]`
- `options` (optional) - Configuration options

**Options:**

- `provider?: 'openai'` - AI provider (default: 'openai', currently only OpenAI supported)
- `model?: string` - AI model to use (default: `gpt-5.1`)
- `includeTranscript?: boolean` - Include video transcript in analysis (default: true)
- `cleanTranscript?: boolean` - Remove VTT timestamps and formatting from transcript (default: true)
- `imageSubmissionMode?: 'url' | 'base64'` - How to submit storyboard to AI providers (default: 'url')
- `imageDownloadOptions?: object` - Options for image download when using base64 mode
  - `timeout?: number` - Request timeout in milliseconds (default: 10000)
  - `retries?: number` - Maximum retry attempts (default: 3)
  - `retryDelay?: number` - Base delay between retries in milliseconds (default: 1000)
  - `maxRetryDelay?: number` - Maximum delay between retries in milliseconds (default: 10000)
  - `exponentialBackoff?: boolean` - Whether to use exponential backoff (default: true)
- `storyboardWidth?: number` - Storyboard resolution in pixels (default: 640)

**Returns:**

```typescript
interface AskQuestionsResult {
  assetId: string;
  answers: Array<{
    question: string; // The original question
    answer: "yes" | "no"; // Binary answer
    confidence: number; // Confidence score (0.0-1.0)
    reasoning: string; // AI's explanation based on observable evidence
  }>;
  storyboardUrl: string; // URL to analyzed storyboard
  usage?: { // Token usage statistics
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  transcriptText?: string; // Raw transcript (when includeTranscript is true)
}
```

**Examples:**

```typescript
// Single question
const result = await askQuestions("asset-id", [
  { question: "Does this video contain cooking?" }
]);

console.log(result.answers[0].answer); // "yes" or "no"
console.log(result.answers[0].confidence); // 0.95
console.log(result.answers[0].reasoning); // "A chef prepares ingredients..."

// Multiple questions (efficient single API call)
const result = await askQuestions("asset-id", [
  { question: "Does this video contain people?" },
  { question: "Is this video in color?" },
  { question: "Does this video contain violence?" }
]);

// Without transcript (visual-only analysis)
const result = await askQuestions("asset-id", questions, {
  includeTranscript: false
});
```

**Tips for Effective Questions:**

- Be specific and focused on observable evidence
- Frame questions positively (prefer "Is X present?" over "Is X not present?")
- Avoid ambiguous or subjective questions
- Questions should have clear yes/no answers
- The AI prioritizes visual evidence when transcript and visuals conflict

## `translateCaptions(assetId, fromLanguageCode, toLanguageCode, options?)`

Translates existing captions from one language to another and optionally adds them as a new track to the Mux asset.

**Parameters:**

- `assetId` (string) - Mux asset ID (video or audio-only)
- `fromLanguageCode` (string) - Source language code (e.g., 'en', 'es', 'fr')
- `toLanguageCode` (string) - Target language code (e.g., 'es', 'fr', 'de')
- `options` (optional) - Configuration options

**Options:**

- `provider: 'openai' | 'anthropic' | 'google'` - AI provider (required)
- `model?: string` - Model to use (defaults to the provider's chat-vision model if omitted)
- `uploadToMux?: boolean` - Whether to upload translated track to Mux (default: true)
- `s3Endpoint?: string` - S3-compatible storage endpoint
- `s3Region?: string` - S3 region (default: 'auto')
- `s3Bucket?: string` - S3 bucket name

**Returns:**

```typescript
interface TranslateCaptionsResult {
  assetId: string;
  sourceLanguageCode: string;
  targetLanguageCode: string;
  originalVtt: string; // Original VTT content
  translatedVtt: string; // Translated VTT content
  uploadedTrackId?: string; // Mux track ID (if uploaded)
  presignedUrl?: string; // S3 presigned URL (expires in 1 hour)
}
```

**Supported Languages:**
All ISO 639-1 language codes are automatically supported using `Intl.DisplayNames`. Examples: Spanish (es), French (fr), German (de), Italian (it), Portuguese (pt), Polish (pl), Japanese (ja), Korean (ko), Chinese (zh), Russian (ru), Arabic (ar), Hindi (hi), Thai (th), Swahili (sw), and many more.

## `generateChapters(assetId, languageCode, options?)`

Generates AI-powered chapter markers by analyzing video or audio transcripts. Creates logical chapter breaks based on topic changes and content transitions.

**Parameters:**

- `assetId` (string) - Mux video asset ID
- `languageCode` (string) - Language code for captions (e.g., 'en', 'es', 'fr')
- `options` (optional) - Configuration options

**Options:**

- `provider?: 'openai' | 'anthropic' | 'google'` - AI provider (default: 'openai')
- `model?: string` - AI model to use (defaults: `gpt-5.1`, `claude-sonnet-4-5`, or `gemini-3-flash-preview`)

**Returns:**

```typescript
{
  assetId: string;
  languageCode: string;
  chapters: Array<{
    startTime: number; // Chapter start time in seconds
    title: string; // Descriptive chapter title
  }>;
}
```

**Requirements:**

- Asset must have a ready caption/transcript track in the specified language
- Uses existing auto-generated or uploaded captions/transcripts

**Example Output:**

```javascript
// Perfect format for Mux Player
player.addChapters([
  { startTime: 0, title: "Introduction and Setup" },
  { startTime: 45, title: "Main Content Discussion" },
  { startTime: 120, title: "Conclusion" }
]);
```

## `translateAudio(assetId, toLanguageCode, options?)`

Creates AI-dubbed audio tracks from existing media content using ElevenLabs voice cloning and translation. Uses the default audio track on your asset, language is auto-detected.

**Parameters:**

- `assetId` (string) - Mux asset ID (video or audio-only; must have audio.m4a static rendition)
- `toLanguageCode` (string) - Target language code (e.g., 'es', 'fr', 'de')
- `options` (optional) - Configuration options

**Options:**

- `provider?: 'elevenlabs'` - AI provider (default: 'elevenlabs')
- `numSpeakers?: number` - Number of speakers (default: 0 for auto-detect)
- `uploadToMux?: boolean` - Whether to upload dubbed track to Mux (default: true)
- `s3Endpoint?: string` - S3-compatible storage endpoint
- `s3Region?: string` - S3 region (default: 'auto')
- `s3Bucket?: string` - S3 bucket name

**Returns:**

```typescript
interface TranslateAudioResult {
  assetId: string;
  targetLanguageCode: string;
  dubbingId: string; // ElevenLabs dubbing job ID
  uploadedTrackId?: string; // Mux audio track ID (if uploaded)
  presignedUrl?: string; // S3 presigned URL (expires in 1 hour)
}
```

**Requirements:**

- Asset must have an `audio.m4a` static rendition
- ElevenLabs API key with Creator plan or higher
- S3-compatible storage for Mux ingestion

**Supported Languages:**
ElevenLabs supports 32+ languages with automatic language name detection via `Intl.DisplayNames`. Supported languages include English, Spanish, French, German, Italian, Portuguese, Polish, Japanese, Korean, Chinese, Russian, Arabic, Hindi, Thai, and many more. Track names are automatically generated (e.g., "Polish (auto-dubbed)").

## `generateEmbeddings(assetId, options?)`

Generate vector embeddings for transcript chunks from video or audio assets for semantic search.

**Deprecated:**
`generateVideoEmbeddings` is deprecated. Use `generateEmbeddings` instead.

**Parameters:**

- `assetId` (string) - Mux asset ID
- `options` (optional) - Configuration options

**Options:**

- `provider?: 'openai' | 'google'` - Embedding provider (default: 'openai')
- `model?: string` - Model to use (defaults: `text-embedding-3-small` for OpenAI, `gemini-embedding-001` for Google)
- `chunkingStrategy?: object` - How to chunk the transcript
  - `type: 'token' | 'vtt'` - Chunking method
  - `maxTokens?: number` - Maximum tokens per chunk (default: 500)
  - `overlap?: number` - Token overlap between chunks (for type: 'token', default: 100)
  - `overlapCues?: number` - VTT cue overlap between chunks (for type: 'vtt', default: 2)
- `languageCode?: string` - Language code for transcript (default: 'en')

**Returns:**

```typescript
{
  assetId: string;
  chunks: Array<{
    chunkId: string;
    embedding: number[]; // Vector embedding
    metadata: {
      startTime?: number; // Chunk start time in seconds
      endTime?: number; // Chunk end time in seconds
      tokenCount: number;
    };
  }>;
  averagedEmbedding: number[]; // Single embedding for entire transcript
  provider: string;
  model: string;
  metadata: {
    totalChunks: number;
    totalTokens: number;
    chunkingStrategy: string;
    embeddingDimensions: number;
    generatedAt: string;
  };
}
```

## Custom Prompts with `promptOverrides`

Customize specific sections of the summarization prompt for different use cases like SEO, social media, or technical analysis.

**Tip:** Before adding overrides, read through the default summarization prompt template in `src/functions/summarization.ts` (the `summarizationPromptBuilder` config) so that you have clear context on what each section does and what you're changing.

```typescript
import { getSummaryAndTags } from "@mux/ai/workflows";

// SEO-optimized metadata
const seoResult = await getSummaryAndTags(assetId, {
  tone: "professional",
  promptOverrides: {
    task: "Generate SEO-optimized metadata that maximizes discoverability.",
    title: "Create a search-optimized title (50-60 chars) with primary keyword front-loaded.",
    keywords: "Focus on high search volume terms and long-tail keywords.",
  },
});

// Social media optimized for engagement
const socialResult = await getSummaryAndTags(assetId, {
  promptOverrides: {
    title: "Create a scroll-stopping headline using emotional triggers or curiosity gaps.",
    description: "Write shareable copy that creates FOMO and works without watching the video.",
    keywords: "Generate hashtag-ready keywords for trending and niche community tags.",
  },
});

// Technical/production analysis
const technicalResult = await getSummaryAndTags(assetId, {
  tone: "professional",
  promptOverrides: {
    task: "Analyze cinematography, lighting, and production techniques.",
    title: "Describe the production style or filmmaking technique.",
    description: "Provide a technical breakdown of camera work, lighting, and editing.",
    keywords: "Use industry-standard production terminology.",
  },
});
```

**Available override sections:**
| Section | Description |
|---------|-------------|
| `task` | Main instruction for what to analyze |
| `title` | Guidance for generating the title |
| `description` | Guidance for generating the description |
| `keywords` | Guidance for generating keywords/tags |
| `qualityGuidelines` | General quality instructions |

Each override can be a simple string (replaces the section content) or a full `PromptSection` object for advanced control over XML tag names and attributes.
