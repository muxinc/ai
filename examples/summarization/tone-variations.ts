import { Command } from "commander";

import type { ToneType } from "@mux/ai";
import { getSummaryAndTags } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
};

const program = new Command();

program
  .name("tone-variations")
  .description("Demonstrate summary generation with different tone variations")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, options: {
    provider: Provider;
    model?: string;
    transcript: boolean;
  }) => {
    // Validate provider
    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];
    const tones: ToneType[] = ["neutral", "playful", "professional"];

    console.log("🎭 Demonstrating different tone variations for video analysis...\n");
    console.log(`Using ${options.provider} (${model}) with different tones.\n`);

    for (const tone of tones) {
      try {
        console.log(`\n--- ${tone.toUpperCase()} TONE ---`);

        // Uses the default prompt built into the library
        const result = await getSummaryAndTags(assetId, {
          tone,
          provider: options.provider,
          model,
          includeTranscript: options.transcript,
        });

        console.log(`Title: ${result.title}`);
        console.log(`Description: ${result.description}`);
        console.log(`Tags: ${result.tags.join(", ")}`);
        console.log("---\n");
      } catch (error) {
        console.error(`❌ Error with ${tone} tone:`, error instanceof Error ? error.message : error);
      }
    }
  });

program.parse();
