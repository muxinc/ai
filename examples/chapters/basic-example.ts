import { Command } from "commander";

import { secondsToTimestamp } from "@mux/ai/primitives";
import { generateChapters } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "baseten" | "anthropic" | "google";

const program = new Command();

program
  .name("chapters")
  .description("Generate chapters for a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-l, --language <code>", "Language code for transcription", "en")
  .option("-p, --provider <provider>", "AI provider (openai, baseten, anthropic, google)", "openai")
  .option("--output-language <code>", "Output language as BCP 47 code (e.g. 'fr', 'ja') or 'auto'")
  .action(async (assetId: string, options: {
    language: string;
    provider: Provider;
    outputLanguage?: string;
  }) => {
    // Validate provider
    if (!["openai", "baseten", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, baseten, anthropic, google");
      process.exit(1);
    }

    console.log(`🎯 Generating chapters for asset: ${assetId}`);
    console.log(`📝 Language: ${options.language}`);
    console.log(`🤖 Provider: ${options.provider}`);
    if (options.outputLanguage) console.log(`🌐 Output Language: ${options.outputLanguage}`);
    console.log();

    try {
      const start = Date.now();

      const result = await generateChapters(assetId, {
        provider: options.provider,
        languageCode: options.language,
        outputLanguageCode: options.outputLanguage,
        promptOverrides: {
          titleGuidelines: "Use concise titles under 6 words.",
        },
      });

      const duration = Date.now() - start;

      console.log("✅ Success!");
      console.log(`⏱️  Duration: ${duration}ms`);
      console.log(`📊 Generated ${result.chapters.length} chapters\n`);

      console.log("📋 Chapter List:");
      result.chapters.forEach((chapter, i) => {
        console.log(`  ${i + 1}. ${secondsToTimestamp(chapter.startTime)} - ${chapter.title}`);
      });

      console.log("\n🎬 Mux Player Format:");
      console.log(JSON.stringify(result.chapters, null, 2));
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
