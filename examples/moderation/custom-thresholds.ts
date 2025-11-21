import 'dotenv/config';
import { getModerationScores } from '@mux/ai/primitives';

async function testDifferentThresholds(assetId: string) {
  console.log('🎯 Testing different moderation thresholds...\n');

  const thresholdConfigs = [
    { name: 'Strict', sexual: 0.3, violence: 0.3 },
    { name: 'Default', sexual: 0.7, violence: 0.8 },
    { name: 'Permissive', sexual: 0.9, violence: 0.9 }
  ];

  for (const config of thresholdConfigs) {
    try {
      console.log(`--- ${config.name.toUpperCase()} THRESHOLDS ---`);
      console.log(`Sexual: ${config.sexual}, Violence: ${config.violence}`);
      
      const result = await getModerationScores(assetId, {
        thresholds: {
          sexual: config.sexual,
          violence: config.violence
        }
      });

      const sexualResult = result.maxScores.sexual > config.sexual ? '❌ FLAGGED' : '✅ PASSED';
      const violenceResult = result.maxScores.violence > config.violence ? '❌ FLAGGED' : '✅ PASSED';
      
      console.log(`Sexual Score: ${result.maxScores.sexual.toFixed(3)} ${sexualResult}`);
      console.log(`Violence Score: ${result.maxScores.violence.toFixed(3)} ${violenceResult}`);
      console.log(`Overall: ${result.exceedsThreshold ? '❌ WOULD BLOCK' : '✅ WOULD ALLOW'}`);
      console.log('');

    } catch (error) {
      console.error(`❌ Error with ${config.name} thresholds:`, error instanceof Error ? error.message : error);
    }
  }
}

async function main() {
  const assetId = process.argv[2];
  
  if (!assetId) {
    console.log('Usage: npm run thresholds <asset-id>');
    process.exit(1);
  }

  await testDifferentThresholds(assetId);
}

main();