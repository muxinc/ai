import 'dotenv/config';
import { getModerationScores } from '@mux/ai';


async function main() {
  const assetId = process.argv[2];
  
  if (!assetId) {
    console.log('Usage: npm run example:moderation <asset-id>');
    process.exit(1);
  }

  // Debug: Check if env vars are loaded
  console.log('Debug - Environment variables:');
  console.log('MUX_TOKEN_ID:', process.env.MUX_TOKEN_ID ? `${process.env.MUX_TOKEN_ID.substring(0, 10)}...` : 'NOT SET');
  console.log('MUX_TOKEN_SECRET:', process.env.MUX_TOKEN_SECRET ? `${process.env.MUX_TOKEN_SECRET.substring(0, 10)}...` : 'NOT SET'); 
  console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? `${process.env.OPENAI_API_KEY.substring(0, 10)}...` : 'NOT SET');
  console.log('Asset ID:', assetId);

  try {
    console.log('🛡️  Starting moderation analysis...\n');

    const result = await getModerationScores(assetId, {
      model: 'omni-moderation-latest',
      thresholds: {
        sexual: 0.7,
        violence: 0.8
      }
    });

    console.log('📊 Moderation Results:');
    console.log('Max Sexual Score:', result.maxScores.sexual.toFixed(3));
    console.log('Max Violence Score:', result.maxScores.violence.toFixed(3));
    console.log('Exceeds Threshold:', result.exceedsThreshold ? '❌ YES' : '✅ PASSED');
    
    console.log('\n🎯 Thresholds:');
    console.log('Sexual Threshold:', result.thresholds.sexual);
    console.log('Violence Threshold:', result.thresholds.violence);

    console.log(`\n📸 Analyzed ${result.thumbnailScores.length} thumbnails:`);
    result.thumbnailScores.forEach((thumb, index) => {
      const status = thumb.error ? '❌ ERROR' : '✅ OK';
      console.log(`  ${index + 1}. Sexual: ${thumb.sexual.toFixed(3)}, Violence: ${thumb.violence.toFixed(3)} ${status}`);
    });

    console.log('\n📦 Asset ID:', result.assetId);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();