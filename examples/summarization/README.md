# Summarization Examples

This directory contains examples demonstrating how to use the `getSummaryAndTags` helper from `@mux/ai/workflows`.

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

Demonstrates how to use `promptOverrides` to customize the summarization for specific use cases:

```bash
# Use a preset (seo, social, technical, ecommerce)
npm run example:summarization:custom <asset-id> --preset seo

# Custom override via CLI
npm run example:summarization:custom <asset-id> --task "Focus on product features"

# Combine preset with additional overrides
npm run example:summarization:custom <asset-id> --preset social --title-guidance "Make it viral"
```

**Available Presets:**

- `seo` - Search engine optimized metadata for discoverability
- `social` - Social media optimized for engagement and shares
- `technical` - Production/cinematography focused analysis
- `ecommerce` - Product video metadata for conversions

**Overridable Sections:**

- `task` - Main instruction for what to analyze
- `title` - Guidance for title generation
- `description` - Guidance for description generation
- `keywords` - Guidance for keyword/tag generation
- `qualityGuidelines` - General quality instructions

## Configuration Options

Key options for `getSummaryAndTags`:

- `provider`: `'openai' | 'anthropic' | 'google'` (default: `'openai'`)
- `model`: Provider-specific chat model (defaults per provider, e.g. `gpt-5.1`)
- `tone`: `'normal' | 'sassy' | 'professional'` (default: `'normal'`)
- `includeTranscript`: Include the asset transcript when available (default: `true`)
- `imageSubmissionMode`: `'url' | 'base64'` storyboard transport (default: `'url'`)
- `promptOverrides`: Override specific sections of the prompt (see below)

All credentials are automatically read from environment variables (`MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).

### Using `promptOverrides`

The `promptOverrides` option lets you customize specific sections of the prompt while keeping the rest of the defaults:

```typescript
import { getSummaryAndTags } from "@mux/ai/workflows";

// SEO-optimized metadata
const seoResult = await getSummaryAndTags(assetId, {
  promptOverrides: {
    task: "Generate SEO-optimized metadata for search engines.",
    title: "Create a search-optimized title (50-60 chars) with primary keyword front-loaded.",
    keywords: "Focus on high search volume terms and long-tail keywords.",
  },
});

// Social media optimized
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
    keywords: "Use industry-standard production terminology.",
  },
});
```

## What You'll Get

Each analysis returns:

- `title`: Short headline for the video content
- `description`: Rich description (≤500 chars)
- `tags`: Array of up to 10 keywords/topics
- `storyboardUrl`: URL to the storyboard image that was analyzed
- `assetId`: The Mux asset ID that was analyzed
