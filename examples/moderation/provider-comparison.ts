import 'dotenv/config';
import { getModerationScores } from '@mux/ai/primitives';


async function main() {
  const assetId = process.argv[2];

  if (!assetId) {
    console.log('Usage: npm run example:moderation:compare <asset-id>');
    console.log('Example: npm run example:moderation:compare your-asset-id');
    console.log('');
    console.log('Note: Asset must have public playback IDs');
    console.log('Note: Requires provider-specific API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY)');
    process.exit(1);
  }

  console.log(`🔍 Comparing moderation providers for asset: ${assetId}\n`);

  try {
    const configs = [
      {
        label: 'OpenAI',
        options: {
          provider: 'openai' as const,
          model: 'omni-moderation-latest',
          thresholds: { sexual: 0.7, violence: 0.8 },
        },
      },
      {
        label: 'Anthropic',
        options: {
          provider: 'anthropic' as const,
          model: 'claude-haiku-4-5',
          thresholds: { sexual: 0.7, violence: 0.8 },
        },
      },
      {
        label: 'Google',
        options: {
          provider: 'google' as const,
          model: 'gemini-2.5-flash',
          thresholds: { sexual: 0.7, violence: 0.8 },
        },
      },
    ];

    console.log('⏳ Running all providers...\n');

    const results = await Promise.all(
      configs.map(async (config) => {
        const start = Date.now();
        const result = await getModerationScores(assetId, config.options);
        const duration = Date.now() - start;
        return { config, result, duration };
      })
    );

    console.log('📊 Comparison Results:\n');

    results.forEach(({ config, result, duration }) => {
      console.log(`${config.label} Results:`);
      console.log(`  Duration: ${duration}ms`);
      console.log(`  Max Sexual: ${result.maxScores.sexual.toFixed(3)}`);
      console.log(`  Max Violence: ${result.maxScores.violence.toFixed(3)}`);
      console.log(`  Exceeds Threshold: ${result.exceedsThreshold ? '⚠️  YES' : '✅ No'}`);
      console.log(`  Thumbnails: ${result.thumbnailScores.length}\n`);
    });

    console.log('\n📈 Score Differences:');
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i];
        const b = results[j];
        console.log(
          `${a.config.label} vs ${b.config.label}: Sexual Δ ${Math.abs(
            a.result.maxScores.sexual - b.result.maxScores.sexual
          ).toFixed(3)}, Violence Δ ${Math.abs(a.result.maxScores.violence - b.result.maxScores.violence).toFixed(3)}`
        );
      }
    }

    const agreesOnFlag = results.every((entry) => entry.result.exceedsThreshold === results[0].result.exceedsThreshold);
    console.log(`\n🎯 Agreement: ${agreesOnFlag ? '✅ All providers agree' : '⚠️  Providers disagree'} on flagging`);
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();