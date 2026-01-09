import { Command } from "commander";

import { askQuestions } from "@mux/ai/workflows";

const program = new Command();

program
  .name("ask-questions")
  .description("Ask yes/no questions about a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<question>", "Yes/no question to ask about the video")
  .option("-m, --model <model>", "Model name (default: gpt-5.1)")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, question: string, options: {
    model?: string;
    transcript: boolean;
  }) => {
    console.log("Asset ID:", assetId);
    console.log("Question:", question);
    console.log(`Model: ${options.model || "gpt-5.1 (default)"}`);
    console.log(`Include Transcript: ${options.transcript}\n`);

    try {
      // Uses the default prompt built into the library
      // Credentials are automatically read from environment variables
      const result = await askQuestions(assetId, [{ question }], {
        model: options.model,
        includeTranscript: options.transcript,
      });

      const answer = result.answers[0];

      console.log("❓ Question:");
      console.log(answer.question);
      console.log("\n✅ Answer:", answer.answer);
      console.log(`📊 Confidence: ${(answer.confidence * 100).toFixed(1)}%`);
      console.log("\n💭 Reasoning:");
      console.log(answer.reasoning);
      console.log("\n🖼️  Storyboard URL:");
      console.log(result.storyboardUrl);

      if (result.usage) {
        console.log("\n📈 Token Usage:");
        console.log(`  Input: ${result.usage.inputTokens}`);
        console.log(`  Output: ${result.usage.outputTokens}`);
        console.log(`  Total: ${result.usage.totalTokens}`);
      }
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
