import { Command } from "commander";

import { secondsToTimestamp } from "@mux/ai/primitives";
import { generateHighlightClips } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const program = new Command();

program
  .name("highlight-clips")
  .description("Generate highlight clips from a Mux video asset based on engagement data")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "openai")
  .option("-m, --max-clips <number>", "Maximum number of clips to generate", "5")
  .option("-d, --dry-run", "Analyze only, don't create clip assets", false)
  .option("--min-duration <number>", "Minimum clip duration in seconds", "15")
  .option("--max-duration <number>", "Maximum clip duration in seconds", "90")
  .option("--target-duration <number>", "Preferred clip duration in seconds")
  .option("-t, --timeframe <timeframe>", "Engagement data timeframe", "[7:days]")
  .action(async (assetId: string, options: {
    provider: Provider;
    maxClips: string;
    dryRun: boolean;
    minDuration: string;
    maxDuration: string;
    targetDuration?: string;
    timeframe: string;
  }) => {
    // Validate provider
    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    const maxClips = Number.parseInt(options.maxClips, 10);
    const minClipDuration = Number.parseInt(options.minDuration, 10);
    const maxClipDuration = Number.parseInt(options.maxDuration, 10);
    const targetDuration = options.targetDuration ? Number.parseInt(options.targetDuration, 10) : undefined;

    console.log(`🎥 Generating highlight clips for asset: ${assetId}`);
    console.log(`🤖 Provider: ${options.provider}`);
    console.log(`📊 Max clips: ${maxClips}`);
    console.log(`⏱️  Duration constraints: ${minClipDuration}s - ${maxClipDuration}s`);
    if (targetDuration) {
      console.log(`🎯 Target duration: ${targetDuration}s`);
    }
    console.log(`📅 Timeframe: ${options.timeframe}`);
    console.log(`🔄 Mode: ${options.dryRun ? "DRY RUN (analysis only)" : "CREATE ASSETS"}\n`);

    try {
      const start = Date.now();

      const result = await generateHighlightClips(assetId, {
        provider: options.provider,
        maxClips,
        minClipDuration,
        maxClipDuration,
        targetDuration,
        timeframe: options.timeframe,
        dryRun: options.dryRun,
      });

      const duration = Date.now() - start;

      console.log("✅ Success!");
      console.log(`⏱️  Duration: ${duration}ms`);
      console.log(`📊 Generated ${result.totalClipsGenerated} clips`);
      console.log(`🔥 Total engagement score: ${result.totalEngagementScore.toFixed(2)}\n`);

      if (result.clips.length === 0) {
        console.log("ℹ️  No clips generated. This could mean:");
        console.log("   - No engagement hotspots found for this asset");
        console.log("   - Try adjusting the timeframe or maxClips parameters");
        return;
      }

      console.log("🎬 Generated Clips:\n");
      result.clips.forEach((clip, i) => {
        const start = secondsToTimestamp(clip.startTime);
        const end = secondsToTimestamp(clip.endTime);

        console.log(`━━━ Clip ${i + 1} ━━━`);
        console.log(`📍 Time: ${start} → ${end} (${clip.duration.toFixed(1)}s)`);
        console.log(`📈 Engagement: ${(clip.engagementScore * 100).toFixed(1)}%`);
        console.log(`📝 Title: ${clip.title}`);
        console.log(`📄 Description: ${clip.description}`);
        console.log(`🏷️  Keywords: ${clip.keywords.join(", ")}`);
        console.log(`📱 Platforms: ${clip.suggestedPlatforms.join(", ")}`);

        if (!options.dryRun) {
          console.log(`🆔 Asset ID: ${clip.clipAssetId}`);
          console.log(`🎮 Playback ID: ${clip.clipPlaybackId}`);
          console.log(`🔗 Clip URL: ${clip.clipUrl}`);
          console.log(`🖼️  Thumbnail: ${clip.thumbnailUrl}`);
          console.log(`📊 Status: ${clip.assetStatus}`);
        }
        console.log();
      });

      if (!options.dryRun) {
        console.log("💡 Tip: Clip assets are being processed. Use the Mux dashboard or API to check their status.");
        console.log("    Once ready, they'll be available at the URLs shown above.\n");
      } else {
        console.log("💡 Tip: Run without --dry-run to create actual clip assets in Mux.\n");
      }

      // Usage information
      if (result.usage) {
        console.log("📊 AI Usage:");
        console.log(`   Input tokens: ${result.usage.inputTokens}`);
        console.log(`   Output tokens: ${result.usage.outputTokens}`);
        console.log(`   Total tokens: ${result.usage.totalTokens}\n`);
      }
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
