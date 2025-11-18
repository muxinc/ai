import { getModerationScores } from '@mux/ai';
import { config } from 'dotenv';

// Load environment variables from parent directory - override existing
const result = config({ path: '.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function main() {
  const assetId = process.argv[2];
  
  if (!assetId) {
    console.log('Usage: npm run compare <asset-id>');
    console.log('Example: npm run compare your-asset-id');
    console.log('');
    console.log('Note: Asset must have public playback IDs');
    console.log('Note: Requires both OPENAI_API_KEY and HIVE_API_KEY environment variables');
    process.exit(1);
  }

  console.log(`🔍 Comparing OpenAI vs Hive moderation for asset: ${assetId}\n`);

  try {
    // Run both providers in parallel
    console.log('⏳ Running both providers...\n');
    
    const [openaiResult, hiveResult] = await Promise.all([
      getModerationScores(assetId, {
        provider: 'openai',
        model: 'omni-moderation-latest',
        thresholds: { sexual: 0.7, violence: 0.8 }
      }),
      getModerationScores(assetId, {
        provider: 'hive',
        thresholds: { sexual: 0.7, violence: 0.8 }
      })
    ]);

    console.log('📊 Comparison Results:\n');
    
    console.log('🤖 OpenAI Results:');
    console.log(`  Max Sexual: ${openaiResult.maxScores.sexual.toFixed(3)}`);
    console.log(`  Max Violence: ${openaiResult.maxScores.violence.toFixed(3)}`);
    console.log(`  Exceeds Threshold: ${openaiResult.exceedsThreshold ? '⚠️  YES' : '✅ No'}`);
    console.log(`  Thumbnails: ${openaiResult.thumbnailScores.length}`);
    
    console.log('\n🏢 Hive Results:');
    console.log(`  Max Sexual: ${hiveResult.maxScores.sexual.toFixed(3)}`);
    console.log(`  Max Violence: ${hiveResult.maxScores.violence.toFixed(3)}`);
    console.log(`  Exceeds Threshold: ${hiveResult.exceedsThreshold ? '⚠️  YES' : '✅ No'}`);
    console.log(`  Thumbnails: ${hiveResult.thumbnailScores.length}`);

    console.log('\n📈 Score Differences:');
    console.log(`  Sexual Δ: ${Math.abs(openaiResult.maxScores.sexual - hiveResult.maxScores.sexual).toFixed(3)}`);
    console.log(`  Violence Δ: ${Math.abs(openaiResult.maxScores.violence - hiveResult.maxScores.violence).toFixed(3)}`);
    
    const agreesOnFlag = openaiResult.exceedsThreshold === hiveResult.exceedsThreshold;
    console.log(`\n🎯 Agreement: ${agreesOnFlag ? '✅ Both agree' : '⚠️  Providers disagree'} on flagging`);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();