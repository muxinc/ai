import { Command } from "commander";

import type { CensorMode } from "@mux/ai/workflows";
import { editCaptions } from "@mux/ai/workflows";

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
  .name("edit-captions")
  .description("Edit captions for a Mux video asset: censor profanity and/or apply static replacements")
  .argument("<asset-id>", "Mux asset ID")
  .argument("<track-id>", "Caption track ID to edit")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "anthropic")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("--mode <mode>", "Censor mode: blank ([____]), remove, or mask (????)", "blank")
  .option("--always-censor <words>", "Comma-separated words to always censor", "")
  .option("--never-censor <words>", "Comma-separated words to never censor", "")
  .option("--replacements <pairs>", "Comma-separated find:replace pairs (e.g., 'Mucks:Mux,gonna:going to')", "")
  .option("--no-profanity", "Skip LLM-powered profanity censorship (use with --replacements)")
  .option("--no-upload", "Skip uploading edited captions to Mux")
  .option("--no-delete", "Keep the original track after uploading the edited one")
  .action(async (assetId: string, trackId: string, options: {
    provider: Provider;
    model?: string;
    mode: string;
    alwaysCensor: string;
    neverCensor: string;
    replacements: string;
    profanity: boolean;
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

    // Parse replacement pairs
    const replacements = options.replacements
      ? options.replacements.split(",").map((pair) => {
          const [find, ...rest] = pair.split(":");
          return { find: find.trim(), replace: rest.join(":").trim() };
        })
      : [];

    const useProfanity = options.profanity;

    if (!useProfanity && replacements.length === 0) {
      console.error("At least one of --profanity or --replacements must be provided.");
      process.exit(1);
    }

    console.log(`Asset ID: ${assetId}`);
    console.log(`Track ID: ${trackId}`);
    if (useProfanity) {
      console.log(`Provider: ${options.provider} (${model})`);
      console.log(`Censor mode: ${options.mode}`);
    }
    console.log(`Upload to Mux: ${options.upload}`);
    console.log(`Delete original: ${options.delete}`);
    if (useProfanity && alwaysCensor.length) console.log(`Always censor: ${alwaysCensor.join(", ")}`);
    if (useProfanity && neverCensor.length) console.log(`Never censor: ${neverCensor.join(", ")}`);
    if (replacements.length) console.log(`Replacements: ${replacements.map(r => `${r.find} -> ${r.replace}`).join(", ")}`);
    console.log();

    try {
      console.log("Editing captions...\n");

      const result = await editCaptions(assetId, trackId, {
        ...(useProfanity
          ? {
              provider: options.provider,
              model,
              autoCensorProfanity: {
                mode: options.mode as CensorMode,
                alwaysCensor,
                neverCensor,
              },
            }
          : {}),
        ...(replacements.length > 0 ? { replacements } : {}),
        uploadToMux: options.upload,
        deleteOriginalTrack: options.delete,
      });

      console.log("Results:");
      console.log(`  Total replacements: ${result.totalReplacementCount}`);

      if (result.autoCensorProfanity) {
        const uniqueWords = [...new Set(result.autoCensorProfanity.replacements.map(r => r.before.toLowerCase()))];
        console.log(`  Profanity censored: ${uniqueWords.length > 0 ? uniqueWords.join(", ") : "(none)"}`);
        console.log(`  Profanity replacements: ${result.autoCensorProfanity.replacements.length}`);
      }

      if (result.replacements) {
        console.log(`  Static replacements: ${result.replacements.replacements.length}`);
      }

      if (result.uploadedTrackId) {
        console.log(`  New track ID: ${result.uploadedTrackId}`);
      }

      if (result.usage) {
        console.log(`  Tokens: ${result.usage.totalTokens} (${result.usage.inputTokens} in, ${result.usage.outputTokens} out)`);
      }

      console.log("\n--- Edited VTT (first 500 chars) ---");
      console.log(result.editedVtt.substring(0, 500));
      if (result.editedVtt.length > 500) console.log("...");

      console.log("\nDone.");
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
