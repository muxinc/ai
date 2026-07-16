import { Command } from "commander";

import { generateEmbeddings } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "google";

const program = new Command();

program
  .name("embeddings:scoped")
  .description("Generate transcript embeddings for a time range within a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument("<start-time>", "Inclusive start time in seconds", Number)
  .argument("<end-time>", "Exclusive end time in seconds", Number)
  .option("-p, --provider <provider>", "AI provider (openai, google)", "openai")
  .option("-l, --language <code>", "Language code for transcription", "en")
  .action(async (assetId: string, startTime: number, endTime: number, options: { provider: Provider; language: string }) => {
    const result = await generateEmbeddings(assetId, {
      provider: options.provider,
      languageCode: options.language,
      scope: { startTime, endTime },
    });

    console.log(`Scope: ${startTime}s to ${endTime}s`);
    console.log("Generated chunks:", result.metadata.totalChunks);
    console.log("Total tokens:", result.metadata.totalTokens);
    console.log("Embedding dimensions:", result.metadata.embeddingDimensions);
  });

program.parse();
