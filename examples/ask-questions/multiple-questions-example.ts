import { Command } from "commander";

import { askQuestions } from "@mux/ai/workflows";

const program = new Command();

program
  .name("ask-multiple-questions")
  .description("Ask multiple yes/no questions about a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<questions...>", "Yes/no questions to ask about the video (space-separated)")
  .option("-m, --model <model>", "Model name (default: gpt-5.1)")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, questions: string[], options: {
    model?: string;
    transcript: boolean;
  }) => {
    console.log("Asset ID:", assetId);
    console.log(`Questions (${questions.length}):`, questions);
    console.log(`Model: ${options.model || "gpt-5.1 (default)"}`);
    console.log(`Include Transcript: ${options.transcript}\n`);

    // Convert string array to Question objects
    const questionObjects = questions.map(q => ({ question: q }));

    try {
      // Uses the default prompt built into the library
      // Credentials are automatically read from environment variables
      const result = await askQuestions(assetId, questionObjects, {
        model: options.model,
        includeTranscript: options.transcript,
      });

      console.log(`\n${"=".repeat(80)}\n`);
      console.log(`RESULTS (${result.answers.length} questions answered)\n`);

      result.answers.forEach((answer, idx) => {
        console.log(`${idx + 1}. ❓ Question:`);
        console.log(`   ${answer.question}`);
        console.log(`\n   ✅ Answer: ${answer.answer.toUpperCase()}`);
        console.log(`   📊 Confidence: ${(answer.confidence * 100).toFixed(1)}%`);
        console.log(`\n   💭 Reasoning:`);
        console.log(`   ${answer.reasoning.replace(/\n/g, "\n   ")}`);
        console.log(`\n${"-".repeat(80)}\n`);
      });

      console.log(`🖼️  Storyboard URL:`);
      console.log(result.storyboardUrl);

      if (result.usage) {
        console.log("\n📈 Token Usage:");
        console.log(`  Input: ${result.usage.inputTokens}`);
        console.log(`  Output: ${result.usage.outputTokens}`);
        console.log(`  Total: ${result.usage.totalTokens}`);
      }

      // Summary statistics
      const yesCount = result.answers.filter(a => a.answer === "yes").length;
      const noCount = result.answers.filter(a => a.answer === "no").length;
      const avgConfidence = result.answers.reduce((sum, a) => sum + a.confidence, 0) / result.answers.length;

      console.log("\n📊 Summary:");
      console.log(`  Yes: ${yesCount}, No: ${noCount}`);
      console.log(`  Average Confidence: ${(avgConfidence * 100).toFixed(1)}%`);
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
