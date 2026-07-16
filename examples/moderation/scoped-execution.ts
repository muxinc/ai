import { Command } from "commander";

import { getModerationScores } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "hive" | "google-vision-api";

const program = new Command();

program
  .name("moderation:scoped")
  .description("Moderate a time range within a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<start-time>", "Inclusive start time in seconds", Number)
  .argument("<end-time>", "Exclusive end time in seconds", Number)
  .option("-p, --provider <provider>", "AI provider (openai, hive, google-vision-api)", "openai")
  .action(async (assetId: string, startTime: number, endTime: number, options: { provider: Provider }) => {
    const result = await getModerationScores(assetId, {
      provider: options.provider,
      scope: { startTime, endTime },
    });

    console.log(`Scope: ${startTime}s to ${endTime}s`);
    console.log("Maximum sexual score:", result.maxScores.sexual);
    console.log("Maximum violence score:", result.maxScores.violence);
    console.log("Exceeds thresholds:", result.exceedsThreshold);
  });

program.parse();
