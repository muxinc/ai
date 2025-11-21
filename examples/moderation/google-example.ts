import 'dotenv/config';
import { getModerationScores } from '@mux/ai/primitives';

async function main() {
  const assetId = process.argv[2];

  if (!assetId) {
    console.log('Usage: npm run google <asset-id>');
    console.log('Example: npm run google your-asset-id');
    console.log('');
    console.log('Note: Asset must have public playback IDs');
    console.log('Note: Requires GOOGLE_GENERATIVE_AI_API_KEY environment variable');
    process.exit(1);
  }

  try {
    console.log(`🔍 Analyzing asset: ${assetId} with Google Gemini moderation`);
    console.log('⏳ Processing thumbnails...\n');

    const moderationResult = await getModerationScores(assetId, {
      provider: 'google',
      model: 'gemini-2.5-flash',
      thresholds: { sexual: 0.7, violence: 0.8 },
    });

    console.log('📊 Google Moderation Results:\n');
    console.log(`Asset ID: ${moderationResult.assetId}`);
    console.log(`Thumbnails analyzed: ${moderationResult.thumbnailScores.length}`);
    console.log(`Max sexual score: ${moderationResult.maxScores.sexual.toFixed(3)}`);
    console.log(`Max violence score: ${moderationResult.maxScores.violence.toFixed(3)}`);
    console.log(`Exceeds thresholds: ${moderationResult.exceedsThreshold ? '⚠️  YES' : '✅ No'}\n`);

    console.log('🖼️  Individual Thumbnail Scores:');
    moderationResult.thumbnailScores.forEach((score, index) => {
      const status = score.error ? '❌' : '✅';
      console.log(`  ${index + 1}. ${status} Sexual: ${score.sexual.toFixed(3)}, Violence: ${score.violence.toFixed(3)}`);
    });

    console.log(
      `\n🎯 Thresholds: Sexual >${moderationResult.thresholds.sexual}, Violence >${moderationResult.thresholds.violence}`
    );
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();

