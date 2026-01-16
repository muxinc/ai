# Audio-Only Workflows

This project supports audio-only assets (no video track) across several workflows. The main requirement is a ready text track (captions/transcript) because there are no storyboard thumbnails to analyze.

## Supported Workflows

### Summarization (`getSummaryAndTags`)

Summarizes audio-only content by analyzing transcript text only. Audio-only assets require `includeTranscript: true` and a ready text track.

```typescript
import { getSummaryAndTags } from "@mux/ai/workflows";

const result = await getSummaryAndTags("your-audio-only-asset-id", {
  provider: "openai",
  includeTranscript: true,
});
```

### Content Moderation (`getModerationScores`)

For audio-only assets, moderation runs on the transcript instead of thumbnails. Use OpenAI for audio-only moderation.

```typescript
import { getModerationScores } from "@mux/ai/workflows";

const result = await getModerationScores("your-audio-only-asset-id", {
  provider: "openai",
});
```

### Chapter Generation (`generateChapters`)

Chapters are generated from the transcript with timestamps. If the asset has a single ready text track, it is used automatically for audio-only assets.

```typescript
import { generateChapters } from "@mux/ai/workflows";

const result = await generateChapters("your-audio-only-asset-id", "en", {
  provider: "openai",
});
```

### Embeddings (`generateEmbeddings`)

Embeddings are computed from transcript text. Audio-only assets require a transcript (single-track fallback is supported).

```typescript
import { generateEmbeddings } from "@mux/ai/workflows";

const result = await generateEmbeddings("your-audio-only-asset-id", {
  provider: "openai",
  chunkingStrategy: { type: "token", maxTokens: 500, overlap: 100 },
});
```

### Caption Translation (`translateCaptions`)

Translate a transcript VTT to another language and optionally upload back to Mux. Audio-only assets can use the single available text track.

```typescript
import { translateCaptions } from "@mux/ai/workflows";

const result = await translateCaptions("your-audio-only-asset-id", "en", "es", {
  provider: "google",
});
```

### Audio Dubbing (`translateAudio`)

Creates a new audio track using ElevenLabs voice cloning. Works for audio-only assets and uploads the result to Mux.

```typescript
import { translateAudio } from "@mux/ai/workflows";

const result = await translateAudio("your-audio-only-asset-id", "es", {
  provider: "elevenlabs",
});
```

## Requirements for Audio-Only Assets

- A ready text track (captions or transcript) is required for summarization, moderation, chapters, embeddings, and caption translation.
- For caption translation, the source language code must match an existing track.
- For dubbing, the asset must have an `audio.m4a` static rendition and S3-compatible storage configured.

## Tips and Examples

- See `examples/summarization/audio-only-example.ts` for a working summarization example.
- If your asset has only one text track, workflows will automatically fall back to it even if it is not labeled as subtitles.
