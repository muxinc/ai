import { Command } from "commander";

import { translateCaptions } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google" | "baseten" | "openai-compatible";

const DEFAULT_MODELS: Partial<Record<Provider, string>> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash-preview",
};

const program = new Command();

program
  .name("translate-captions")
  .description("Translate captions for a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to translate")
  .requiredOption("--track <trackId>", "Source text track ID")
  .option("-t, --to <language>", "Target language code", "es")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google, baseten)", "anthropic")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("--no-upload", "Skip uploading translated captions to Mux (returns presigned URL only)")
  .option("--never-translate <terms>", "Comma-separated terms to preserve verbatim (e.g. \"Mux,GIF\")")
  .option("--print-vtt", "Print the translated VTT to stdout")
  .action(async (assetId: string, options: {
    track: string;
    to: string;
    provider: Provider;
    model?: string;
    upload: boolean;
    neverTranslate?: string;
    printVtt?: boolean;
  }) => {
    // Validate provider
    if (!["openai", "anthropic", "google", "baseten", "openai-compatible"].includes(options.provider)) {
      console.error("Unsupported provider. Choose from: openai, anthropic, google, baseten");
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];
    const neverTranslate = options.neverTranslate?.split(",").map(term => term.trim()).filter(Boolean);

    console.log(`Asset ID: ${assetId}`);
    console.log(`Track ID: ${options.track}`);
    console.log(`Target language: ${options.to}`);
    console.log(`Provider: ${options.provider} (${model})`);
    if (neverTranslate?.length) {
      console.log(`Never translate: ${neverTranslate.join(", ")}`);
    }
    console.log(`Upload to Mux: ${options.upload}\n`);

    try {
      console.log("Starting translation...\n");

      const result = await translateCaptions(assetId, options.track, options.to, {
        provider: options.provider,
        model,
        uploadToMux: options.upload,
        neverTranslate,
      });

      console.log("\nTranslation Results:");
      console.log(`Source Language: ${result.sourceLanguageCode}`);
      console.log(`Target Language: ${result.targetLanguageCode}`);
      console.log(`Asset ID: ${result.assetId}`);
      console.log(`Track ID: ${result.trackId}`);

      if (result.uploadedTrackId) {
        console.log(`Mux Track ID: ${result.uploadedTrackId}`);
      }

      if (result.presignedUrl) {
        console.log(`Presigned URL: ${result.presignedUrl.substring(0, 80)}...`);
      }

      if (result.neverTranslateTermsPreserved !== undefined) {
        console.log(`Never-translate terms preserved: ${result.neverTranslateTermsPreserved}`);
      }

      if (options.printVtt) {
        console.log(`\n${result.translatedVtt}`);
      }

      console.log("\nVTT translation completed successfully!");
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
