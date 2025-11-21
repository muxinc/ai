# Summarization Examples

This directory contains examples demonstrating how to use the `getSummaryAndTags` helper from `@mux/ai/functions`.

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
# Optional additional providers
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_GENERATIVE_AI_API_KEY=your_google_generative_ai_key
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

Key options for `getSummaryAndTags`:

- `provider`: `'openai' | 'anthropic' | 'google'` (default: `'openai'`)
- `model`: Provider-specific chat model (defaults per provider, e.g. `gpt-5-mini`)
- `tone`: `'normal' | 'sassy' | 'professional'` (default: `'normal'`)
- `includeTranscript`: Include the asset transcript when available (default: `true`)
- `imageSubmissionMode`: `'url' | 'base64'` storyboard transport (default: `'url'`)
- Credential overrides (all fall back to env vars): `muxTokenId`, `muxTokenSecret`, `openaiApiKey`, `anthropicApiKey`, `googleApiKey`

## What You'll Get

Each analysis returns:
- `title`: Short headline for the video content
- `description`: Rich description (≤500 chars)
- `tags`: Array of up to 10 keywords/topics
- `storyboardUrl`: URL to the storyboard image that was analyzed
- `assetId`: The Mux asset ID that was analyzed