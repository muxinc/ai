# @mux/ai

AI-powered video analysis library for Mux, built in TypeScript.

## Features

- **Video Summarization**: Generate titles, descriptions, and tags from video content
- **Multi-modal Analysis**: Combines storyboard images with video transcripts
- **Tone Control**: Normal, sassy, or professional analysis styles
- **Provider Support**: Currently supports OpenAI (Anthropic and others coming soon)
- **TypeScript**: Fully typed for excellent developer experience

## Installation

```bash
npm install @mux/ai
```

## Quick Start

```typescript
import { getSummaryAndTags } from '@mux/ai';

// Uses built-in optimized prompt
const result = await getSummaryAndTags('your-mux-asset-id', {
  tone: 'professional'
});

console.log(result.title);       // Short, descriptive title
console.log(result.description); // Detailed description
console.log(result.tags);        // Array of relevant keywords
console.log(result.storyboardUrl); // URL to video storyboard
```

## Configuration

Set environment variables:

```bash
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret
OPENAI_API_KEY=your_openai_api_key
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
- `tone?: 'normal' | 'sassy' | 'professional'` - Analysis tone (default: 'normal')
- `model?: string` - OpenAI model to use (default: 'gpt-4o-mini')
- `includeTranscript?: boolean` - Include video transcript in analysis (default: true)
- `muxTokenId?: string` - Mux API token ID
- `muxTokenSecret?: string` - Mux API token secret  
- `openaiApiKey?: string` - OpenAI API key

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

### Custom Prompts

Override the default prompt:

```typescript
const result = await getSummaryAndTags(
  assetId, 
  'Custom analysis prompt here',
  { tone: 'professional' }
);
```

## Examples

See the `examples/` directory for complete working examples:

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

## Planned Features

- **Moderation**: `getModerationScores()` for content safety
- **Translation**: `translateCaptions()` for multilingual support
- **Additional Providers**: Anthropic Claude integration

## License

MIT © Mux, Inc.