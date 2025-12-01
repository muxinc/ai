/**
 * Summarization with signed playback assets.
 *
 * This demonstrates using the getSummaryAndTags function with an asset
 * that has a signed playback policy. The library automatically handles
 * URL signing when credentials are provided.
 */

import { Command } from "commander";

import type { ToneType } from "@mux/ai";
import { getSummaryAndTags } from "@mux/ai/functions";

import env from "../env";

type Provider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
};

const program = new Command();

program
  .name("signed-summarization")
  .description("Generate summary and tags for a Mux asset with signed playback policy")
  .argument("<asset-id>", "Mux asset ID with signed playback policy")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "anthropic")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("-t, --tone <tone>", "Tone for summary (normal, sassy, professional)", "professional")
  .option("--no-transcript", "Exclude transcript from analysis")
  .addHelpText("after", `
Environment Variables:
  MUX_TOKEN_ID        Your Mux API token ID
  MUX_TOKEN_SECRET    Your Mux API token secret
  MUX_SIGNING_KEY     Signing key ID (for signed assets)
  MUX_PRIVATE_KEY     Base64-encoded private key (for signed assets)
  ANTHROPIC_API_KEY   (or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY)

Notes:
  - Asset must have a signed playback policy
  - Signing credentials are automatically used when provided
  - Create signing keys in Mux Dashboard → Settings → Signing Keys`)
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

    // Check for signing credentials
    const hasSigningCredentials = env.MUX_SIGNING_KEY && env.MUX_PRIVATE_KEY;

    // Use provided model or default for the provider
    const model = options.model || DEFAULT_MODELS[options.provider];

    console.log("🎬 Signed Asset Summarization\n");
    console.log(`Asset ID: ${assetId}`);
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Tone: ${options.tone}`);
    console.log(`Include Transcript: ${options.transcript}`);
    console.log(`Signing: ${hasSigningCredentials ? "✅ Credentials available" : "⚠️ No credentials"}`);

    if (!hasSigningCredentials) {
      console.log("   If your asset has a signed playback policy, this will fail.\n");
    } else {
      console.log("");
    }

    try {
      const result = await getSummaryAndTags(assetId, {
        tone: options.tone,
        provider: options.provider,
        model,
        includeTranscript: options.transcript,
        // Mux API credentials
        muxTokenId: env.MUX_TOKEN_ID,
        muxTokenSecret: env.MUX_TOKEN_SECRET,
        // Signing credentials (used automatically for signed playback IDs)
        muxSigningKey: env.MUX_SIGNING_KEY,
        muxPrivateKey: env.MUX_PRIVATE_KEY,
        // AI provider credentials
        openaiApiKey: env.OPENAI_API_KEY,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      });

      console.log("─".repeat(60));
      console.log("📝 Title:");
      console.log(result.title);
      console.log("\n📋 Description:");
      console.log(result.description);
      console.log("\n🏷️  Tags:");
      console.log(result.tags.join(", "));
      console.log("\n🖼️  Storyboard URL (signed):");
      console.log(`${result.storyboardUrl.substring(0, 80)}...`);
      console.log("─".repeat(60));
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);

      if (error instanceof Error && error.message.includes("signing credentials")) {
        console.log("\n💡 Hint: This asset likely has a signed playback policy.");
        console.log("   Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.");
      }

      process.exit(1);
    }
  });

program.parse();
