import type { ToneType } from "@mux/ai";

import { getSummaryAndTags } from "@mux/ai/functions";
import { Command } from "commander";

import env from "../env";

type Provider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
};

const program = new Command();

program
  .name("summarization")
  .description("Generate summary and tags for a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("-t, --tone <tone>", "Tone for summary (normal, sassy, professional)", "normal")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, options: {
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

    // Use provided model or default for the provider
    const model = options.model || DEFAULT_MODELS[options.provider];

    console.log("Asset ID:", assetId);
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Tone: ${options.tone}`);
    console.log(`Include Transcript: ${options.transcript}\n`);

    try {
      // Uses the default prompt built into the library
      const result = await getSummaryAndTags(assetId, {
        tone: options.tone,
        provider: options.provider,
        model,
        includeTranscript: options.transcript,
        // Credentials can be passed in options or via environment variables
        muxTokenId: env.MUX_TOKEN_ID,
        muxTokenSecret: env.MUX_TOKEN_SECRET,
        openaiApiKey: env.OPENAI_API_KEY,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      });

      console.log("📝 Title:");
      console.log(result.title);
      console.log("\n📋 Description:");
      console.log(result.description);
      console.log("\n🏷️  Tags:");
      console.log(result.tags.join(", "));
      console.log("\n🖼️  Storyboard URL:");
      console.log(result.storyboardUrl);
    }
    catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
