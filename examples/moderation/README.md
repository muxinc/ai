# Moderation Examples

This directory contains examples demonstrating how to use the `getModerationScores` helper from `@mux/ai/workflows`.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set environment variables in your `.env` file (same as parent project):

```bash
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret
OPENAI_API_KEY=your_openai_api_key
# Optional Hive provider
HIVE_API_KEY=your_hive_visual_moderation_key
# Optional Google Vision SafeSearch provider
GOOGLE_VISION_API_KEY=your_google_vision_api_key
```

## Examples

### Basic Example (`basic-example.ts`)

Demonstrates basic moderation analysis with default settings:

```bash
npm run basic <your-asset-id>
```

Features:

- Analyzes video thumbnails for sexual and violent content
- Uses default thresholds (sexual: 0.7, violence: 0.8)
- Shows individual thumbnail scores and overall results
- Reports whether content would be flagged

### Custom Thresholds (`custom-thresholds.ts`)

Shows how different threshold settings affect moderation results:

```bash
npm run thresholds <your-asset-id>
```

Compares three threshold levels:

- **Strict**: Lower thresholds (0.3/0.3) - more likely to flag content
- **Default**: Standard thresholds (0.7/0.8) - balanced approach
- **Permissive**: Higher thresholds (0.9/0.9) - less likely to flag content

### Hive Example

Demonstrates running moderation through Hive’s Visual Moderation API:

```bash
# From this directory
npm run basic <your-asset-id> hive

# Or from the project root
npm run example:moderation <your-asset-id> hive
```

Features:

- Requires `HIVE_API_KEY` plus standard Mux credentials.
- You can use stricter default thresholds in your own code (e.g. `0.9/0.9`), matching Hive’s recommended starting point from their docs.
- Prints both aggregate and per-thumbnail scores so you can tune thresholds quickly.

### Google Vision API Example

Demonstrates running moderation through Google Cloud Vision SafeSearch:

```bash
# From this directory
npm run basic <your-asset-id> google-vision-api

# Or from the project root
npm run example:moderation <your-asset-id> google-vision-api
```

Features:

- Requires `GOOGLE_VISION_API_KEY` plus standard Mux credentials.
- Image-only — audio-only assets are not supported by SafeSearch and will throw a clear error.
- SafeSearch returns discrete `Likelihood` buckets (`UNKNOWN`..`VERY_LIKELY`); these are mapped to a 0..1 scale so they slot into the same threshold model as the other providers.
  - `LIKELY` → 0.8 and `VERY_LIKELY` → 1.0; the default 0.8 threshold treats only `VERY_LIKELY` as exceeding (the comparison is strict `>`).

## How It Works

1. **Thumbnail Generation**: Creates thumbnails at regular intervals
   - Short videos (≤50s): 5 evenly spaced thumbnails
   - Long videos: One thumbnail every 10 seconds

2. **Parallel Analysis**: Sends thumbnails to the selected provider (OpenAI Moderation endpoint, Hive Visual Moderation API, or Google Vision SafeSearch)

3. **Score Aggregation**: Takes the maximum score across all thumbnails for each category

4. **Threshold Comparison**: Flags content if any category exceeds its threshold

## Configuration Options

Key options for `getModerationScores`:

- `provider`: `'openai' | 'hive' | 'google-vision-api'` (default: `'openai'`)
- `model`: OpenAI moderation model (e.g. `omni-moderation-latest`) — ignored for Hive and Google Vision
- `thresholds`: Custom thresholds for sexual and violence content
- `thumbnailInterval`: Seconds between thumbnails for long videos (default: 10)
- `thumbnailWidth`: Thumbnail width in pixels (default: 640)

All credentials are automatically read from environment variables (`MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `OPENAI_API_KEY`, `HIVE_API_KEY`, `GOOGLE_VISION_API_KEY`).

## What You'll Get

Each analysis returns:

- `thumbnailScores`: Individual scores for each thumbnail analyzed
- `maxScores`: Highest scores found across all thumbnails
- `exceedsThreshold`: Boolean indicating if content should be flagged
- `thresholds`: The threshold values used for analysis
- `assetId`: The Mux asset ID that was analyzed

## Content Categories

Currently analyzes two categories:

- **Sexual**: Adult/sexual content detection
- **Violence**: Violent content detection

Scores range from 0.0 (no detected content) to 1.0 (high confidence detection).
