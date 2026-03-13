import { Command } from "commander";

import { secondsToTimestamp } from "@mux/ai/primitives";
import { generateScenes } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const program = new Command();

program
  .name("scenes")
  .description("Generate scene boundaries for a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-l, --language <code>", "Language code for transcript/captions", "en")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("--output-language <code>", "Output language as BCP 47 code (e.g. 'fr', 'ja') or 'auto'")
  .option("--broad", "Prefer broader scenes with fewer splits")
  .action(async (assetId: string, options: {
    language: string;
    provider: Provider;
    outputLanguage?: string;
    broad?: boolean;
  }) => {
    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    console.log(`Generating scenes for asset: ${assetId}`);
    console.log(`Language: ${options.language}`);
    console.log(`Provider: ${options.provider}`);
    if (options.outputLanguage)
      console.log(`Output Language: ${options.outputLanguage}`);
    if (options.broad)
      console.log("Segmentation Style: broader scenes");
    console.log();

    try {
      const start = Date.now();

      console.log("Generating scenes...");
      const result = await generateScenes(assetId, options.language, {
        provider: options.provider,
        outputLanguageCode: options.outputLanguage,
        promptOverrides: options.broad ?
            {
              boundaryGuidelines: "Prefer broader scenes unless the narrative or setting clearly changes.",
              titleGuidelines: "Use concise titles under 5 words.",
            } :
          {
            titleGuidelines: "Use concise titles under 5 words.",
          },
      });

      const duration = Date.now() - start;

      console.log("Success!");
      console.log(`Duration: ${duration}ms`);
      console.log(`Generated ${result.scenes.length} scenes\n`);

      console.log("Scene List:");
      result.scenes.forEach((scene, index) => {
        console.log(
          `  ${index + 1}. ${secondsToTimestamp(scene.startTime)} - ${secondsToTimestamp(scene.endTime)} | ${scene.title}`,
        );
      });

      if (result.usage) {
        console.log("\nToken Usage:");
        console.log(JSON.stringify(result.usage, null, 2));
      }

      console.log("\nStructured Output:");
      console.log(JSON.stringify(result.scenes, null, 2));
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
