import { Command } from "commander";

import { askQuestions } from "@mux/ai/workflows";

import { parseQuestionArg } from "./parse-question";

const program = new Command();

program
  .name("ask-questions")
  .description("Ask a question about a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument(
    "<question>",
    "Question to ask. Answer options default to yes/no. To use custom allowed answers, " +
    "append a pipe followed by comma-separated options, e.g. " +
    "\"What is the quality?|amateur,semi-pro,professional\"",
  )
  .option("-p, --provider <provider>", "AI provider: openai, anthropic, google (default: openai)")
  .option("-m, --model <model>", "Model name (default varies by provider)")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, questionArg: string, options: {
    provider?: string;
    model?: string;
    transcript: boolean;
  }) => {
    const parsedQuestion = parseQuestionArg(questionArg);

    console.log("Asset ID:", assetId);
    console.log("Question:", parsedQuestion.question);
    console.log(`Allowed answers: ${(parsedQuestion.answerOptions ?? ["yes", "no"]).join(", ")}`);
    console.log(`Provider: ${options.provider || "openai (default)"}`);
    console.log(`Model: ${options.model || "default"}`);
    console.log(`Include Transcript: ${options.transcript}\n`);

    try {
      // Uses the default prompt built into the library
      // Credentials are automatically read from environment variables
      const result = await askQuestions(assetId, [parsedQuestion], {
        provider: options.provider as any,
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
      console.log(result.storyboardUrl ?? "N/A (audio-only asset)");

      if (result.usage) {
        console.log("\n📈 Token Usage:");
        console.log(JSON.stringify(result.usage, null, 2));
      }
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
