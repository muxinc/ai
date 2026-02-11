# Workflow to Mux Primitive Mapping

Quick reference for where each workflow reads/writes Mux data, and which primitives/helpers are involved.

## Legend

- `✓` = always used
- `◐` = conditionally used
- `—` = not used

## Asset + Service Matrix (fast scan)

| Workflow | Asset metadata (`video.assets.retrieve`) | Storyboard (`image.mux.com/.../storyboard.png`) | Thumbnails (`image.mux.com/.../thumbnail.png`) | Transcript (`stream.mux.com/.../text/{trackId}.vtt`) | Audio (`stream.mux.com/.../audio.m4a`) | Writes track to Mux (`assets.createTrack`) |
| --- | --- | --- | --- | --- | --- | --- |
| `getSummaryAndTags` | ✓ | ◐ video assets | — | ◐ optional (required for audio-only) | — | — |
| `askQuestions` | ✓ | ✓ | — | ◐ optional | — | — |
| `hasBurnedInCaptions` | ✓ | ✓ | — | — | — | — |
| `getModerationScores` | ✓ | — | ◐ video assets | ◐ audio-only assets | — | — |
| `generateChapters` | ✓ | — | — | ✓ required | — | — |
| `generateEmbeddings` | ✓ | — | — | ✓ required | — | — |
| `translateCaptions` | ✓ | — | — | ✓ required | — | ◐ text track (default `uploadToMux=true`) |
| `translateAudio` | ✓ | — | — | — | ✓ required | ◐ audio track (default `uploadToMux=true`) |

## Workflow -> Primitive/Helper Mapping

| Workflow (source) | Primitives/helpers touched | What is pulled from Mux | Writes to Mux | Other services in path |
| --- | --- | --- | --- | --- |
| `getSummaryAndTags` (`src/workflows/summarization.ts`) | `getPlaybackIdForAssetWithClient`, `fetchTranscriptForAsset`, `getStoryboardUrl`, `isAudioOnlyAsset` | Asset payload + playback ID, optional transcript VTT/text, storyboard image | None | LLM provider (OpenAI/Anthropic/Google) |
| `askQuestions` (`src/workflows/ask-questions.ts`) | `getPlaybackIdForAssetWithClient`, `fetchTranscriptForAsset`, `getStoryboardUrl` | Asset payload + playback ID, storyboard image, optional transcript VTT/text | None | LLM provider |
| `hasBurnedInCaptions` (`src/workflows/burned-in-captions.ts`) | `getPlaybackIdForAssetWithClient`, `getStoryboardUrl` | Asset payload + playback ID, storyboard image | None | LLM provider |
| `getModerationScores` (`src/workflows/moderation.ts`) | `getPlaybackIdForAssetWithClient`, `getThumbnailUrls`, `fetchTranscriptForAsset`, `getReadyTextTracks` | Video: sampled thumbnails. Audio-only: transcript text chunks. | None | OpenAI Moderation API or Hive |
| `generateChapters` (`src/workflows/chapters.ts`) | `getPlaybackIdForAssetWithClient`, `fetchTranscriptForAsset`, `getReadyTextTracks`, `extractTimestampedTranscript` | Transcript VTT (kept with timestamps) | None | LLM provider |
| `generateEmbeddings` (`src/workflows/embeddings.ts`) | `getPlaybackIdForAssetWithClient`, `fetchTranscriptForAsset`, `getReadyTextTracks`, `parseVTTCues`, `chunkVTTCues`/`chunkText` | Transcript (raw VTT for VTT chunking, cleaned text for token chunking) | None | Embedding provider (OpenAI/Google) |
| `translateCaptions` (`src/workflows/translate-captions.ts`) | `getPlaybackIdForAssetWithClient`, `getReadyTextTracks`, `buildTranscriptUrl` | Source transcript VTT track | Creates new **text/subtitles** track (optional) | LLM provider + S3-compatible storage |
| `translateAudio` (`src/workflows/translate-audio.ts`) | `getPlaybackIdForAssetWithClient`, `signUrl` (for signed playback), static rendition helpers in workflow | `audio.m4a` static rendition (creates/polls rendition if missing) | Creates new **audio** track (optional) | ElevenLabs + S3-compatible storage |

## Shared Mux URL Entry Points

- Storyboard: `getStoryboardUrl()` -> `https://image.mux.com/{playbackId}/storyboard.png?width={w}`
- Thumbnails: `getThumbnailUrls()` -> `https://image.mux.com/{playbackId}/thumbnail.png?time={t}&width={w}`
- Transcript VTT: `buildTranscriptUrl()` -> `https://stream.mux.com/{playbackId}/text/{trackId}.vtt`
- Audio rendition (translate-audio workflow): `https://stream.mux.com/{playbackId}/audio.m4a`

If playback policy is `signed`, URLs above are tokenized via `signUrl(...)` and require `MUX_SIGNING_KEY` + `MUX_PRIVATE_KEY` (or a `muxClient` carrying signing keys).
