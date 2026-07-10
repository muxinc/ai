import { Command } from "commander";

import { askQuestions } from "@mux/ai/workflows";

import { parseQuestionArg } from "./parse-question";

const program = new Command();

program
  .name("ask-questions:scoped")
  .description("Ask a question about a time range within a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<start-time>", "Inclusive start time in seconds", Number)
  .argument("<end-time>", "Exclusive end time in seconds", Number)
  .argument("<question>", "Question to ask; append |option-one,option-two for custom answers")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, startTime: number, endTime: number, questionArg: string, options: { provider?: string; transcript: boolean }) => {
    const question = parseQuestionArg(questionArg);
    const result = await askQuestions(assetId, [question], {
      provider: options.provider as any,
      includeTranscript: options.transcript,
      scope: { startTime, endTime },
    });
    const answer = result.answers[0];

    console.log(`Scope: ${startTime}s to ${endTime}s`);
    console.log("Question:", answer.question);
    console.log("Answer:", answer.answer);
    console.log("Confidence:", answer.confidence);
    console.log("Reasoning:", answer.reasoning);
  });

program.parse();
