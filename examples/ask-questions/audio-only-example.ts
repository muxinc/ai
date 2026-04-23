import { Command } from "commander";

import { askQuestions } from "@mux/ai/workflows";

import env from "../env";
import { parseQuestionArg } from "./parse-question";

type Provider = "openai" | "baseten" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.1",
  baseten: process.env.BASETEN_MODEL || "your-baseten-model",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3.1-flash-lite-preview",
};

const DEFAULT_QUESTION = "Is there spoken dialogue in this content?";

const program = new Command();

program
  .name("ask-questions-audio-only")
  .description("Ask a question about an audio-only Mux asset")
  .argument(
    "[asset-id]",
    "Mux asset ID to analyze (defaults to MUX_TEST_ASSET_ID_AUDIO_ONLY)",
  )
  .argument(
    "[question]",
    `Question to ask (defaults to "${DEFAULT_QUESTION}"). Answer options default to yes/no; ` +
    "append a pipe + comma-separated options for custom allowed answers, e.g. " +
    "\"What is the speaker's tone?|calm,excited,angry\"",
  )
  .option("-p, --provider <provider>", "AI provider (openai, baseten, anthropic, google)", "openai")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .action(async (assetId: string | undefined, questionArg: string | undefined, options: {
    provider: Provider;
    model?: string;
  }) => {
    const resolvedAssetId = assetId ?? env.MUX_TEST_ASSET_ID_AUDIO_ONLY;
    const parsedQuestion = parseQuestionArg(questionArg?.trim() || DEFAULT_QUESTION);

    if (!resolvedAssetId) {
      console.error(
        "Missing asset ID. Provide one as an argument or set MUX_TEST_ASSET_ID_AUDIO_ONLY.",
      );
      process.exit(1);
    }

    if (!["openai", "baseten", "anthropic", "google"].includes(options.provider)) {
      console.error("Unsupported provider. Choose from: openai, baseten, anthropic, google");
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];

    console.log("Asset ID:", resolvedAssetId);
    console.log("Asset Type: audio-only");
    console.log("Question:", parsedQuestion.question);
    console.log(`Allowed answers: ${(parsedQuestion.answerOptions ?? ["yes", "no"]).join(", ")}`);
    console.log(`Provider: ${options.provider} (${model})`);
    console.log("Include Transcript: true\n");

    try {
      const result = await askQuestions(resolvedAssetId, [parsedQuestion], {
        provider: options.provider,
        model,
        includeTranscript: true,
      });

      const answer = result.answers[0];

      console.log("Question:");
      console.log(answer.question);
      console.log("\nAnswer:", answer.answer);
      console.log(`Confidence: ${(answer.confidence * 100).toFixed(1)}%`);
      console.log("\nReasoning:");
      console.log(answer.reasoning);

      console.log("\nStoryboard URL:");
      console.log(result.storyboardUrl ?? "N/A (audio-only asset)");

      if (result.usage) {
        console.log("\nToken Usage:");
        console.log(`  Input: ${result.usage.inputTokens}`);
        console.log(`  Output: ${result.usage.outputTokens}`);
        console.log(`  Total: ${result.usage.totalTokens}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
