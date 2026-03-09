import { Command } from "commander";

import type { CensorMode } from "@mux/ai/workflows";
import { censorCaptions } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash-preview",
};

const VALID_MODES: CensorMode[] = ["blank", "remove", "mask"];

const program = new Command();

program
  .name("censor-captions")
  .description("Detect and censor profanity in captions for a Mux video asset")
  .argument("<asset-id>", "Mux asset ID")
  .argument("<track-id>", "Caption track ID to censor")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "anthropic")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("--mode <mode>", "Censor mode: blank ([____]), remove, or mask (????)", "blank")
  .option("--always-censor <words>", "Comma-separated words to always censor", "")
  .option("--never-censor <words>", "Comma-separated words to never censor", "")
  .option("--no-upload", "Skip uploading censored captions to Mux")
  .option("--no-delete", "Keep the original track after uploading the censored one")
  .action(async (assetId: string, trackId: string, options: {
    provider: Provider;
    model?: string;
    mode: string;
    alwaysCensor: string;
    neverCensor: string;
    upload: boolean;
    delete: boolean;
  }) => {
    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    if (!VALID_MODES.includes(options.mode as CensorMode)) {
      console.error(`Unsupported mode '${options.mode}'. Choose from: ${VALID_MODES.join(", ")}`);
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];
    const alwaysCensor = options.alwaysCensor ? options.alwaysCensor.split(",").map(w => w.trim()) : [];
    const neverCensor = options.neverCensor ? options.neverCensor.split(",").map(w => w.trim()) : [];

    console.log(`Asset ID: ${assetId}`);
    console.log(`Track ID: ${trackId}`);
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Mode: ${options.mode}`);
    console.log(`Upload to Mux: ${options.upload}`);
    console.log(`Delete original: ${options.delete}`);
    if (alwaysCensor.length) console.log(`Always censor: ${alwaysCensor.join(", ")}`);
    if (neverCensor.length) console.log(`Never censor: ${neverCensor.join(", ")}`);
    console.log();

    try {
      console.log("Scanning captions for profanity...\n");

      const result = await censorCaptions(assetId, trackId, {
        provider: options.provider,
        model,
        mode: options.mode as CensorMode,
        uploadToMux: options.upload,
        deleteOriginalTrack: options.delete,
        alwaysCensor,
        neverCensor,
      });

      console.log("Results:");
      console.log(`  Mode: ${result.mode}`);
      console.log(`  Words censored: ${result.censoredWords.length > 0 ? result.censoredWords.join(", ") : "(none)"}`);
      console.log(`  Replacements made: ${result.replacementCount}`);

      if (result.uploadedTrackId) {
        console.log(`  New track ID: ${result.uploadedTrackId}`);
      }

      if (result.usage) {
        console.log(`  Tokens: ${result.usage.totalTokens} (${result.usage.inputTokens} in, ${result.usage.outputTokens} out)`);
      }

      console.log("\n--- Censored VTT (first 500 chars) ---");
      console.log(result.censoredVtt.substring(0, 500));
      if (result.censoredVtt.length > 500) console.log("...");

      console.log("\nDone.");
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
