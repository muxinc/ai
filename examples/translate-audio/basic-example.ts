import { Command } from "commander";

import { translateAudio } from "@mux/ai/workflows";

import "../env";

const program = new Command();

program
  .name("translate-audio")
  .description("Translate audio (dubbing) for a Mux video asset")
  .argument("<asset-id>", "Mux asset ID to translate")
  .option("-f, --from <language>", "Source language tag or ISO alias (defaults to auto-detect)")
  .option("-t, --to <language>", "Target language tag (e.g. es, ur, yue)", "es")
  .option("-s, --speakers <number>", "Speaker count (only 0, auto-detect, is supported by the project API)", "0")
  .option("--no-upload", "Skip uploading translated audio to Mux")
  .addHelpText("after", `
Notes:
  - Uses an existing static rendition or requests an audio rendition if needed
  - Uses default audio track, source language is auto-detected unless --from is provided
  - Uses ElevenLabs Dubbing v1; regional target tags such as es-MX are not supported`)
  .action(async (assetId: string, options: {
    from?: string;
    to: string;
    speakers: string;
    upload: boolean;
  }) => {
    const numSpeakers = Number.parseInt(options.speakers, 10);
    const fromLanguageCode = options.from?.trim() || undefined;

    if (numSpeakers !== 0) {
      console.error("❌ The project API only supports --speakers 0 (auto-detect).");
      process.exit(1);
    }

    console.log(`Asset ID: ${assetId}`);
    console.log(`Audio Dubbing: ${fromLanguageCode ?? "auto-detect"} -> ${options.to}`);
    console.log(`Number of Speakers: ${numSpeakers === 0 ? "auto-detect" : numSpeakers}`);
    console.log(`Upload to Mux: ${options.upload}\n`);

    try {
      console.log("🎙️ Starting audio dubbing...\n");

      const result = await translateAudio(assetId, options.to, {
        provider: "elevenlabs",
        fromLanguageCode,
        numSpeakers,
        uploadToMux: options.upload,
      });

      console.log("\n📊 Audio Dubbing Results:");
      console.log(`Target Language: ${result.targetLanguageCode}`);
      console.log(`Asset ID: ${result.assetId}`);
      console.log(`ElevenLabs Project ID: ${result.dubbingId}`);

      if (result.uploadedTrackId) {
        console.log(`🎬 Mux Audio Track ID: ${result.uploadedTrackId}`);
      }

      if (result.presignedUrl) {
        console.log(`🔗 Presigned URL: ${result.presignedUrl.substring(0, 80)}...`);
      }

      console.log("\n✅ Audio dubbing completed successfully!");
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
