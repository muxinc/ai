import { getModerationScores } from '@mux/ai';
import { config } from 'dotenv';

// Load environment variables from parent directory - override existing
const result = config({ path: '../../.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function main() {
  const assetId = process.argv[2];
  
  if (!assetId) {
    console.log('Usage: npm run hive <asset-id>');
    console.log('Example: npm run hive your-asset-id');
    console.log('');
    console.log('Note: Asset must have public playback IDs');
    console.log('Note: Requires HIVE_API_KEY environment variable');
    process.exit(1);
  }

  try {
    console.log(`🔍 Analyzing asset: ${assetId} with Hive Moderation`);
    console.log('⏳ Processing thumbnails...\n');

    const moderationResult = await getModerationScores(assetId, {
      provider: 'hive',
      thresholds: { sexual: 0.7, violence: 0.8 }
    });

    console.log('📊 Hive Moderation Results:\n');
    console.log(`Asset ID: ${moderationResult.assetId}`);
    console.log(`Thumbnails analyzed: ${moderationResult.thumbnailScores.length}`);
    console.log(`Max sexual score: ${moderationResult.maxScores.sexual.toFixed(3)}`);
    console.log(`Max violence score: ${moderationResult.maxScores.violence.toFixed(3)}`);
    console.log(`Exceeds thresholds: ${moderationResult.exceedsThreshold ? '⚠️  YES' : '✅ No'}\n`);

    // Show individual thumbnail scores
    console.log('🖼️  Individual Thumbnail Scores:');
    moderationResult.thumbnailScores.forEach((score, index) => {
      const status = score.error ? '❌' : '✅';
      console.log(`  ${index + 1}. ${status} Sexual: ${score.sexual.toFixed(3)}, Violence: ${score.violence.toFixed(3)}`);
    });

    console.log(`\n🎯 Thresholds: Sexual >${moderationResult.thresholds.sexual}, Violence >${moderationResult.thresholds.violence}`);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();