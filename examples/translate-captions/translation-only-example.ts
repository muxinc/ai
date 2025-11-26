import 'dotenv/config';
import { Command } from 'commander';
import { translateCaptions } from '@mux/ai/functions';

type Provider = 'openai' | 'anthropic' | 'google';

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash'
};

const program = new Command();

program
  .name('translation-only')
  .description('Translate captions without uploading to Mux (returns VTT content)')
  .argument('<asset-id>', 'Mux asset ID to translate')
  .option('-f, --from <language>', 'Source language code', 'en')
  .option('-t, --to <language>', 'Target language code', 'es')
  .option('-p, --provider <provider>', 'AI provider (openai, anthropic, google)', 'anthropic')
  .option('-m, --model <model>', 'Model name (overrides default for provider)')
  .option('--preview-length <chars>', 'Number of VTT characters to preview', '500')
  .action(async (assetId: string, options: {
    from: string;
    to: string;
    provider: Provider;
    model?: string;
    previewLength: string;
  }) => {
    // Validate provider
    if (!['openai', 'anthropic', 'google'].includes(options.provider)) {
      console.error('❌ Unsupported provider. Choose from: openai, anthropic, google');
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];
    const previewLength = parseInt(options.previewLength, 10);

    if (isNaN(previewLength) || previewLength < 0) {
      console.error('❌ Invalid preview length. Must be a non-negative integer.');
      process.exit(1);
    }

    console.log('🌍 Starting translation (no upload to Mux)...\n');
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Translation: ${options.from} -> ${options.to}\n`);

    try {
      const result = await translateCaptions(assetId, options.from, options.to, {
        provider: options.provider,
        model,
        uploadToMux: false  // Only translate, don't upload
      });

      console.log('\n📊 Translation Results:');
      console.log(`Source Language: ${result.sourceLanguageCode}`);
      console.log(`Target Language: ${result.targetLanguageCode}`);
      console.log(`Asset ID: ${result.assetId}`);

      console.log(`\n--- Original VTT (first ${previewLength} chars) ---`);
      console.log(result.originalVtt.substring(0, previewLength) + '...');
      console.log(`\n--- Translated VTT (first ${previewLength} chars) ---`);
      console.log(result.translatedVtt.substring(0, previewLength) + '...');

    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
