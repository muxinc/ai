import { Command } from "commander";

import { secondsToTimestamp } from "@mux/ai/primitives";
import { generateChapters } from "@mux/ai/workflows";

import "../env";

const program = new Command();

program
  .name("chapters-compare")
  .description("Compare chapter generation across multiple AI providers")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-l, --language <code>", "Language code for transcription", "en")
  .action(async (assetId: string, options: {
    language: string;
  }) => {
    console.log(`🎯 Comparing chapter generation for asset: ${assetId}`);
    console.log(`📝 Language: ${options.language}\n`);

    try {
      const providers: Array<{ name: string; provider: "openai" | "anthropic" | "google" }> = [
        { name: "OpenAI", provider: "openai" },
        { name: "Anthropic", provider: "anthropic" },
        { name: "Google", provider: "google" },
      ];

      const results = [];

      for (const config of providers) {
        console.log(`Testing ${config.name} chapter generation...`);
        const start = Date.now();
        const result = await generateChapters(assetId, options.language, { provider: config.provider });
        const duration = Date.now() - start;

        console.log("📊 Results:");
        console.log(`  Duration: ${duration}ms`);
        console.log(`  Generated chapters: ${result.chapters.length}`);
        console.log("  Chapter breakdown:");
        result.chapters.forEach((chapter, index) => {
          console.log(`    ${index + 1}. ${secondsToTimestamp(chapter.startTime)} - ${chapter.title}`);
        });
        console.log();

        results.push({ config, result, duration });
      }

      console.log("\n🏁 Provider Comparison:");
      results.forEach(({ config, result, duration }) => {
        console.log(`${config.name}: ${result.chapters.length} chapters (${duration}ms)`);
      });

      const topicOverlap = new Set<string>();
      for (let i = 0; i < results.length; i++) {
        for (let j = i + 1; j < results.length; j++) {
          const titlesA = results[i].result.chapters.map(c => c.title.toLowerCase());
          const titlesB = results[j].result.chapters.map(c => c.title.toLowerCase());
          titlesA.forEach((title) => {
            titlesB.forEach((otherTitle) => {
              const wordsA = title.split(" ").filter(w => w.length > 3);
              const wordsB = otherTitle.split(" ").filter(w => w.length > 3);
              const overlap = wordsA.filter(word => wordsB.includes(word));
              if (overlap.length > 1) {
                topicOverlap.add(overlap.join(" "));
              }
            });
          });
        }
      }

      if (topicOverlap.size > 0) {
        console.log(`🤝 Common topics found: ${Array.from(topicOverlap).join(", ")}`);
      } else {
        console.log("🤔 No obvious common topics detected - providers may have different approaches");
      }
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
