# Summarization Examples

This directory contains examples demonstrating how to use the `getSummaryAndTags` function from `@mux/ai`.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables in your `.env` file:
```bash
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret
OPENAI_API_KEY=your_openai_api_key
```

## Examples

### Basic Example (`basic-example.ts`)

Demonstrates the most straightforward usage with the built-in default prompt:

```bash
npm run basic <your-asset-id>
```

Features:
- Uses the built-in optimized prompt
- Professional tone analysis
- Includes transcript data when available
- Shows summary, tags, and storyboard URL

### Tone Variations (`tone-variations.ts`)

Shows how different tone settings affect the analysis output using the default prompt:

```bash
npm run tones <your-asset-id>
```

Compares three tone styles:
- **Normal**: Clear, straightforward analysis
- **Sassy**: Playful, engaging personality
- **Professional**: Executive-level, business-appropriate

### Custom Prompt Example (`custom-prompt-example.ts`)

Demonstrates how to override the default prompt with your own:

```bash
npm run custom
```

Shows how to provide a custom prompt for specialized analysis needs.

## Configuration Options

The `getSummaryAndTags` function accepts these options:

- `tone`: 'normal' | 'sassy' | 'professional' (default: 'normal')
- `model`: OpenAI model to use (default: 'gpt-4o-mini')
- `includeTranscript`: Whether to include video transcript in analysis (default: true)
- `muxTokenId`: Mux API token ID (or use MUX_TOKEN_ID env var)
- `muxTokenSecret`: Mux API token secret (or use MUX_TOKEN_SECRET env var)
- `openaiApiKey`: OpenAI API key (or use OPENAI_API_KEY env var)

## What You'll Get

Each analysis returns:
- `summary`: AI-generated summary of the video content
- `tags`: Array of relevant keywords/topics
- `storyboardUrl`: URL to the video's storyboard image
- `assetId`: The Mux asset ID that was analyzed