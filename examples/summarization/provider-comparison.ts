import "../env";
import type { ToneType } from "@mux/ai";

import { getSummaryAndTags } from "@mux/ai/functions";
import { Command } from "commander";

const program = new Command();

program
  .name("summarization-compare")
  .description("Compare summary generation across multiple AI providers")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-t, --tone <tone>", "Tone for summary (normal, sassy, professional)", "normal")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, options: {
    tone: ToneType;
    transcript: boolean;
  }) => {
    // Validate tone
    if (!["normal", "sassy", "professional"].includes(options.tone)) {
      console.error("❌ Unsupported tone. Choose from: normal, sassy, professional");
      process.exit(1);
    }

    console.log("🔍 Comparing OpenAI vs Anthropic vs Google analysis results...\n");

    const providers = [
      { name: "OpenAI", provider: "openai" as const, model: "gpt-5-mini" },
      { name: "Anthropic", provider: "anthropic" as const, model: "claude-sonnet-4-5" },
      { name: "Google", provider: "google" as const, model: "gemini-2.5-flash" },
    ];

    for (const config of providers) {
      try {
        console.log(`--- ${config.name.toUpperCase()} ANALYSIS ---`);
        console.log(`Model: ${config.model}`);

        const startTime = Date.now();
        const result = await getSummaryAndTags(assetId, {
          provider: config.provider,
          model: config.model,
          tone: options.tone,
          includeTranscript: options.transcript,
        });
        const duration = Date.now() - startTime;

        console.log(`⏱️  Analysis time: ${duration}ms`);
        console.log(`📝 Title: ${result.title}`);
        console.log(`📋 Description: ${result.description}`);
        console.log(`🏷️  Tags: ${result.tags.join(", ")}`);
        console.log("---\n");
      }
      catch (error) {
        console.error(`❌ Error with ${config.name}:`, error instanceof Error ? error.message : error);
        console.log("---\n");
      }
    }
  });

program.parse();
