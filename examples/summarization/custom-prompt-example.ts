import 'dotenv/config';
import { Command } from 'commander';
import { getSummaryAndTags } from '@mux/ai/functions';
import { ToneType } from '@mux/ai';

type Provider = 'openai' | 'anthropic' | 'google';

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash',
};

const DEFAULT_PROMPT = 'Provide a detailed technical analysis of this video, focusing on production quality, visual composition, and any technical elements visible.';

const program = new Command();

program
  .name('custom-prompt')
  .description('Generate summary with a custom prompt')
  .argument('<asset-id>', 'Mux asset ID to analyze')
  .option('--prompt <text>', 'Custom prompt text', DEFAULT_PROMPT)
  .option('-p, --provider <provider>', 'AI provider (openai, anthropic, google)', 'openai')
  .option('-m, --model <model>', 'Model name (overrides default for provider)')
  .option('-t, --tone <tone>', 'Tone for summary (normal, sassy, professional)', 'professional')
  .option('--no-transcript', 'Exclude transcript from analysis')
  .action(async (assetId: string, options: {
    prompt: string;
    provider: Provider;
    model?: string;
    tone: ToneType;
    transcript: boolean;
  }) => {
    // Validate provider
    if (!['openai', 'anthropic', 'google'].includes(options.provider)) {
      console.error('❌ Unsupported provider. Choose from: openai, anthropic, google');
      process.exit(1);
    }

    // Validate tone
    if (!['normal', 'sassy', 'professional'].includes(options.tone)) {
      console.error('❌ Unsupported tone. Choose from: normal, sassy, professional');
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];

    console.log('🎯 Using a custom prompt to override the default...\n');
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`Prompt: ${options.prompt}\n`);

    try {
      const result = await getSummaryAndTags(assetId, options.prompt, {
        tone: options.tone,
        provider: options.provider,
        model,
        includeTranscript: options.transcript,
      });

      console.log('📋 Custom Analysis:');
      console.log(`Title: ${result.title}`);
      console.log(`Description: ${result.description}`);
      console.log('\n🏷️  Tags:');
      console.log(result.tags.join(', '));
      console.log('\n🖼️  Storyboard URL:');
      console.log(result.storyboardUrl);
    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();