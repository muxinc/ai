import { Command } from "commander";

import { secondsToTimestamp } from "@mux/ai/primitives";
import { generateChapters } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const program = new Command();

program
  .name("chapters:scoped")
  .description("Generate chapters for a time range within a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<start-time>", "Inclusive start time in seconds", Number)
  .argument("<end-time>", "Exclusive end time in seconds", Number)
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("-l, --language <code>", "Language code for transcription", "en")
  .action(async (assetId: string, startTime: number, endTime: number, options: { provider: Provider; language: string }) => {
    const result = await generateChapters(assetId, {
      provider: options.provider,
      languageCode: options.language,
      scope: { startTime, endTime },
    });

    console.log(`Scope: ${startTime}s to ${endTime}s`);
    for (const chapter of result.chapters) {
      console.log(`${secondsToTimestamp(chapter.startTime)} - ${chapter.title}`);
    }
  });

program.parse();
