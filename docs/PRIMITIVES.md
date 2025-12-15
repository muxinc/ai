# Primitives

Low-level building blocks for constructing custom AI workflows with Mux video data.

## Overview

Primitives are focused utilities that fetch and transform Mux video data without making AI provider calls. Use these when you need to:

- Build custom AI prompts with Mux data
- Combine Mux video data with your own logic
- Create workflows not covered by the pre-built options

All workflows in `@mux/ai/workflows` are composed from these primitives.

```typescript
import {
  chunkByTokens,
  chunkVTTCues,
  fetchTranscriptForAsset,
  getStoryboardUrl,
  getThumbnailUrls,
  parseVTTCues
} from "@mux/ai/primitives";
```

## Transcript Primitives

### `fetchTranscriptForAsset(asset, playbackId, options?)`

Fetches and optionally cleans transcript text from a Mux asset.

```typescript
import Mux from "@mux/mux-node";

import { fetchTranscriptForAsset } from "@mux/ai/primitives";

const mux = new Mux();
const asset = await mux.video.assets.retrieve("asset-id");
const playbackId = asset.playback_ids?.[0]?.id || "";

const result = await fetchTranscriptForAsset(asset, playbackId, {
  languageCode: "en",
  cleanTranscript: true // Remove VTT formatting
});

console.log(result.transcriptText); // Clean text
console.log(result.transcriptUrl); // VTT file URL
console.log(result.track); // Mux track metadata
```

**Options:**

- `languageCode?: string` - Language code (defaults to first available track)
- `cleanTranscript?: boolean` - Remove VTT timestamps and formatting (default: true)
- `shouldSign?: boolean` - For signed playback policies

### `extractTextFromVTT(vttContent)`

Cleans VTT content to plain text by removing timestamps, formatting, and metadata.

```typescript
import { extractTextFromVTT } from "@mux/ai/primitives";

const vttContent = `WEBVTT

00:00:00.000 --> 00:00:03.000
Hello and welcome to the video.

00:00:03.000 --> 00:00:06.000
Today we'll be discussing AI.`;

const cleanText = extractTextFromVTT(vttContent);
// "Hello and welcome to the video. Today we'll be discussing AI."
```

### `parseVTTCues(vttContent)`

Parses VTT into structured cues with timing information.

```typescript
import { parseVTTCues } from "@mux/ai/primitives";

const cues = parseVTTCues(vttContent);
// [
//   { startTime: 0, endTime: 3, text: "Hello and welcome to the video." },
//   { startTime: 3, endTime: 6, text: "Today we'll be discussing AI." }
// ]
```

**Returns:** `VTTCue[]`

```typescript
interface VTTCue {
  startTime: number; // Seconds
  endTime: number; // Seconds
  text: string; // Cleaned text
}
```

### `extractTimestampedTranscript(vttContent)`

Converts VTT to timestamped text format for AI prompts.

```typescript
import { extractTimestampedTranscript } from "@mux/ai/primitives";

const timestamped = extractTimestampedTranscript(vttContent);
// "[0s] Hello and welcome to the video.
// [3s] Today we'll be discussing AI."
```

## Image Primitives

### `getStoryboardUrl(playbackId, width?, shouldSign?)`

Generates a Mux storyboard URL (sprite sheet of video frames).

```typescript
import { getStoryboardUrl } from "@mux/ai/primitives";

const storyboardUrl = await getStoryboardUrl("playback-id", 640);
// "https://image.mux.com/playback-id/storyboard.png?width=640"
```

**Parameters:**

- `playbackId: string` - Mux playback ID
- `width?: number` - Storyboard width in pixels (default: 640)
- `shouldSign?: boolean` - For signed playback policies

### `getThumbnailUrls(playbackId, duration, options?)`

Generates thumbnail URLs at regular intervals throughout the video.

```typescript
import { getThumbnailUrls } from "@mux/ai/primitives";

const thumbnails = await getThumbnailUrls("playback-id", 120, {
  interval: 10, // Every 10 seconds
  width: 640
});

// [
//   "https://image.mux.com/playback-id/thumbnail.png?time=0&width=640",
//   "https://image.mux.com/playback-id/thumbnail.png?time=10&width=640",
//   ...
// ]
```

**Options:**

```typescript
interface ThumbnailOptions {
  interval?: number; // Seconds between thumbnails (default: 10)
  width?: number; // Thumbnail width in pixels (default: 640)
  shouldSign?: boolean; // For signed playback
}
```

**Behavior:**

- Videos ≤50 seconds: Generates 5 evenly-spaced thumbnails
- Videos >50 seconds: Uses specified interval

## Text Chunking Primitives

Utilities for splitting transcripts into manageable chunks for embedding generation or long-form analysis.

### `chunkByTokens(text, maxTokens, overlapTokens?)`

Chunks text by approximate token count with optional overlap.

```typescript
import { chunkByTokens } from "@mux/ai/primitives";

const transcript = "Your long transcript text here...";

const chunks = chunkByTokens(transcript, 500, 100);
// [
//   { id: "chunk-0", text: "...", tokenCount: 500 },
//   { id: "chunk-1", text: "...", tokenCount: 500 },
//   ...
// ]
```

**Parameters:**

- `text: string` - Text to chunk
- `maxTokens: number` - Maximum tokens per chunk
- `overlapTokens?: number` - Overlap between chunks (default: 0)

**Note:** Uses word-count approximation (1 token ≈ 0.75 words). For production use with OpenAI, consider using `tiktoken` for accurate token counts.

### `chunkVTTCues(cues, maxTokens, overlapCues?)`

Chunks VTT cues while preserving timing information and cue boundaries.

```typescript
import { chunkVTTCues, parseVTTCues } from "@mux/ai/primitives";

const cues = parseVTTCues(vttContent);
const chunks = chunkVTTCues(cues, 500, 2);

// [
//   {
//     id: "chunk-0",
//     text: "...",
//     tokenCount: 485,
//     startTime: 0,
//     endTime: 45.5
//   },
//   ...
// ]
```

**Parameters:**

- `cues: VTTCue[]` - Parsed VTT cues
- `maxTokens: number` - Maximum tokens per chunk
- `overlapCues?: number` - Number of cues to overlap (default: 2)

**Benefits over token-based chunking:**

- Respects natural speech boundaries
- Preserves accurate timestamps for each chunk
- Better for video search and timestamped results

### `estimateTokenCount(text)`

Estimates token count using word-count approximation.

```typescript
import { estimateTokenCount } from "@mux/ai/primitives";

const count = estimateTokenCount("Hello world");
// ~3 tokens
```

## Helper Functions

### `findCaptionTrack(asset, languageCode?)`

Finds a ready caption track on a Mux asset.

```typescript
import { findCaptionTrack } from "@mux/ai/primitives";

const track = findCaptionTrack(asset, "en");
// Returns first ready English subtitle track, or undefined
```

### `getReadyTextTracks(asset)`

Gets all ready text tracks from a Mux asset.

```typescript
import { getReadyTextTracks } from "@mux/ai/primitives";

const tracks = getReadyTextTracks(asset);
// Returns all tracks with status === "ready"
```

### `buildTranscriptUrl(playbackId, trackId, shouldSign?)`

Builds a transcript URL with optional signing for secure playback.

```typescript
import { buildTranscriptUrl } from "@mux/ai/primitives";

const url = await buildTranscriptUrl("playback-id", "track-id");
// "https://stream.mux.com/playback-id/text/track-id.vtt"

// With signing (requires MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables)
const signedUrl = await buildTranscriptUrl("playback-id", "track-id", true);
// URL with ?token=... appended
```

## Building Custom Workflows

Combine primitives to create custom AI workflows:

```typescript
import { openai } from "@ai-sdk/openai";
import Mux from "@mux/mux-node";
import { generateText } from "ai";

import {
  chunkVTTCues,
  fetchTranscriptForAsset,
  getStoryboardUrl,
  parseVTTCues
} from "@mux/ai/primitives";

async function customVideoAnalysis(assetId: string) {
  const mux = new Mux();
  const asset = await mux.video.assets.retrieve(assetId);
  const playbackId = asset.playback_ids?.[0]?.id || "";

  // Fetch transcript
  const { transcriptText } = await fetchTranscriptForAsset(
    asset,
    playbackId,
    { languageCode: "en" }
  );

  // Get storyboard
  const storyboardUrl = await getStoryboardUrl(playbackId);

  // Build custom prompt
  const result = await generateText({
    model: openai("gpt-4o-mini"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this video and extract key insights." },
          { type: "image", image: storyboardUrl },
          { type: "text", text: `Transcript: ${transcriptText}` }
        ]
      }
    ]
  });

  return result.text;
}
```

## Composing Workflows

### Combining Multiple Workflows

Compose pre-built workflows to create higher-level features:

```typescript
import { getModerationScores, getSummaryAndTags } from "@mux/ai/workflows";

export async function summarizeIfSafe(assetId: string) {
  // Check content first
  const moderation = await getModerationScores(assetId, {
    provider: "openai"
  });

  if (moderation.exceedsThreshold) {
    throw new Error("Asset failed content safety review");
  }

  // Then summarize
  return getSummaryAndTags(assetId, {
    provider: "anthropic",
    tone: "professional"
  });
}
```

### Building Custom Workflows

Drop down to primitives when you need complete control over the AI prompt and logic:

```typescript
import { openai } from "@ai-sdk/openai";
import Mux from "@mux/mux-node";
import { generateText } from "ai";

import { fetchTranscriptForAsset, getStoryboardUrl } from "@mux/ai/primitives";

export async function customTranscriptAnalysis(assetId: string) {
  const mux = new Mux();
  const asset = await mux.video.assets.retrieve(assetId);
  const playbackId = asset.playback_ids?.[0]?.id || "";

  // Use primitives to fetch Mux data
  const { transcriptText } = await fetchTranscriptForAsset(
    asset,
    playbackId,
    { languageCode: "en" }
  );

  const storyboardUrl = await getStoryboardUrl(playbackId);

  // Build your custom AI prompt
  const result = await generateText({
    model: openai("gpt-4o-mini"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Your custom prompt here" },
          { type: "image", image: storyboardUrl },
          { type: "text", text: transcriptText }
        ]
      }
    ]
  });

  return result.text;
}
```

### Using with Other AI SDKs

Primitives work with any AI SDK, not just Vercel AI SDK:

```typescript
import OpenAI from "openai";

import { fetchTranscriptForAsset, getStoryboardUrl } from "@mux/ai/primitives";

const openai = new OpenAI();

async function analyzeWithOpenAISDK(assetId: string) {
  const mux = new Mux();
  const asset = await mux.video.assets.retrieve(assetId);
  const playbackId = asset.playback_ids?.[0]?.id || "";

  const { transcriptText } = await fetchTranscriptForAsset(asset, playbackId);
  const storyboardUrl = await getStoryboardUrl(playbackId);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this video" },
          { type: "image_url", image_url: { url: storyboardUrl } },
          { type: "text", text: transcriptText }
        ]
      }
    ]
  });

  return response.choices[0].message.content;
}
```

### Creating Reusable Custom Workflows

Build your own workflow functions following the library patterns:

```typescript
import { openai } from "@ai-sdk/openai";
import Mux from "@mux/mux-node";
import { generateText } from "ai";

import { fetchTranscriptForAsset } from "@mux/ai/primitives";

interface SentimentResult {
  assetId: string;
  sentiment: "positive" | "negative" | "neutral";
  score: number;
  summary: string;
}

export async function analyzeSentiment(
  assetId: string,
): Promise<SentimentResult> {
  const mux = new Mux({
    tokenId: process.env.MUX_TOKEN_ID,
    tokenSecret: process.env.MUX_TOKEN_SECRET
  });

  const asset = await mux.video.assets.retrieve(assetId);
  const playbackId = asset.playback_ids?.[0]?.id || "";

  const { transcriptText } = await fetchTranscriptForAsset(
    asset,
    playbackId
  );

  const result = await generateText({
    model: openai("gpt-4o-mini", {
      apiKey: process.env.OPENAI_API_KEY
    }),
    messages: [
      {
        role: "system",
        content: "Analyze the sentiment of this video transcript. Return JSON with sentiment (positive/negative/neutral), score (0-1), and summary."
      },
      {
        role: "user",
        content: transcriptText
      }
    ]
  });

  return {
    assetId,
    ...JSON.parse(result.text)
  };
}
```

## Signed Playback

All primitives support signed playback for assets with `playback_policy: "signed"`.

```typescript
// Primitives automatically sign URLs when shouldSign is provided and MUX_SIGNING_KEY + MUX_PRIVATE_KEY are defined in your env
// NOTE: Make sure you validate these environment variables if you want to sign URLs. This is done automatically when using workflows
// that have signed URL capabilities.
const shouldSign = true;

const storyboardUrl = await getStoryboardUrl(playbackId, 640, shouldSign);
const thumbnails = await getThumbnailUrls(playbackId, duration, { shouldSign });
const transcript = await fetchTranscriptForAsset(asset, playbackId, { shouldSign });
```

See the [signed playback examples](./EXAMPLES.md#signed-playback-examples) for more details.
