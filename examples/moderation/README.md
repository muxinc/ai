# Moderation Examples

This directory contains examples demonstrating how to use the `getModerationScores` function from `@mux/ai`.

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

## How It Works

1. **Thumbnail Generation**: Creates thumbnails at regular intervals
   - Short videos (≤50s): 5 evenly spaced thumbnails
   - Long videos: One thumbnail every 10 seconds

2. **Parallel Analysis**: Sends all thumbnails to OpenAI's moderation API concurrently

3. **Score Aggregation**: Takes the maximum score across all thumbnails for each category

4. **Threshold Comparison**: Flags content if any category exceeds its threshold

## Configuration Options

The `getModerationScores` function accepts these options:

- `provider`: 'openai' (default and only supported provider)
- `model`: OpenAI model to use (default: 'omni-moderation-latest')
- `thresholds`: Custom thresholds for sexual and violence content
- `thumbnailInterval`: Seconds between thumbnails for long videos (default: 10)
- `thumbnailWidth`: Thumbnail width in pixels (default: 640)
- `muxTokenId/muxTokenSecret`: Mux credentials
- `openaiApiKey`: OpenAI API key

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