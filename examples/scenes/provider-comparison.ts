import { Command } from "commander";

import { secondsToTimestamp } from "@mux/ai/primitives";
import { generateScenes } from "@mux/ai/workflows";

import "../env";

interface ProviderConfig {
  name: string;
  provider: "openai" | "anthropic" | "google";
}

const program = new Command();

program
  .name("scenes-compare")
  .description("Compare scene generation across multiple AI providers")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-l, --language <code>", "Language code for transcript/captions", "en")
  .action(async (assetId: string, options: {
    language: string;
  }) => {
    console.log(`Comparing scene generation for asset: ${assetId}`);
    console.log(`Language: ${options.language}\n`);

    try {
      const providers: ProviderConfig[] = [
        { name: "OpenAI", provider: "openai" },
        { name: "Anthropic", provider: "anthropic" },
        { name: "Google", provider: "google" },
      ];

      const results: Array<{
        config: ProviderConfig;
        result: Awaited<ReturnType<typeof generateScenes>>;
        duration: number;
      }> = [];

      for (const config of providers) {
        console.log(`Testing ${config.name} scene generation...`);
        const start = Date.now();
        const result = await generateScenes(assetId, options.language, { provider: config.provider });
        const duration = Date.now() - start;

        console.log("Results:");
        console.log(`  Duration: ${duration}ms`);
        console.log(`  Generated scenes: ${result.scenes.length}`);
        console.log("  Scene breakdown:");
        result.scenes.forEach((scene, index) => {
          console.log(
            `    ${index + 1}. ${secondsToTimestamp(scene.startTime)} - ${secondsToTimestamp(scene.endTime)} | ${scene.title}`,
          );
        });
        if (result.usage) {
          console.log("  Token usage:");
          console.log(`    Input: ${result.usage.inputTokens ?? "n/a"}`);
          console.log(`    Output: ${result.usage.outputTokens ?? "n/a"}`);
          console.log(`    Total: ${result.usage.totalTokens ?? "n/a"}`);
        }
        console.log();

        results.push({ config, result, duration });
      }

      console.log("\nProvider Comparison:");
      results.forEach(({ config, result, duration }) => {
        console.log(`${config.name}: ${result.scenes.length} scenes (${duration}ms)`);
      });

      const allFirstTitles = results
        .map(({ config, result }) => `${config.name}: ${result.scenes[0]?.title ?? "No scenes returned"}`);
      console.log(`\nFirst Scene Titles: ${allFirstTitles.join(" | ")}`);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
