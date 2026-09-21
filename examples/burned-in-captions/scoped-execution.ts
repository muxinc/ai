import { Command } from "commander";

import { hasBurnedInCaptions } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const program = new Command();

program
  .name("burned-in-captions:scoped")
  .description("Detect burned-in captions in a time range within a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<start-time>", "Inclusive start time in seconds", Number)
  .argument("<end-time>", "Exclusive end time in seconds", Number)
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .action(async (assetId: string, startTime: number, endTime: number, options: { provider: Provider }) => {
    const result = await hasBurnedInCaptions(assetId, {
      provider: options.provider,
      scope: { startTime, endTime },
    });

    console.log(`Scope: ${startTime}s to ${endTime}s`);
    console.log("Has burned-in captions:", result.hasBurnedInCaptions);
    console.log("Confidence:", result.confidence);
    console.log("Detected language:", result.detectedLanguage ?? "Not detected");
  });

program.parse();
