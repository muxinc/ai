import { Command } from "commander";

import type { ToneType } from "@mux/ai";
import { getSummaryAndTags } from "@mux/ai/workflows";

import env from "../env";

type Provider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash-preview",
};

const program = new Command();

program
  .name("summarization-audio-only")
  .description("Generate summary and tags for an audio-only Mux asset")
  .argument(
    "[asset-id]",
    "Mux asset ID to analyze (defaults to MUX_TEST_ASSET_ID_AUDIO_ONLY)",
  )
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("-t, --tone <tone>", "Tone for summary (neutral, playful, professional)", "neutral")
  .action(async (assetId: string | undefined, options: {
    provider: Provider;
    model?: string;
    tone: ToneType;
  }) => {
    const resolvedAssetId = assetId ?? env.MUX_TEST_ASSET_ID_AUDIO_ONLY;

    if (!resolvedAssetId) {
      console.error(
        "❌ Missing asset ID. Provide one as an argument or set MUX_TEST_ASSET_ID_AUDIO_ONLY.",
      );
      process.exit(1);
    }

    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    if (!["neutral", "playful", "professional"].includes(options.tone)) {
      console.error("❌ Unsupported tone. Choose from: neutral, playful, professional");
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];

    console.log("Asset ID:", resolvedAssetId);
    console.log("Asset Type: audio-only");
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Tone: ${options.tone}`);
    console.log("Include Transcript: true\n");

    try {
      const result = await getSummaryAndTags(resolvedAssetId, {
        tone: options.tone,
        provider: options.provider,
        model,
        includeTranscript: true,
      });

      console.log("Title:");
      console.log(result.title);
      console.log("\nDescription:");
      console.log(result.description);
      console.log("\nTags:");
      console.log(result.tags.join(", "));

      if (result.storyboardUrl) {
        console.log("\nStoryboard URL:");
        console.log(result.storyboardUrl);
      } else {
        console.log("\nStoryboard URL:");
        console.log("N/A (audio-only asset)");
      }
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
