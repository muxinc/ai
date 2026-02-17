# Prompt Customization

`@mux/ai` workflows use a **prompt builder** pattern that makes it easy to experiment with and customize the AI prompts powering each workflow — without forking the library or rewriting anything from scratch.

Every workflow that accepts a `promptOverrides` option is backed by a structured prompt template made up of named sections. You can override any section with a simple string, and the rest of the prompt stays intact. This makes it easy to iterate on specific aspects of the output (e.g. title style, keyword strategy) while keeping the battle-tested defaults for everything else.

## How It Works

Each workflow prompt is built from an ordered list of **sections**, where each section is rendered as an XML-like tag:

```xml
<task>
Analyze the storyboard frames and generate metadata...
</task>

<title_requirements>
A short, compelling headline...
</title_requirements>

<keywords_requirements>
Specific, searchable terms...
</keywords_requirements>
```

When you pass `promptOverrides`, you replace the content of individual sections by name. Sections you don't override keep their defaults.

```ts
const result = await getSummaryAndTags(assetId, {
  provider: "openai",
  promptOverrides: {
    // Only override the title and keywords sections — everything else stays default
    title: "Create a search-optimized title (50-60 chars) with the primary keyword front-loaded.",
    keywords: "Focus on high search volume terms and long-tail keyword phrases.",
  },
});
```

## Supported Workflows

| Workflow | Override sections |
| --- | --- |
| `getSummaryAndTags` | `task`, `title`, `description`, `keywords`, `qualityGuidelines` |
| `generateChapters` | `task`, `titleGuidelines`, `chapterGuidelines` |
| `hasBurnedInCaptions` | `task`, `positiveIndicators`, `negativeIndicators`, `confidenceGuidelines` |

## Presets: Common Override Patterns

Here are ready-to-use override sets for common use cases. Copy and adapt these as starting points.

### SEO-Optimized Metadata

```ts
const result = await getSummaryAndTags(assetId, {
  tone: "professional",
  promptOverrides: {
    task: "Generate SEO-optimized metadata that maximizes discoverability.",
    title: "Create a search-optimized title (50-60 chars) with the primary keyword front-loaded.",
    keywords: "Focus on high search volume terms and long-tail keyword phrases. Use lowercase.",
  },
});
```

### Social Media Engagement

```ts
const result = await getSummaryAndTags(assetId, {
  promptOverrides: {
    title: "Create a scroll-stopping headline using emotional triggers or curiosity gaps.",
    description: "Write shareable copy that creates FOMO and works without watching the video.",
    keywords: "Generate hashtag-ready keywords for trending and niche community tags.",
  },
});
```

### E-Commerce Product Videos

```ts
const result = await getSummaryAndTags(assetId, {
  promptOverrides: {
    task: "Generate e-commerce optimized metadata for product videos that drive conversions.",
    title: 'Format: "[Product Type] - [Key Benefit] | [Brand if visible]"',
    description: "Highlight visible product features and benefits. Address potential buyer questions.",
    keywords: "Include product category, features, use cases, and purchase-intent modifiers.",
  },
});
```

### Technical / Production Analysis

```ts
const result = await getSummaryAndTags(assetId, {
  tone: "professional",
  promptOverrides: {
    task: "Analyze cinematography, lighting, and production techniques.",
    title: "Describe the production style or filmmaking technique.",
    description: "Provide a technical breakdown of camera work, lighting, and editing.",
    keywords: "Use industry-standard production terminology.",
  },
});
```

### Chapter Title Style

```ts
const result = await generateChapters(assetId, "en", {
  provider: "openai",
  promptOverrides: {
    titleGuidelines: "Use short, punchy titles under 6 words. Start with an action verb.",
  },
});
```

## Advanced: Full Section Objects

For more control, you can pass a full `PromptSection` object instead of a string to customize the XML tag name and attributes:

```ts
import type { PromptSection } from "@mux/ai";

const result = await getSummaryAndTags(assetId, {
  promptOverrides: {
    task: {
      tag: "task",
      content: "Analyze this video for accessibility compliance.",
      attributes: { focus: "accessibility" },
    } satisfies PromptSection,
  },
});
```

This is rarely needed — string overrides cover the vast majority of use cases.

## Tips for Effective Overrides

- **Start small.** Override one section at a time and compare results against the defaults before changing more.
- **Read the defaults first.** Look at the prompt template in the workflow source (e.g. `src/workflows/summarization.ts`) to understand what each section does before overriding it.
- **Be specific.** Vague instructions like "make it better" won't help the model. Provide concrete criteria, formats, and examples.
- **Use the `tone` option too.** Combine `promptOverrides` with the `tone` option (`"neutral"`, `"playful"`, `"professional"`) for additional control over voice and style.
- **Compare providers.** The same overrides can produce different results across OpenAI, Anthropic, and Google — try all three.

## Running the Examples

The repository includes a full custom prompt example with built-in presets:

```bash
# Use a preset
npm run example:summarization:custom <asset-id> --preset seo
npm run example:summarization:custom <asset-id> --preset social
npm run example:summarization:custom <asset-id> --preset technical
npm run example:summarization:custom <asset-id> --preset ecommerce

# Provide individual overrides
npm run example:summarization:custom <asset-id> --task "Focus on product features"

# Combine a preset with additional overrides
npm run example:summarization:custom <asset-id> --preset social --title-guidance "Make it viral"
```

See [`examples/summarization/custom-prompt-example.ts`](../examples/summarization/custom-prompt-example.ts) for the full source.

## Related

- [Workflows Guide](./WORKFLOWS.md) — full documentation for each workflow
- [API Reference](./API.md#custom-prompts-with-promptoverrides) — `promptOverrides` parameter details
- [Examples](./EXAMPLES.md) — running example scripts
