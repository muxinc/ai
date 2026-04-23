import { Command } from "commander";

import { hasBurnedInCaptions } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "baseten" | "anthropic" | "google";

const program = new Command();

program
  .name("burned-in-captions")
  .description("Detect burned-in captions in a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-p, --provider <provider>", "AI provider (openai, baseten, anthropic, google)", "openai")
  .action(async (assetId: string, options: {
    provider: Provider;
  }) => {
    // Validate provider
    if (!["openai", "baseten", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, baseten, anthropic, google");
      process.exit(1);
    }

    console.log(`🔍 Detecting burned-in captions for asset: ${assetId}`);
    console.log(`🤖 Provider: ${options.provider}\n`);

    try {
      const start = Date.now();

      const result = await hasBurnedInCaptions(assetId, {
        provider: options.provider,
      });

      const duration = Date.now() - start;

      console.log("📊 Analysis Results:");
      console.log(`⏱️  Duration: ${duration}ms`);
      console.log(`🔤 Has burned-in captions: ${result.hasBurnedInCaptions ? "✅ YES" : "❌ NO"}`);
      console.log(`📈 Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`🌐 Detected language: ${result.detectedLanguage || "Not detected"}`);
      console.log(`🖼️  Storyboard URL: ${result.storyboardUrl}`);

      if (result.hasBurnedInCaptions) {
        console.log("\n✨ This video appears to have burned-in captions!");
        if (result.detectedLanguage) {
          console.log(`   Language detected: ${result.detectedLanguage}`);
        }
        console.log("   Consider this when processing captions or accessibility features.");
      } else {
        console.log("\n📝 No burned-in captions detected.");
        console.log("   This video likely uses separate caption tracks or no captions.");
      }
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
