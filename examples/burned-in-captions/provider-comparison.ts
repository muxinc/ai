import "../env";
import { hasBurnedInCaptions } from "@mux/ai/functions";
import { Command } from "commander";

const program = new Command();

program
  .name("burned-in-captions-compare")
  .description("Compare burned-in caption detection across multiple AI providers")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .action(async (assetId: string) => {
    console.log(`🔍 Comparing burned-in caption detection for asset: ${assetId}\n`);

    try {
      interface ProviderConfig { name: string; provider: "openai" | "anthropic" | "google" }
      const providers: ProviderConfig[] = [
        { name: "OpenAI", provider: "openai" },
        { name: "Anthropic", provider: "anthropic" },
        { name: "Google", provider: "google" },
      ];

      const results: Array<{
        config: ProviderConfig;
        result: Awaited<ReturnType<typeof hasBurnedInCaptions>>;
        duration: number;
      }> = [];

      for (const config of providers) {
        console.log(`Testing ${config.name} burned-in caption detection...`);
        const start = Date.now();
        const result = await hasBurnedInCaptions(assetId, { provider: config.provider });
        const duration = Date.now() - start;

        console.log("📊 Results:");
        console.log(`  Duration: ${duration}ms`);
        console.log(`  Has burned-in captions: ${result.hasBurnedInCaptions ? "✅ YES" : "❌ NO"}`);
        console.log(`  Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        console.log(`  Detected language: ${result.detectedLanguage || "N/A"}`);
        console.log(`  Storyboard URL: ${result.storyboardUrl}\n`);

        results.push({ config, result, duration });
      }

      console.log("\n🏁 Provider Comparison:");
      results.forEach(({ config, result, duration }) => {
        console.log(
          `${config.name}: ${result.hasBurnedInCaptions ? "✅" : "❌"} (${(result.confidence * 100).toFixed(
            1,
          )}% confidence, ${duration}ms)`,
        );
      });

      const agreement = results.every(entry => entry.result.hasBurnedInCaptions === results[0].result.hasBurnedInCaptions);
      console.log(`\n🤝 Provider Agreement: ${agreement ? "✅ AGREE" : "❌ DISAGREE"}`);

      if (!agreement) {
        console.log("   Consider manually reviewing the storyboard to determine ground truth.");
        console.log(`   Storyboard: ${results[0].result.storyboardUrl}`);
      }

      const avgConfidence =
        results.reduce((sum, entry) => sum + entry.result.confidence, 0) / results.length;
      console.log(`📊 Average Confidence: ${(avgConfidence * 100).toFixed(1)}%`);
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
