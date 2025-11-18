# @mux/ai

AI-powered video analysis library for Mux, built in TypeScript.

## Available Tools

| Function | Description | Providers | Default Models | Input | Output |
|----------|-------------|-----------|----------------|--------|--------|
| `getSummaryAndTags` | Generate titles, descriptions, and tags from a Mux video asset | OpenAI, Anthropic | `gpt-4o-mini`, `claude-3-5-haiku-20241022` | Asset ID + options | Title, description, tags, storyboard URL |
| `getModerationScores` | Analyze video thumbnails for inappropriate content | OpenAI, Hive | `omni-moderation-latest`, Hive Visual API | Asset ID + thresholds | Sexual/violence scores, flagged status |
| `hasBurnedInCaptions` | Detect burned-in captions (hardcoded subtitles) in video frames | OpenAI, Anthropic | `gpt-4o-mini`, `claude-3-5-haiku-20241022` | Asset ID + options | Boolean result, confidence, language |
| `generateChapters` | Generate AI-powered chapter markers from video captions | OpenAI, Anthropic | `gpt-4o-mini`, `claude-3-5-haiku-20241022` | Asset ID + language + options | Timestamped chapter list |
| `translateCaptions` | Translate video captions to different languages | Anthropic only | `claude-sonnet-4-20250514` | Asset ID + languages + S3 config | Translated VTT + Mux track ID |
| `translateAudio` | Create AI-dubbed audio tracks in different languages | ElevenLabs only | ElevenLabs Dubbing API | Asset ID + languages + S3 config | Dubbed audio + Mux track ID |

## Features

- **Cost-Effective by Default**: Uses affordable models like `gpt-4o-mini` and `claude-3-5-haiku` to keep analysis costs low while maintaining high quality results
- **Multi-modal Analysis**: Combines storyboard images with video transcripts
- **Tone Control**: Normal, sassy, or professional analysis styles (summarization only)
- **Configurable Thresholds**: Custom sensitivity levels for content moderation
- **TypeScript**: Fully typed for excellent developer experience
- **Provider Choice**: Switch between OpenAI and Anthropic for different perspectives
- **Universal Language Support**: Automatic language name detection using `Intl.DisplayNames` for all ISO 639-1 codes

## Installation

```bash
npm install @mux/ai
```

## Quick Start

### Video Summarization

```typescript
import { getSummaryAndTags } from '@mux/ai';

// Uses built-in optimized prompt
const result = await getSummaryAndTags('your-mux-asset-id', {
  tone: 'professional'
});

console.log(result.title);       // Short, descriptive title
console.log(result.description); // Detailed description
console.log(result.tags);        // Array of relevant keywords
console.log(result.storyboardUrl); // URL to Mux storyboard

// Use base64 mode for improved reliability (works with both OpenAI and Anthropic)
const reliableResult = await getSummaryAndTags('your-mux-asset-id', {
  provider: 'anthropic',
  imageSubmissionMode: 'base64',  // Uses Files API for Anthropic, base64 for OpenAI
  imageDownloadOptions: {
    timeout: 15000,
    retries: 2,
    retryDelay: 1000
  },
  tone: 'professional'
});
```

### Content Moderation

```typescript
import { getModerationScores } from '@mux/ai';

// Analyze Mux video asset for inappropriate content (OpenAI default)
const result = await getModerationScores('your-mux-asset-id', {
  thresholds: { sexual: 0.7, violence: 0.8 }
});

console.log(result.maxScores);        // Highest scores across all thumbnails
console.log(result.exceedsThreshold); // true if content should be flagged
console.log(result.thumbnailScores);  // Individual thumbnail results

// Or use Hive for moderation
const hiveResult = await getModerationScores('your-mux-asset-id', {
  provider: 'hive',
  thresholds: { sexual: 0.7, violence: 0.8 }
});

// Use base64 submission for improved reliability (downloads images locally)
const reliableResult = await getModerationScores('your-mux-asset-id', {
  provider: 'openai',
  imageSubmissionMode: 'base64',
  imageDownloadOptions: {
    timeout: 15000,
    retries: 3,
    retryDelay: 1000
  }
});

// Hive also supports base64 mode (uses multipart upload)
const hiveReliableResult = await getModerationScores('your-mux-asset-id', {
  provider: 'hive',
  imageSubmissionMode: 'base64',
  imageDownloadOptions: {
    timeout: 15000,
    retries: 2,
    retryDelay: 1000
  }
});
```

### Burned-in Caption Detection

```typescript
import { hasBurnedInCaptions } from '@mux/ai';

// Detect burned-in captions (hardcoded subtitles) in video frames
const result = await hasBurnedInCaptions('your-mux-asset-id', {
  provider: 'openai'
});

console.log(result.hasBurnedInCaptions); // true/false
console.log(result.confidence);         // 0.0-1.0 confidence score
console.log(result.detectedLanguage);   // Language if captions detected
console.log(result.storyboardUrl);      // Video storyboard analyzed

// Compare providers
const anthropicResult = await hasBurnedInCaptions('your-mux-asset-id', {
  provider: 'anthropic',
  model: 'claude-3-5-haiku-20241022'
});

// Use base64 mode for improved reliability
const reliableResult = await hasBurnedInCaptions('your-mux-asset-id', {
  provider: 'openai',
  imageSubmissionMode: 'base64',
  imageDownloadOptions: {
    timeout: 15000,
    retries: 3,
    retryDelay: 1000
  }
});
```

#### Image Submission Modes

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
- For Hive: uploads images via multipart/form-data (Hive doesn't support base64 data URIs)
- For Anthropic (summarization): uploads to Files API then references by file_id (no size limit)

```typescript
// High reliability mode - recommended for production
const result = await getModerationScores(assetId, {
  imageSubmissionMode: 'base64',
  imageDownloadOptions: {
    timeout: 15000,      // 15s timeout per image
    retries: 3,          // Retry failed downloads 3x
    retryDelay: 1000,    // 1s base delay with exponential backoff
    exponentialBackoff: true
  }
});
```

### Caption Translation

```typescript
import { translateCaptions } from '@mux/ai';

// Translate existing captions to Spanish and add as new track
const result = await translateCaptions(
  'your-mux-asset-id',
  'en',  // from language
  'es',  // to language
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514'
  }
);

console.log(result.uploadedTrackId);  // New Mux track ID
console.log(result.presignedUrl);     // S3 file URL
console.log(result.translatedVtt);    // Translated VTT content
```

### Video Chapters

```typescript
import { generateChapters } from '@mux/ai';

// Generate AI-powered chapters from video captions
const result = await generateChapters('your-mux-asset-id', 'en', {
  provider: 'openai'
});

console.log(result.chapters);  // Array of {startTime: number, title: string}

// Use with Mux Player
const player = document.querySelector('mux-player');
player.addChapters(result.chapters);

// Compare providers
const anthropicResult = await generateChapters('your-mux-asset-id', 'en', {
  provider: 'anthropic',
  model: 'claude-3-5-haiku-20241022'
});
```

### Audio Dubbing

```typescript
import { translateAudio } from '@mux/ai';

// Create AI-dubbed audio track and add to Mux asset
// Uses the default audio track on your asset, language is auto-detected
const result = await translateAudio(
  'your-mux-asset-id',
  'es',  // target language
  {
    provider: 'elevenlabs',
    numSpeakers: 0 // Auto-detect speakers
  }
);

console.log(result.dubbingId);        // ElevenLabs dubbing job ID
console.log(result.uploadedTrackId);  // New Mux audio track ID
console.log(result.presignedUrl);     // S3 audio file URL
```

### Compare Summarization from Providers

```typescript
import { getSummaryAndTags } from '@mux/ai';

// Compare different AI providers analyzing the same Mux video asset
const assetId = 'your-mux-asset-id';

// OpenAI analysis (default: gpt-4o-mini)
const openaiResult = await getSummaryAndTags(assetId, {
  provider: 'openai',
  tone: 'professional'
});

// Anthropic analysis (default: claude-3-5-haiku-20241022)  
const anthropicResult = await getSummaryAndTags(assetId, {
  provider: 'anthropic',
  tone: 'professional'
});

// Compare results
console.log('OpenAI:', openaiResult.title);
console.log('Anthropic:', anthropicResult.title);
```

## Configuration

Set environment variables:

```bash
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
HIVE_API_KEY=your_hive_api_key

# S3-Compatible Storage (required for translation & audio dubbing)
S3_ENDPOINT=https://your-s3-endpoint.com
S3_REGION=auto
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
```

Or pass credentials directly:

```typescript
const result = await getSummaryAndTags(assetId, {
  muxTokenId: 'your-token-id',
  muxTokenSecret: 'your-token-secret',
  openaiApiKey: 'your-openai-key'
});
```

## API Reference

### `getSummaryAndTags(assetId, options?)`

Analyzes a Mux video asset and returns AI-generated metadata.

**Parameters:**
- `assetId` (string) - Mux video asset ID
- `options` (optional) - Configuration options

**Options:**
- `provider?: 'openai' | 'anthropic'` - AI provider (default: 'openai')
- `tone?: 'normal' | 'sassy' | 'professional'` - Analysis tone (default: 'normal')
- `model?: string` - AI model to use (default: 'gpt-4o-mini' for OpenAI, 'claude-3-5-haiku-20241022' for Anthropic)
- `includeTranscript?: boolean` - Include video transcript in analysis (default: true)
- `cleanTranscript?: boolean` - Remove VTT timestamps and formatting from transcript (default: true)
- `imageSubmissionMode?: 'url' | 'base64'` - How to submit storyboard to AI providers (default: 'url')
- `imageDownloadOptions?: object` - Options for image download when using base64 mode
  - `timeout?: number` - Request timeout in milliseconds (default: 10000)
  - `retries?: number` - Maximum retry attempts (default: 3)
  - `retryDelay?: number` - Base delay between retries in milliseconds (default: 1000)
  - `maxRetryDelay?: number` - Maximum delay between retries in milliseconds (default: 10000)
  - `exponentialBackoff?: boolean` - Whether to use exponential backoff (default: true)
- `muxTokenId?: string` - Mux API token ID
- `muxTokenSecret?: string` - Mux API token secret  
- `openaiApiKey?: string` - OpenAI API key
- `anthropicApiKey?: string` - Anthropic API key

**Returns:**
```typescript
{
  assetId: string;
  title: string;        // Short title (max 100 chars)
  description: string;  // Detailed description
  tags: string[];       // Relevant keywords
  storyboardUrl: string; // Video storyboard URL
}
```

### `getModerationScores(assetId, options?)`

Analyzes video thumbnails for inappropriate content using OpenAI's moderation API or Hive's Visual Moderation API.

**Parameters:**
- `assetId` (string) - Mux video asset ID
- `options` (optional) - Configuration options

**Options:**
- `provider?: 'openai' | 'hive'` - Moderation provider (default: 'openai')
- `model?: string` - OpenAI model to use (default: 'omni-moderation-latest')
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
- `muxTokenId/muxTokenSecret/openaiApiKey?: string` - API credentials
- `hiveApiKey?: string` - Hive API key (required for Hive provider)

**Returns:**
```typescript
{
  assetId: string;
  thumbnailScores: Array<{     // Individual thumbnail results
    url: string;
    sexual: number;            // 0-1 score
    violence: number;          // 0-1 score
    error: boolean;
  }>;
  maxScores: {                 // Highest scores across all thumbnails
    sexual: number;
    violence: number;
  };
  exceedsThreshold: boolean;   // true if content should be flagged
  thresholds: {                // Threshold values used
    sexual: number;
    violence: number;
  };
}
```

### `hasBurnedInCaptions(assetId, options?)`

Analyzes video frames to detect burned-in captions (hardcoded subtitles) that are permanently embedded in the video image.

**Parameters:**
- `assetId` (string) - Mux video asset ID
- `options` (optional) - Configuration options

**Options:**
- `provider?: 'openai' | 'anthropic'` - AI provider (default: 'openai')
- `model?: string` - AI model to use (default: 'gpt-4o-mini' for OpenAI, 'claude-3-5-haiku-20241022' for Anthropic)
- `imageSubmissionMode?: 'url' | 'base64'` - How to submit storyboard to AI providers (default: 'url')
- `imageDownloadOptions?: object` - Options for image download when using base64 mode
  - `timeout?: number` - Request timeout in milliseconds (default: 10000)
  - `retries?: number` - Maximum retry attempts (default: 3)
  - `retryDelay?: number` - Base delay between retries in milliseconds (default: 1000)
  - `maxRetryDelay?: number` - Maximum delay between retries in milliseconds (default: 10000)
  - `exponentialBackoff?: boolean` - Whether to use exponential backoff (default: true)
- `muxTokenId?: string` - Mux API token ID
- `muxTokenSecret?: string` - Mux API token secret
- `openaiApiKey?: string` - OpenAI API key
- `anthropicApiKey?: string` - Anthropic API key

**Returns:**
```typescript
{
  assetId: string;
  hasBurnedInCaptions: boolean;  // Whether burned-in captions were detected
  confidence: number;            // Confidence score (0.0-1.0)
  detectedLanguage: string | null; // Language of detected captions, or null
  storyboardUrl: string;         // URL to analyzed storyboard
}
```

**Detection Logic:**
- Analyzes video storyboard frames to identify text overlays
- Distinguishes between actual captions and marketing/end-card text
- Text appearing only in final 1-2 frames is classified as marketing copy
- Caption text must appear across multiple frames throughout the timeline
- Both providers use optimized prompts to minimize false positives

### `translateCaptions(assetId, fromLanguageCode, toLanguageCode, options?)`

Translates existing captions from one language to another and optionally adds them as a new track to the Mux asset.

**Parameters:**
- `assetId` (string) - Mux video asset ID
- `fromLanguageCode` (string) - Source language code (e.g., 'en', 'es', 'fr')
- `toLanguageCode` (string) - Target language code (e.g., 'es', 'fr', 'de')
- `options` (optional) - Configuration options

**Options:**
- `provider?: 'anthropic'` - AI provider (default: 'anthropic')
- `model?: string` - Model to use (default: 'claude-sonnet-4-20250514')
- `uploadToMux?: boolean` - Whether to upload translated track to Mux (default: true)
- `s3Endpoint?: string` - S3-compatible storage endpoint
- `s3Region?: string` - S3 region (default: 'auto')
- `s3Bucket?: string` - S3 bucket name
- `s3AccessKeyId?: string` - S3 access key ID
- `s3SecretAccessKey?: string` - S3 secret access key
- `muxTokenId/muxTokenSecret/anthropicApiKey?: string` - API credentials

**Returns:**
```typescript
{
  assetId: string;
  sourceLanguageCode: string;
  targetLanguageCode: string;
  originalVtt: string;         // Original VTT content
  translatedVtt: string;       // Translated VTT content
  uploadedTrackId?: string;    // Mux track ID (if uploaded)
  presignedUrl?: string;       // S3 presigned URL (expires in 1 hour)
}
```

**Supported Languages:**
All ISO 639-1 language codes are automatically supported using `Intl.DisplayNames`. Examples: Spanish (es), French (fr), German (de), Italian (it), Portuguese (pt), Polish (pl), Japanese (ja), Korean (ko), Chinese (zh), Russian (ru), Arabic (ar), Hindi (hi), Thai (th), Swahili (sw), and many more.

### `generateChapters(assetId, languageCode, options?)`

Generates AI-powered chapter markers by analyzing video captions. Creates logical chapter breaks based on topic changes and content transitions.

**Parameters:**
- `assetId` (string) - Mux video asset ID
- `languageCode` (string) - Language code for captions (e.g., 'en', 'es', 'fr')
- `options` (optional) - Configuration options

**Options:**
- `provider?: 'openai' | 'anthropic'` - AI provider (default: 'openai')
- `model?: string` - AI model to use (default: 'gpt-4o-mini' for OpenAI, 'claude-3-5-haiku-20241022' for Anthropic)
- `muxTokenId?: string` - Mux API token ID
- `muxTokenSecret?: string` - Mux API token secret
- `openaiApiKey?: string` - OpenAI API key
- `anthropicApiKey?: string` - Anthropic API key

**Returns:**
```typescript
{
  assetId: string;
  languageCode: string;
  chapters: Array<{
    startTime: number;    // Chapter start time in seconds
    title: string;        // Descriptive chapter title
  }>;
}
```

**Requirements:**
- Asset must have caption track in the specified language
- Caption track must be in 'ready' status
- Uses existing auto-generated or uploaded captions

**Example Output:**
```javascript
// Perfect format for Mux Player
player.addChapters([
  {startTime: 0, title: 'Introduction and Setup'},
  {startTime: 45, title: 'Main Content Discussion'}, 
  {startTime: 120, title: 'Conclusion'}
]);
```

### `translateAudio(assetId, toLanguageCode, options?)`

Creates AI-dubbed audio tracks from existing video content using ElevenLabs voice cloning and translation. Uses the default audio track on your asset, language is auto-detected.

**Parameters:**
- `assetId` (string) - Mux video asset ID (must have audio.m4a static rendition)
- `toLanguageCode` (string) - Target language code (e.g., 'es', 'fr', 'de')
- `options` (optional) - Configuration options

**Options:**
- `provider?: 'elevenlabs'` - AI provider (default: 'elevenlabs')
- `numSpeakers?: number` - Number of speakers (default: 0 for auto-detect)
- `uploadToMux?: boolean` - Whether to upload dubbed track to Mux (default: true)
- `s3Endpoint?: string` - S3-compatible storage endpoint
- `s3Region?: string` - S3 region (default: 'auto')
- `s3Bucket?: string` - S3 bucket name
- `s3AccessKeyId?: string` - S3 access key ID
- `s3SecretAccessKey?: string` - S3 secret access key
- `elevenLabsApiKey?: string` - ElevenLabs API key
- `muxTokenId/muxTokenSecret?: string` - API credentials

**Returns:**
```typescript
{
  assetId: string;
  targetLanguageCode: string;
  dubbingId: string;           // ElevenLabs dubbing job ID
  uploadedTrackId?: string;    // Mux audio track ID (if uploaded)
  presignedUrl?: string;       // S3 presigned URL (expires in 1 hour)
}
```

**Requirements:**
- Asset must have an `audio.m4a` static rendition
- ElevenLabs API key with Creator plan or higher
- S3-compatible storage for Mux ingestion

**Supported Languages:**
ElevenLabs supports 32+ languages with automatic language name detection via `Intl.DisplayNames`. Supported languages include English, Spanish, French, German, Italian, Portuguese, Polish, Japanese, Korean, Chinese, Russian, Arabic, Hindi, Thai, and many more. Track names are automatically generated (e.g., "Polish (auto-dubbed)").

### Custom Prompts

Override the default summarization prompt:

```typescript
const result = await getSummaryAndTags(
  assetId, 
  'Custom analysis prompt here',
  { tone: 'professional' }
);
```

## Examples

See the `examples/` directory for complete working examples.

### Quick Start (Run from Root)

You can run examples directly from the project root without installing dependencies in each example folder:

```bash
# Chapters
npm run example:chapters <asset-id> [language-code] [provider]
npm run example:chapters:compare <asset-id> [language-code]

# Burned-in Caption Detection
npm run example:burned-in <asset-id> [provider]
npm run example:burned-in:compare <asset-id>

# Summarization
npm run example:summarization <asset-id>
npm run example:summarization:compare <asset-id>

# Moderation
npm run example:moderation <asset-id>
npm run example:moderation:compare <asset-id>
```

**Examples:**
```bash
# Generate chapters with OpenAI
npm run example:chapters abc123 en openai

# Detect burned-in captions with Anthropic
npm run example:burned-in abc123 anthropic

# Compare OpenAI vs Anthropic chapter generation
npm run example:chapters:compare abc123 en

# Run moderation analysis
npm run example:moderation abc123
```

**Prerequisites:**
Set up your `.env` file with API credentials:
```bash
MUX_TOKEN_ID=your_token_id
MUX_TOKEN_SECRET=your_token_secret
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
```

### Summarization Examples
- **Basic Usage**: Default prompt with different tones
- **Custom Prompts**: Override default behavior
- **Tone Variations**: Compare analysis styles

```bash
cd examples/summarization
npm install
npm run basic <your-asset-id>
npm run tones <your-asset-id>
npm run custom
```

### Moderation Examples
- **Basic Moderation**: Analyze content with default thresholds
- **Custom Thresholds**: Compare strict/default/permissive settings
- **Hive Provider**: Use Hive's Visual Moderation API
- **Provider Comparison**: Compare OpenAI vs Hive results side-by-side

```bash
cd examples/moderation
npm install
npm run basic <your-asset-id>
npm run thresholds <your-asset-id>
npm run hive <your-asset-id>
npm run compare <your-asset-id>
```

### Burned-in Caption Examples
- **Basic Detection**: Detect burned-in captions with different AI providers
- **Provider Comparison**: Compare OpenAI vs Anthropic detection accuracy

```bash
cd examples/burned-in-captions
npm install
npm run burned-in:basic <your-asset-id> [provider]
npm run compare <your-asset-id>
```

### Chapter Generation Examples
- **Basic Chapters**: Generate chapters with different AI providers
- **Provider Comparison**: Compare OpenAI vs Anthropic chapter generation

```bash
cd examples/chapters
npm install
npm run chapters:basic <your-asset-id> [language-code] [provider]
npm run compare <your-asset-id> [language-code]
```

### Translation Examples
- **Basic Translation**: Translate captions and upload to Mux
- **Translation Only**: Translate without uploading to Mux

```bash
cd examples/translation
npm install
npm run basic <your-asset-id> en es
npm run translation-only <your-asset-id> en fr
```

**Translation Workflow:**
1. Fetches existing captions from Mux asset
2. Translates VTT content using Anthropic Claude
3. Uploads translated VTT to S3-compatible storage
4. Generates presigned URL (1-hour expiry)
5. Adds new subtitle track to Mux asset
6. Track name: "{Language} (auto-translated)"

### Audio Dubbing Examples
- **Basic Dubbing**: Create AI-dubbed audio and upload to Mux
- **Dubbing Only**: Create dubbed audio without uploading to Mux

```bash
cd examples/audio-translation
npm install
npm run basic <your-asset-id> es
npm run dubbing-only <your-asset-id> fr
```

**Audio Dubbing Workflow:**
1. Checks asset has audio.m4a static rendition
2. Downloads default audio track from Mux
3. Creates ElevenLabs dubbing job with automatic language detection
4. Polls for completion (up to 30 minutes)
5. Downloads dubbed audio file
6. Uploads to S3-compatible storage
7. Generates presigned URL (1-hour expiry)
8. Adds new audio track to Mux asset
9. Track name: "{Language} (auto-dubbed)"

## S3-Compatible Storage

The translation feature requires S3-compatible storage to temporarily host VTT files for Mux ingestion. Supported providers include:

- **AWS S3** - Amazon's object storage
- **DigitalOcean Spaces** - S3-compatible with CDN
- **Cloudflare R2** - Zero egress fees
- **MinIO** - Self-hosted S3 alternative
- **Backblaze B2** - Cost-effective storage
- **Wasabi** - Hot cloud storage

**Why S3 Storage?**
Mux requires a publicly accessible URL to ingest subtitle tracks. The translation workflow:
1. Uploads translated VTT to your S3 storage
2. Generates a presigned URL for secure access
3. Mux fetches the file using the presigned URL
4. File remains in your storage for future use

## Planned Features

- **Additional Translation Providers**: OpenAI GPT-4 support
- **Batch Translation**: Translate multiple assets at once
- **Custom Translation Prompts**: Override default translation behavior

## License

MIT © Mux, Inc.