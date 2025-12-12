/**
 * Custom Prompt Example
 *
 * This example demonstrates how to use `promptOverrides` to customize the
 * summarization output for specific use cases like SEO, social media, or
 * technical analysis.
 *
 * Available override sections:
 *   - task: The main instruction for what to analyze
 *   - title: Guidance for generating the title
 *   - description: Guidance for generating the description
 *   - keywords: Guidance for generating keywords/tags
 *   - qualityGuidelines: General quality instructions
 *
 * Usage:
 *   # Use a preset (seo, social, technical)
 *   npm run example:summarization:custom <asset-id> --preset seo
 *
 *   # Or provide custom overrides via CLI
 *   npm run example:summarization:custom <asset-id> --task "Focus on product features"
 *
 *   # Combine preset with additional overrides
 *   npm run example:summarization:custom <asset-id> --preset social --title-guidance "Make it viral"
 */

import { Command } from "commander";

import type { ToneType } from "@mux/ai";
import type { SummarizationPromptOverrides } from "@mux/ai/workflows";
import { getSummaryAndTags } from "@mux/ai/workflows";

type Provider = "openai" | "anthropic" | "google";
type Preset = "seo" | "social" | "technical" | "ecommerce";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
};

/**
 * Preset prompt overrides for common use cases.
 * These demonstrate how to tailor the summarization for different purposes.
 */
const PRESETS: Record<Preset, SummarizationPromptOverrides> = {
  // SEO-optimized metadata for search engines and video platforms
  seo: {
    task: "Generate SEO-optimized metadata that maximizes discoverability in search engines and video platforms.",
    title: `
      Create a search-optimized title (50-60 characters ideal for SERP display).
      Front-load the primary keyword. Include a compelling hook or benefit.
      Avoid clickbait but make it enticing. Consider search intent.
      Example: "How to Cook Perfect Pasta | 5-Minute Italian Recipe"
    `,
    description: `
      Write a meta description (150-160 characters) that:
      - Includes primary and secondary keywords naturally
      - Contains a clear value proposition
      - Ends with a subtle call-to-action
      - Would encourage clicks from search results
    `,
    keywords: `
      Generate search-focused keywords including:
      - Primary topic keywords (high search volume)
      - Long-tail keyword phrases
      - Related semantic keywords
      - Question-based keywords (how to, what is, etc.)
      Use lowercase. Prioritize searchability over creativity.
    `,
  },

  // Social media optimized for engagement
  social: {
    task: "Generate social media-optimized metadata designed to maximize engagement, shares, and comments.",
    title: `
      Create a scroll-stopping headline that works across social platforms.
      Use emotional triggers, curiosity gaps, or unexpected angles.
      Keep it punchy (under 8 words ideal). Consider how it appears in feeds.
      Emojis are acceptable if they add value.
    `,
    description: `
      Write social-ready copy (2-3 sentences) that:
      - Hooks immediately with the most interesting element
      - Creates FOMO or curiosity
      - Is shareable and quotable
      - Works without watching the full video
    `,
    keywords: `
      Generate hashtag-ready keywords:
      - Trending topic tags
      - Niche community tags
      - Branded or campaign tags if apparent
      - Emotional or reaction tags
      Format as lowercase, no spaces (hashtag-ready).
    `,
  },

  // Technical/production analysis
  technical: {
    task: "Analyze the storyboard with focus on production quality, cinematography, and technical filmmaking elements.",
    title: `
      Create a technical headline describing the production style or technique.
      Focus on cinematography, editing, or production quality rather than narrative.
      Examples: "Handheld Documentary Interview", "Aerial Drone Tracking Shot"
    `,
    description: `
      Provide a technical breakdown analyzing:
      - Camera work: angles, movement, framing, lens choices
      - Lighting: natural vs artificial, mood, color temperature
      - Editing: pacing, transitions, visual effects
      - Audio indicators: interview setup, ambient, music-driven
      Write for a filmmaker or video professional audience.
    `,
    keywords: `
      Generate industry-standard production terms:
      - Camera techniques (handheld, steadicam, dolly, drone, gimbal)
      - Shot types (close-up, wide, medium, tracking, POV)
      - Lighting (key light, backlight, natural, studio)
      - Style (documentary, cinematic, vlog, commercial)
      Use professional terminology.
    `,
  },

  // E-commerce product videos
  ecommerce: {
    task: "Generate e-commerce optimized metadata for product videos that drive conversions.",
    title: `
      Create a product-focused title that highlights key selling points.
      Include product category and primary benefit.
      Format: "[Product Type] - [Key Benefit] | [Brand if visible]"
    `,
    description: `
      Write conversion-focused copy that:
      - Highlights visible product features and benefits
      - Addresses potential buyer questions
      - Creates desire without over-promising
      - Suitable for product detail pages
    `,
    keywords: `
      Generate shopping-intent keywords:
      - Product category and type
      - Key features and attributes
      - Use cases and benefits
      - Comparison terms (best, top, vs)
      - Purchase-intent modifiers (buy, review, demo)
    `,
  },
};

const program = new Command();

program
  .name("custom-prompt")
  .description("Generate summary with custom prompt overrides")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("--preset <name>", "Use a preset: seo, social, technical, ecommerce")
  .option("--task <text>", "Override the task description")
  .option("--title-guidance <text>", "Override title generation guidance")
  .option("--description-guidance <text>", "Override description generation guidance")
  .option("--keywords-guidance <text>", "Override keywords generation guidance")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("-t, --tone <tone>", "Tone for summary (normal, sassy, professional)", "professional")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, options: {
    preset?: string;
    task?: string;
    titleGuidance?: string;
    descriptionGuidance?: string;
    keywordsGuidance?: string;
    provider: Provider;
    model?: string;
    tone: ToneType;
    transcript: boolean;
  }) => {
    // Validate provider
    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    // Validate tone
    if (!["normal", "sassy", "professional"].includes(options.tone)) {
      console.error("❌ Unsupported tone. Choose from: normal, sassy, professional");
      process.exit(1);
    }

    // Validate preset if provided
    if (options.preset && !Object.keys(PRESETS).includes(options.preset)) {
      console.error(`❌ Unknown preset "${options.preset}". Choose from: ${Object.keys(PRESETS).join(", ")}`);
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];

    // Start with preset if provided, then layer on CLI overrides
    const promptOverrides: SummarizationPromptOverrides = {
      ...(options.preset ? PRESETS[options.preset as Preset] : {}),
    };

    // CLI options override preset values
    if (options.task)
      promptOverrides.task = options.task;
    if (options.titleGuidance)
      promptOverrides.title = options.titleGuidance;
    if (options.descriptionGuidance)
      promptOverrides.description = options.descriptionGuidance;
    if (options.keywordsGuidance)
      promptOverrides.keywords = options.keywordsGuidance;

    const hasOverrides = Object.keys(promptOverrides).length > 0;

    console.log("🎯 Generating summary with custom prompt overrides...\n");
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Tone: ${options.tone}`);
    if (options.preset) {
      console.log(`Preset: ${options.preset}`);
    }
    if (hasOverrides) {
      console.log(`Overridden sections: ${Object.keys(promptOverrides).join(", ")}`);
    }
    console.log();

    try {
      const result = await getSummaryAndTags(assetId, {
        tone: options.tone,
        provider: options.provider,
        model,
        includeTranscript: options.transcript,
        promptOverrides: hasOverrides ? promptOverrides : undefined,
      });

      console.log("📋 Analysis Result:");
      console.log(`Title: ${result.title}`);
      console.log(`\nDescription: ${result.description}`);
      console.log("\n🏷️  Tags:");
      console.log(result.tags.join(", "));
      console.log("\n🖼️  Storyboard URL:");
      console.log(result.storyboardUrl);
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
