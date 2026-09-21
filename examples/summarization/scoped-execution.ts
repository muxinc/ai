import { Command } from "commander";

import { getSummaryAndTags } from "@mux/ai/workflows";

type Provider = "openai" | "anthropic" | "google";

const program = new Command();

program
  .name("summarization:scoped")
  .description("Generate a summary for a time range within a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<start-time>", "Inclusive start time in seconds", Number)
  .argument("<end-time>", "Exclusive end time in seconds", Number)
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, startTime: number, endTime: number, options: { provider: Provider; transcript: boolean }) => {
    const result = await getSummaryAndTags(assetId, {
      provider: options.provider,
      includeTranscript: options.transcript,
      scope: { startTime, endTime },
    });

    console.log(`Scope: ${startTime}s to ${endTime}s`);
    console.log("\nTitle:", result.title);
    console.log("\nDescription:", result.description);
    console.log("\nTags:", result.tags.join(", "));
  });

program.parse();
