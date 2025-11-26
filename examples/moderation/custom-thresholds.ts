import 'dotenv/config';
import { Command } from 'commander';
import { getModerationScores } from '@mux/ai/functions';

const SUPPORTED_PROVIDERS = ['openai', 'hive'] as const;
type ModerationProviderArg = (typeof SUPPORTED_PROVIDERS)[number];
type ProviderWithModel = Exclude<ModerationProviderArg, 'hive'>;

const DEFAULT_MODELS: Record<ProviderWithModel, string> = {
  openai: 'omni-moderation-latest',
};

const program = new Command();

program
  .name('custom-thresholds')
  .description('Test moderation with different threshold configurations')
  .argument('<asset-id>', 'Mux asset ID to analyze')
  .option('-p, --provider <provider>', 'AI provider (openai, hive)', 'openai')
  .option('-m, --model <model>', 'Model name (overrides default for provider)')
  .action(async (assetId: string, options: {
    provider: string;
    model?: string;
  }) => {
    // Validate provider
    if (!SUPPORTED_PROVIDERS.includes(options.provider as ModerationProviderArg)) {
      console.error(`❌ Unsupported provider "${options.provider}". Choose from: ${SUPPORTED_PROVIDERS.join(', ')}`);
      process.exit(1);
    }

    const provider = options.provider as ModerationProviderArg;
    const model = options.model || (provider === 'hive' ? undefined : DEFAULT_MODELS[provider]);

    console.log('🎯 Testing different moderation thresholds...\n');
    console.log(`Provider: ${provider} (${model || 'default'})\n`);

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
          provider,
          ...(model ? { model } : {}),
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
  });

program.parse();