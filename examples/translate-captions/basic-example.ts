import { Command } from "commander";

import { translateCaptions } from "@mux/ai/functions";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
};

const program = new Command();

program
  .name("translate-captions")
  .description("Translate captions for a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to translate")
  .option("-f, --from <language>", "Source language code", "en")
  .option("-t, --to <language>", "Target language code", "es")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "anthropic")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("--no-upload", "Skip uploading translated captions to Mux (returns presigned URL only)")
  .action(async (assetId: string, options: {
    from: string;
    to: string;
    provider: Provider;
    model?: string;
    upload: boolean;
  }) => {
    // Validate provider
    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];

    console.log(`Asset ID: ${assetId}`);
    console.log(`Translation: ${options.from} -> ${options.to}`);
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Upload to Mux: ${options.upload}\n`);

    try {
      console.log("🌍 Starting translation...\n");

      const result = await translateCaptions(assetId, options.from, options.to, {
        provider: options.provider,
        model,
        uploadToMux: options.upload,
      });

      console.log("\n📊 Translation Results:");
      console.log(`Source Language: ${result.sourceLanguageCode}`);
      console.log(`Target Language: ${result.targetLanguageCode}`);
      console.log(`Asset ID: ${result.assetId}`);

      if (result.uploadedTrackId) {
        console.log(`🎬 Mux Track ID: ${result.uploadedTrackId}`);
      }

      if (result.presignedUrl) {
        console.log(`🔗 Presigned URL: ${result.presignedUrl.substring(0, 80)}...`);
      }

      console.log("\n✅ VTT translation completed successfully!");
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
