import 'dotenv/config';
import { Command } from 'commander';
import { getModerationScores } from '@mux/ai/functions';

const program = new Command();

program
  .name('moderation-compare')
  .description('Compare moderation analysis across multiple providers')
  .argument('<asset-id>', 'Mux asset ID to analyze')
  .addHelpText('after', `
Notes:
  - Asset must have public playback IDs
  - Requires OPENAI_API_KEY and HIVE_API_KEY environment variables`)
  .action(async (assetId: string) => {
    console.log(`🔍 Comparing moderation providers for asset: ${assetId}\n`);

    try {
      const configs = [
        {
          label: 'OpenAI',
          options: {
            provider: 'openai' as const,
            model: 'omni-moderation-latest',
          },
        },
        {
          label: 'Hive',
          options: {
            provider: 'hive' as const,
          },
        },
      ];

      console.log('⏳ Running providers...\n');

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
          ).toFixed(3)}, Violence Δ ${Math.abs(
            a.result.maxScores.violence - b.result.maxScores.violence
          ).toFixed(3)}`
        );
      }
    }

      const agreesOnFlag = results.every(
        (entry) => entry.result.exceedsThreshold === results[0].result.exceedsThreshold
      );
      console.log(`\n🎯 Agreement: ${agreesOnFlag ? '✅ Both providers agree' : '⚠️  Providers disagree'} on flagging`);
    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();